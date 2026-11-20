// Theme before first paint: what you picked last, else the system's. A file, not inline, so the page's CSP can
// refuse every inline script.
try { const t = localStorage.getItem('loupe.theme'); if (t === '"light"' || t === '"dark"') document.documentElement.dataset.theme = JSON.parse(t); } catch { /* private window */ }
