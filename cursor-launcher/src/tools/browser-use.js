const path = require('path');
const fs = require('fs');
const os = require('os');

let browserWin = null;

function getBrowserWindow() {
  try {
    const { BrowserWindow } = require('electron');
    return BrowserWindow;
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: 'browser_use',
  description: `Open a browser window to navigate web pages, interact with elements, and take screenshots. Use for testing web applications, verifying UI changes, checking page rendering. Actions: navigate, click, type, screenshot, get_text, wait, close.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'type', 'screenshot', 'get_text', 'wait', 'close'],
        description: 'Browser action to perform.',
      },
      url: { type: 'string', description: 'URL to navigate to (for "navigate" action).' },
      selector: { type: 'string', description: 'CSS selector for click/type/get_text actions.' },
      text: { type: 'string', description: 'Text to type (for "type" action).' },
      waitMs: { type: 'number', description: 'Milliseconds to wait (for "wait" action). Max 10000.' },
    },
    required: ['action'],
  },
  riskLevel: 'medium',
  timeout: 30000,

  async handler(args) {
    const BW = getBrowserWindow();
    if (!BW) {
      return { success: false, error: 'BrowserWindow not available in this context', code: 'E_NO_BROWSER' };
    }

    switch (args.action) {
      case 'navigate': {
        if (!args.url) return { success: false, error: 'URL required for navigate' };
        if (browserWin && !browserWin.isDestroyed()) browserWin.close();

        browserWin = new BW({
          width: 1280, height: 800, show: false,
          webPreferences: { sandbox: true, contextIsolation: true },
        });

        try {
          await browserWin.loadURL(args.url);
          const title = browserWin.getTitle();
          return { success: true, title, url: args.url };
        } catch (e) {
          return { success: false, error: `Failed to load URL: ${e.message}` };
        }
      }

      case 'screenshot': {
        if (!browserWin || browserWin.isDestroyed()) {
          return { success: false, error: 'No browser open. Navigate first.' };
        }
        try {
          const image = await browserWin.webContents.capturePage();
          const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
          fs.writeFileSync(tmpPath, image.toPNG());
          return { success: true, screenshotPath: tmpPath, size: image.getSize() };
        } catch (e) {
          return { success: false, error: `Screenshot failed: ${e.message}` };
        }
      }

      case 'click': {
        if (!browserWin || browserWin.isDestroyed()) return { success: false, error: 'No browser open' };
        if (!args.selector) return { success: false, error: 'Selector required' };
        try {
          const escaped = args.selector.replace(/'/g, "\\'");
          await browserWin.webContents.executeJavaScript(
            `document.querySelector('${escaped}')?.click()`
          );
          return { success: true };
        } catch (e) {
          return { success: false, error: `Click failed: ${e.message}` };
        }
      }

      case 'type': {
        if (!browserWin || browserWin.isDestroyed()) return { success: false, error: 'No browser open' };
        if (!args.selector || !args.text) return { success: false, error: 'Selector and text required' };
        try {
          const escaped = args.selector.replace(/'/g, "\\'");
          const textEscaped = args.text.replace(/'/g, "\\'");
          await browserWin.webContents.executeJavaScript(`
            const el = document.querySelector('${escaped}');
            if (el) { el.focus(); el.value = '${textEscaped}'; el.dispatchEvent(new Event('input', {bubbles:true})); }
          `);
          return { success: true };
        } catch (e) {
          return { success: false, error: `Type failed: ${e.message}` };
        }
      }

      case 'get_text': {
        if (!browserWin || browserWin.isDestroyed()) return { success: false, error: 'No browser open' };
        try {
          const selector = args.selector || 'body';
          const escaped = selector.replace(/'/g, "\\'");
          const text = await browserWin.webContents.executeJavaScript(
            `document.querySelector('${escaped}')?.innerText || ''`
          );
          return { success: true, text: text.substring(0, 10000) };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'wait': {
        const ms = Math.min(args.waitMs || 1000, 10000);
        await new Promise(r => setTimeout(r, ms));
        return { success: true, waited: ms };
      }

      case 'close': {
        if (browserWin && !browserWin.isDestroyed()) {
          browserWin.close();
          browserWin = null;
        }
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action: ${args.action}` };
    }
  },
};
