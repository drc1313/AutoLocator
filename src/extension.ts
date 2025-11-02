import * as vscode from 'vscode';
import { chromium } from 'playwright';
import { ChatRequestTurn } from 'vscode';

// === Shared global state ===
let pageRef: any = null;
let highlightEnabled = true;
let selectedElements: any[] = [];

// === Helpers to manage selection ===
export function setLastSelectedElements(elements: any[]) {
  selectedElements = elements;
}

export function getLastSelectedElements() {
  return selectedElements;
}

// === LM Studio Chat Helper ===
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

// === Extract locators from model output ===
function extractLocators(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    if (parsed.locators && Array.isArray(parsed.locators)) return parsed.locators;
  } catch {}
  return [];
}

// === Browser Setup and Highlighter ===
async function launchBrowser() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  pageRef = page;

  await page.goto('http://192.168.1.202:45245/ui/index.html#/dashboard');
  page.on('console', (msg) => console.log('[Browser]', msg.text()));

  await page.exposeFunction('logSelectedElement', async (info: any) => {
    selectedElements.push(info);
    setLastSelectedElements(selectedElements);
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
}

// === Activate Extension ===
export function activate(context: vscode.ExtensionContext) {
  // --- Command: open browser and highlighter ---
  const openBrowser = vscode.commands.registerCommand('autolocator.openBrowser', async () => {
    await launchBrowser();
    vscode.window.showInformationMessage(
      'Browser launched. Hover & click elements to capture them for locator generation.'
    );
  });

  // --- Command: toggle highlight mode ---
  const toggleHighlight = vscode.commands.registerCommand('autolocator.toggleHighlightMode', async () => {
    if (!pageRef) {
      vscode.window.showWarningMessage('Browser not active.');
      return;
    }

    highlightEnabled = !highlightEnabled;
    await pageRef.evaluate((enabled: boolean) => {
      (window as any).__HIGHLIGHT_MODE_ENABLED__ = enabled;
    }, highlightEnabled);

    vscode.window.showInformationMessage(
      `Highlight mode ${highlightEnabled ? 'enabled' : 'disabled'}.`
    );
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

  // --- Chat participant: uses VS Code chat memory directly ---
  const chat = vscode.chat.createChatParticipant(
    'autolocator.participant',
    async (request, context, stream, token) => {
      const userPrompt = request.prompt.trim();
      const firstMessage = {role: "user", content: "These are the selected elements:\n" + JSON.stringify(selectedElements, null, 2)}
      let contentToSend:object[];
      let convertToLMStudioFormat:object[] = []
      if(context.history.length>0){
        console.log(context.history)
        context.history.forEach((turn: Pick<ChatRequestTurn, "participant" | "prompt"> | Pick<vscode.ChatResponseTurn, "participant" | "response">) => {
          convertToLMStudioFormat.push({
            role: (<ChatRequestTurn>turn).prompt ? 'user' : 'assistant', // Determine role based on presence of prompt or response
            content: (<ChatRequestTurn>turn).prompt ? (<ChatRequestTurn>turn).prompt : (<vscode.ChatResponseMarkdownPart>(<vscode.ChatResponseTurn>turn).response[0]).value.value
          });
        })
        convertToLMStudioFormat.push({ role: 'user', content: userPrompt });
        contentToSend = convertToLMStudioFormat
      } else {
        contentToSend = [{ role: 'user', content: userPrompt}];
      }
      try {
        stream.progress('Querying LM Studio…');
        // Post first message with selected elements
        contentToSend.unshift(firstMessage)
        const reply = await queryLMStudio(contentToSend);
        const locators = extractLocators(reply);

        if (locators.length > 0) {
          const formatted = locators.map((l) => `\`\`\`ts\n${l}\n\`\`\``).join('\n');
          stream.markdown(`**Suggested Playwright Locators:**\n${formatted}`);
        } else {
          stream.markdown(`🧠 LM Studio Response:\n${reply}`);
        }
      } catch (err: any) {
        stream.markdown(`❌ Error: ${err.message}`);
      }
    }
  );

  // Register all commands
  context.subscriptions.push(openBrowser, toggleHighlight, clearSelection, chat);
}

// --- Deactivate extension ---
export function deactivate() {
  if (pageRef) {
    pageRef.browser()?.close();
    pageRef = null;
  }
}
