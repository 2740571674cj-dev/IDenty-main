class EditFuzzyMatcher {
  findMatch(content, searchStr, replaceAll = false) {
    // Strategy 1: Exact match
    const exactResult = this._exactMatch(content, searchStr, replaceAll);
    if (exactResult.found) return { ...exactResult, strategy: 'exact' };

    // Strategy 2: Whitespace-normalized match
    const wsResult = this._whitespaceNormalized(content, searchStr, replaceAll);
    if (wsResult.found) return { ...wsResult, strategy: 'whitespace_normalized' };

    // Strategy 3: Indent-agnostic match
    const indentResult = this._indentAgnostic(content, searchStr, replaceAll);
    if (indentResult.found) return { ...indentResult, strategy: 'indent_agnostic' };

    // Strategy 4: Line-trimmed match (trim each line before comparing)
    const trimResult = this._lineTrimmed(content, searchStr, replaceAll);
    if (trimResult.found) return { ...trimResult, strategy: 'line_trimmed' };

    return {
      found: false,
      error: 'old_string not found in file. The content may have changed — use read_file to get current content, then retry with the correct old_string.',
      code: 'E_MATCH_NOT_FOUND',
    };
  }

  _exactMatch(content, searchStr, replaceAll) {
    const idx = content.indexOf(searchStr);
    if (idx === -1) return { found: false };

    if (!replaceAll) {
      const secondIdx = content.indexOf(searchStr, idx + 1);
      if (secondIdx !== -1) {
        const count = content.split(searchStr).length - 1;
        return {
          found: false,
          error: `old_string matches ${count} locations. Include more surrounding context to make it unique.`,
          code: 'E_MULTIPLE_MATCHES',
        };
      }
    }

    return {
      found: true,
      start: idx,
      end: idx + searchStr.length,
      count: replaceAll ? content.split(searchStr).length - 1 : 1,
    };
  }

  _whitespaceNormalized(content, searchStr, replaceAll) {
    const normalize = (s) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
    const normContent = normalize(content);
    const normSearch = normalize(searchStr);

    const idx = normContent.indexOf(normSearch);
    if (idx === -1) return { found: false };

    // Map back to original positions
    const mapping = this._buildPositionMap(content, normContent);
    const originalStart = mapping[idx] ?? idx;
    const originalEnd = mapping[idx + normSearch.length] ?? (idx + normSearch.length);

    if (!replaceAll) {
      const secondIdx = normContent.indexOf(normSearch, idx + 1);
      if (secondIdx !== -1) {
        return {
          found: false,
          error: 'old_string matches multiple locations after whitespace normalization.',
          code: 'E_MULTIPLE_MATCHES',
        };
      }
    }

    return {
      found: true,
      start: originalStart,
      end: originalEnd,
      count: replaceAll ? normContent.split(normSearch).length - 1 : 1,
    };
  }

  _indentAgnostic(content, searchStr, replaceAll) {
    const contentLines = content.split('\n');
    const searchLines = searchStr.split('\n').map(l => l.trimStart());

    if (searchLines.length === 0) return { found: false };

    const matches = [];
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trimStart() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const startOffset = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
        const matchedText = contentLines.slice(i, i + searchLines.length).join('\n');
        const endOffset = startOffset + matchedText.length;
        matches.push({ start: startOffset, end: endOffset });
      }
    }

    if (matches.length === 0) return { found: false };
    if (!replaceAll && matches.length > 1) {
      return {
        found: false,
        error: `old_string matches ${matches.length} locations (indent-agnostic). Include more context.`,
        code: 'E_MULTIPLE_MATCHES',
      };
    }

    return { found: true, start: matches[0].start, end: matches[0].end, count: matches.length };
  }

  _lineTrimmed(content, searchStr, replaceAll) {
    const contentLines = content.split('\n');
    const searchLines = searchStr.split('\n').map(l => l.trim());

    if (searchLines.length === 0) return { found: false };

    const matches = [];
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const startOffset = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
        const matchedText = contentLines.slice(i, i + searchLines.length).join('\n');
        const endOffset = startOffset + matchedText.length;
        matches.push({ start: startOffset, end: endOffset });
      }
    }

    if (matches.length === 0) return { found: false };
    if (!replaceAll && matches.length > 1) {
      return {
        found: false,
        error: `old_string matches ${matches.length} locations (trimmed). Include more context.`,
        code: 'E_MULTIPLE_MATCHES',
      };
    }

    return { found: true, start: matches[0].start, end: matches[0].end, count: matches.length };
  }

  _buildPositionMap(original, normalized) {
    const map = {};
    let oi = 0;
    let ni = 0;
    while (oi < original.length && ni < normalized.length) {
      map[ni] = oi;
      if (original[oi] === normalized[ni]) {
        oi++;
        ni++;
      } else {
        oi++;
      }
    }
    map[ni] = oi;
    return map;
  }
}

module.exports = { EditFuzzyMatcher };
