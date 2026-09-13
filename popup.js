// popup.js — v6.1.1 Web UI

const solveAllBtn = document.getElementById('solve-all-btn');
const autoSolveBtn = document.getElementById('auto-solve-btn');
const aiSelector = document.getElementById('ai-selector');
const bgModeToggle = document.getElementById('bg-mode-toggle');

// Load settings
chrome.storage.local.get(['preferredAI', 'backgroundMode'], (res) => {
    if (res.preferredAI) aiSelector.value = res.preferredAI;
    if (res.backgroundMode) bgModeToggle.checked = true;
});

// Save settings
aiSelector.addEventListener('change', () => {
    chrome.storage.local.set({ preferredAI: aiSelector.value });
});
bgModeToggle.addEventListener('change', () => {
    chrome.storage.local.set({ backgroundMode: bgModeToggle.checked });
});

function isSupportedUrl(url) {
    if (!url) return false;
    return url.includes('coursera.org') || url.includes('maya.adityauniversity.in');
}

// ── Answer this quiz only (Single Quiz Solve) ─────────────────────────────────
solveAllBtn.addEventListener('click', () => {
    const orig = solveAllBtn.innerHTML;
    solveAllBtn.disabled = true;
    solveAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Starting solver...`;
    
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0]) { restore(); return; }
        if (!isSupportedUrl(tabs[0].url)) {
            alert("This extension only works on Coursera and Aditya University pages. Please navigate there first.");
            restore();
            return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_SOLVE_ALL' }, () => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                alert("Please refresh the assessment page first to ensure the extension is fully loaded.");
            }
            setTimeout(restore, 3000);
        });
    });
    function restore() { solveAllBtn.disabled = false; solveAllBtn.innerHTML = orig; }
});

// ── Auto-solve all assignments (Pipeline) ──────────────────────────────────────
autoSolveBtn.addEventListener('click', () => {
    const orig = autoSolveBtn.innerHTML;
    autoSolveBtn.disabled = true;
    autoSolveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Starting pipeline...`;
    
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0]) { restore(); return; }
        if (!isSupportedUrl(tabs[0].url)) {
            alert("This extension only works on Coursera and Aditya University pages. Please navigate there first.");
            restore();
            return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_START' }, () => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                alert("Please refresh the assessment page first to ensure the extension is fully loaded.");
            }
            setTimeout(restore, 3000);
        });
    });
    function restore() { autoSolveBtn.disabled = false; autoSolveBtn.innerHTML = orig; }
});
