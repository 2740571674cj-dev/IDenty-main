import React from 'react';
import { Loader2, Check, X, Pause, StopCircle, Brain } from 'lucide-react';

const STATE_CONFIG = {
  idle: { icon: null, label: '', color: '' },
  planning: { icon: Brain, label: '规划中...', color: 'text-purple-400' },
  calling_llm: { icon: Loader2, label: '思考中...', color: 'text-blue-400', spin: true },
  executing_tools: { icon: Loader2, label: '执行工具...', color: 'text-cyan-400', spin: true },
  awaiting_approval: { icon: Pause, label: '等待确认', color: 'text-yellow-400' },
  reflecting: { icon: Brain, label: '反思中...', color: 'text-purple-400' },
  complete: { icon: Check, label: '完成', color: 'text-green-400' },
  failed: { icon: X, label: '失败', color: 'text-red-400' },
  cancelled: { icon: StopCircle, label: '已取消', color: 'text-zinc-400' },
};

export default function AgentStatusBar({ state, iteration, toolCallCount, onCancel }) {
  const config = STATE_CONFIG[state] || STATE_CONFIG.idle;
  if (!config.icon) return null;

  const Icon = config.icon;
  const isActive = ['planning', 'calling_llm', 'executing_tools', 'awaiting_approval', 'reflecting'].includes(state);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/80 border-t border-zinc-800 text-xs">
      <Icon size={14} className={`${config.color} ${config.spin ? 'animate-spin' : ''}`} />
      <span className={config.color}>{config.label}</span>

      {iteration > 0 && (
        <span className="text-zinc-600">
          · 迭代 {iteration}
        </span>
      )}
      {toolCallCount > 0 && (
        <span className="text-zinc-600">
          · {toolCallCount} 次工具调用
        </span>
      )}

      <div className="flex-1" />

      {isActive && onCancel && (
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-red-950/30 transition-colors"
        >
          <StopCircle size={12} />
          取消
        </button>
      )}
    </div>
  );
}
