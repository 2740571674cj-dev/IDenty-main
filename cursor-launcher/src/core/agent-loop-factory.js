const { AgentLoopController } = require('./agent-loop-controller');
const { ToolExecutor } = require('./tool-executor');

class AgentLoopFactory {
  constructor({ llmGateway, toolExecutor, promptAssembler, contextEngine, securityLayer }) {
    this.deps = { llmGateway, toolExecutor, promptAssembler, contextEngine, securityLayer };
  }

  create({ projectPath, modelId, maxIterations, readonly, emitter }) {
    const toolExec = readonly
      ? this._createReadonlyExecutor()
      : this.deps.toolExecutor;

    const agent = new AgentLoopController({
      llmGateway: this.deps.llmGateway,
      toolExecutor: toolExec,
      promptAssembler: this.deps.promptAssembler,
      contextEngine: this.deps.contextEngine,
      config: {
        maxIterations: maxIterations || 15,
        maxTokenBudget: 64000,
        responseTokenReserve: 2048,
      },
    });

    if (emitter) agent.setEmitter(emitter);
    agent.projectPath = projectPath;
    agent.modelId = modelId;

    return {
      async run(prompt) {
        return agent.start({
          sessionId: `sub_${Date.now()}`,
          modelId,
          userMessage: prompt,
          projectPath,
          mode: 'agent',
          autoApprove: true,
        });
      },
      cancel() { agent.cancel(); },
      destroy() { agent.destroy(); },
    };
  }

  _createReadonlyExecutor() {
    const readonlyTools = ['read_file', 'search_files', 'glob_search', 'list_directory'];
    const filtered = new ToolExecutor();
    for (const name of readonlyTools) {
      const tool = this.deps.toolExecutor.getTool(name);
      if (tool) filtered.register(tool);
    }
    return filtered;
  }
}

module.exports = { AgentLoopFactory };
