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
exports.setLastSelectedElements = setLastSelectedElements;
exports.getLastSelectedElements = getLastSelectedElements;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const playwright_1 = __webpack_require__(2);
// === Shared global state ===
let pageRef = null;
let highlightEnabled = true;
let selectedElements = [];
// === Helpers to manage selection ===
function setLastSelectedElements(elements) {
    selectedElements = elements;
}
function getLastSelectedElements() {
    return selectedElements;
}
// === LM Studio Chat Helper ===
async function queryLMStudio(messages) {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen/qwen3-coder-30b', messages }),
    });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return result.choices?.[0]?.message?.content ?? '';
}
// === Extract locators from model output ===
function extractLocators(content) {
    try {
        const parsed = JSON.parse(content);
        if (parsed.locators && Array.isArray(parsed.locators))
            return parsed.locators;
    }
    catch { }
    return [];
}
// === Browser Setup and Highlighter ===
async function launchBrowser() {
    const browser = await playwright_1.chromium.launch({ headless: false });
    const page = await browser.newPage();
    pageRef = page;
    await page.goto('http://192.168.1.202:45245/ui/index.html#/dashboard');
    page.on('console', (msg) => console.log('[Browser]', msg.text()));
    await page.exposeFunction('logSelectedElement', async (info) => {
        selectedElements.push(info);
        setLastSelectedElements(selectedElements);
    });
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
            while (current && current.tagName !== 'HTML') {
                pathEls.unshift(current);
                if (current.tagName === 'MAIN')
                    break;
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
        }, true);
    });
}
// === Activate Extension ===
function activate(context) {
    // --- Command: open browser and highlighter ---
    const openBrowser = vscode.commands.registerCommand('autolocator.openBrowser', async () => {
        await launchBrowser();
        vscode.window.showInformationMessage('Browser launched. Hover & click elements to capture them for locator generation.');
    });
    // --- Command: toggle highlight mode ---
    const toggleHighlight = vscode.commands.registerCommand('autolocator.toggleHighlightMode', async () => {
        if (!pageRef) {
            vscode.window.showWarningMessage('Browser not active.');
            return;
        }
        highlightEnabled = !highlightEnabled;
        await pageRef.evaluate((enabled) => {
            window.__HIGHLIGHT_MODE_ENABLED__ = enabled;
        }, highlightEnabled);
        vscode.window.showInformationMessage(`Highlight mode ${highlightEnabled ? 'enabled' : 'disabled'}.`);
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
    const chat = vscode.chat.createChatParticipant('autolocator.participant', async (request, context, stream, token) => {
        const userPrompt = request.prompt.trim();
        const firstMessage = { role: "user", content: "These are the selected elements:\n" + JSON.stringify(selectedElements, null, 2) };
        let contentToSend;
        let convertToLMStudioFormat = [];
        if (context.history.length > 0) {
            console.log(context.history);
            context.history.forEach((turn) => {
                convertToLMStudioFormat.push({
                    role: turn.prompt ? 'user' : 'assistant', // Determine role based on presence of prompt or response
                    content: turn.prompt ? turn.prompt : turn.response[0].value.value
                });
            });
            convertToLMStudioFormat.push({ role: 'user', content: userPrompt });
            contentToSend = convertToLMStudioFormat;
        }
        else {
            contentToSend = [{ role: 'user', content: userPrompt }];
        }
        try {
            stream.progress('Querying LM Studio…');
            // Post first message with selected elements
            contentToSend.unshift(firstMessage);
            const reply = await queryLMStudio(contentToSend);
            const locators = extractLocators(reply);
            if (locators.length > 0) {
                const formatted = locators.map((l) => `\`\`\`ts\n${l}\n\`\`\``).join('\n');
                stream.markdown(`**Suggested Playwright Locators:**\n${formatted}`);
            }
            else {
                stream.markdown(`🧠 LM Studio Response:\n${reply}`);
            }
        }
        catch (err) {
            stream.markdown(`❌ Error: ${err.message}`);
        }
    });
    // Register all commands
    context.subscriptions.push(openBrowser, toggleHighlight, clearSelection, chat);
}
// --- Deactivate extension ---
function deactivate() {
    if (pageRef) {
        pageRef.browser()?.close();
        pageRef = null;
    }
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