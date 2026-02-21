const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

module.exports = {
  name: 'write_file',
  description: `Create a new file or overwrite an existing file with the given contents. Use edit_file for modifying existing files instead. Parent directories are created automatically.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The target file path, relative to the project root.' },
      content: { type: 'string', description: 'The full content to write to the file.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: ['path', 'content'],
  },
  riskLevel: 'medium',
  timeout: 10000,

  async handler(args, projectPath) {
    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, args.content, 'utf-8');

      const readback = fs.readFileSync(fullPath, 'utf-8');
      if (readback !== args.content) {
        return { success: false, error: 'Write verification failed — file content mismatch', code: 'E_VERIFY_FAILED' };
      }

      return { success: true, path: args.path, bytesWritten: Buffer.byteLength(args.content, 'utf-8') };
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}`, code: 'E_WRITE_FAILED' };
    }
  },
};
