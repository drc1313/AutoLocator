import * as vscode from 'vscode';
import { chromium } from 'playwright';

export function activate(context: vscode.ExtensionContext) {
  let pageRef: any = null;
  let highlightEnabled = true;
  let selectedElements: any[] = []; // store multiple selected elements
  let conversation: any[] = [];

  // === Helper functions ===
  async function queryLMStudio(messages: any[]) {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages }),
      body: JSON.stringify({ model: 'qwen/qwen3-coder-30b', messages }),

    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return result.choices?.[0]?.message?.content ?? '';
  }

  function extractLocators(content: string): string[] {
    console.log('Raw LM Studio response:\n', content);
    // const cleaned = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');

    try {
      // Somestimes the response includes comments, so we strip them out before parsing
      const parsed = JSON.parse(content);
      if (parsed.locators && Array.isArray(parsed.locators)) return parsed.locators;
    } catch {
      throw new Error(`Failed to parse LM Studio response as JSON: ${content}`);
    }
    return [];
  }

  async function showLocatorMenu(locators: string[]) {
    while (true) {
      const items: vscode.QuickPickItem[] = [];

      if (locators.length > 0) {
        items.push({ label: 'LM Studio Suggestions', kind: vscode.QuickPickItemKind.Separator });
        items.push(
          ...locators.map((loc, i) => ({
            label: `Locator #${i + 1}`,
            description: loc,
            detail: 'Suggested by LM Studio',
          }))
        );
      }

      items.push({ label: '────────────', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: 'Follow up...',
        description: 'Ask LM Studio to refine or change locator strategy',
        detail: 'Send another message with context',
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a locator or ask a follow-up question',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!selected) break;

      if (selected.label === 'Follow up...') {
        const followup = await vscode.window.showInputBox({
          prompt: 'Enter your follow-up request for LM Studio',
          placeHolder: 'e.g., "Use only CSS selectors" or "Include aria roles"',
        });
        if (!followup) continue;

        conversation.push({ role: 'user', content: followup });
        vscode.window.showInformationMessage('Requesting updated locators...');

        const content = await queryLMStudio(conversation);
        const newLocators = extractLocators(content);
        if (newLocators.length > 0) {
          conversation.push({ role: 'assistant', content });
          locators = newLocators;
          continue;
        } else {
          vscode.window.showWarningMessage('No locators returned for follow-up.');
        }
      } else {
        const locator = selected.description || selected.label;
        vscode.env.clipboard.writeText(locator);
        vscode.window.showInformationMessage(`Locator copied: ${locator}`);
        break;
      }
    }
  }

  // === Main command: open browser ===
  const openBrowser = vscode.commands.registerCommand('autolocator.openBrowser', async () => {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    pageRef = page;

    await page.goto('http://192.168.1.202:45245/ui/index.html#/dashboard');
    page.on('console', (msg) => console.log('[Browser]', msg.text()));
    let fullObject = {};
    // === Expose functions for browser ===
    await page.exposeFunction('logSelectedElement', async (info: any) => {
      selectedElements.push(info);
      fullObject = { ...fullObject, ...info };
      vscode.window.showInformationMessage(
        `Selected <${info.tag}> — total selected: ${selectedElements.length}`
      );
    });

    await page.exposeFunction('setHighlightMode', (enabled: boolean) => {
      (window as any).__HIGHLIGHT_MODE_ENABLED__ = enabled;
    });

    // === Inject highlighter ===
    await page.evaluate(() => {
      (window as any).__HIGHLIGHT_MODE_ENABLED__ = true;

      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'absolute',
        pointerEvents: 'none',
        background: 'rgba(0, 128, 255, 0.2)',
        border: '2px solid #08f',
        zIndex: '999999',
      });
      document.body.appendChild(overlay);

      let lastTarget: Element | null = null;
      document.addEventListener('mousemove', (e) => {
        if (!(window as any).__HIGHLIGHT_MODE_ENABLED__) {
          overlay.style.width = '0px';
          overlay.style.height = '0px';
          return;
        }
        const target = e.target as HTMLElement;
        if (!target || target === overlay) return;
        if (target !== lastTarget) {
          const rect = target.getBoundingClientRect();
          overlay.style.left = rect.left + window.scrollX + 'px';
          overlay.style.top = rect.top + window.scrollY + 'px';
          overlay.style.width = rect.width + 'px';
          overlay.style.height = rect.height + 'px';
          lastTarget = target;
        }
      });

 document.addEventListener(
  'click',
  (e) => {
    if (!(window as any).__HIGHLIGHT_MODE_ENABLED__) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target as HTMLElement;
    const pathEls: HTMLElement[] = [];
    let current: HTMLElement | null = el;

    // Collect all parent elements up to <main> (inclusive)
    while (current && current.tagName !== 'HTML') {
      pathEls.unshift(current);
      if (current.tagName === 'MAIN') break; // stop at <main>
      current = current.parentElement;
    }

    // Build readable HTML path string
    const htmlPath = pathEls
      .map((el) => {
        const attrs = Array.from(el.attributes)
          .map((a) => `${a.name}="${a.value}"`)
          .join(' ');
        return `<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>`;
      })
      .join(' → ');

    const outerHTML = el.outerHTML;
    console.log("HTML Path:", htmlPath);
    console.log("Outer HTML:", outerHTML);

    // @ts-ignore
    window.logSelectedElement({
      tag: el.tagName,
      id: el.id,
      className: el.className,
      htmlPath,
      outerHTML,
    });
  },
  true
);
    });

    vscode.window.showInformationMessage(
      'Hover and click elements to add them to your selection. Run "Send Selection" to analyze them.'
    );
  });

  // === Command: toggle highlight mode ===
  const toggleHighlight = vscode.commands.registerCommand('autolocator.toggleHighlightMode', async () => {
    if (!pageRef) {
      vscode.window.showWarningMessage('Browser is not active yet.');
      return;
    }

    highlightEnabled = !highlightEnabled;
    await pageRef.evaluate((enabled: boolean) => {
      (window as any).__HIGHLIGHT_MODE_ENABLED__ = enabled;
    }, highlightEnabled);

    vscode.window.showInformationMessage(
      `Highlight mode ${highlightEnabled ? 'enabled ✅' : 'disabled ⏸️'}`
    );
  });

  // === Command: send all selected elements ===
  const sendSelection = vscode.commands.registerCommand('autolocator.sendSelection', async () => {
    if (selectedElements.length === 0) {
      vscode.window.showWarningMessage('No elements selected yet.');
      return;
    }

    const additionalContext = await vscode.window.showInputBox({
      prompt: 'Add any additional context for LM Studio (optional)',
      placeHolder: 'Describe what these elements do or what kind of locators you prefer',
    });

    const userPrompt =
      "Analyze the following elements and suggest Playwright locators:\n\n" +
      selectedElements.map((el, i) => `Element ${i + 1}:\n${el.outerHTML}`).join('\n\n') +
      (additionalContext ? `\n\nAdditional context: ${additionalContext}` : '');

    conversation = [{ role: 'user', content: userPrompt }];

    vscode.window.showInformationMessage('Requesting locator suggestions from LM Studio...');

    try {
      const content = await queryLMStudio(conversation);
      const locators = extractLocators(content);
      conversation.push({ role: 'assistant', content });

      if (locators.length > 0) {
        await showLocatorMenu(locators);
      } else {
        vscode.window.showWarningMessage('LM Studio did not return valid locators.');
      }
    } catch (err) {
      vscode.window.showErrorMessage('Failed to reach LM Studio API.');
      console.error(err);
    } finally {
      selectedElements = []; // clear after sending
    }
  });

  // === Register commands ===
  context.subscriptions.push(openBrowser, toggleHighlight, sendSelection);
}
