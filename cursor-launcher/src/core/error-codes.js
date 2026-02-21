const ERROR_CODES = {
  PATH_TRAVERSAL: { code: 'E_PATH_TRAVERSAL', message: 'Path traversal detected: access outside project directory is forbidden', recoverable: false },
  FILE_NOT_FOUND: { code: 'E_FILE_NOT_FOUND', message: 'File not found', recoverable: true },
  FILE_TOO_LARGE: { code: 'E_FILE_TOO_LARGE', message: 'File exceeds size limit', recoverable: true },
  MATCH_NOT_FOUND: { code: 'E_MATCH_NOT_FOUND', message: 'old_string not found in file content', recoverable: true },
  MULTIPLE_MATCHES: { code: 'E_MULTIPLE_MATCHES', message: 'old_string matches multiple locations — provide more context', recoverable: true },
  WRITE_FAILED: { code: 'E_WRITE_FAILED', message: 'Failed to write file', recoverable: true },
  CMD_BLOCKED: { code: 'E_CMD_BLOCKED', message: 'Command blocked by security policy', recoverable: false },
  CMD_TIMEOUT: { code: 'E_CMD_TIMEOUT', message: 'Command timed out', recoverable: true },
  CMD_FAILED: { code: 'E_CMD_FAILED', message: 'Command exited with non-zero code', recoverable: true },
  TOOL_NOT_FOUND: { code: 'E_TOOL_NOT_FOUND', message: 'Unknown tool name', recoverable: false },
  TOOL_TIMEOUT: { code: 'E_TOOL_TIMEOUT', message: 'Tool execution timed out', recoverable: true },
  INVALID_PARAMS: { code: 'E_INVALID_PARAMS', message: 'Invalid or missing tool parameters', recoverable: true },
  LLM_ERROR: { code: 'E_LLM_ERROR', message: 'LLM API call failed', recoverable: true },
  APPROVAL_DENIED: { code: 'E_APPROVAL_DENIED', message: 'User denied the operation', recoverable: false },
  MAX_ITERATIONS: { code: 'E_MAX_ITERATIONS', message: 'Agent reached maximum iteration limit', recoverable: false },
  BUDGET_EXCEEDED: { code: 'E_BUDGET_EXCEEDED', message: 'Token budget exceeded', recoverable: false },
};

function makeError(errorDef, details = '') {
  return {
    success: false,
    error: details ? `${errorDef.message}: ${details}` : errorDef.message,
    code: errorDef.code,
    recoverable: errorDef.recoverable,
  };
}

module.exports = { ERROR_CODES, makeError };
