const { ERROR_CODES, makeError } = require('./error-codes');
const { validatePath, needsApproval } = require('./security-layer');

const TOOL_ALIASES = {
  'search_files': 'grep_search',
  'glob_search': 'file_search',
  'list_directory': 'list_dir',
};

class ToolExecutor {
  constructor() {
    this.registry = new Map();
  }

  register(toolDef) {
    if (!toolDef.name || !toolDef.handler) {
      throw new Error(`Invalid tool definition: missing name or handler`);
    }
    this.registry.set(toolDef.name, toolDef);
  }

  getDefinitions() {
    return Array.from(this.registry.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  getTool(name) {
    return this.registry.get(name) || this.registry.get(TOOL_ALIASES[name]);
  }

  async execute(name, args, projectPath, context = {}) {
    const tool = this.registry.get(name) || this.registry.get(TOOL_ALIASES[name]);
    if (!tool) {
      return makeError(ERROR_CODES.TOOL_NOT_FOUND, name);
    }

    const requiredParams = tool.parameters?.required || [];
    for (const param of requiredParams) {
      if (args[param] === undefined || args[param] === null) {
        return makeError(ERROR_CODES.INVALID_PARAMS, `Missing required parameter: ${param}`);
      }
    }

    const timeout = tool.timeout || 30000;
    try {
      const result = await Promise.race([
        tool.handler(args, projectPath, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TOOL_TIMEOUT')), timeout)
        ),
      ]);
      return result;
    } catch (err) {
      if (err.message === 'TOOL_TIMEOUT') {
        return makeError(ERROR_CODES.TOOL_TIMEOUT, `${name} exceeded ${timeout}ms`);
      }
      return { success: false, error: err.message, code: 'E_TOOL_EXEC' };
    }
  }
}

module.exports = { ToolExecutor };
