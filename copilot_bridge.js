// copilot_bridge.js — runs on copilot.microsoft.com/* (Chrome extension content script)

(async function () {
    'use strict';

    const TASK_KEY = 'cqsCopilotTask';
    const ANSWER_KEY = 'cqsCopilotAnswers';

    const PROCESSING_PHRASES = [
        /searching(?:\s.*)?web(?:\s|\.)*$/i,
        /generating(?:\s|\.)*$/i
    ];

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes[TASK_KEY]?.newValue) {
            handleTask(changes[TASK_KEY].newValue);
        }
    });

    const storage = await chrome.storage.local.get([TASK_KEY]);
    if (storage[TASK_KEY]) {
        handleTask(storage[TASK_KEY]);
    }

    // Helper to find elements inside Shadow DOMs if needed
    function findInShadowDOM(selector) {
        let found = document.querySelector(selector);
        if (found) return found;

        const allNodes = [...document.querySelectorAll('*')];
        for (const node of allNodes) {
            if (node.shadowRoot) {
                found = node.shadowRoot.querySelector(selector);
                if (found) return found;
            }
        }
        return null;
    }

    async function handleTask(task) {
        if (!task?.prompt) return;

        console.log('[QuizAI Bridge] ✅ Task found. Prompt length:', task.prompt.length);
        await delay(2500); 

        // Find Copilot input (could be in a shadow root or a standard textarea)
        let inputEl = null;
        for (let i = 0; i < 50; i++) {
            const sels = ['#searchbox', 'textarea#prompt-textarea', 'textarea[placeholder*="Ask"]', 'textarea'];
            for (const sel of sels) {
                const el = findInShadowDOM(sel);
                if (el && el.getBoundingClientRect().height > 0) {
                    inputEl = el;
                    break;
                }
            }
            if (inputEl) break;
            await delay(400);
        }

        if (!inputEl) {
            await storeError('Copilot input not found. Make sure you are logged into copilot.microsoft.com');
            return;
        }

        const RESPONSE_SELS = ['.cib-message-main', 'cib-message', '.ac-textBlock', 'div[data-message-author="bot"]', 'div[data-testid="message-content"]', '.message-content', 'div[class*="messageBlock"]', 'div[class*="botMessage"]', '.chat-message', '[data-testid="message"]', 'div.markdown-body'];

        function getAllResponseEls() {
            let all = [];
            for (const sel of RESPONSE_SELS) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) all.push(...els);
                const shadowEls = findInShadowDOM(sel);
                if (shadowEls) all.push(shadowEls);
            }
            return all;
        }

        const baselineCount = getAllResponseEls().length;
        console.log('[QuizAI Bridge] Baseline captured. Count:', baselineCount);

        // Inject the prompt
        inputEl.focus();
        await delay(300);

        inputEl.value = task.prompt;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

        await delay(800);

        // Click Send
        let sendBtn = null;
        for (const sel of ['button[aria-label="Submit"]', '.cib-search-icon']) {
            sendBtn = findInShadowDOM(sel);
            if (sendBtn) break;
        }

        if (sendBtn && !sendBtn.disabled) {
            console.log('[QuizAI Bridge] Clicking Send...');
            sendBtn.click();
        } else {
            console.warn('[QuizAI Bridge] Send button not found — pressing Enter');
            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
        }

        
        console.log('[QuizAI Bridge] Message sent. Polling page for JSON response...');

        // Wait for Copilot's streaming to finish (stable text)
        // We scan the ENTIRE body text to completely bypass React DOM selector brittleness.
        const responseText = await waitForStableText(() => {
            return document.body.innerText;
        }, 120000);

        if (!responseText || !responseText.trim()) {
            await storeError('Copilot response was empty. Try again.');
            return;
        }

        // Parse and store
        const { answers } = parseChatGPTResponse(responseText);

        
        await chrome.storage.local.set({
            [ANSWER_KEY]: {
                answers,
                rawText: responseText.slice(0, 5000),
                taskId: task.taskId,
                timestamp: Date.now(),
            }
        });
        await chrome.storage.local.remove([TASK_KEY]);

        console.log('[QuizAI Bridge] ✅ Done.');

        function waitFor(fn, maxMs) {
            return new Promise(resolve => {
                const r = fn(); if (r) { resolve(r); return; }
                const start = Date.now();
                const id = setInterval(() => {
                    const r2 = fn();
                    if (r2 || Date.now() - start > maxMs) { clearInterval(id); resolve(r2 || null); }
                }, 600);
            });
        }

        function isChatGPTProcessing(text) {
            if (!text) return false;
            return PROCESSING_PHRASES.some(re => re.test(text));
        }

        function waitForStableText(getText, maxMs) {
            return new Promise(resolve => {
                let last = '', stableCount = 0;
                const start = Date.now();
                const id = setInterval(() => {
                    const cur = getText();
                    if (cur && cur === last && cur.length > 5) {
                        if (isChatGPTProcessing(cur)) {
                            stableCount = 0; last = ''; 
                        } else {
                            stableCount++;
                            if (stableCount >= 3) { clearInterval(id); resolve(cur); return; }
                        }
                    } else {
                        stableCount = 0; last = cur;
                        if (cur && cur.includes('"answers"')) {
                            const parsed = parseChatGPTResponse(cur, true);
                            if (parsed && parsed.answers && parsed.answers.length > 0) {
                                clearInterval(id); resolve(cur); return;
                            }
                        }
                    }
                    if (Date.now() - start > maxMs) { clearInterval(id); resolve(last); }
                }, 800);
            });
        }

        function parseChatGPTResponse(text, skipFallback = false) {
            const candidates = [];
            let depth = 0, start = -1;
            for (let i = 0; i < text.length; i++) {
                if (text[i] === '{') {
                    if (depth === 0) start = i;
                    depth++;
                } else if (text[i] === '}') {
                    if (depth > 0) {
                        depth--;
                        if (depth === 0 && start !== -1) {
                            candidates.push(text.slice(start, i + 1));
                            start = -1;
                        }
                    }
                }
            }
            for (const candidate of [...candidates].reverse()) {
                try {
                    const p = JSON.parse(candidate);
                    if (Array.isArray(p.answers)) return { answers: p.answers };
                } catch { }
            }
            if (skipFallback) return { answers: [] };
            for (const candidate of [...candidates].reverse()) {
                try {
                    const sanitized = candidate.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
                        const fixed = inner.replace(/(?<!\\)"/g, "'");
                        return ': "' + fixed + '"';
                    });
                    const p = JSON.parse(sanitized);
                    if (Array.isArray(p.answers)) return { answers: p.answers };
                } catch { }
            }
            return { answers: [] };
        }

        async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

        async function storeError(msg) {
            console.error('[QuizAI Bridge]', msg);
            await chrome.storage.local.set({ [ANSWER_KEY]: { error: msg } });
            await chrome.storage.local.remove([TASK_KEY]);
        }
    }
})();
