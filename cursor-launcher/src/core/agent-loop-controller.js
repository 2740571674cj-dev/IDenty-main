const { AgentTracer } = require('./agent-tracer');
const { ERROR_CODES, makeError } = require('./error-codes');
const { needsApproval } = require('./security-layer');

const STATES = {
  IDLE: 'idle',
  PLANNING: 'planning',
  CALLING_LLM: 'calling_llm',
  EXECUTING_TOOLS: 'executing_tools',
  AWAITING_APPROVAL: 'awaiting_approval',
  REFLECTING: 'reflecting',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const STATE_LABELS = {
  [STATES.PLANNING]: 'Planning next moves',
  [STATES.CALLING_LLM]: 'Thinking...',
  [STATES.EXECUTING_TOOLS]: 'Running tools...',
  [STATES.AWAITING_APPROVAL]: 'Waiting for approval...',
  [STATES.REFLECTING]: 'Reviewing changes...',
  [STATES.COMPLETE]: 'Task complete',
  [STATES.FAILED]: 'Task failed',
  [STATES.CANCELLED]: 'Task cancelled',
};

class AgentLoopController {
  constructor({ llmGateway, toolExecutor, promptAssembler, contextEngine, config = {} }) {
    this.llm = llmGateway;
    this.tools = toolExecutor;
    this.promptAssembler = promptAssembler;
    this.contextEngine = contextEngine;

    this.config = {
      maxIterations: config.maxIterations || 60,
      maxTokenBudget: config.maxTokenBudget || 128000,
      responseTokenReserve: config.responseTokenReserve || 4096,
      ...config,
    };

    this.state = STATES.IDLE;
    this.messages = [];
    this.iteration = 0;
    this.toolCallCount = 0;
    this.abortController = null;
    this.pendingApproval = null;
    this.tracer = null;
    this.emitter = null;
    this.sessionId = null;

    this._streamBuffer = '';
    this._lastFlushTime = 0;
    this._flushTimer = null;

    this._gateRetries = 0;
    this._maxGateRetries = Number(config.maxGateRetries) > 0 ? Number(config.maxGateRetries) : 5;
    this._lastNoToolContent = '';
    this._stallCount = 0;
    this._consecutiveNoToolRounds = 0;
    this._modifiedFiles = new Set(); // 追踪 agent 修改过的文件
    this._lintCheckPending = false;  // 是否有文件修改后尚未 lint 检查
  }

  setEmitter(emitter) {
    this.emitter = emitter;
  }

  _emit(event, data) {
    if (this.emitter) {
      this.emitter(event, { sessionId: this.sessionId, iteration: this.iteration, state: this.state, ...data });
    }
  }

  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    this._emit('state-change', { from: oldState, to: newState });
    const label = STATE_LABELS[newState];
    if (label) {
      this._emit('progress-note', { text: label });
    }
  }

  async start({ sessionId, modelId, userMessage, projectPath, mode = 'agent', openFiles = [], autoApprove = false, webSearchEnabled = false, evalPassScore, compressThreshold }) {
    this.sessionId = sessionId;
    this.tracer = new AgentTracer(sessionId);
    this.abortController = new AbortController();
    this.iteration = 0;
    this.toolCallCount = 0;
    this._gateRetries = 0;
    this._noToolRetries = 0;
    this._forceToolRequired = false;
    this.modelId = modelId;
    this.projectPath = projectPath;
    this.autoApprove = autoApprove;
    this.webSearchEnabled = webSearchEnabled;
    this.evalPassScore = typeof evalPassScore === 'number' ? evalPassScore : (this.config.evalPassScore || 75);
    this.compressThresholdPct = typeof compressThreshold === 'number' ? compressThreshold : (this.config.compressThreshold || 60);

    const span = this.tracer.startSpan('agent-loop');

    try {
      this._setState(STATES.PLANNING);

      let systemPrompt;
      if (this.promptAssembler?.assembleAsync) {
        systemPrompt = await this.promptAssembler.assembleAsync({ mode, projectPath, openFiles, modelId });
      } else if (this.promptAssembler) {
        systemPrompt = this.promptAssembler.assemble({ mode, projectPath, openFiles, modelId });
      } else {
        systemPrompt = this._defaultSystemPrompt(mode);
      }

      this.messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      // --- 工作流匹配 ---
      this._activeWorkflow = null;
      this._workflowStepStatus = [];
      try {
        const matched = await this._matchWorkflow(userMessage);
        if (matched && matched.steps && matched.steps.length > 0) {
          this._activeWorkflow = matched;
          this._workflowStepStatus = this._flattenSteps(matched.steps).map(s => ({
            id: s.id, title: s.title, depth: s.depth, status: 'pending'
          }));

          const stepsText = this._formatWorkflowSteps(matched.steps);
          this.messages.push({
            role: 'system',
            content: `[工作流已匹配] "${matched.name}"\n请严格按以下步骤顺序执行，每完成一步自行进入下一步：\n\n${stepsText}\n\n执行要求：\n- 必须按顺序逐步执行，不可跳步\n- 每个步骤完成后简短报告，然后继续\n- 工具调用正常进行，无需额外说明\n- 全部步骤完成后进行自检，然后输出结论`,
          });

          // 启动第一步
          if (this._workflowStepStatus.length > 0) {
            this._workflowStepStatus[0].status = 'in_progress';
          }

          this._emit('workflow-matched', {
            workflowId: matched.id,
            name: matched.name,
            steps: this._workflowStepStatus,
          });
        }
      } catch (e) {
        this.tracer?.warn('Workflow match failed: ' + e.message);
      }

      this._emit('started', { userMessage });

      await this._loop();

      span.end({ iterations: this.iteration, toolCalls: this.toolCallCount });

      if (this.state === STATES.CANCELLED) {
        return { success: false, error: 'Agent cancelled', iteration: this.iteration };
      }
      return { success: true, iteration: this.iteration, toolCallCount: this.toolCallCount, finalContent: this._getLastAssistantContent() };

    } catch (err) {
      span.end({ error: err.message });
      if (this.state !== STATES.CANCELLED) {
        this._setState(STATES.FAILED);
        this._emit('error', { error: err.message });
      }
      return { success: false, error: err.message, iteration: this.iteration };
    }
  }

  // 根据当前状态决定 tool_choice — Cursor 的核心做法
  _resolveToolChoice() {
    if (this._forceToolRequired) {
      this._forceToolRequired = false;
      return 'required';
    }
    return 'auto';
  }

  async _loop() {
    while (this.iteration < this.config.maxIterations) {
      if (this.abortController.signal.aborted) {
        this._setState(STATES.CANCELLED);
        return;
      }

      this.iteration++;
      this.tracer.info(`Iteration ${this.iteration} start`);

      // Cursor 风格迭代进度：每 5 轮或第 1 轮汇报
      if (this.iteration === 1 || this.iteration % 5 === 0) {
        const todoStore = this.config.todoStore;
        if (todoStore) {
          const p = todoStore.getProgress();
          if (p.total > 0 && this.iteration > 1) {
            this._emit('progress-note', { text: `Iteration ${this.iteration} — ${p.completed}/${p.total} tasks done` });
          }
        }
      }

      this._setState(STATES.CALLING_LLM);
      this._compressContextIfNeeded();

      const toolChoice = this._resolveToolChoice();
      const llmResult = await this._callLLM(toolChoice);

      if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
        this._consecutiveNoToolRounds++;

        if (llmResult.content) {
          this.messages.push({ role: 'assistant', content: llmResult.content });
        }

        // 停滞检测：连续纯文本且内容相似 → 注入 nudge 强制工具调用
        const cur = (llmResult.content || '').substring(0, 200);
        const prev = this._lastNoToolContent;
        if (prev && cur && cur.startsWith(prev.substring(0, 100))) {
          this._stallCount++;
        } else {
          this._stallCount = 0;
        }
        this._lastNoToolContent = cur;
        if (this._stallCount >= 2) {
          this._emit('progress-note', { text: '检测到文本停滞，强制工具调用...' });
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg?.role === 'assistant' && !lastMsg.tool_calls) this.messages.pop();
          this.messages.push({
            role: 'system',
            content: '你已连续输出相似文本但未调用工具。请立即使用工具继续执行任务。不要输出结论，先完成未做完的事。',
          });
          this._forceToolRequired = true;
          this._stallCount = 0;
          continue;
        }

        const todoStore = this.config.todoStore;
        const progress = todoStore ? todoStore.getProgress() : { pending: 0, inProgress: 0, total: 0, completed: 0 };
        const remaining = progress.pending + progress.inProgress;
        const hasPendingTodos = remaining > 0;

        // —— 核心防提前中止逻辑 ——
        // 还有未完成任务时，绝不允许模型输出结论
        if (hasPendingTodos) {
          this._noToolRetries++;

          // 移除模型的纯文本回复（可能是"伪结论"），不让它污染上下文
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
            this.messages.pop();
          }

          const pendingItems = todoStore.get()
            .filter(t => t.status === 'pending' || t.status === 'in_progress')
            .slice(0, 5)
            .map(t => `• ${t.content}`)
            .join('\n');

          if (this._noToolRetries <= 3) {
            this._emit('progress-note', {
              text: `还有 ${remaining} 项待完成，tool_choice=required 重试（${this._noToolRetries}/3）`,
            });
            this.messages.push({
              role: 'system',
              content: `任务尚未完成！以下事项仍待执行：\n${pendingItems}\n\n请立即使用工具继续执行，不要输出结论。`,
            });
            this._forceToolRequired = true;
          } else if (this._noToolRetries <= 6) {
            // 二次强化：如果 tool_choice=required 已重试 3 次还是不行，换策略
            this._emit('progress-note', {
              text: `强制重试第 ${this._noToolRetries} 轮，还剩 ${remaining} 项`,
            });
            this.messages.push({
              role: 'system',
              content: `你已多次未调用工具。请重新审视以下未完成任务，选择一个立即开始执行：\n${pendingItems}\n\n如果之前的方案行不通，请换一种方法。必须调用工具来推进。`,
            });
            this._forceToolRequired = true;
          } else {
            // 超过 6 次还是无法推进，放行到 gate 检查，但不直接 COMPLETE
            this._emit('progress-note', {
              text: `Tool retries exhausted (${this._noToolRetries}), entering gate check`,
            });
            // 不再 continue，让它走到下面的 gate 逻辑
          }

          if (this._noToolRetries <= 6) continue;
        }

        // —— 验收闸门 ——
        const gate = this._checkCompletionGate();
        if (!gate.pass) {
          this._gateRetries++;

          // 移除可能的"伪结论"
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
            this.messages.pop();
          }

          if (this._gateRetries <= this._maxGateRetries) {
            this._emit('progress-note', {
              text: `Gate check failed (${this._gateRetries}/${this._maxGateRetries}): ${gate.reasons.length} issue(s)`,
            });
            this.messages.push({
              role: 'system',
              content: `验收未通过，以下问题必须解决：\n${gate.reasons.map(r => `• ${r}`).join('\n')}\n\n请用工具修复。修不了就换方案，实在不行再在结论中说明。`,
            });
            // 重置 noToolRetries 让模型有新的机会调用工具
            this._noToolRetries = 0;
            this._forceToolRequired = true;
            continue;
          }

          // 超限：给最后一次机会输出带说明的结论
          this._emit('progress-note', {
            text: `Finalizing — gate retries exhausted (${this._maxGateRetries})`,
          });
          this.messages.push({
            role: 'system',
            content: `已多次尝试仍有遗留：${gate.reasons.join('；')}。请在最终结论中详细说明这些遗留项的原因和影响。`,
          });
          // 再跑一轮让它输出结论，但标记 gate 已超限
          this._gateRetries++;
          continue;
        }

        // 验收通过但 consecutiveNoToolRounds 过高（防止模型反复输出文字不干活就 pass 的边界情况）
        // 如果 todo 都完成了且 gate 通过 → 正常结束
        this._setState(STATES.COMPLETE);
        this._emit('complete', {
          content: llmResult.content,
          iterations: this.iteration,
        });
        return;
      }

      // 模型正常返回了工具调用 — 保留 reasoning traces（Codex 模型依赖此连续性）
      const assistantMsg = {
        role: 'assistant',
        content: llmResult.content || null,
        tool_calls: llmResult.toolCalls,
      };
      if (llmResult.reasoning) {
        assistantMsg._reasoning = llmResult.reasoning;
      }
      this.messages.push(assistantMsg);
      this._emit('tool-calls-received', { toolCalls: llmResult.toolCalls });

      this._setState(STATES.EXECUTING_TOOLS);
      const toolResults = await this._executeTools(llmResult.toolCalls);

      for (const result of toolResults) {
        let content = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        if (content.length > 8000) {
          const head = content.substring(0, 3500);
          const tail = content.substring(content.length - 1500);
          content = head + '\n\n... [内容过长，已截断中间部分] ...\n\n' + tail;
        }
        this.messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content,
        });
      }

      this._emit('tools-executed', { results: toolResults });
      this._noToolRetries = 0;
      this._stallCount = 0;
      this._lastNoToolContent = '';
      this._consecutiveNoToolRounds = 0;

      // Cursor 风格批次摘要：统计本轮探索和修改的文件
      const EXPLORE_NAMES = new Set(['read_file', 'grep_search', 'file_search', 'list_dir', 'list_directory', 'search_files', 'glob_search', 'read_lints']);
      const exploredCount = llmResult.toolCalls.filter(tc => EXPLORE_NAMES.has(tc.function?.name)).length;
      const editedCount = llmResult.toolCalls.filter(tc => ['write_file', 'edit_file', 'create_file'].includes(tc.function?.name)).length;
      if (exploredCount > 2) {
        this._emit('progress-note', { text: `Explored ${exploredCount} files` });
      }
      if (editedCount > 1) {
        this._emit('progress-note', { text: `Edited ${editedCount} files` });
      }

      // 追踪文件修改，为 lint 检查做准备
      const FILE_CHANGE_TOOL_NAMES = ['write_file', 'edit_file', 'create_file', 'reapply'];
      let hasNewFileChanges = false;
      for (const tc of llmResult.toolCalls) {
        if (FILE_CHANGE_TOOL_NAMES.includes(tc.function?.name)) {
          try {
            const tcArgs = JSON.parse(tc.function.arguments || '{}');
            const changedFile = tcArgs.path || tcArgs.file_path || tcArgs.target_file;
            if (changedFile) {
              this._modifiedFiles.add(changedFile);
              hasNewFileChanges = true;
            }
          } catch (_) {}
        }
      }

      // 如果本轮有文件修改且没有调用 read_lints → 标记需要 lint 检查
      const hasLintCall = llmResult.toolCalls.some(tc => tc.function?.name === 'read_lints');
      if (hasNewFileChanges && !hasLintCall) {
        this._lintCheckPending = true;
      }
      if (hasLintCall) {
        this._lintCheckPending = false;
      }

      // 工作流步骤自动推进
      this._tryAdvanceWorkflow(llmResult.content);

      this._setState(STATES.REFLECTING);
    }

    // 达到最大迭代次数
    this.tracer.warn('Max iterations reached, requesting final conclusion');

    // 收集 todo 进度信息放入结论提示
    const todoStore = this.config.todoStore;
    let todoStatus = '';
    if (todoStore) {
      const todos = todoStore.get();
      const progress = todoStore.getProgress();
      if (progress.total > 0) {
        const completed = todos.filter(t => t.status === 'completed').map(t => `✅ ${t.content}`);
        const remaining = todos.filter(t => t.status !== 'completed').map(t => `⬜ ${t.content}`);
        todoStatus = `\n\n已完成：\n${completed.join('\n') || '无'}\n未完成：\n${remaining.join('\n') || '全部完成'}`;
      }
    }

    this.messages.push({
      role: 'system',
      content: `已达到最大执行轮次（${this.config.maxIterations}轮）。请输出最终结论，详细说明已完成和未完成的工作。${todoStatus}`,
    });
    this._setState(STATES.CALLING_LLM);
    const finalResult = await this._callLLM('none');
    this._setState(STATES.COMPLETE);
    this._emit('complete', {
      content: finalResult.content,
      iterations: this.iteration,
      maxIterationsReached: true,
    });
  }

  // --- 上下文智能压缩 ---
  _compressContextIfNeeded() {
    const estimatedTokens = this._estimateTokenCount();
    const budget = this.config.maxTokenBudget - this.config.responseTokenReserve;

    const threshold = (this.compressThresholdPct || 60) / 100;
    if (estimatedTokens < budget * threshold) return;

    this._emit('progress-note', { text: `Summarized Chat context (~${Math.round(estimatedTokens / 1000)}k tokens)` });

    const systemMsg = this.messages[0];
    const userMsg = this.messages[1];

    // 找到所有系统级指令消息（工作流、上下文记忆等），这些必须保留
    const criticalSystemMsgs = [];
    const middle = [];
    for (let i = 2; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'system' && (
        msg.content?.includes('[工作流已匹配]') ||
        msg.content?.includes('[会话记忆]') ||
        msg.content?.includes('[上下文摘要]')
      )) {
        criticalSystemMsgs.push(msg);
      } else {
        middle.push(msg);
      }
    }

    if (middle.length < 6) return;

    // 保留最近 40% 的消息（至少 6 条，最多 15 条）
    const keepCount = Math.min(15, Math.max(6, Math.floor(middle.length * 0.4)));
    const toCompress = middle.slice(0, middle.length - keepCount);
    const toKeep = middle.slice(middle.length - keepCount);

    // 从被压缩的消息中提取关键信息
    const summaryParts = [];
    const fileChanges = new Set();
    const keyDecisions = [];

    for (const msg of toCompress) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name).filter(Boolean);
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (['write_file', 'edit_file', 'create_file', 'delete_file'].includes(name)) {
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args.path || args.file_path) fileChanges.add(args.path || args.file_path);
            } catch (_) {}
          }
        }
        if (msg.content && msg.content.length > 20) {
          keyDecisions.push(msg.content.substring(0, 200));
        }
      } else if (msg.role === 'assistant' && msg.content && msg.content.length > 50) {
        keyDecisions.push(msg.content.substring(0, 200));
      }
    }

    // 构建 todo 完整进度（这是最关键的上下文，不能丢失）
    const todoStore = this.config.todoStore;
    let todoDetail = '';
    if (todoStore) {
      const todos = todoStore.get();
      const progress = todoStore.getProgress();
      todoDetail = `\n\n当前任务清单（${progress.completed}/${progress.total} 完成）：\n`;
      for (const t of todos) {
        const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
        todoDetail += `${icon} ${t.content}\n`;
      }
    }

    const fileChangeList = fileChanges.size > 0 ? `\n已修改的文件：${[...fileChanges].join('、')}` : '';
    const decisionList = keyDecisions.length > 0
      ? `\n关键操作记录：\n${keyDecisions.slice(-5).map(d => `- ${d}`).join('\n')}`
      : '';

    const summaryMsg = {
      role: 'system',
      content: `[上下文摘要] 已压缩 ${toCompress.length} 条旧消息。${fileChangeList}${decisionList}${todoDetail}\n\n请继续执行清单中剩余未完成的任务，不要重复已完成的工作。`,
    };

    this.messages = [systemMsg, userMsg, ...criticalSystemMsgs, summaryMsg, ...toKeep];
    this._emit('progress-note', { text: `Summarized ${toCompress.length} messages, kept ${toKeep.length + criticalSystemMsgs.length}` });
  }

  _estimateTokenCount() {
    let chars = 0;
    for (const msg of this.messages) {
      if (msg.content) chars += msg.content.length;
      if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
    }
    return Math.ceil(chars / 3.5);
  }

  _flushStreamBuffer() {
    if (this._streamBuffer) {
      this._emit('stream-content', { content: this._streamBuffer, delta: true });
      this._streamBuffer = '';
    }
    this._lastFlushTime = Date.now();
    this._flushTimer = null;
  }

  async _callLLM(toolChoice = 'auto') {
    const span = this.tracer.startSpan('llm-call', { iteration: this.iteration, toolChoice });
    let toolDefs = this.tools.getDefinitions();
    if (!this.webSearchEnabled) {
      toolDefs = toolDefs.filter(t => t.name !== 'web_search' && t.name !== 'web_fetch');
    }

    const effectiveTools = toolDefs.length > 0 ? toolDefs : undefined;
    const effectiveToolChoice = effectiveTools ? toolChoice : undefined;

    return new Promise((resolve, reject) => {
      let result = { content: '', reasoning: '', toolCalls: null };

      this.llm.streamChat({
        modelId: this.modelId,
        messages: this.messages,
        tools: effectiveTools,
        toolChoice: effectiveToolChoice,
        signal: this.abortController.signal,
        onChunk: (chunk) => {
          if (chunk.type === 'content') {
            this._streamBuffer += chunk.content;
            const now = Date.now();
            if (now - this._lastFlushTime >= 100) {
              if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
              this._flushStreamBuffer();
            } else if (!this._flushTimer) {
              this._flushTimer = setTimeout(() => this._flushStreamBuffer(), 100 - (now - this._lastFlushTime));
            }
          } else if (chunk.type === 'reasoning') {
            this._emit('stream-reasoning', { content: chunk.content });
          } else if (chunk.type === 'tool_call_delta') {
            this._emit('tool-call-delta', { index: chunk.index, toolCall: chunk.toolCall });
          }
        },
        onDone: (data) => {
          if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
          this._flushStreamBuffer();

          result.content = data.content;
          result.reasoning = data.reasoning;
          result.toolCalls = data.toolCalls;
          span.end({ hasToolCalls: !!result.toolCalls });
          resolve(result);
        },
        onError: (err) => {
          if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
          this._flushStreamBuffer();
          span.end({ error: err.error });
          reject(new Error(err.error));
        },
      });
    });
  }

  async _executeTools(toolCalls) {
    const results = [];

    for (const tc of toolCalls) {
      if (this.abortController.signal.aborted) break;

      const toolName = tc.function.name;
      let args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e) {
        results.push({ toolCallId: tc.id, toolName, output: { success: false, error: 'Invalid JSON arguments', code: 'E_INVALID_JSON' } });
        continue;
      }

      const tool = this.tools.getTool(toolName);
      const riskLevel = tool?.riskLevel || 'medium';

      if (needsApproval(riskLevel, this.autoApprove)) {
        this._setState(STATES.AWAITING_APPROVAL);
        this._emit('approval-needed', { toolCallId: tc.id, toolName, args, riskLevel });

        const approved = await this._waitForApproval(tc.id);
        if (!approved) {
          results.push({ toolCallId: tc.id, toolName, output: makeError(ERROR_CODES.APPROVAL_DENIED) });
          continue;
        }
        this._setState(STATES.EXECUTING_TOOLS);
      }

      this._emit('tool-executing', { toolCallId: tc.id, toolName, args });
      const span = this.tracer.startSpan(`tool:${toolName}`, { args });
      const startTime = Date.now();

      let output;
      try {
        output = await this.tools.execute(toolName, args, this.projectPath, {
          agentLoopFactory: this.config.agentLoopFactory,
          modelId: this.modelId,
          todoStore: this.config.todoStore,
        });
      } catch (execErr) {
        output = { success: false, error: execErr.message || 'Tool execution crashed', code: 'E_TOOL_CRASH' };
      }

      const elapsed = Date.now() - startTime;
      span.end({ output: { success: output?.success }, elapsed });

      this.toolCallCount++;
      this._emit('tool-result', { toolCallId: tc.id, toolName, output, elapsed });
      results.push({ toolCallId: tc.id, toolName, output, elapsed });
    }

    return results;
  }

  _waitForApproval(toolCallId) {
    return new Promise((resolve) => {
      this.pendingApproval = { toolCallId, resolve };
      const timeout = setTimeout(() => {
        if (this.pendingApproval?.toolCallId === toolCallId) {
          this.pendingApproval = null;
          resolve(false);
        }
      }, 300000);
      this.pendingApproval.timeout = timeout;
    });
  }

  handleApproval(toolCallId, approved) {
    if (this.pendingApproval?.toolCallId === toolCallId) {
      clearTimeout(this.pendingApproval.timeout);
      this.pendingApproval.resolve(approved);
      this.pendingApproval = null;
    }
  }

  cancel() {
    this._setState(STATES.CANCELLED);
    if (this.abortController) this.abortController.abort();
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timeout);
      this.pendingApproval.resolve(false);
      this.pendingApproval = null;
    }
    this._emit('cancelled', {});
  }

  destroy() {
    this.cancel();
    this.messages = [];
    this.emitter = null;
  }

  _getLastAssistantContent() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant' && this.messages[i].content) {
        return this.messages[i].content;
      }
    }
    return '';
  }

  _checkCompletionGate() {
    const reasons = [];

    // 1. 检查 todo 清单完成度
    const todoStore = this.config.todoStore;
    if (todoStore) {
      const progress = todoStore.getProgress();
      const remaining = progress.pending + progress.inProgress;
      if (remaining > 0) {
        const pendingItems = todoStore.get()
          .filter(t => t.status === 'pending' || t.status === 'in_progress')
          .slice(0, 5)
          .map(t => t.content);
        reasons.push(`${remaining} 项计划未完成：${pendingItems.join('、')}`);
      }
    }

    // 2. 检查工具失败（前两轮 gate 检查时检测）
    if (this._gateRetries <= 1) {
      const lastToolCallIds = new Set();
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msg = this.messages[i];
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) lastToolCallIds.add(tc.id);
          break;
        }
      }
      let failedToolCount = 0;
      for (const msg of this.messages) {
        if (msg.role === 'tool' && lastToolCallIds.has(msg.tool_call_id)) {
          try {
            const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
            if (parsed && parsed.success === false) failedToolCount++;
          } catch (_) { }
        }
      }
      if (failedToolCount > 0) {
        reasons.push(`最近一轮有 ${failedToolCount} 个工具调用失败，请检查并处理`);
      }
    }

    // 3. 有文件变更但没做验证
    if (this._hasFileChanges()) {
      const VERIFY_TOOLS = ['run_terminal_cmd', 'read_file', 'grep_search', 'file_search', 'list_dir', 'read_lints',
                            'search_files', 'glob_search', 'list_directory'];
      let hasRecentVerify = false;
      const recent = this.messages.slice(-8);
      for (const msg of recent) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (VERIFY_TOOLS.includes(tc.function?.name)) hasRecentVerify = true;
          }
        }
      }
      if (!hasRecentVerify && this._gateRetries <= 1) {
        reasons.push('改完文件后还没做检查，请回读关键文件确认改动正确');
      }
    }

    // 4. 修改了文件但没有运行 lint 检查
    if (this._lintCheckPending && this._modifiedFiles.size > 0 && this._gateRetries <= 1) {
      const files = [...this._modifiedFiles].slice(0, 5).map(f => {
        const parts = f.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1];
      });
      reasons.push(`编辑了 ${this._modifiedFiles.size} 个文件但未运行 read_lints 检查，请先检查 ${files.join('、')} 等文件是否有 lint 错误`);
    }

    // 5. 检查迭代次数是否过少
    if (todoStore) {
      const progress = todoStore.getProgress();
      if (progress.total >= 3 && this.iteration < progress.total * 2 && progress.completed < progress.total && this._gateRetries === 0) {
        reasons.push(`任务清单有 ${progress.total} 项但仅执行了 ${this.iteration} 轮，请确认是否都已处理`);
      }
    }

    return { pass: reasons.length === 0, reasons };
  }

  _hasFileChanges() {
    return this._lastFileChangeIndex() >= 0;
  }

  _lastFileChangeIndex() {
    const FILE_CHANGE_TOOLS = ['write_file', 'edit_file', 'delete_file', 'create_file', 'reapply'];
    let lastIdx = -1;
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (FILE_CHANGE_TOOLS.includes(tc.function.name)) {
            lastIdx = i;
          }
        }
      }
    }
    return lastIdx;
  }

  _isCodex() {
    return this.modelId && /codex/i.test(this.modelId);
  }

  _defaultSystemPrompt(mode) {
    return `You are an AI coding assistant. You are in ${mode} mode. Help the user with their coding tasks. When you need to perform actions, use the available tools. Always respond in Simplified Chinese.`;
  }

  // --- 工作流匹配（通过 IPC 调用后端） ---
  async _matchWorkflow(userMessage) {
    if (typeof this.config.workflowMatcher === 'function') {
      return await this.config.workflowMatcher(userMessage);
    }
    return null;
  }

  _flattenSteps(steps, depth = 0) {
    const result = [];
    for (const s of steps) {
      result.push({ id: s.id, title: s.title, depth });
      if (s.subSteps && s.subSteps.length > 0) {
        result.push(...this._flattenSteps(s.subSteps, depth + 1));
      }
    }
    return result;
  }

  _formatWorkflowSteps(steps, depth = 0) {
    const lines = [];
    steps.forEach((s, i) => {
      const indent = '  '.repeat(depth);
      const prefix = depth === 0 ? `${i + 1}.` : `${i + 1})`;
      lines.push(`${indent}${prefix} ${s.title}`);
      if (s.subSteps && s.subSteps.length > 0) {
        lines.push(this._formatWorkflowSteps(s.subSteps, depth + 1));
      }
    });
    return lines.join('\n');
  }

  _tryAdvanceWorkflow(textContent) {
    if (!this._activeWorkflow || !this._workflowStepStatus) return;

    const current = this._workflowStepStatus.find(s => s.status === 'in_progress');
    if (!current) {
      // 无进行中步骤 → 启动下一个
      this.advanceWorkflow();
      return;
    }

    // 检测模型文本中是否包含当前步骤关键词 + 完成暗示
    const text = (textContent || '').toLowerCase();
    const stepTitle = (current.title || '').toLowerCase();
    const completionHints = ['完成', '已完成', '搞定', 'done', '✓', '✔', '已处理', '已执行', '已实现', '成功'];
    const stepKeywords = stepTitle.split(/\s+/).filter(w => w.length >= 2);

    const mentionsStep = stepKeywords.some(kw => text.includes(kw));
    const mentionsComplete = completionHints.some(h => text.includes(h));

    if (mentionsStep && mentionsComplete) {
      this.advanceWorkflow();
    }
  }

  // Agent 在执行过程中调用此方法更新工作流步骤状态
  updateWorkflowStep(stepId, status) {
    if (!this._workflowStepStatus) return;
    const step = this._workflowStepStatus.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      this._emit('workflow-step-update', {
        stepId,
        status,
        steps: this._workflowStepStatus,
      });
    }
  }

  // 按序推进工作流：完成当前步骤，标记下一步为进行中
  advanceWorkflow() {
    if (!this._workflowStepStatus || this._workflowStepStatus.length === 0) return null;

    const current = this._workflowStepStatus.find(s => s.status === 'in_progress');
    if (current) {
      current.status = 'completed';
    }

    const next = this._workflowStepStatus.find(s => s.status === 'pending');
    if (next) {
      next.status = 'in_progress';
      this._emit('workflow-step-update', { stepId: next.id, status: 'in_progress', steps: this._workflowStepStatus });
      return next;
    }

    this._emit('workflow-step-update', { stepId: null, status: 'all_complete', steps: this._workflowStepStatus });
    return null;
  }
}

module.exports = { AgentLoopController, STATES };
