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
        const inserted = document.execCommand('insertText', false, task.prompt);
        
        if (!inserted || !(inputEl.innerText || '').trim()) {
            console.warn('[QuizAI Bridge] execCommand failed, falling back to innerHTML...');
            inputEl.innerHTML = '<p>' + task.prompt.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
            const events = ['input', 'change', 'keyup'];
            for (const e of events) {
                inputEl.dispatchEvent(new Event(e, { bubbles: true, composed: true }));
            }
        }

        await delay(800);

        // Click Send aggressively
        const sendSels = [
            'button[aria-label*="Send message"]',
            'button[aria-label*="Send"]',
            'button[mattooltip*="Send"]',
            '.send-button',
            'button.action-button.send-button'
        ];
        
        let sendBtn = null;
        for (let i = 0; i < 10; i++) {
            for (const sel of sendSels) {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && btn.getBoundingClientRect().width > 0) {
                    sendBtn = btn;
                    break;
                }
            }
            if (sendBtn) break;
            
            // Try to force state again
            inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            await delay(500);
        }

        if (sendBtn) {
            console.log('[QuizAI Bridge] Clicking Send...');
            sendBtn.click();
        } else {
            console.warn('[QuizAI Bridge] Send button not found or disabled — pressing Enter natively');
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true
            });
            inputEl.dispatchEvent(enterEvent);
        }

        console.log('[QuizAI Bridge] Message sent. Waiting for NEW response elements...');
        await delay(3000);

        // Wait for a NEW response element to appear
        const newEls = await waitFor(
            () => {
                const all = getAllResponseEls();
                if (all.length > baselineCount) return all;
                return null;
            },
            60000
        );

        if (!newEls) {
            await storeError('Gemini did not generate a response in time. Try again.');
            return;
        }

        console.log('[QuizAI Bridge] New response text detected.');

        // Wait for Gemini's streaming to finish (stable text)
        const responseText = await waitForStableText(() => {
            const all = getAllResponseEls();
            if (!all.length) return '';
            const last = all[all.length - 1];
            return (last.innerText || last.textContent || '').trim();
        }, 120000);

        if (!responseText.trim()) {
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
