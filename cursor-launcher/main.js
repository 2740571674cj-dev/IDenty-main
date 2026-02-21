const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Agent 系统模块（延迟加载，在 app ready 后初始化）
let agentIPCInitialized = false;

// --- 持久化存储：最近项目列表 ---
const STORE_PATH = path.join(app.getPath('userData'), 'recent-projects.json');

function loadRecentProjects() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to load recent projects:', e);
    }
    return [];
}

function saveRecentProjects(list) {
    try {
        fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.error('Failed to save recent projects:', e);
    }
}

// --- 持久化存储：模型配置 ---
const MODELS_PATH = path.join(app.getPath('userData'), 'models.json');
const CODEX_PROXY_DIR = path.join(__dirname, 'codexProapi-main');
const CODEX_PROXY_ENTRY = path.join(CODEX_PROXY_DIR, 'src', 'index.js');

let codexProxyProcess = null;
let codexProxyExpectedExit = false;
let codexProxyState = {
    status: 'stopped', // stopped | starting | running | stopping | failed
    pid: null,
    port: 1455,
    lastError: '',
    startedAt: null,
    logs: [],
};

function loadModels() {
    try {
        if (fs.existsSync(MODELS_PATH)) {
            return JSON.parse(fs.readFileSync(MODELS_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[Models] Failed to load:', e);
    }
    return [];
}

function saveModels(list) {
    try {
        fs.writeFileSync(MODELS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Models] Failed to save:', e);
    }
}

function appendCodexProxyLog(line) {
    if (!line) return;
    codexProxyState.logs.push({
        ts: new Date().toISOString(),
        line: String(line).trim(),
    });
    if (codexProxyState.logs.length > 200) {
        codexProxyState.logs.splice(0, codexProxyState.logs.length - 200);
    }
}

// --- cURL / Python 解析器 ---
function parseCurl(raw) {
    const result = { baseUrl: '', apiKey: '', modelName: '', headers: {}, extraBody: {} };
    try {
        // 提取 URL
        const urlMatch = raw.match(/curl\s+(?:--[^\s]+\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/i)
            || raw.match(/(https?:\/\/[^\s'"\\]+)/);
        if (urlMatch) result.baseUrl = urlMatch[1].replace(/\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '');

        // 提取所有 -H headers
        const headerRegex = /-H\s+['"]([^'"]+)['"]/gi;
        let hm;
        while ((hm = headerRegex.exec(raw)) !== null) {
            const colonIdx = hm[1].indexOf(':');
            if (colonIdx > 0) {
                const key = hm[1].substring(0, colonIdx).trim();
                const val = hm[1].substring(colonIdx + 1).trim();
                if (key.toLowerCase() === 'authorization') {
                    result.apiKey = val.replace(/^Bearer\s+/i, '');
                } else if (key.toLowerCase() !== 'content-type') {
                    result.headers[key] = val;
                }
            }
        }

        // 提取 -d / --data body
        const bodyMatch = raw.match(/-d\s+['"]({[\s\S]*?})['"]/i)
            || raw.match(/--data(?:-raw)?\s+['"]({[\s\S]*?})['"]/i)
            || raw.match(/--data(?:-raw)?\s+\$'({[\s\S]*?})'/i);
        if (bodyMatch) {
            try {
                const body = JSON.parse(bodyMatch[1].replace(/\\n/g, '').replace(/\\'/g, "'"));
                if (body.model) result.modelName = body.model;
                // 保留非 model/messages 的字段作为 extraBody
                const { model, messages, ...rest } = body;
                if (Object.keys(rest).length > 0) result.extraBody = rest;
            } catch (_) { /* body parse fail, ok */ }
        }
    } catch (e) {
        console.error('[Models] cURL parse error:', e);
    }
    return result;
}

function parsePython(raw) {
    const result = { baseUrl: '', apiKey: '', modelName: '', headers: {}, extraBody: {} };
    try {
        // api_key=
        const keyMatch = raw.match(/api_key\s*=\s*['"]([^'"]+)['"]/);
        if (keyMatch) result.apiKey = keyMatch[1];

        // base_url=
        const urlMatch = raw.match(/base_url\s*=\s*['"]([^'"]+)['"]/);
        if (urlMatch) result.baseUrl = urlMatch[1].replace(/\/v1\/?$/, '').replace(/\/$/, '');

        // model=
        const modelMatch = raw.match(/model\s*=\s*['"]([^'"]+)['"]/);
        if (modelMatch) result.modelName = modelMatch[1];

        // headers dict
        const headersMatch = raw.match(/headers\s*=\s*({[^}]+})/);
        if (headersMatch) {
            try { result.headers = JSON.parse(headersMatch[1].replace(/'/g, '"')); } catch (_) { }
        }
    } catch (e) {
        console.error('[Models] Python parse error:', e);
    }
    return result;
}

function generateId() {
    return 'mdl_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

function normalizeBaseUrl(url) {
    return String(url || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/v1$/, '');
}

function parseCodexModelsFromSource() {
    try {
        const src = fs.readFileSync(CODEX_PROXY_ENTRY, 'utf-8');
        const found = new Set();
        const re = /id:\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            if (m[1]) found.add(m[1]);
        }
        return Array.from(found);
    } catch (e) {
        return [];
    }
}

function getCodexProxyConfig() {
    const cfg = loadModeConfig();
    const rawPort = Number(cfg?.codexProxy?.port);
    return {
        port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 1455,
        apiKey: cfg?.codexProxy?.apiKey || '',
    };
}

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, '0.0.0.0');
    });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
    const base = Number(startPort) > 0 ? Number(startPort) : 1455;
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = base + i;
        if (await isPortAvailable(candidate)) return candidate;
    }
    return null;
}

function updateCodexProxyState(patch) {
    codexProxyState = { ...codexProxyState, ...patch };
}

async function ensureCodexProxyDependencies() {
    const expressPath = path.join(CODEX_PROXY_DIR, 'node_modules', 'express');
    if (fs.existsSync(expressPath)) return { success: true };
    if (!fs.existsSync(path.join(CODEX_PROXY_DIR, 'package.json'))) {
        return { success: false, error: `codexProapi project not found: ${CODEX_PROXY_DIR}` };
    }
    try {
        await execAsync('npm install --no-audit --no-fund', {
            cwd: CODEX_PROXY_DIR,
            timeout: 5 * 60 * 1000,
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: `Dependency install failed: ${e.message}` };
    }
}

async function waitForCodexProxyHealth(port, timeoutMs = 15000) {
    const start = Date.now();
    const url = `http://127.0.0.1:${port}/health`;
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url, { method: 'GET' });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data?.service === 'codex-proapi' || data?.status === 'ok') return true;
            }
        } catch (_) { }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function startCodexProxyService({ port, apiKey, _retryCount } = {}) {
    const retryCount = Number(_retryCount) || 0;
    if (codexProxyProcess && !codexProxyProcess.killed) {
        updateCodexProxyState({ status: 'running' });
        return { success: true, data: codexProxyState };
    }
    if (!fs.existsSync(CODEX_PROXY_ENTRY)) {
        updateCodexProxyState({ status: 'failed', lastError: `Entry file not found: ${CODEX_PROXY_ENTRY}` });
        return { success: false, error: codexProxyState.lastError };
    }

    const cfg = getCodexProxyConfig();
    const requestedPort = Number(port) > 0 ? Number(port) : cfg.port;
    const existingHealthy = await waitForCodexProxyHealth(requestedPort, 1200);
    if (existingHealthy) {
        updateCodexProxyState({ status: 'running', port: requestedPort, pid: null, lastError: '' });
        appendCodexProxyLog(`[OK] Existing codexProapi detected on port ${requestedPort}`);
        return { success: true, data: codexProxyState };
    }

    const targetPort = await findAvailablePort(requestedPort, 200);
    if (!targetPort) {
        const err = `No available port found from ${requestedPort} to ${requestedPort + 199}`;
        updateCodexProxyState({ status: 'failed', lastError: err });
        appendCodexProxyLog(`[ERROR] ${err}`);
        return { success: false, error: err };
    }
    const targetApiKey = typeof apiKey === 'string' ? apiKey : cfg.apiKey;

    updateCodexProxyState({ status: 'starting', port: targetPort, lastError: '' });
    appendCodexProxyLog(`[START] Starting codexProapi on port ${targetPort}`);
    appendCodexProxyLog(`[INFO] Requested port=${requestedPort}, selected port=${targetPort}`);
    if (retryCount > 0) {
        appendCodexProxyLog(`[INFO] Retry attempt ${retryCount}`);
    }
    if (targetPort !== requestedPort) {
        appendCodexProxyLog(`[WARN] Port ${requestedPort} is busy, switched to ${targetPort}`);
    }

    const dep = await ensureCodexProxyDependencies();
    if (!dep.success) {
        updateCodexProxyState({ status: 'failed', lastError: dep.error });
        appendCodexProxyLog(`[ERROR] ${dep.error}`);
        return { success: false, error: dep.error };
    }

    const modeCfg = loadModeConfig();
    modeCfg.codexProxy = { ...(modeCfg.codexProxy || {}), port: targetPort, apiKey: targetApiKey || '' };
    saveModeConfig(modeCfg);

    codexProxyExpectedExit = false;
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['start'], {
        cwd: CODEX_PROXY_DIR,
        env: {
            ...process.env,
            PORT: String(targetPort),
        },
        windowsHide: true,
    });
    codexProxyProcess = child;
    updateCodexProxyState({ pid: child.pid || null, startedAt: new Date().toISOString() });

    let sawAddrInUse = false;
    child.stdout.on('data', (buf) => appendCodexProxyLog(buf.toString()));
    child.stderr.on('data', (buf) => {
        const line = buf.toString();
        if (line.includes('EADDRINUSE')) sawAddrInUse = true;
        appendCodexProxyLog(line);
    });
    child.on('exit', (code, signal) => {
        codexProxyProcess = null;
        const normalStop = codexProxyExpectedExit;
        codexProxyExpectedExit = false;
        if (!normalStop && codexProxyState.status !== 'stopping') {
            const err = `Service exited, code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
            updateCodexProxyState({ status: 'failed', pid: null, lastError: err });
            appendCodexProxyLog(`[EXIT] ${err}`);
        } else {
            updateCodexProxyState({ status: 'stopped', pid: null });
            appendCodexProxyLog('[STOP] Service stopped');
        }
    });

    const healthy = await waitForCodexProxyHealth(targetPort, 15000);
    if (!healthy) {
        codexProxyExpectedExit = true;
        try { child.kill(); } catch (_) { }
        codexProxyProcess = null;
        if (sawAddrInUse && retryCount < 5) {
            appendCodexProxyLog(`[WARN] EADDRINUSE detected on ${targetPort}, retrying with next port`);
            return await startCodexProxyService({
                port: targetPort + 1,
                apiKey: targetApiKey,
                _retryCount: retryCount + 1,
            });
        }
        const err = 'Service startup timed out: /health not ready in 15s';
        updateCodexProxyState({ status: 'failed', pid: null, lastError: err });
        appendCodexProxyLog(`[ERROR] ${err}`);
        return { success: false, error: err };
    }

    updateCodexProxyState({ status: 'running', lastError: '' });
    appendCodexProxyLog('[OK] codexProapi started');
    return { success: true, data: codexProxyState };
}

async function stopCodexProxyService() {
    if (!codexProxyProcess || codexProxyProcess.killed) {
        updateCodexProxyState({ status: 'stopped', pid: null });
        return { success: true, data: codexProxyState };
    }
    updateCodexProxyState({ status: 'stopping' });
    codexProxyExpectedExit = true;

    const pid = codexProxyProcess.pid;
    try {
        if (process.platform === 'win32' && pid) {
            await execAsync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
        } else {
            codexProxyProcess.kill('SIGTERM');
        }
    } catch (_) {
        try { codexProxyProcess.kill(); } catch (_) { }
    }

    codexProxyProcess = null;
    updateCodexProxyState({ status: 'stopped', pid: null, lastError: '' });
    appendCodexProxyLog('[STOP] Stop requested for codexProapi');
    return { success: true, data: codexProxyState };
}

function getCodexProxyHomeUrl(port) {
    const cfg = getCodexProxyConfig();
    const targetPort = Number(port) > 0 ? Number(port) : (codexProxyState.port || cfg.port);
    return `http://127.0.0.1:${targetPort}/`;
}

async function openCodexProxyHomeInBrowser(port) {
    const url = getCodexProxyHomeUrl(port);
    try {
        await shell.openExternal(url);
        appendCodexProxyLog(`[INFO] Opened browser: ${url}`);
        return { success: true, data: { url } };
    } catch (e) {
        const err = `Failed to open browser: ${e.message}`;
        appendCodexProxyLog(`[WARN] ${err}`);
        return { success: false, error: err };
    }
}

async function fetchCodexProxyModelIds(baseUrl, apiKey) {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/models`, { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`获取 /v1/models 失败: HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    const ids = (data?.data || []).map(m => m?.id).filter(Boolean);
    return Array.from(new Set(ids));
}

// --- 创建主窗口 ---
let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        frame: false, // 无边框窗口，使用自定义标题栏
        backgroundColor: '#0b0b0b',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Development uses Vite dev server; production loads built index.html
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }
}

app.whenReady().then(() => {
    createWindow();

    // 初始化 Agent IPC 系统
    if (!agentIPCInitialized) {
        try {
            const { setupAgentIPC } = require('./src/main-process/agent-ipc');
            setupAgentIPC({ loadModels, mainWindow });
            agentIPCInitialized = true;
            console.log('[Agent] IPC system initialized');
        } catch (e) {
            console.error('[Agent] Failed to initialize IPC:', e.message);
            if (e && e.stack) console.error(e.stack);
        }
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (codexProxyProcess && !codexProxyProcess.killed) {
        codexProxyExpectedExit = true;
        try {
            if (process.platform === 'win32' && codexProxyProcess.pid) {
                exec(`taskkill /PID ${codexProxyProcess.pid} /T /F`);
            } else {
                codexProxyProcess.kill('SIGTERM');
            }
        } catch (_) { }
    }
});

// ========================================
// IPC 通道：渲染进程 ↔ 主进程 通信
// ========================================

// 1. Open native folder picker
ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择项目文件夹',
    });
    if (result.canceled) return null;
    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    return { name: folderName, path: folderPath };
});

// 2. 读取指定目录下的文件和文件夹列表
ipcMain.handle('fs:readDir', async (_event, dirPath) => {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
            .filter(entry => !entry.name.startsWith('.'))
            .map(entry => ({
                name: entry.name,
                isDirectory: entry.isDirectory(),
                path: path.join(dirPath, entry.name),
            }))
            .sort((a, b) => {
                // 文件夹排前面
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });
    } catch (e) {
        console.error('Failed to read directory:', e);
        return [];
    }
});

// 3. Open project folder in Cursor/Code
ipcMain.handle('shell:openInCursor', async (_event, folderPath) => {
    return new Promise((resolve) => {
        // 尝试用 cursor 命令打开，如果失败则用系统默认文件管理器打开
        exec(`cursor "${folderPath}"`, (error) => {
            if (error) {
                console.warn('cursor command failed, trying code...', error.message);
                // 回退：尝试用 VS Code 打开
                exec(`code "${folderPath}"`, (error2) => {
                    if (error2) {
                        // 最后回退：用系统文件管理器打开
                        shell.openPath(folderPath);
                    }
                    resolve(true);
                });
            } else {
                resolve(true);
            }
        });
    });
});

// 4. 在系统文件管理器中显示文件夹
ipcMain.handle('shell:showInExplorer', async (_event, folderPath) => {
    shell.showItemInFolder(folderPath);
    return true;
});

// 5. Read recent projects
ipcMain.handle('store:getRecent', async () => {
    return loadRecentProjects();
});

// 6. Save recent projects
ipcMain.handle('store:saveRecent', async (_event, list) => {
    saveRecentProjects(list);
    return true;
});

// 7. 窗口控制
ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
});

ipcMain.on('window:toggleMaximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.on('window:close', () => {
    mainWindow?.close();
});

// 8. 查询窗口是否最大化
ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
});

