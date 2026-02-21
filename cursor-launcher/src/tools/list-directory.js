const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

module.exports = {
  name: 'list_dir',
  description: `List the contents of a directory. The quick tool to use for discovery, before using more targeted tools like semantic search or file reading. Useful to try to understand the file structure before diving deeper into specific files.`,
  parameters: {
    type: 'object',
    properties: {
      relative_workspace_path: { type: 'string', description: 'Path to list contents of, relative to the workspace root. Use "./" for root.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: [],
  },
  riskLevel: 'safe',
  timeout: 5000,

  async handler(args, projectPath) {
    const inputPath = args.relative_workspace_path || args.path;
    const dirPath = inputPath
      ? path.resolve(projectPath, inputPath)
      : projectPath;

    if (args.path) {
      const check = validatePath(args.path, projectPath);
      if (!check.valid) return check;
    }

    if (!fs.existsSync(dirPath)) {
      return { success: false, error: `Directory not found: ${args.path || '.'}`, code: 'E_DIR_NOT_FOUND' };
    }

    if (!fs.statSync(dirPath).isDirectory()) {
      return { success: false, error: 'Path is a file, not a directory', code: 'E_NOT_DIRECTORY' };
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const listing = items.map(i => `${i.type === 'directory' ? '📁' : '📄'} ${i.name}`).join('\n');

      return { success: true, entries: items, listing, total: items.length };
    } catch (err) {
      return { success: false, error: `Failed to list directory: ${err.message}`, code: 'E_LIST_FAILED' };
    }
  },
};
