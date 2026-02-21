import React, { useState, useRef, useEffect } from 'react';
import { CheckCircle2, Circle, Loader2, XCircle, ChevronDown, ChevronRight, ListChecks } from 'lucide-react';

const STATUS_CFG = {
  pending:     { icon: Circle,       color: '#52525b' },
  in_progress: { icon: Loader2,      color: '#60a5fa', spin: true },
  completed:   { icon: CheckCircle2, color: '#4ade80' },
  cancelled:   { icon: XCircle,      color: '#3f3f46' },
};

function TodoItem({ todo }) {
  const cfg = STATUS_CFG[todo.status] || STATUS_CFG.pending;
  const Icon = cfg.icon;
  const isDone = todo.status === 'completed';
  const isCancelled = todo.status === 'cancelled';

  return (
    <div className={`flex items-center gap-2.5 py-[5px] ${isCancelled ? 'opacity-30' : ''}`}>
      <Icon
        size={17}
        className={cfg.spin ? 'animate-spin' : ''}
        style={{ color: cfg.color, flexShrink: 0 }}
      />
      <span
        className={`text-[13px] leading-snug ${
          isDone ? 'text-zinc-500 line-through' :
          isCancelled ? 'text-zinc-600 line-through' :
          'text-zinc-300'
        }`}
      >
        {todo.content}
      </span>
    </div>
  );
}

function ProgressBar({ percent, allDone }) {
  return (
    <div className="h-[3px] rounded-full bg-zinc-800/70 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{
          width: `${percent}%`,
          background: allDone
            ? 'linear-gradient(90deg, #4ade80, #22c55e)'
            : 'linear-gradient(90deg, #818cf8, #4ade80)',
        }}
      />
    </div>
  );
}

// 完整 TodoPanel（内联显示在 todo_write 调用位置）
export default function TodoPanel({ todos = [] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const allDone = completed === total && total > 0;

  return (
    <div className="my-2 todo-panel-anchor">
      <div
        className="flex items-center gap-1.5 cursor-pointer py-0.5 select-none group"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed
          ? <ChevronRight size={16} className="text-zinc-500 group-hover:text-zinc-400 transition-colors" />
          : <ChevronDown size={16} className="text-zinc-500 group-hover:text-zinc-400 transition-colors" />
        }
        <span className="text-[13px] font-medium text-zinc-300">执行计划</span>
        <span className="text-[13px] text-zinc-500">({completed}/{total})</span>
        <div className="flex-1" />
        <span className={`text-[13px] tabular-nums ${allDone ? 'text-green-400' : 'text-zinc-500'}`}>
          {percent}%
        </span>
      </div>
      <ProgressBar percent={percent} allDone={allDone} />
      {!collapsed && (
        <div className="pl-1.5 pt-1 pb-0.5">
          {todos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
}

// 悬浮 Sticky 进度条（滚动离开后显示，悬停展开完整列表）
export function StickyTodoTracker({ todos = [] }) {
  const [hovered, setHovered] = useState(false);
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const allDone = completed === total && total > 0;

  return (
    <div
      className="sticky top-0 z-20 backdrop-blur-md bg-zinc-900/90 border-b border-zinc-800/50 -mx-1 px-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 紧凑进度行 */}
      <div className="flex items-center gap-2 py-1.5 px-1 cursor-pointer">
        <ListChecks size={14} className={allDone ? 'text-green-400' : 'text-blue-400'} />
        <span className="text-[12px] text-zinc-400">执行计划</span>
        <span className="text-[12px] text-zinc-500">({completed}/{total})</span>
        <div className="flex-1">
          <ProgressBar percent={percent} allDone={allDone} />
        </div>
        <span className={`text-[12px] tabular-nums ${allDone ? 'text-green-400' : 'text-zinc-500'}`}>
          {percent}%
        </span>
      </div>

      {/* 悬停展开完整列表 */}
      {hovered && (
        <div className="pb-2 px-1 max-h-[200px] overflow-y-auto border-t border-zinc-800/40 mt-0.5">
          {todos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
}

// 方案评估卡片
export function PlanEvaluationCard({ evaluationText }) {
  const [expanded, setExpanded] = useState(true);
  if (!evaluationText || !evaluationText.trim()) return null;

  return (
    <div className="my-2 rounded-lg border border-indigo-800/30 bg-indigo-950/15 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <ChevronDown size={14} className="text-indigo-400" />
          : <ChevronRight size={14} className="text-indigo-400" />
        }
        <span className="text-[13px] font-medium text-indigo-300">方案评估</span>
      </div>
      {expanded && (
        <div className="px-3 pb-2 text-[12px] text-zinc-400 leading-relaxed">
          {evaluationText}
        </div>
      )}
    </div>
  );
}
