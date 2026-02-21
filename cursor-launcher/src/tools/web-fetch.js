module.exports = {
  name: 'web_fetch',
  description: `Fetch content from a URL and return it as readable text. Use to read documentation, API references, or code examples. Only fetches public pages. Does not support authentication or binary content.`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to fetch (must start with http:// or https://).',
      },
    },
    required: ['url'],
  },
  riskLevel: 'safe',
  timeout: 20000,

  async handler(args) {
    const { url } = args;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: false, error: 'URL must start with http:// or https://', code: 'E_INVALID_URL' };
    }

    const blocked = /^https?:\/\/(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
    if (blocked.test(url)) {
      return { success: false, error: 'Cannot fetch localhost or private network URLs', code: 'E_PRIVATE_URL' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'CursorLauncher/1.0 (WebFetch Tool)' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return { success: false, error: `HTTP ${resp.status}`, code: `E_HTTP_${resp.status}` };
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('application/xml')) {
        return { success: false, error: `Unsupported content type: ${contentType}`, code: 'E_UNSUPPORTED_TYPE' };
      }

      let text = await resp.text();

      if (contentType.includes('text/html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }

      if (text.length > 30000) {
        text = text.substring(0, 30000) + '\n\n...(truncated, content too long)';
      }

      return { success: true, content: text, url, contentType };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, error: 'Request timed out', code: 'E_TIMEOUT' };
      }
      return { success: false, error: err.message, code: 'E_FETCH_FAILED' };
    }
  },
};
