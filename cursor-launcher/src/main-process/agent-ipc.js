const { ipcMain } = require('electron');
const { AgentLoopController } = require('../core/agent-loop-controller');
const { LLMGateway } = require('../core/llm-gateway');
const { createToolExecutor } = require('../tools/index');
const { PromptAssembler } = require('../prompts/prompt-assembler');
const { ContextEngine } = require('../core/context-engine');
const { AgentLoopFactory } = require('../core/agent-loop-factory');
const { TodoStore } = require('../core/todo-store');
const { WorkflowStore } = require('../core/workflow-store');
const { SessionMemoryStore } = require('../core/session-memory-store');
const path = require('path');
const { app } = require('electron');

let activeAgents = new Map();

function setupAgentIPC({ loadModels, mainWindow }) {
  const llmGateway = new LLMGateway({ loadModels });
  const toolExecutor = createToolExecutor();
  const promptAssembler = new PromptAssembler();
  const contextEngine = new ContextEngine();
  const todoStore = new TodoStore();
  const wfStorePath = path.join(app.getPath('userData'), 'workflows.json');
  const workflowStore = new WorkflowStore(wfStorePath);
  const memoryBaseDir = path.join(app.getPath('userData'), 'session-memory');
  const sessionMemoryStore = new SessionMemoryStore(memoryBaseDir);

  const agentLoopFactory = new AgentLoopFactory({
    llmGateway,
    toolExecutor,
    promptAssembler,
    contextEngine,
  });

  // 当 TodoStore 变更时通知渲染进程
  todoStore.subscribe((todos) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:todo-update', { todos });
    }
  });

  ipcMain.handle('agent:start', async (_event, params) => {
    const { sessionId, chatSessionId, modelId, userMessage, projectPath, mode, openFiles, autoApprove, webSearchEnabled, evalPassScore, compressThreshold } = params;

    if (activeAgents.has(sessionId)) {
      activeAgents.get(sessionId).cancel();
    }

    todoStore.reset();

    // 加载会话记忆并注入到 userMessage 中
    let enrichedMessage = userMessage;
    const memorySessionId = chatSessionId || sessionId;
    try {
      const memoryContext = sessionMemoryStore.formatForPrompt(memorySessionId);
      if (memoryContext) {
        enrichedMessage = `${memoryContext}\n\n---\n\n${userMessage}`;
      }
    } catch (e) {
      console.error('[AgentIPC] Load session memory failed:', e.message);
    }

    const agent = new AgentLoopController({
      llmGateway,
      toolExecutor,
      promptAssembler,
      contextEngine,
      config: {
        maxIterations: 60,
        agentLoopFactory,
        todoStore,
        evalPassScore: typeof evalPassScore === 'number' ? evalPassScore : 75,
        compressThreshold: typeof compressThreshold === 'number' ? compressThreshold : 60,
        workflowMatcher: async (userMsg) => {
          const wf = workflowStore.matchWorkflow(userMsg);
          if (!wf) return null;
          const steps = workflowStore.getActiveSteps(wf.id);
          return { id: wf.id, name: wf.name, description: wf.description, steps };
        },
      },
    });

    agent.setEmitter((event, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`agent:${event}`, data);
      }
    });

    activeAgents.set(sessionId, agent);

    try {
      const result = await agent.start({
        sessionId, modelId, userMessage: enrichedMessage, projectPath,
        mode: mode || 'agent',
        openFiles: openFiles || [],
        autoApprove: autoApprove || false,
        webSearchEnabled: webSearchEnabled || false,
        evalPassScore: typeof evalPassScore === 'number' ? evalPassScore : 75,
        compressThreshold: typeof compressThreshold === 'number' ? compressThreshold : 60,
      });

      // Agent 完成后，更新会话记忆
      try {
        const todos = todoStore.get();
        const completedTasks = todos.filter(t => t.status === 'completed').map(t => t.content);
        const pendingIssues = todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').map(t => t.content);

        // 从 agent 消息中提取文件变更
        const fileChanges = new Set();
        for (const msg of (agent.messages || [])) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (['write_file', 'edit_file', 'create_file', 'delete_file'].includes(tc.function?.name)) {
                try {
                  const args = JSON.parse(tc.function.arguments);
                  if (args.path || args.file_path) fileChanges.add(args.path || args.file_path);
                } catch (_) {}
              }
            }
          }
        }

        // 提取关键发现（assistant 的纯文本回复中前几条有实质内容的）
        const keyFindings = [];
        for (const msg of (agent.messages || [])) {
          if (msg.role === 'assistant' && msg.content && !msg.tool_calls && msg.content.length > 30) {
            keyFindings.push(msg.content.substring(0, 200));
            if (keyFindings.length >= 3) break;
          }
        }

        // 提取原始用户请求（去除记忆前缀）
        const rawRequest = (userMessage || '').replace(/\[会话记忆\][\s\S]*?---\s*\n\n/, '').substring(0, 500);

        sessionMemoryStore.appendExecution(memorySessionId, {
          userRequest: rawRequest,
          completedTasks,
          fileChanges: [...fileChanges],
          keyFindings,
          pendingIssues,
        });
      } catch (e) {
        console.error('[AgentIPC] Update session memory failed:', e.message);
      }

      return result;
    } finally {
      activeAgents.delete(sessionId);
    }
  });

  ipcMain.handle('agent:cancel', async (_event, sessionId) => {
    const agent = activeAgents.get(sessionId);
    if (agent) {
      agent.cancel();
      activeAgents.delete(sessionId);
      return { success: true };
    }
    return { success: false, error: 'No active agent for this session' };
  });

  ipcMain.on('agent:approve', (_event, { sessionId, toolCallId, approved }) => {
    const agent = activeAgents.get(sessionId);
    if (agent) {
      agent.handleApproval(toolCallId, approved);
    }
  });
}

module.exports = { setupAgentIPC };
