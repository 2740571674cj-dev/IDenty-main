const systemBase = require('./system-base');
const modeAgent = require('./mode-agent');
const modeAsk = require('./mode-ask');
const modePlan = require('./mode-plan');
const modeDebug = require('./mode-debug');
const recoveryPrompt = require('./recovery-prompt');
let ruleLoader;
try { ruleLoader = require('../core/rule-loader'); } catch (_) {}

const MODE_PROMPTS = {
  agent: modeAgent,
  chat: modeAsk,
  ask: modeAsk,
  plan: modePlan,
  debug: modeDebug,
};

class PromptAssembler {
  assemble({ mode = 'agent', projectPath, openFiles, rules, dynamicContext, modelId }) {
    const layers = [];

    layers.push(systemBase);

    const modePrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.agent;
    layers.push(modePrompt);

    // Codex 模型专属 harness（参考 Cursor 官方博客 "Improving Cursor's agent for OpenAI Codex models"）
    if (modelId && /codex/i.test(modelId)) {
      layers.push(this._codexHarness());
    }

    if (dynamicContext) {
      layers.push(this._formatDynamicContext(dynamicContext));
    }

    if (mode === 'agent' || mode === 'debug') {
      layers.push(recoveryPrompt);
    }

    if (rules && rules.length > 0) {
      layers.push(this._formatRules(rules));
    }

    if (projectPath) {
      layers.push(`\n## Current Project\nProject root: ${projectPath}`);
    }

    return layers.join('\n\n---\n\n');
  }

  async assembleAsync({ mode = 'agent', projectPath, openFiles, rules, dynamicContext, modelId }) {
    let projectRules = rules || [];
    if (projectRules.length === 0 && projectPath && ruleLoader) {
      try {
        const loaded = await ruleLoader.loadProjectRules(projectPath);
        if (loaded.length > 0) {
          const formatted = ruleLoader.formatRulesForPrompt(loaded);
          if (formatted) projectRules = [formatted];
        }
      } catch (_) {}
    }
    return this.assemble({ mode, projectPath, openFiles, rules: projectRules, dynamicContext, modelId });
  }

  _formatDynamicContext(ctx) {
    const parts = ['## Current Context'];

    if (ctx.openFiles && ctx.openFiles.length > 0) {
      parts.push('### Open Files');
      for (const f of ctx.openFiles.slice(0, 5)) {
        parts.push(`- ${f.path}${f.cursorLine ? ` (cursor at line ${f.cursorLine})` : ''}`);
      }
    }

    if (ctx.linterErrors && ctx.linterErrors.length > 0) {
      parts.push('### Linter Errors');
      for (const e of ctx.linterErrors.slice(0, 15)) {
        const loc = `${e.file}:${e.line}${e.column > 1 ? ':' + e.column : ''}`;
        const source = e.source ? ` [${e.source}${e.ruleId ? '/' + e.ruleId : ''}]` : '';
        parts.push(`- ${e.severity === 'error' ? '❌' : '⚠️'} ${loc}: ${e.message}${source}`);
      }
    }

    if (ctx.recentlyEdited && ctx.recentlyEdited.length > 0) {
      parts.push('### Recently Edited Files');
      for (const f of ctx.recentlyEdited.slice(0, 5)) {
        parts.push(`- ${f.path}`);
      }
    }

    if (ctx.terminalOutput) {
      parts.push(`### Recent Terminal Output\n\`\`\`\n${ctx.terminalOutput.substring(0, 1000)}\n\`\`\``);
    }

    return parts.join('\n');
  }

  /**
   * Codex 模型专属 harness
   * 参考 Cursor 官方：https://cursor.com/blog/codex-model-harness
   */
  _codexHarness() {
    return `<codex_model_harness>
如果有专门的工具可以完成某个操作，优先使用工具而非 shell 命令（例如使用 read_file 而非 cat）。

编辑文件前必须先 read_file 读取，了解内容后再精确修改。可以一次调用多个独立的工具（并行探索）。

编辑文件后，必须使用 read_lints 检查 lint 错误。read_lints 支持 ESLint、Biome 和 TypeScript 编译器。只修复你引入的错误。

每个工具调用都填写 explanation 参数，简要说明调用原因。

推理摘要限制在1-2句话。避免评论自己的沟通方式。
</codex_model_harness>`;
  }

  _formatRules(rules) {
    const parts = ['## Project Rules'];
    for (const rule of rules) {
      parts.push(`- ${rule}`);
    }
    return parts.join('\n');
  }
}

module.exports = { PromptAssembler };
