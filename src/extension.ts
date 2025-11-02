import * as vscode from 'vscode';
import { chromium } from 'playwright';

let pageRef: any = null;
let highlightEnabled = true;
let selectedElements: any[] = [];
let conversation: any[] = [];

// === Shared store so chat can see last clicked elements ===
export function setLastSelectedElements(elements: any[]) {
  selectedElements = elements;
}
export function getLastSelectedElements() {
  return selectedElements;
}

// === Helper: send to LM Studio ===
async function queryLMStudio(messages: any[]) {
  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen/qwen3-coder-30b', messages }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  return result.choices?.[0]?.message?.content ?? '';
}

// === Helper: extract locators from JSON ===
function extractLocators(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    if (parsed.locators && Array.isArray(parsed.locators)) return parsed.locators;
  } catch {}
  return [];
}

// === Activate extension ===
export function activate(context: vscode.ExtensionContext) {
  // --- Command: open browser & element highlighter ---
  const openBrowser = vscode.commands.registerCommand('autolocator.openBrowser', async () => {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    pageRef = page;

    await page.goto('http://192.168.1.202:45245/ui/index.html#/dashboard');
    page.on('console', (msg) => console.log('[Browser]', msg.text()));

    await page.exposeFunction('logSelectedElement', async (info: any) => {
      selectedElements.push(info);
      setLastSelectedElements(selectedElements);
      // vscode.window.showInformationMessage(`Selected <${info.tag}> — total: ${selectedElements.length}`);
    });

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
          while (current && current.tagName !== 'HTML') {
            pathEls.unshift(current);
            if (current.tagName === 'MAIN') break;
            current = current.parentElement;
          }

          const htmlPath = pathEls
            .map((el) => {
              const attrs = Array.from(el.attributes)
                .map((a) => `${a.name}="${a.value}"`)
                .join(' ');
              return `<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>`;
            })
            .join(' → ');

          // @ts-ignore
          window.logSelectedElement({
            tag: el.tagName,
            id: el.id,
            className: el.className,
            htmlPath,
            outerHTML: el.outerHTML,
          });
        },
        true
      );
    });

    // vscode.window.showInformationMessage(
    //   'Hover & click elements to add them. Use the chat "@autolocator" to analyze or refine locators.'
    // );
  });

  // --- Command: toggle highlight ---
  const toggleHighlight = vscode.commands.registerCommand('autolocator.toggleHighlightMode', async () => {
    if (!pageRef) {
      vscode.window.showWarningMessage('Browser not active.');
      return;
    }
    highlightEnabled = !highlightEnabled;
    await pageRef.evaluate((enabled: boolean) => {
      (window as any).__HIGHLIGHT_MODE_ENABLED__ = enabled;
    }, highlightEnabled);
    vscode.window.showInformationMessage(`Highlight mode ${highlightEnabled ? 'enabled' : 'disabled'}`);
  });

  // --- Command: clear selected elements ---
  const clearSelection = vscode.commands.registerCommand('autolocator.clearSelection', async () => {
    if (selectedElements.length === 0) {
      vscode.window.showInformationMessage('No elements to clear.');
      return;
    }

    const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
      title: 'Clear all selected elements?',
      placeHolder: 'This will remove all stored element selections.',
    });

    if (confirm === 'Yes') {
      selectedElements = [];
      setLastSelectedElements([]);
      vscode.window.showInformationMessage('All selected elements cleared.');
    }
  });

  // === Chat participant (unchanged) ===
  const chat = vscode.chat.createChatParticipant(
    'autolocator.participant',
    async (request, context, stream, token) => {
      const userPrompt = request.prompt.trim();

      const elements = getLastSelectedElements();
      const htmlContext = elements.length
        ? elements.map((el, i) => `Element ${i + 1}:\n${el.outerHTML}`).join('\n\n')
        : '';

      const fullPrompt =
        htmlContext.length > 0
          ? `${userPrompt}\n\nSelected elements:\n${htmlContext}`
          : userPrompt;

      // stream.progress('Querying LM Studio…');

      try {
        const content = await queryLMStudio([{ role: 'user', content: fullPrompt }]);
        const locators = extractLocators(content);

        if (locators.length > 0) {
          const formatted = locators.map((l) => `\`\`\`ts\n${l}\n\`\`\``).join('\n');
          stream.markdown(`**Suggested Playwright Locators:**\n${formatted}`);

          // const choice = await vscode.window.showQuickPick(locators, {
          //   title: 'Insert Locator',
          //   placeHolder: 'Choose a locator to insert into your code',
          // });
          if (vscode.window.activeTextEditor) {
            // const editor = vscode.window.activeTextEditor;
            // await editor.edit((editBuilder) =>
            //   editBuilder.insert(editor.selection.active, choice)
            // );
            // stream.markdown(`✅ Inserted locator:\n\`\`\`ts\n${choice}\n\`\`\``);
          }
        } else {
          stream.markdown(`🧠 LM Studio Response:\n${content}`);
        }
      } catch (err: any) {
        stream.markdown(`❌ Error: ${err.message}`);
      }
    }
  );

  // Register commands
  context.subscriptions.push(openBrowser, toggleHighlight, clearSelection, chat);
}
