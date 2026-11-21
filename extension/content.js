// On github.com, from document_start: g then l opens this page in loupe, and (when that setting is on) a pull request
// page you land on is reported to the service worker, which decides whether to open it.
(function () {
  'use strict';
  const L = globalThis.loupeLink;
  const settings = { shortcut: L.DEFAULTS.shortcut, autoOpen: L.DEFAULTS.autoOpen };
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* the extension was reloaded */ } };

  // ---------------------------------------------------------------- g l
  // Registered now, before GitHub's own scripts, on window in the capture phase, so it runs first. The shortcut
  // counts as on until storage answers. GitHub's own "g l" (labels) never sees the l that completes ours.
  const seq = L.createSequence(1500);
  window.addEventListener('keydown', (e) => {
    if (!settings.shortcut || !e.isTrusted) return;
    const target = typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target;
    if (L.isTyping(target)) { seq.reset(); return; }
    if (seq.step(e, Date.now()) !== 'done') return;
    // With the extension reloaded, this page's script can no longer reach it: leave the key to GitHub.
    if (!alive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    send({ type: 'open', url: location.href });
  }, true);

  // ---------------------------------------------------------------- landing on a pull request
  // A tab whose history is this one page was opened for it (a link from Slack, email, a notification): the worker
  // may put loupe in its place. A page reached by browsing in the tab is never replaced. A tab in the background
  // (a restored session, a link opened behind) reports when it is first looked at.
  let reported = '';
  let waiting = false;
  function report(fresh) {
    if (!settings.autoOpen || !alive()) return;
    const pr = L.parsePr(location.href);
    if (!pr) { reported = ''; return; }
    const key = L.prKey(pr);
    if (key === reported) return;
    if (document.visibilityState === 'hidden') {
      if (!waiting) {
        waiting = true;
        document.addEventListener('visibilitychange', function shown() {
          if (document.visibilityState === 'hidden') return;
          document.removeEventListener('visibilitychange', shown);
          waiting = false;
          report(fresh);
        });
      }
      return;
    }
    reported = key;
    // Read again now: a page shown later (from the background, or prerendered) may have joined a tab with history.
    send({ type: 'landed', url: location.href, fresh: fresh && history.length <= 1 });
  }

  const fresh = history.length <= 1;
  const ready = (async () => {
    try {
      const got = await chrome.storage.sync.get(['shortcut', 'autoOpen']);
      if (typeof got.shortcut === 'boolean') settings.shortcut = got.shortcut;
      if (typeof got.autoOpen === 'boolean') settings.autoOpen = got.autoOpen;
    } catch { /* keep the defaults */ }
  })();
  ready.then(() => report(fresh));
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of ['shortcut', 'autoOpen']) if (changes[k] && typeof changes[k].newValue === 'boolean') settings[k] = changes[k].newValue;
    });
  } catch { /* the extension was reloaded */ }
  // GitHub moves between pages without loading one (pushState); the Navigation API sees each move.
  if (globalThis.navigation && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('currententrychange', () => { ready.then(() => report(false)); });
  }
})();
