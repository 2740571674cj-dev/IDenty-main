const path = require('path');
const { ERROR_CODES, makeError } = require('./error-codes');

const DANGEROUS_COMMANDS = [
  /\brm\s+(-rf?|--recursive)\s+[\/\\]/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sfq]/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\s+-9\s+1\b/,
  /\breg\s+delete/i,
  /\bnet\s+user\b.*\/add/i,
];

const RISK_LEVELS = {
  safe: { needsApproval: false, description: 'Read-only operations' },
  low: { needsApproval: false, description: 'Low risk write operations' },
  medium: { needsApproval: true, description: 'File modifications, command execution' },
  high: { needsApproval: true, description: 'Destructive or irreversible operations' },
};

function validatePath(filePath, projectPath) {
  const resolved = path.resolve(projectPath, filePath);
  const normalizedProject = path.resolve(projectPath);
  if (!resolved.startsWith(normalizedProject + path.sep) && resolved !== normalizedProject) {
    return makeError(ERROR_CODES.PATH_TRAVERSAL, filePath);
  }
  return { valid: true, resolvedPath: resolved };
}

function validateCommand(command) {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return makeError(ERROR_CODES.CMD_BLOCKED, `Matched dangerous pattern: ${pattern}`);
    }
  }
  return { valid: true };
}

function needsApproval(riskLevel, autoApproveMode = false) {
  if (autoApproveMode) return false;
  const level = RISK_LEVELS[riskLevel];
  return level ? level.needsApproval : true;
}

module.exports = { validatePath, validateCommand, needsApproval, RISK_LEVELS };
