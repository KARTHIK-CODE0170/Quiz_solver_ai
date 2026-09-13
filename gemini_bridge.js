// gemini_bridge.js — runs on gemini.google.com/* (Chrome extension content script)

(async function () {
    'use strict';

    const TASK_KEY = 'cqsGeminiTask';
    const ANSWER_KEY = 'cqsGeminiAnswers';

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

    async function handleTask(task) {
        if (!task?.prompt) return;

        console.log('[QuizAI Bridge] ✅ Task found. Prompt length:', task.prompt.length);
        await delay(2500); 

        // Find Gemini input 
        let inputEl = null;
        for (let i = 0; i < 50; i++) {
            const els = document.querySelectorAll('rich-textarea, div[contenteditable="true"][aria-label*="Prompt"], div[contenteditable="true"][aria-label*="Message"], .text-input-field');
            const visible = [...els].reverse().find(e => e.getBoundingClientRect().height > 0);
            if (visible) {
                inputEl = visible;
                break;
            }
            await delay(400);
        }

        if (!inputEl) {
            await storeError('Gemini input not found. Make sure you are logged into gemini.google.com');
            return;
        }

        const RESPONSE_SELS = ['model-response', 'message-content[data-message-author-role="model"]', '.model-response-text'];

        function getAllResponseEls() {
            for (const sel of RESPONSE_SELS) {
                const all = document.querySelectorAll(sel);
                if (all.length > 0) return [...all];
            }
            return [];
        }

        const baselineCount = getAllResponseEls().length;
        console.log('[QuizAI Bridge] Baseline captured. Count:', baselineCount);

        // Inject the prompt
        inputEl.focus();
        await delay(300);

        // Gemini uses Angular/Lit and rich-textarea.
        // Try the native execCommand which works best for rich editors when focused
        
        // Layered Injection
        let inserted = false;
        try {
            inputEl.focus();
            inserted = document.execCommand('insertText', false, task.prompt);
        } catch (e) {}

        if (!inserted || !(inputEl.innerText || '').trim()) {
            console.warn('[QuizAI Bridge] execCommand failed, falling back to innerHTML layered injection...');
            inputEl.innerHTML = '<p>' + task.prompt.replace(/

/g, '</p><p>').replace(/
/g, '<br>') + '</p>';
            const events = ['input', 'change', 'keyup'];
            for (const e of events) {
                inputEl.dispatchEvent(new Event(e, { bubbles: true, composed: true }));
            }
        }
        await delay(800);

        // Verified Dispatch with bounded retries
        let sendBtn = null;
        let retries = 0;
        while (retries < 10) {
            sendBtn = document.querySelector('button[aria-label*="Send message"], button[aria-label*="Send"], button.send-button');
            if (sendBtn && !sendBtn.disabled) {
                console.log('[QuizAI Bridge] Clicking Send...');
                sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                sendBtn.click();
                break;
            }
            console.log('[QuizAI Bridge] Send button disabled or not found. Dispatched synthetic events to wake framework...');
            inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            retries++;
            await delay(500);
        }
        
        if (!sendBtn || sendBtn.disabled) {
            console.warn('[QuizAI Bridge] Failed to enable send button. Firing highly aggressive Enter sequence.');
            const enterEvents = [
                new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }),
                new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }),
                new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true })
            ];
            for (const ev of enterEvents) inputEl.dispatchEvent(ev);
            
            // Also try finding ANY button inside the input container
            const altSendBtn = document.querySelector('.send-button, button[aria-label*="Send"]');
            if (altSendBtn) altSendBtn.click();
        }
console.log('[QuizAI Bridge] Message sent. Polling page for JSON response...');

        // Wait for Gemini's streaming to finish (stable text)
        // We scan the ENTIRE body text to completely bypass Angular DOM selector brittleness.
        const responseText = await waitForStableText(() => {
            return document.body.innerText;
        }, 120000);

        if (!responseText || !responseText.trim()) {
            await storeError('Gemini response was empty. Try again.');
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

        function waitForEl(sels, maxMs) {
            return new Promise(resolve => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (el) { resolve(el); return; }
                }
                const start = Date.now();
                const id = setInterval(() => {
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (el) { clearInterval(id); resolve(el); return; }
                    }
                    if (Date.now() - start > maxMs) { clearInterval(id); resolve(null); }
                }, 400);
            });
        }

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