// 9. 递归读取项目文件树（用于项目界面左侧资源管理器）
ipcMain.handle('fs:readFileTree', async (_event, rootPath, maxDepth = 4) => {
    const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.vscode', '.idea']);

    function buildTree(dirPath, depth) {
        if (depth > maxDepth) return [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env')
                .filter(e => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
                .map(e => {
                    const fullPath = path.join(dirPath, e.name);
                    if (e.isDirectory()) {
                        return {
                            id: fullPath,
                            name: e.name,
                            type: 'folder',
                            path: fullPath,
                            isOpen: depth === 0, // 第一层默认展开
                            children: buildTree(fullPath, depth + 1),
                        };
                    }
                    return {
                        id: fullPath,
                        name: e.name,
                        type: 'file',
                        path: fullPath,
                        language: getLanguageFromExt(e.name),
                    };
                })
                .sort((a, b) => {
                    if (a.type === 'folder' && b.type === 'file') return -1;
                    if (a.type === 'file' && b.type === 'folder') return 1;
                    return a.name.localeCompare(b.name);
                });
        } catch (e) {
            return [];
        }
    }

    function getLanguageFromExt(filename) {
        const ext = path.extname(filename).toLowerCase();
        const map = {
            '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
            '.json': 'json', '.html': 'html', '.css': 'css', '.scss': 'scss',
            '.md': 'markdown', '.py': 'python', '.yaml': 'yaml', '.yml': 'yaml',
            '.xml': 'xml', '.svg': 'xml', '.sh': 'shell', '.bat': 'batch',
            '.txt': 'plaintext', '.gitignore': 'plaintext', '.env': 'plaintext',
        };
        return map[ext] || 'plaintext';
    }

    const rootName = path.basename(rootPath);
    return [{
        id: rootPath,
        name: rootName,
        type: 'folder',
        path: rootPath,
        isOpen: true,
        children: buildTree(rootPath, 0),
    }];
});

// 10. 读取单个文件内容
ipcMain.handle('fs:readFileContent', async (_event, filePath) => {
    try {
        // Limit file size to avoid very large file rendering issues
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024) { // 2MB 上限
            return '// [文件过大，仅支持 2MB 以下文件预览]';
        }
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return `// 无法读取文件: ${e.message}`;
    }
});

