module.exports = {
  name: 'task',
  description: `Launch a sub-agent to handle a complex sub-task autonomously. The sub-agent runs with its own context window and can use all tools. Use when:
- You need to explore a large codebase to gather context
- A task can be broken into independent parallel sub-tasks
- The sub-task requires deep investigation that would fill your context
Do NOT use for simple operations — use the other tools directly.`,
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short (3-5 word) description of the sub-task.',
      },
      prompt: {
        type: 'string',
        description: 'Detailed instructions for the sub-agent. Include all context needed since it cannot see the parent conversation.',
      },
      model: {
        type: 'string',
        enum: ['default', 'fast'],
        description: 'Model to use. "fast" for quick tasks, "default" for complex ones.',
      },
      readonly: {
        type: 'boolean',
        description: 'If true, sub-agent can only read files and search, not modify anything.',
      },
    },
    required: ['description', 'prompt'],
  },
  riskLevel: 'medium',
  timeout: 300000,

  async handler(args, projectPath, context) {
    const { agentLoopFactory, modelId } = context || {};

    if (!agentLoopFactory) {
      return { success: false, error: 'Sub-agent system not available', code: 'E_NO_FACTORY' };
    }

    const subAgent = agentLoopFactory.create({
      projectPath,
      modelId: modelId,
      maxIterations: 15,
      readonly: args.readonly || false,
    });

    try {
      const result = await subAgent.run(args.prompt);
      return {
        success: result.success,
        content: result.finalContent || '',
        iterations: result.iteration,
        toolsUsed: result.toolCallCount,
        error: result.error,
      };
    } catch (err) {
      return { success: false, error: `Sub-agent failed: ${err.message}` };
    } finally {
      subAgent.destroy();
    }
  },
};
