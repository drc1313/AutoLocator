/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
const vscode = __importStar(__webpack_require__(1));
const playwright_1 = __webpack_require__(2);
function activate(context) {
    let pageRef = null;
    let highlightEnabled = true;
    let selectedElements = []; // store multiple selected elements
    let conversation = [];
    // === Helper functions ===
    async function queryLMStudio(messages) {
        const response = await fetch('http://localhost:1234/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages }),
            body: JSON.stringify({ model: 'qwen/qwen3-coder-30b', messages }),
        });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        return result.choices?.[0]?.message?.content ?? '';
    }
    function extractLocators(content) {
        console.log('Raw LM Studio response:\n', content);
        // const cleaned = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
        try {
            // Somestimes the response includes comments, so we strip them out before parsing
            const parsed = JSON.parse(content);
            if (parsed.locators && Array.isArray(parsed.locators))
                return parsed.locators;
        }
        catch {
            throw new Error(`Failed to parse LM Studio response as JSON: ${content}`);
        }
        return [];
    }
    async function showLocatorMenu(locators) {
        while (true) {
            const items = [];
            if (locators.length > 0) {
                items.push({ label: 'LM Studio Suggestions', kind: vscode.QuickPickItemKind.Separator });
                items.push(...locators.map((loc, i) => ({
                    label: `Locator #${i + 1}`,
                    description: loc,
                    detail: 'Suggested by LM Studio',
                })));
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
            if (!selected)
                break;
            if (selected.label === 'Follow up...') {
                const followup = await vscode.window.showInputBox({
                    prompt: 'Enter your follow-up request for LM Studio',
                    placeHolder: 'e.g., "Use only CSS selectors" or "Include aria roles"',
                });
                if (!followup)
                    continue;
                conversation.push({ role: 'user', content: followup });
                vscode.window.showInformationMessage('Requesting updated locators...');
                const content = await queryLMStudio(conversation);
                const newLocators = extractLocators(content);
                if (newLocators.length > 0) {
                    conversation.push({ role: 'assistant', content });
                    locators = newLocators;
                    continue;
                }
                else {
                    vscode.window.showWarningMessage('No locators returned for follow-up.');
                }
            }
            else {
                const locator = selected.description || selected.label;
                vscode.env.clipboard.writeText(locator);
                vscode.window.showInformationMessage(`Locator copied: ${locator}`);
                break;
            }
        }
    }
    // === Main command: open browser ===
    const openBrowser = vscode.commands.registerCommand('autolocator.openBrowser', async () => {
        const browser = await playwright_1.chromium.launch({ headless: false });
        const page = await browser.newPage();
        pageRef = page;
        await page.goto('http://192.168.1.202:45245/ui/index.html#/dashboard');
        page.on('console', (msg) => console.log('[Browser]', msg.text()));
        let fullObject = {};
        // === Expose functions for browser ===
        await page.exposeFunction('logSelectedElement', async (info) => {
            selectedElements.push(info);
            fullObject = { ...fullObject, ...info };
            vscode.window.showInformationMessage(`Selected <${info.tag}> — total selected: ${selectedElements.length}`);
        });
        await page.exposeFunction('setHighlightMode', (enabled) => {
            window.__HIGHLIGHT_MODE_ENABLED__ = enabled;
        });
        // === Inject highlighter ===
        await page.evaluate(() => {
            window.__HIGHLIGHT_MODE_ENABLED__ = true;
            const overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'absolute',
                pointerEvents: 'none',
                background: 'rgba(0, 128, 255, 0.2)',
                border: '2px solid #08f',
                zIndex: '999999',
            });
            document.body.appendChild(overlay);
            let lastTarget = null;
            document.addEventListener('mousemove', (e) => {
                if (!window.__HIGHLIGHT_MODE_ENABLED__) {
                    overlay.style.width = '0px';
                    overlay.style.height = '0px';
                    return;
                }
                const target = e.target;
                if (!target || target === overlay)
                    return;
                if (target !== lastTarget) {
                    const rect = target.getBoundingClientRect();
                    overlay.style.left = rect.left + window.scrollX + 'px';
                    overlay.style.top = rect.top + window.scrollY + 'px';
                    overlay.style.width = rect.width + 'px';
                    overlay.style.height = rect.height + 'px';
                    lastTarget = target;
                }
            });
            document.addEventListener('click', (e) => {
                if (!window.__HIGHLIGHT_MODE_ENABLED__)
                    return;
                e.preventDefault();
                e.stopPropagation();
                const el = e.target;
                const pathEls = [];
                let current = el;
                // Collect all parent elements up to <main> (inclusive)
                while (current && current.tagName !== 'HTML') {
                    pathEls.unshift(current);
                    if (current.tagName === 'MAIN')
                        break; // stop at <main>
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
            }, true);
        });
        vscode.window.showInformationMessage('Hover and click elements to add them to your selection. Run "Send Selection" to analyze them.');
    });
    // === Command: toggle highlight mode ===
    const toggleHighlight = vscode.commands.registerCommand('autolocator.toggleHighlightMode', async () => {
        if (!pageRef) {
            vscode.window.showWarningMessage('Browser is not active yet.');
            return;
        }
        highlightEnabled = !highlightEnabled;
        await pageRef.evaluate((enabled) => {
            window.__HIGHLIGHT_MODE_ENABLED__ = enabled;
        }, highlightEnabled);
        vscode.window.showInformationMessage(`Highlight mode ${highlightEnabled ? 'enabled ✅' : 'disabled ⏸️'}`);
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
        const userPrompt = "Analyze the following elements and suggest Playwright locators:\n\n" +
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
            }
            else {
                vscode.window.showWarningMessage('LM Studio did not return valid locators.');
            }
        }
        catch (err) {
            vscode.window.showErrorMessage('Failed to reach LM Studio API.');
            console.error(err);
        }
        finally {
            selectedElements = []; // clear after sending
        }
    });
    // === Register commands ===
    context.subscriptions.push(openBrowser, toggleHighlight, sendSelection);
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("playwright");

/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map