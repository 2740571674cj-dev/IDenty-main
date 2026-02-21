const { TokenCounter } = require('./token-counter');
const { DynamicContextProvider } = require('./dynamic-context-provider');

class ContextEngine {
  constructor() {
    this.tokenCounter = new TokenCounter();
    this.contextProvider = new DynamicContextProvider();
  }

  async buildContext({ projectPath, openFiles, recentlyEdited, linterErrors, terminalOutput, maxTokens = 8000 }) {
    return this.contextProvider.gather({
      projectPath,
      openFiles,
      recentlyEdited,
      linterErrors,
      terminalOutput,
      maxTokens,
    });
  }

  computeBudget({ modelMaxTokens = 128000, systemPromptTokens = 4000, toolDefsTokens = 3000, responseReserve = 4096 }) {
    const available = modelMaxTokens - systemPromptTokens - toolDefsTokens - responseReserve;
    return {
      totalBudget: modelMaxTokens,
      systemReserve: systemPromptTokens,
      toolDefsReserve: toolDefsTokens,
      responseReserve,
      historyBudget: Math.floor(available * 0.6),
      contextBudget: Math.floor(available * 0.4),
      available,
    };
  }

  compressHistory(messages, maxTokens) {
    const counter = this.tokenCounter;
    let currentTokens = counter.estimateMessages(messages);

    if (currentTokens <= maxTokens) return messages;

    const compressed = [...messages];
    const systemMsg = compressed[0]?.role === 'system' ? compressed.shift() : null;
    const lastUserMsg = compressed.length > 0 ? compressed.pop() : null;

    // Keep last N messages that fit the budget
    const kept = [];
    let keptTokens = 0;
    const reserveForSummary = 500;
    const effectiveMax = maxTokens - (systemMsg ? counter.estimateMessages([systemMsg]) : 0) - reserveForSummary;

    for (let i = compressed.length - 1; i >= 0; i--) {
      const msgTokens = counter.estimateMessages([compressed[i]]);
      if (keptTokens + msgTokens > effectiveMax) break;
      kept.unshift(compressed[i]);
      keptTokens += msgTokens;
    }

    const droppedCount = compressed.length - kept.length;
    const result = [];

    if (systemMsg) result.push(systemMsg);

    if (droppedCount > 0) {
      const dropped = compressed.slice(0, droppedCount);
      const summary = this._summarizeMessages(dropped);
      result.push({ role: 'system', content: `[Previous conversation summary (${droppedCount} messages compressed)]\n${summary}` });
    }

    result.push(...kept);
    if (lastUserMsg) result.push(lastUserMsg);

    return result;
  }

  _summarizeMessages(messages) {
    const parts = [];
    const filesRead = new Set();
    const filesEdited = new Set();
    let toolCallsMade = 0;

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallsMade++;
          try {
            const args = JSON.parse(tc.function.arguments);
            if (tc.function.name === 'read_file' && args.path) filesRead.add(args.path);
            if ((tc.function.name === 'edit_file' || tc.function.name === 'write_file') && args.path) filesEdited.add(args.path);
          } catch (_) {}
        }
      }
      if (msg.role === 'user' && msg.content) {
        parts.push(`User: ${msg.content.substring(0, 100)}...`);
      }
    }

    const summary = [];
    if (parts.length > 0) summary.push('Conversation topics: ' + parts.slice(0, 3).join('; '));
    if (filesRead.size > 0) summary.push('Files read: ' + Array.from(filesRead).join(', '));
    if (filesEdited.size > 0) summary.push('Files modified: ' + Array.from(filesEdited).join(', '));
    if (toolCallsMade > 0) summary.push(`Total tool calls: ${toolCallsMade}`);

    return summary.join('\n');
  }
}

module.exports = { ContextEngine };
