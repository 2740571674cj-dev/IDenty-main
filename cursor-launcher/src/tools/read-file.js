const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

module.exports = {
  name: 'read_file',
  description: `Read the contents of a file. Output lines are numbered as LINE_NUMBER|LINE_CONTENT.\n\nWhen using this tool to gather information, ensure you have COMPLETE context:\n1) Assess if contents viewed are sufficient to proceed.\n2) Take note of lines not shown.\n3) If insufficient, call again to view those lines.\n4) When in doubt, call again to gather more information.\n\nReading entire files is wasteful for large files. Use offset and limit for targeted reading.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path of the file to read, relative to the project root.' },
      offset: { type: 'number', description: 'The one-indexed line number to start reading from (inclusive).' },
      limit: { type: 'number', description: 'Max number of lines to read. Omit to read entire file.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used, and how it contributes to the goal.' },
    },
    required: ['path'],
  },
  riskLevel: 'safe',
  timeout: 10000,

  async handler(args, projectPath) {
    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${args.path}`, code: 'E_FILE_NOT_FOUND' };
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory, not a file. Use list_directory instead.', code: 'E_IS_DIRECTORY' };
    }
    if (stat.size > 5 * 1024 * 1024) {
      return { success: false, error: 'File too large (>5MB). Use offset and limit to read in chunks.', code: 'E_FILE_TOO_LARGE' };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    if (content.length === 0) return { success: true, content: '(empty file)', totalLines: 0 };

    const lines = content.split('\n');
    const totalLines = lines.length;

    let start = 0;
    let end = totalLines;
    if (args.offset) {
      start = Math.max(0, args.offset - 1);
    }
    if (args.limit) {
      end = Math.min(totalLines, start + args.limit);
    }

    const numbered = lines.slice(start, end).map((line, i) => {
      const lineNum = String(start + i + 1).padStart(6, ' ');
      return `${lineNum}|${line}`;
    }).join('\n');

    return { success: true, content: numbered, totalLines, startLine: start + 1, endLine: end };
  },
};
