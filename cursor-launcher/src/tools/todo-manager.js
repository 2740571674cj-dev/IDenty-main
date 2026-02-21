module.exports = {
  name: 'todo_write',
  description: `Create or update a structured task list. Use to track progress on multi-step operations. Each todo has: id, content, status (pending/in_progress/completed/cancelled). Set merge=true to update existing todos; merge=false to replace all.`,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier.' },
            content: { type: 'string', description: 'Task description.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
          required: ['id', 'content', 'status'],
        },
        description: 'Array of TODO items.',
      },
      merge: {
        type: 'boolean',
        description: 'If true, merge with existing todos by id. If false, replace all.',
      },
    },
    required: ['todos', 'merge'],
  },
  riskLevel: 'safe',
  timeout: 1000,

  async handler(args, projectPath, context) {
    const { todoStore } = context || {};
    if (!todoStore) {
      return { success: true, note: 'TodoStore not available — todos recorded but not persisted to UI' };
    }

    if (args.merge) {
      const existing = todoStore.get();
      const warnings = [];
      for (const newTodo of args.todos) {
        const idx = existing.findIndex(t => t.id === newTodo.id);
        if (idx >= 0) {
          const oldStatus = existing[idx].status;
          const newStatus = newTodo.status;
          // 状态跃迁保护
          if (oldStatus === 'completed' && (newStatus === 'pending' || newStatus === 'in_progress')) {
            warnings.push(`[${newTodo.id}] completed → ${newStatus} 非法回退，已忽略状态变更`);
            existing[idx] = { ...existing[idx], ...newTodo, status: oldStatus }; // 保持原状态
            continue;
          }
          if (oldStatus === 'pending' && newStatus === 'completed') {
            warnings.push(`[${newTodo.id}] pending → completed 跳过了 in_progress`);
          }
          existing[idx] = { ...existing[idx], ...newTodo };
        } else {
          existing.push(newTodo);
        }
      }
      todoStore.set(existing);
      const progress = todoStore.getProgress();
      return { success: true, count: progress.total, completed: progress.completed, percent: progress.percent, ...(warnings.length > 0 ? { warnings } : {}) };
    } else {
      todoStore.set(args.todos);
    }

    const progress = todoStore.getProgress();
    return { success: true, count: progress.total, completed: progress.completed, percent: progress.percent };
  },
};
