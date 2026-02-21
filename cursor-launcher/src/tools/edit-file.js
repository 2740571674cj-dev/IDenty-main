const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');
const { ERROR_CODES, makeError } = require('../core/error-codes');

module.exports = {
  name: 'edit_file',
  description: `Perform exact string replacement in a file. Provide old_string (text to find) and new_string (replacement). The old_string must uniquely match one location in the file unless replace_all is true.\n\nIMPORTANT: Unless appending a small edit or creating a new file, you MUST read the file contents before editing to ensure accuracy.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The target file to modify, relative to the project root.' },
      old_string: { type: 'string', description: 'The exact text to find and replace. Must be unique in the file.' },
      new_string: { type: 'string', description: 'The replacement text (must differ from old_string).' },
      replace_all: { type: 'boolean', description: 'If true, replace all occurrences. Default false.' },
      explanation: { type: 'string', description: 'One sentence instruction describing what this edit does.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  riskLevel: 'medium',
  timeout: 10000,

  async handler(args, projectPath) {
    try {
      const { setLastEditAttempt } = require('./reapply');
      setLastEditAttempt({ old_string: args.old_string, new_string: args.new_string, path: args.path });
    } catch (_) {}

    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    if (!fs.existsSync(fullPath)) {
      return makeError(ERROR_CODES.FILE_NOT_FOUND, args.path);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');

    let matchResult;
    try {
      const { EditFuzzyMatcher } = require('../core/edit-fuzzy-matcher');
      const matcher = new EditFuzzyMatcher();
      matchResult = matcher.findMatch(content, args.old_string, args.replace_all);
    } catch (_) {
      matchResult = this._basicMatch(content, args.old_string, args.replace_all);
    }

    if (!matchResult.found) {
      return { success: false, error: matchResult.error, code: matchResult.code };
    }

    let newContent;
    if (args.replace_all) {
      newContent = content.split(args.old_string).join(args.new_string);
    } else {
      newContent = content.substring(0, matchResult.start) + args.new_string + content.substring(matchResult.end);
    }

    fs.writeFileSync(fullPath, newContent, 'utf-8');

    const readback = fs.readFileSync(fullPath, 'utf-8');
    if (readback !== newContent) {
      return { success: false, error: 'Write verification failed', code: 'E_VERIFY_FAILED' };
    }

    return {
      success: true,
      path: args.path,
      replacements: matchResult.count || 1,
      matchStrategy: matchResult.strategy || 'exact',
    };
  },

  _basicMatch(content, oldString, replaceAll) {
    const idx = content.indexOf(oldString);
    if (idx === -1) {
      return { found: false, error: `old_string not found in file. Read the file first to get the exact content.`, code: 'E_MATCH_NOT_FOUND' };
    }

    if (!replaceAll) {
      const secondIdx = content.indexOf(oldString, idx + 1);
      if (secondIdx !== -1) {
        return { found: false, error: `old_string matches multiple locations. Include more surrounding context to make it unique.`, code: 'E_MULTIPLE_MATCHES' };
      }
    }

    const count = replaceAll ? content.split(oldString).length - 1 : 1;
    return { found: true, start: idx, end: idx + oldString.length, count, strategy: 'exact' };
  },
};
