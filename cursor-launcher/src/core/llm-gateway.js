const { AgentTracer } = require('./agent-tracer');

class LLMGateway {
  constructor({ loadModels }) {
    this.loadModels = loadModels;
  }

  async streamChat({ modelId, messages, tools, toolChoice, onChunk, onDone, onError, signal }) {
    const models = this.loadModels();
    const model = models.find(m => m.id === modelId);
    if (!model) {
      onError({ error: 'Model not found', code: 'E_MODEL_NOT_FOUND' });
      return;
    }

    const url = model.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
      ...(model.headers || {}),
    };

    const body = {
      model: model.modelName,
      messages: messages.map(m => {
        const msg = { role: m.role === 'ai' ? 'assistant' : m.role };
        if (m.content !== undefined) msg.content = m.content;
        if (m.text !== undefined && msg.content === undefined) msg.content = m.text;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m._reasoning) msg._reasoning = m._reasoning;
        if (msg.content === undefined) msg.content = '';
        return msg;
      }),
      stream: true,
      ...(model.extraBody || {}),
    };

    // Codex 模型：低温减少随机性 + 禁用并行工具调用，提升 Agent 链路稳定性
    const isCodex = /codex/i.test(model.modelName || '') || /codex/i.test(modelId || '');
    if (isCodex) {
      if (body.temperature === undefined) body.temperature = 0.2;
      body.parallel_tool_calls = false;
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (toolChoice) {
        body.tool_choice = toolChoice;
      }
    }

    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);
      if (signal) signal.addEventListener('abort', () => controller.abort());

      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      if (err.name === 'AbortError') {
        onError({ error: 'Request aborted or timed out', code: 'E_ABORTED' });
      } else {
        onError({ error: `Network error: ${err.message}`, code: 'E_NETWORK' });
      }
      return;
    }

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch (_) { }
      onError({ error: `HTTP ${response.status}: ${errBody.substring(0, 300)}`, code: `E_HTTP_${response.status}` });
      return;
    }

    let fullContent = '';
    let fullReasoning = '';
    const toolCallAccumulator = {};
    let buffer = '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
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
            const finishReason = parsed.choices?.[0]?.finish_reason;
            if (!delta && !finishReason) continue;

            if (delta?.content) {
              fullContent += delta.content;
              onChunk({ type: 'content', content: delta.content, fullContent });
            }

            if (delta?.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              onChunk({ type: 'reasoning', content: delta.reasoning_content, fullReasoning });
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulator[idx]) {
                  toolCallAccumulator[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) toolCallAccumulator[idx].id = tc.id;
                if (tc.function?.name) toolCallAccumulator[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCallAccumulator[idx].function.arguments += tc.function.arguments;

                onChunk({
                  type: 'tool_call_delta',
                  index: idx,
                  toolCall: { ...toolCallAccumulator[idx] },
                });
              }
            }

            if (finishReason) {
              onChunk({ type: 'finish', finishReason });
            }
          } catch (_) { }
        }
      }
    } catch (readErr) {
      onError({ error: `Stream read error: ${readErr.message}`, code: 'E_STREAM' });
      return;
    }

    const toolCalls = Object.values(toolCallAccumulator);
    onDone({
      content: fullContent,
      reasoning: fullReasoning,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      model: model.modelName,
    });
  }
}

module.exports = { LLMGateway };