// 11. 新建文件
ipcMain.handle('fs:createFile', async (_event, filePath) => {
    try {
        if (fs.existsSync(filePath)) return { success: false, error: 'File already exists' };
        fs.writeFileSync(filePath, '', 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 12. Create folder
ipcMain.handle('fs:createFolder', async (_event, folderPath) => {
    try {
        if (fs.existsSync(folderPath)) return { success: false, error: '文件夹已存在' };
        fs.mkdirSync(folderPath, { recursive: true });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 13. Rename file/folder
ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    try {
        if (!fs.existsSync(oldPath)) return { success: false, error: '源文件不存在', code: 'E_NOT_FOUND' };
        if (fs.existsSync(newPath)) return { success: false, error: 'Target already exists', code: 'E_EXISTS' };
        fs.renameSync(oldPath, newPath);
        return { success: true };
    } catch (e) {
        const code = e.code === 'EBUSY' || e.code === 'EPERM' ? 'E_LOCKED' : 'E_UNKNOWN';
        return { success: false, error: e.message, code };
    }
});

// 14. Delete file/folder
ipcMain.handle('fs:delete', async (_event, targetPath) => {
    try {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 15. 在系统终端中打开指定路径
ipcMain.handle('shell:openTerminal', async (_event, dirPath) => {
    try {
        if (process.platform === 'win32') {
            exec(`start cmd /K "cd /d ${dirPath}"`, { cwd: dirPath });
        } else if (process.platform === 'darwin') {
            exec(`open -a Terminal "${dirPath}"`);
        } else {
            exec(`x-terminal-emulator --working-directory="${dirPath}"`, (err) => {
                if (err) exec(`gnome-terminal --working-directory="${dirPath}"`);
            });
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 15b. Agent 模式：在项目目录下执行命令并返回输出（与 Cursor 一致）
ipcMain.handle('agent:runCommand', async (_event, { projectPath, command }) => {
    try {
        if (!projectPath || !fs.existsSync(projectPath)) {
            return { success: false, error: '项目路径无效或不存在', stdout: '', stderr: '' };
        }
        const cwd = projectPath;
        const opts = {
            cwd,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 120000,
            encoding: 'utf-8',
            windowsHide: true,
        };
        if (process.platform === 'win32') {
            opts.shell = 'cmd.exe';
            opts.windowsVerbatimArguments = false;
        }
        const { stdout, stderr } = await execAsync(command, opts);
        return { success: true, stdout: stdout || '', stderr: stderr || '', code: 0 };
    } catch (e) {
        const stdout = e.stdout || '';
        const stderr = e.stderr || e.message || '';
        const code = e.code !== undefined ? e.code : -1;
        return { success: false, stdout, stderr, code, error: e.message };
    }
});

// 16. 写入文件内容
ipcMain.handle('fs:writeFile', async (_event, filePath, content) => {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ========================================
// 模型管理 IPC（持久化 + 解析）
// ========================================

// M1. 获取模型列表
ipcMain.handle('model:list', async () => {
    try {
        return { success: true, data: loadModels() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M2. 创建模型
ipcMain.handle('model:create', async (_event, modelData) => {
    try {
        const models = loadModels();
        const newModel = {
            id: generateId(),
            displayName: modelData.displayName || 'Untitled Model',
            apiKey: modelData.apiKey || '',
            baseUrl: modelData.baseUrl || '',
            modelName: modelData.modelName || '',
            sourceType: modelData.sourceType || 'manual',
            rawSource: modelData.rawSource || '',
            headers: modelData.headers || {},
            extraBody: modelData.extraBody || {},
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        models.push(newModel);
        saveModels(models);
        return { success: true, data: newModel };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M3. 更新模型
ipcMain.handle('model:update', async (_event, id, updates) => {
    try {
        const models = loadModels();
        const idx = models.findIndex(m => m.id === id);
        if (idx === -1) return { success: false, error: 'Model not found', code: 'E_NOT_FOUND' };
        models[idx] = { ...models[idx], ...updates, updatedAt: new Date().toISOString() };
        saveModels(models);
        return { success: true, data: models[idx] };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M4. 删除模型
ipcMain.handle('model:delete', async (_event, id) => {
    try {
        let models = loadModels();
        const before = models.length;
        models = models.filter(m => m.id !== id);
        if (models.length === before) return { success: false, error: 'Model not found', code: 'E_NOT_FOUND' };
        saveModels(models);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M5. 解析 cURL / Python 文本
ipcMain.handle('model:parse', async (_event, raw, type) => {
    try {
        if (!raw || !raw.trim()) return { success: false, error: '输入为空' };
        const parsed = type === 'python' ? parsePython(raw) : parseCurl(raw);
        return { success: true, data: parsed };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M6. 复制模型
ipcMain.handle('model:duplicate', async (_event, id) => {
    try {
        const models = loadModels();
        const source = models.find(m => m.id === id);
        if (!source) return { success: false, error: 'Model not found', code: 'E_NOT_FOUND' };
        const dup = {
            ...source,
            id: generateId(),
            displayName: source.displayName + ' (Copy)',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        models.push(dup);
        saveModels(models);
        return { success: true, data: dup };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M7. Codex proxy service status
ipcMain.handle('codexProxy:status', async () => {
    try {
        const cfg = getCodexProxyConfig();
        return {
            success: true,
            data: {
                ...codexProxyState,
                port: codexProxyState.port || cfg.port,
                configuredApiKey: !!cfg.apiKey,
                running: codexProxyState.status === 'running',
                logs: codexProxyState.logs.slice(-80),
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M8. 启动 Codex 反代服务
ipcMain.handle('codexProxy:start', async (_event, opts) => {
    try {
        const r = await startCodexProxyService(opts || {});
        if (r?.success && (opts?.openBrowser ?? true)) {
            const openRes = await openCodexProxyHomeInBrowser(r?.data?.port || opts?.port);
            if (openRes?.success) {
                r.data = { ...(r.data || {}), browserOpened: true, browserUrl: openRes.data?.url || '' };
            } else {
                r.data = { ...(r.data || {}), browserOpened: false, browserOpenError: openRes?.error || 'unknown error' };
            }
        }
        return r;
    } catch (e) {
        updateCodexProxyState({ status: 'failed', lastError: e.message });
        return { success: false, error: e.message };
    }
});

ipcMain.handle('codexProxy:open', async (_event, opts) => {
    try {
        return await openCodexProxyHomeInBrowser(opts?.port);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M9. 停止 Codex 反代服务
ipcMain.handle('codexProxy:stop', async () => {
    try {
        return await stopCodexProxyService();
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M10. 导入 codexProapi 所有模型到 IDE 模型列表
ipcMain.handle('codexProxy:importModels', async (_event, opts) => {
    try {
        const cfg = getCodexProxyConfig();
        const targetPort = Number(opts?.port) > 0 ? Number(opts.port) : cfg.port;
        const baseUrl = normalizeBaseUrl(opts?.baseUrl || `http://127.0.0.1:${targetPort}`);
        const apiKey = typeof opts?.apiKey === 'string' ? opts.apiKey : cfg.apiKey;

        let ids = [];
        let source = 'endpoint';
        try {
            ids = await fetchCodexProxyModelIds(baseUrl, apiKey);
        } catch (_) {
            ids = parseCodexModelsFromSource();
            source = 'source';
        }

        if (!ids || ids.length === 0) {
            return { success: false, error: 'No models available to import. Start the proxy or check codexProapi source.' };
        }

        const models = loadModels();
        const now = new Date().toISOString();
        let created = 0;
        let updated = 0;

        for (const modelId of ids) {
            const idx = models.findIndex(m =>
                normalizeBaseUrl(m.baseUrl) === baseUrl &&
                String(m.modelName || '').trim() === modelId
            );

            if (idx >= 0) {
                models[idx] = {
                    ...models[idx],
                    apiKey: apiKey ?? models[idx].apiKey ?? '',
                    baseUrl,
                    sourceType: 'codex-proxy',
                    rawSource: 'codexProapi-main:/v1/models',
                    updatedAt: now,
                };
                updated++;
            } else {
                models.push({
                    id: generateId(),
                    displayName: `Codex ${modelId}`,
                    apiKey: apiKey || '',
                    baseUrl,
                    modelName: modelId,
                    sourceType: 'codex-proxy',
                    rawSource: 'codexProapi-main:/v1/models',
                    headers: {},
                    extraBody: {},
                    enabled: true,
                    createdAt: now,
                    updatedAt: now,
                });
                created++;
            }
        }

        saveModels(models);
        return {
            success: true,
            data: {
                source,
                baseUrl,
                importedModelIds: ids,
                created,
                updated,
                total: ids.length,
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M11. 手动导入账号到 codexProapi
ipcMain.handle('codexProxy:addAccountManual', async (_event, body) => {
    try {
        const cfg = getCodexProxyConfig();
        const targetPort = codexProxyState?.port || cfg.port || 1455;
        const url = `http://127.0.0.1:${targetPort}/api/accounts`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error || `HTTP ${res.status}` };
        return { success: true, data };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// M12. 获取 OAuth 诊断信息
ipcMain.handle('codexProxy:getAuthDebug', async () => {
    try {
        const cfg = getCodexProxyConfig();
        const statusPort = Number(codexProxyState?.port);
        const cfgPort = Number(cfg?.port) > 0 ? Number(cfg.port) : 1455;
        const candidatePorts = Array.from(new Set([statusPort, cfgPort].filter(p => Number.isFinite(p) && p > 0)));
        const candidateHosts = ['127.0.0.1', 'localhost'];

        let lastProbeError = '';
        for (const port of candidatePorts) {
            for (const host of candidateHosts) {
                const url = `http://${host}:${port}/auth/debug`;
                try {
                    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
                    if (!res.ok) {
                        lastProbeError = `HTTP ${res.status} @ ${url}`;
                        continue;
                    }
                    const data = await res.json();
                    return { success: true, data: { ...data, _debugUrl: url } };
                } catch (e) {
                    lastProbeError = `${e.message} @ ${url}`;
                }
            }
        }

        const serviceStatus = codexProxyState?.status || 'stopped';
        const isRunning = serviceStatus === 'running' || serviceStatus === 'starting';
        if (!isRunning) {
            return {
                success: false,
                code: 'SERVICE_NOT_RUNNING',
                error: `Service is not running (status=${serviceStatus}). Please start service first. ${lastProbeError ? `Last probe: ${lastProbeError}` : ''}`.trim(),
                data: { status: serviceStatus, candidatePorts },
            };
        }
        return {
            success: false,
            code: 'AUTH_DEBUG_UNREACHABLE',
            error: `Auth debug endpoint unreachable. ${lastProbeError ? `Last probe: ${lastProbeError}` : ''}`.trim(),
            data: { status: serviceStatus, candidatePorts },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// 持久化存储：聊天会话 (chat-sessions.json)
// ============================================================
const SESSIONS_PATH = path.join(app.getPath('userData'), 'chat-sessions.json');

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_PATH)) {
            return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[Chat] Failed to load sessions:', e);
    }
    return [];
}

function saveSessions(list) {
    try {
        fs.writeFileSync(SESSIONS_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Chat] Failed to save sessions:', e);
    }
}

// C1. 列出会话（仅元数据），可按 projectPath 过滤
ipcMain.handle('chat:list', async (_event, opts) => {
    try {
        let sessions = loadSessions();
        const filterPath = opts?.projectPath;
        if (filterPath) {
            const norm = filterPath.replace(/[\\/]+$/, '').toLowerCase();
            sessions = sessions.filter(s => {
                const sp = (s.projectPath || '').replace(/[\\/]+$/, '').toLowerCase();
                return sp === norm;
            });
        }
        const meta = sessions.map(s => ({
            id: s.id,
            title: s.title,
            messageCount: (s.messages || []).length,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            projectPath: s.projectPath || '',
        }));
        return { success: true, data: meta };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C2. 获取单个会话完整数据
ipcMain.handle('chat:get', async (_event, id) => {
    try {
        const sessions = loadSessions();
        const session = sessions.find(s => s.id === id);
        if (!session) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };
        return { success: true, data: session };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C3. 新建会话
ipcMain.handle('chat:create', async (_event, data) => {
    try {
        const sessions = loadSessions();
        const now = new Date().toISOString();
        const newSession = {
            id: generateId(),
            title: (data && data.title) || ('新对话 ' + new Date().toLocaleString('zh-CN')),
            messages: (data && data.messages) || [],
            projectPath: (data && data.projectPath) || '',
            createdAt: now,
            updatedAt: now,
        };
        sessions.unshift(newSession); // 最新的排在前面
        saveSessions(sessions);
        return { success: true, data: newSession };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C4. 更新会话（标题 / 消息 / 等）
ipcMain.handle('chat:update', async (_event, id, updates) => {
    try {
        const sessions = loadSessions();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx === -1) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };
        sessions[idx] = { ...sessions[idx], ...updates, updatedAt: new Date().toISOString() };
        saveSessions(sessions);
        return { success: true, data: sessions[idx] };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C5. 删除会话
ipcMain.handle('chat:delete', async (_event, id) => {
    try {
        let sessions = loadSessions();
        const before = sessions.length;
        sessions = sessions.filter(s => s.id !== id);
        if (sessions.length === before) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };
        saveSessions(sessions);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C6. 导出会话
ipcMain.handle('chat:export', async (_event, id, format) => {
    try {
        const sessions = loadSessions();
        const session = sessions.find(s => s.id === id);
        if (!session) return { success: false, error: 'Session not found', code: 'E_NOT_FOUND' };

        let content, ext;
        if (format === 'json') {
            content = JSON.stringify(session, null, 2);
            ext = 'json';
        } else {
            // TXT 格式
            const lines = [`# ${session.title}`, `创建时间: ${session.createdAt}`, ''];
            (session.messages || []).forEach(m => {
                lines.push(`[${m.role === 'user' ? '用户' : 'AI'}] ${new Date(m.id).toLocaleString('zh-CN')}`);
                lines.push(m.text);
                lines.push('');
            });
            content = lines.join('\n');
            ext = 'txt';
        }

        const { dialog } = require('electron');
        const result = await dialog.showSaveDialog({
            title: '导出会话',
            defaultPath: path.join(app.getPath('documents'), `${session.title}.${ext}`),
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });

        if (result.canceled || !result.filePath) return { success: false, error: '用户取消' };

        fs.writeFileSync(result.filePath, content, 'utf-8');
        return { success: true, filePath: result.filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// C7. AI 自动生成会话标题
ipcMain.handle('chat:generateTitle', async (_event, { modelId, userMessage }) => {
    try {
        const models = loadModels();
        const model = models.find(m => m.id === modelId);
        if (!model || !model.baseUrl || !model.modelName) {
            // 无模型时用启发式方法生成标题
            const title = (userMessage || '').replace(/\n/g, ' ').substring(0, 30).trim() || '新对话';
            return { success: true, data: title };
        }

        const url = model.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
        const headers = { 'Content-Type': 'application/json' };
        if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

        const body = {
            model: model.modelName,
            messages: [
                {
                    role: 'system',
                    content: '根据用户的消息，生成一个简洁的对话主题标题（6-15个中文字符）。直接输出标题文本，不要加引号、标点或任何解释。'
                },
                { role: 'user', content: (userMessage || '').substring(0, 500) },
            ],
            max_tokens: 30,
            temperature: 0.3,
        };

        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });

        if (resp.ok) {
            const json = await resp.json();
            let title = (json.choices?.[0]?.message?.content || '').trim();
            // 清理可能的引号和多余标点
            title = title.replace(/^["""'《「【\[]+|["""'》」】\]]+$/g, '').trim();
            if (title.length > 0 && title.length <= 30) {
                return { success: true, data: title };
            }
        }

        // 回退：截取用户消息前 20 个字符
        const fallback = (userMessage || '').replace(/\n/g, ' ').substring(0, 20).trim() || '新对话';
        return { success: true, data: fallback };
    } catch (e) {
        const fallback = (userMessage || '').replace(/\n/g, ' ').substring(0, 20).trim() || '新对话';
        return { success: true, data: fallback };
    }
});

// ============================================================
// 持久化存储：会话记忆 (session-memory/)
// ============================================================
const { SessionMemoryStore } = require('./src/core/session-memory-store');
const sessionMemoryStore = new SessionMemoryStore(path.join(app.getPath('userData'), 'session-memory'));

ipcMain.handle('memory:getSummary', async (_event, sessionId) => {
    try {
        const summary = sessionMemoryStore.getSummary(sessionId);
        return { success: true, data: summary };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('memory:getPromptContext', async (_event, sessionId) => {
    try {
        const ctx = sessionMemoryStore.formatForPrompt(sessionId);
        return { success: true, data: ctx };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('memory:deleteSession', async (_event, sessionId) => {
    try {
        sessionMemoryStore.deleteSession(sessionId);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// 持久化存储：模式配置 (mode-config.json)
// ============================================================
const MODE_CONFIG_PATH = path.join(app.getPath('userData'), 'mode-config.json');

function loadModeConfig() {
    const defaults = {
        defaultMode: 'chat',
        modeModels: {},
        taskExecution: { autoExecute: false },
        codexProxy: { port: 1455, apiKey: '' },
    };
    try {
        if (fs.existsSync(MODE_CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(MODE_CONFIG_PATH, 'utf-8'));
            // 兼容旧配置：补全缺失字段
            if (!raw.taskExecution) raw.taskExecution = { ...defaults.taskExecution };
            if (!raw.codexProxy) raw.codexProxy = { ...defaults.codexProxy };
            const parsedPort = Number(raw.codexProxy.port);
            raw.codexProxy.port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 1455;
            if (typeof raw.codexProxy.apiKey !== 'string') raw.codexProxy.apiKey = '';
            return raw;
        }
    } catch (e) {
        console.error('[ModeConfig] Failed to load:', e);
    }
    return defaults;
}

function saveModeConfig(config) {
    try {
        fs.writeFileSync(MODE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.error('[ModeConfig] Failed to save:', e);
    }
}

ipcMain.handle('modeConfig:get', async () => {
    try {
        return { success: true, data: loadModeConfig() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('modeConfig:save', async (_event, config) => {
    try {
        saveModeConfig(config);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// 工作流管理
// ============================================================
const { WorkflowStore } = require('./src/core/workflow-store');
const WORKFLOWS_PATH = path.join(app.getPath('userData'), 'workflows.json');
const workflowStore = new WorkflowStore(WORKFLOWS_PATH);

ipcMain.handle('workflow:list', async () => workflowStore.list());
ipcMain.handle('workflow:get', async (_event, id) => workflowStore.get(id));
ipcMain.handle('workflow:create', async (_event, data) => workflowStore.create(data));
ipcMain.handle('workflow:update', async (_event, id, updates) => workflowStore.update(id, updates));
ipcMain.handle('workflow:delete', async (_event, id) => workflowStore.delete(id));
ipcMain.handle('workflow:updateActiveVersion', async (_event, wfId, data) => workflowStore.updateActiveVersion(wfId, data));
ipcMain.handle('workflow:saveVersion', async (_event, wfId, versionData) => workflowStore.saveVersion(wfId, versionData));
ipcMain.handle('workflow:deleteVersion', async (_event, wfId, versionId) => workflowStore.deleteVersion(wfId, versionId));
ipcMain.handle('workflow:match', async (_event, taskDesc) => {
    const wf = workflowStore.matchWorkflow(taskDesc);
    if (!wf) return null;
    const steps = workflowStore.getActiveSteps(wf.id);
    return { id: wf.id, name: wf.name, description: wf.description, steps };
});

// ============================================================
// LLM 统一网关（OpenAI-compatible）— 非流式
// ============================================================
ipcMain.handle('llm:chat', async (_event, { modelId, messages }) => {
    const startTime = Date.now();
    const logTag = '[LLM:Chat]';

    try {
        // 1) 查找模型配置
        const models = loadModels();
        const model = models.find(m => m.id === modelId);
        if (!model) {
            console.error(logTag, 'Model not found:', modelId);
            return { success: false, error: '模型配置不存在，请先在设置中添加模型', code: 'E_MODEL_NOT_FOUND' };
        }

        if (!model.baseUrl || !model.modelName) {
            return { success: false, error: 'Model config incomplete (missing baseUrl or modelName)', code: 'E_CONFIG_INCOMPLETE' };
        }

        // 2) 构建请求
        const url = model.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
            ...(model.headers || {})
        };

        const body = {
            model: model.modelName,
            messages: messages.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.text || m.content || '' })),
            ...(model.extraBody || {})
        };

        // 日志（脱敏）
        const maskedKey = model.apiKey ? model.apiKey.substring(0, 4) + '****' + model.apiKey.slice(-4) : 'none';
        console.log(logTag, 'Request:', {
            url,
            model: model.modelName,
            messageCount: messages.length,
            apiKey: maskedKey,
            extraHeaders: Object.keys(model.headers || {}),
        });

        // 3) Request (30s timeout)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (fetchErr) {
            clearTimeout(timeout);
            if (fetchErr.name === 'AbortError') {
                console.error(logTag, 'Timeout after 30s');
                return { success: false, error: 'Request timed out after 30s', code: 'E_TIMEOUT' };
            }
            console.error(logTag, 'Network error:', fetchErr.message);
            return { success: false, error: `Network error: ${fetchErr.message}`, code: 'E_NETWORK' };
        }
        clearTimeout(timeout);

        // 4) 处理 HTTP 错误
        if (!response.ok) {
            let errorBody = '';
            try { errorBody = await response.text(); } catch (e) { /* ignore */ }
            const errorSummary = errorBody.substring(0, 200);
            console.error(logTag, `HTTP ${response.status}:`, errorSummary);

            const statusMessages = {
                401: 'Authentication failed (invalid or expired API key)',
                403: 'Forbidden (insufficient permission)',
                404: 'Endpoint not found (check baseUrl)',
                429: 'Rate limited (too many requests)',
                500: 'Model service internal error',
                502: 'Bad gateway',
                503: 'Service unavailable',
            };
            const readableError = statusMessages[response.status] || `HTTP ${response.status} 错误`;
            return {
                success: false,
                error: `${readableError}\n${errorSummary}`,
                code: `E_HTTP_${response.status}`,
                httpStatus: response.status
            };
        }

        // 5) 解析成功响应
        const data = await response.json();
        const elapsed = Date.now() - startTime;

        const choice = data.choices?.[0];
        const content = choice?.message?.content || '';
        const reasoningContent = choice?.message?.reasoning_content || '';
        const usage = data.usage || {};

        // Detect reasoning model
        const REASONING_KEYWORDS = /reasoning|thinking|o1|o3|r1|deepseek-r/i;
        const isReasoning = model.isReasoningModel === true ||
            (model.isReasoningModel !== false && REASONING_KEYWORDS.test(model.modelName || ''));

        console.log(logTag, 'Response:', {
            elapsed: `${elapsed}ms`,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            contentLength: content.length,
            reasoningLength: reasoningContent.length,
            isReasoning,
            finishReason: choice?.finish_reason
        });

        return {
            success: true,
            data: {
                content,
                answerText: content,
                thoughtSummaryZh: reasoningContent || '',
                thoughtDurationMs: elapsed,
                isReasoningModel: isReasoning,
                model: data.model,
                usage,
                finishReason: choice?.finish_reason,
                elapsed
            }
        };

    } catch (e) {
        console.error(logTag, 'Unexpected error:', e.message);
        return { success: false, error: `未知错误：${e.message}`, code: 'E_UNKNOWN' };
    }
});

// ============================================================
// 项目可检索 API（Ask 模式专用）// ============================================================

// 递归收集文件路径（忽略 node_modules, .git 等）
function collectFiles(dir, maxDepth = 5, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', '.vscode'];
    const TEXT_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md', '.txt', '.yaml', '.yml', '.toml', '.env', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.vue', '.svelte'];
    let files = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (IGNORE.includes(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files = files.concat(collectFiles(fullPath, maxDepth, currentDepth + 1));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (TEXT_EXTS.includes(ext)) {
                    files.push({ name: entry.name, path: fullPath, ext });
                }
            }
        }
    } catch (e) { /* ignore permission errors */ }
    return files;
}

// project:search — 多关键词搜索项目文件名和内容
ipcMain.handle('project:search', async (_event, projectPath, query) => {
    try {
        if (!projectPath || !query) return { success: false, error: '缺少参数' };
        if (!fs.existsSync(projectPath)) return { success: false, error: 'Project path does not exist' };

        const files = collectFiles(projectPath);
        const results = [];
        const seen = new Set(); // 去重 key: file.path:line

        // 支持多关键词（逗号或空格分隔）
        const keywords = query
            .split(/[,\s]+/)
            .map(k => k.trim().toLowerCase())
            .filter(k => k.length > 1);
        if (keywords.length === 0) keywords.push(query.toLowerCase());

        const EXT_LANG = { '.js': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx', '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown', '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust' };

        for (const file of files) {
            if (results.length >= 30) break;

            // 文件名匹配（任一关键词命中）
            const nameMatched = keywords.some(k => file.name.toLowerCase().includes(k));
            if (nameMatched) {
                const key = `${file.path}:1`;
                if (!seen.has(key)) {
                    seen.add(key);
                    try {
                        const content = fs.readFileSync(file.path, 'utf-8');
                        const lines = content.split('\n');
                        const relPath = path.relative(projectPath, file.path).replace(/\\/g, '/');
                        results.push({
                            file: file.name,
                            path: file.path,
                            relativePath: relPath,
                            line: 1,
                            language: EXT_LANG[file.ext] || 'text',
                            snippet: lines.slice(0, 10).join('\n'),
                            matchType: 'filename',
                            matchedKeyword: keywords.find(k => file.name.toLowerCase().includes(k))
                        });
                    } catch (e) { /* skip */ }
                }
            }

            // 内容匹配（限制文件大小 ≤ 500KB，每文件最大 2 条）
            try {
                const stat = fs.statSync(file.path);
                if (stat.size > 500 * 1024) continue;
                const content = fs.readFileSync(file.path, 'utf-8');
                const lines = content.split('\n');
                const relPath = path.relative(projectPath, file.path).replace(/\\/g, '/');
                let fileHits = 0;

                for (let li = 0; li < lines.length && fileHits < 2; li++) {
                    const lineLower = lines[li].toLowerCase();
                    const matchedKw = keywords.find(k => lineLower.includes(k));
                    if (matchedKw) {
                        const key = `${file.path}:${li + 1}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            const snippetStart = Math.max(0, li - 2);
                            const snippetEnd = Math.min(lines.length, li + 5);
                            results.push({
                                file: file.name,
                                path: file.path,
                                relativePath: relPath,
                                line: li + 1,
                                language: EXT_LANG[file.ext] || 'text',
                                snippet: lines.slice(snippetStart, snippetEnd).join('\n'),
                                matchType: 'content',
                                matchedKeyword: matchedKw
                            });
                            fileHits++;
                        }
                    }
                }
            } catch (e) { /* skip */ }
        }

        return { success: true, data: results, fileCount: files.length, keywords };
    } catch (e) {
        return { success: false, error: e.message };
    }
});


// project:readSnippet - read specific line range from file
ipcMain.handle('project:readSnippet', async (_event, filePath, startLine, endLine) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File does not exist' };
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, (startLine || 1) - 1);
        const end = Math.min(lines.length, endLine || start + 20);
        return {
            success: true,
            data: {
                content: lines.slice(start, end).join('\n'),
                totalLines: lines.length,
                startLine: start + 1,
                endLine: end
            }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// project:listFiles — 获取项目文件名列表（用于相关性判定）
ipcMain.handle('project:listFiles', async (_event, projectPath) => {
    try {
        if (!projectPath || !fs.existsSync(projectPath)) return { success: false, error: '路径无效' };
        const files = collectFiles(projectPath);
        return { success: true, data: files.map(f => f.name) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ============================================================
// 文件系统监听（实时同步）
// ============================================================
const activeWatchers = new Map();

ipcMain.handle('fs:watchStart', async (_event, projectPath) => {
    if (activeWatchers.has(projectPath)) return { success: true, already: true };
    try {
        const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__']);
        let debounceTimer = null;

        const watcher = fs.watch(projectPath, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const parts = filename.replace(/\\/g, '/').split('/');
            if (parts.some(p => SKIP.has(p))) return;

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('fs:changed', {
                        projectPath,
                        eventType,
                        filename: filename.replace(/\\/g, '/'),
                    });
                }
            }, 300);
        });

        activeWatchers.set(projectPath, watcher);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('fs:watchStop', async (_event, projectPath) => {
    const watcher = activeWatchers.get(projectPath);
    if (watcher) {
        watcher.close();
        activeWatchers.delete(projectPath);
    }
    return { success: true };
});

// ============================================================
// Linter 集成
// ============================================================
ipcMain.handle('linter:run', async (_event, projectPath, targetFiles, options) => {
    try {
        const { getLinterErrors } = require('./src/core/linter-runner');
        return await getLinterErrors(projectPath, targetFiles, options || {});
    } catch (e) {
        return { success: false, diagnostics: [], error: e.message };
    }
});

ipcMain.handle('linter:detect', async (_event, projectPath) => {
    try {
        const { detectAvailableEngines } = require('./src/core/linter-runner');
        return { success: true, engines: detectAvailableEngines(projectPath) };
    } catch (e) {
        return { success: false, engines: ['builtin'], error: e.message };
    }
});

// ============================================================
// LLM 流式网关（SSE streaming）// ============================================================
const activeStreams = new Map();

ipcMain.on('llm:stream', (event, { modelId, messages, requestId }) => {
    const logTag = '[LLM:Stream]';
    const startTime = Date.now();

    (async () => {
        try {
            const models = loadModels();
            const model = models.find(m => m.id === modelId);
            if (!model) {
                event.reply('llm:stream-error', { requestId, error: 'Model config not found', code: 'E_MODEL_NOT_FOUND' });
                return;
            }
            if (!model.baseUrl || !model.modelName) {
                event.reply('llm:stream-error', { requestId, error: 'Model config incomplete', code: 'E_CONFIG_INCOMPLETE' });
                return;
            }

            const url = model.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
            const headers = {
                'Content-Type': 'application/json',
                ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
                ...(model.headers || {})
            };

            const body = {
                model: model.modelName,
                messages: messages.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.text || m.content || '' })),
                stream: true,
                ...(model.extraBody || {})
            };

            const REASONING_KEYWORDS = /reasoning|thinking|o1|o3|r1|deepseek-r/i;
            const isReasoning = model.isReasoningModel === true ||
                (model.isReasoningModel !== false && REASONING_KEYWORDS.test(model.modelName || ''));

            console.log(logTag, 'Stream start:', { url, model: model.modelName, requestId });

            const controller = new AbortController();
            activeStreams.set(requestId, controller);
            const timeout = setTimeout(() => controller.abort(), 120000);

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (fetchErr) {
                clearTimeout(timeout);
                activeStreams.delete(requestId);
                if (fetchErr.name === 'AbortError') {
                    event.reply('llm:stream-error', { requestId, error: '请求已取消或超时', code: 'E_ABORTED' });
                } else {
                    event.reply('llm:stream-error', { requestId, error: `Network error: ${fetchErr.message}`, code: 'E_NETWORK' });
                }
                return;
            }

            if (!response.ok) {
                clearTimeout(timeout);
                activeStreams.delete(requestId);
                let errorBody = '';
                try { errorBody = await response.text(); } catch (e) { }
                const statusMessages = {
                    401: 'Authentication failed (invalid or expired API key)',
                    403: '权限不足',
                    404: 'Endpoint not found (check baseUrl)',
                    429: '请求频率限制',
                    500: '模型服务内部错误',
                    502: '网关错误',
                    503: 'Service unavailable',
                };
                const msg = statusMessages[response.status] || `HTTP ${response.status}`;
                event.reply('llm:stream-error', { requestId, error: `${msg}\n${errorBody.substring(0, 200)}`, code: `E_HTTP_${response.status}` });
                return;
            }

            let fullContent = '';
            let fullReasoning = '';
            let buffer = '';

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    try {
                        const parsed = JSON.parse(trimmed.slice(6));
                        const delta = parsed.choices?.[0]?.delta;
                        if (!delta) continue;

                        if (delta.content) {
                            fullContent += delta.content;
                            event.reply('llm:stream-chunk', {
                                requestId,
                                content: delta.content,
                                fullContent,
                                isReasoning
                            });
                        }
                        if (delta.reasoning_content) {
                            fullReasoning += delta.reasoning_content;
                            event.reply('llm:stream-chunk', {
                                requestId,
                                reasoning: delta.reasoning_content,
                                fullReasoning,
                                isReasoning: true
                            });
                        }
                        // Tool Calling 支持
                        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                            event.reply('llm:stream-chunk', {
                                requestId,
                                toolCalls: delta.tool_calls,
                                isReasoning
                            });
                        }
                    } catch (e) { }
                }
            }

            clearTimeout(timeout);
            activeStreams.delete(requestId);
            const elapsed = Date.now() - startTime;

            console.log(logTag, 'Stream done:', { requestId, elapsed: `${elapsed}ms`, contentLen: fullContent.length, reasoningLen: fullReasoning.length });

            event.reply('llm:stream-done', {
                requestId,
                content: fullContent,
                reasoning: fullReasoning,
                isReasoningModel: isReasoning || fullReasoning.length > 0,
                elapsed,
                model: model.modelName,
            });

        } catch (e) {
            activeStreams.delete(requestId);
            console.error(logTag, 'Unexpected error:', e.message);
            event.reply('llm:stream-error', { requestId, error: `未知错误：${e.message}`, code: 'E_UNKNOWN' });
        }
    })();
});

ipcMain.on('llm:stream-abort', (_event, { requestId }) => {
    const controller = activeStreams.get(requestId);
    if (controller) {
        console.log('[LLM:Stream] Abort:', requestId);
        controller.abort();
        activeStreams.delete(requestId);
    }
});
