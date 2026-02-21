const fs = require('fs');
const path = require('path');

class SessionMemoryStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  _sessionDir(sessionId) {
    const dir = path.join(this.baseDir, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  _summaryPath(sessionId) {
    return path.join(this._sessionDir(sessionId), 'summary.json');
  }

  /**
   * 获取会话记忆摘要
   * 返回 { background, keyDecisions, fileChanges, pendingIssues, progress, lastUpdated }
   */
  getSummary(sessionId) {
    try {
      const p = this._summaryPath(sessionId);
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch (_) {}
    return null;
  }

  /**
   * 保存/更新会话记忆摘要
   */
  saveSummary(sessionId, summary) {
    try {
      const p = this._summaryPath(sessionId);
      const data = {
        ...summary,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[SessionMemory] Save failed:', e.message);
      return false;
    }
  }

  /**
   * 追加一次执行记录到会话记忆
   */
  appendExecution(sessionId, { userRequest, completedTasks, fileChanges, keyFindings, pendingIssues }) {
    const existing = this.getSummary(sessionId) || {
      background: '',
      executions: [],
      cumulativeFileChanges: [],
      pendingIssues: [],
    };

    const execution = {
      timestamp: new Date().toISOString(),
      userRequest: (userRequest || '').substring(0, 500),
      completedTasks: completedTasks || [],
      fileChanges: fileChanges || [],
      keyFindings: keyFindings || [],
      pendingIssues: pendingIssues || [],
    };

    existing.executions = existing.executions || [];
    existing.executions.push(execution);

    // 限制历史记录最多保留 20 次执行
    if (existing.executions.length > 20) {
      existing.executions = existing.executions.slice(-20);
    }

    // 累积文件变更记录（去重）
    const allFiles = new Set(existing.cumulativeFileChanges || []);
    for (const f of (fileChanges || [])) allFiles.add(f);
    existing.cumulativeFileChanges = [...allFiles];

    // 更新待解决问题
    existing.pendingIssues = pendingIssues || existing.pendingIssues;

    this.saveSummary(sessionId, existing);
    return existing;
  }

  /**
   * 更新背景描述（通常由 AI 生成）
   */
  updateBackground(sessionId, background) {
    const existing = this.getSummary(sessionId) || {
      executions: [],
      cumulativeFileChanges: [],
      pendingIssues: [],
    };
    existing.background = background;
    this.saveSummary(sessionId, existing);
  }

  /**
   * 格式化为可注入 prompt 的文本
   */
  formatForPrompt(sessionId) {
    const summary = this.getSummary(sessionId);
    if (!summary) return '';

    const parts = ['[会话记忆] 以下是本次会话的历史上下文摘要：'];

    if (summary.background) {
      parts.push(`\n背景：${summary.background}`);
    }

    if (summary.executions && summary.executions.length > 0) {
      parts.push('\n历史执行记录（最近）：');
      // 只展示最近 5 次执行的摘要
      const recent = summary.executions.slice(-5);
      for (const exec of recent) {
        parts.push(`\n• ${exec.timestamp.substring(0, 16)} 用户请求：${exec.userRequest}`);
        if (exec.completedTasks.length > 0) {
          parts.push(`  已完成：${exec.completedTasks.slice(0, 5).join('、')}`);
        }
        if (exec.keyFindings.length > 0) {
          parts.push(`  关键发现：${exec.keyFindings.slice(0, 3).join('、')}`);
        }
      }
    }

    if (summary.cumulativeFileChanges && summary.cumulativeFileChanges.length > 0) {
      const files = summary.cumulativeFileChanges.slice(-15);
      parts.push(`\n本会话已修改的文件：${files.join('、')}`);
    }

    if (summary.pendingIssues && summary.pendingIssues.length > 0) {
      parts.push(`\n待解决问题：${summary.pendingIssues.join('、')}`);
    }

    return parts.join('\n');
  }

  /**
   * 删除会话记忆
   */
  deleteSession(sessionId) {
    try {
      const dir = path.join(this.baseDir, sessionId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  /**
   * 列出所有有记忆的会话 ID
   */
  listSessions() {
    try {
      return fs.readdirSync(this.baseDir).filter(d => {
        const stat = fs.statSync(path.join(this.baseDir, d));
        return stat.isDirectory();
      });
    } catch (_) {
      return [];
    }
  }
}

module.exports = { SessionMemoryStore };
