const { ToolExecutor } = require('../core/tool-executor');

function createToolExecutor() {
  const executor = new ToolExecutor();

  const tools = [
    require('./read-file'),
    require('./write-file'),
    require('./edit-file'),
    require('./delete-file'),
    require('./run-terminal-cmd'),
    require('./search-files'),
    require('./glob-search'),
    require('./list-directory'),
  ];

  try { tools.push(require('./todo-manager')); } catch (_) {}
  try { tools.push(require('./task-delegation')); } catch (_) {}
  try { tools.push(require('./web-search')); } catch (_) {}
  try { tools.push(require('./web-fetch')); } catch (_) {}
  try { tools.push(require('./browser-use')); } catch (_) {}
  try { tools.push(require('./generate-image')); } catch (_) {}
  try { tools.push(require('./git-operations')); } catch (_) {}
  try { tools.push(require('./read-lints')); } catch (_) {}
  try { tools.push(require('./diff-history')); } catch (_) {}
  try { tools.push(require('./reapply')); } catch (_) {}

  for (const tool of tools) {
    executor.register(tool);
  }

  return executor;
}

module.exports = { createToolExecutor };
