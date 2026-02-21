const { exec } = require('child_process');
const { validateCommand } = require('../core/security-layer');

module.exports = {
  name: 'run_terminal_cmd',
  description: `Execute a terminal command in the project directory.\n\nGuidelines:\n1. For commands that use a pager (git, less, head, tail, more), append \` | cat\`.\n2. For long-running commands, set is_background to true.\n3. Don't include newlines in the command.\n4. If a tool exists for an action, prefer using the tool instead of shell commands (e.g. read_file over cat).`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The terminal command to execute.' },
      working_directory: { type: 'string', description: 'Working directory relative to project root. Defaults to project root.' },
      is_background: { type: 'boolean', description: 'Whether the command should be run in the background.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this command needs to be run and how it contributes to the goal.' },
    },
    required: ['command'],
  },
  riskLevel: 'medium',
  timeout: 130000,

  async handler(args, projectPath) {
    const cmdCheck = validateCommand(args.command);
    if (!cmdCheck.valid) return cmdCheck;

    const cwd = args.working_directory
      ? require('path').resolve(projectPath, args.working_directory)
      : projectPath;

    const fs = require('fs');
    if (!fs.existsSync(cwd)) {
      return { success: false, error: `Working directory not found: ${cwd}`, code: 'E_DIR_NOT_FOUND' };
    }

    return new Promise((resolve) => {
      const opts = {
        cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 120000,
        encoding: 'utf-8',
        windowsHide: true,
      };

      let actualCmd = args.command;
      if (process.platform === 'win32') {
        opts.shell = 'cmd.exe';
        actualCmd = `chcp 65001 >nul 2>&1 && ${args.command}`;
      }

      exec(actualCmd, opts, (error, stdout, stderr) => {
        const exitCode = error ? (error.code ?? -1) : 0;
        const truncatedStdout = stdout?.length > 50000 ? stdout.substring(0, 50000) + '\n...(truncated)' : (stdout || '');
        const truncatedStderr = stderr?.length > 10000 ? stderr.substring(0, 10000) + '\n...(truncated)' : (stderr || '');

        if (error && error.killed) {
          resolve({ success: false, stdout: truncatedStdout, stderr: truncatedStderr, exitCode: -1, error: 'Command timed out (120s)', code: 'E_CMD_TIMEOUT' });
        } else if (exitCode !== 0) {
          resolve({ success: false, stdout: truncatedStdout, stderr: truncatedStderr, exitCode, code: 'E_CMD_FAILED' });
        } else {
          resolve({ success: true, stdout: truncatedStdout, stderr: truncatedStderr, exitCode: 0 });
        }
      });
    });
  },
};
