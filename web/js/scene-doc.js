// loupe's side of a scene written as a document (the model's own HTML, CSS and JS): it runs before the scene's code,
// in the sandboxed frame loupe serves it in (an opaque origin, a policy with no network). It gives the scene a way to
// open a line of code in loupe and sends its errors to the card; it takes WebRTC away, the one way out of a page that
// a content policy does not close.
(function () {
  // a scene runs only inside loupe's frame: opened as a page of its own (whatever the browser said it was for), the
  // document stops here, before the scene's own code is even read
  if (window.top === window) { window.stop(); document.documentElement.innerHTML = ''; throw new Error('a scene runs only inside loupe'); }
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver']) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  const post = (m) => { try { parent.postMessage(m, '*'); } catch {} };
  // a channel only this shim holds, made before the scene's code runs: what the reader does (Escape, a code link they
  // clicked) goes to loupe on it, so the scene's own code cannot send those itself
  const ch = new MessageChannel(), tell = MessagePort.prototype.postMessage.bind(ch.port1);
  const clock = Performance.prototype.now.bind(performance); // taken now: the scene cannot stop or bend it later
  let clicked = 0; // a real click inside the scene, which one code link may follow
  addEventListener('click', (e) => { if (e.isTrusted) clicked = clock(); }, true);
  Object.defineProperty(window, 'loupe', { value: Object.freeze({
    // 'path/to/file.go:120': opened only as the reader's act, within a moment of their click in the scene, once a click
    open(ref) { if (typeof ref !== 'string' || !clicked || clock() - clicked > 1500) return; clicked = 0; tell({ type: 'open', ref: ref.slice(0, 240) }); },
    // loupe's colours as the kit takes them (makeKit(canvas, { colors: loupe.colors(), dark: loupe.dark })), from :root
    colors() { const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim(); return { paper: v('--bg'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), rule: v('--rule'), ruleStrong: v('--rule-strong'), lineSoft: v('--line-soft') || v('--rule'), onAct: v('--on-act'), ok: v('--ok'), warn: v('--warn'), danger: v('--danger') }; },
    fonts() { const cs = getComputedStyle(document.documentElement); return { ui: cs.getPropertyValue('--f-ui').trim(), mono: cs.getPropertyValue('--f-mono').trim() }; },
    dark: document.documentElement.dataset.theme === 'dark',
  }), writable: false, configurable: false });
  addEventListener('error', (e) => post({ type: 'error', message: String((e && e.message) || 'the scene failed').slice(0, 300) }));
  addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String((e && e.reason && e.reason.message) || (e && e.reason) || 'the scene failed').slice(0, 300) }));
  // a load the frame's policy refused (there is no network here): said, so the writer learns it
  addEventListener('securitypolicyviolation', (e) => post({ type: 'error', message: `blocked: ${e.violatedDirective} ${String(e.blockedURI || '').slice(0, 120)}` }));
  // the card asks now and then that the scene is alive; a scene stuck in a loop does not answer and its frame goes
  // what the scene holds, and what does not fit its frame, for the check before it is kept
  const report = () => {
    const d = document.documentElement, b = document.body, cut = [];
    if (d.scrollHeight > innerHeight + 2) cut.push(`it is ${d.scrollHeight - innerHeight} px taller than its frame (${innerHeight} px), so its foot is cut off`);
    if (d.scrollWidth > innerWidth + 2) cut.push(`it is ${d.scrollWidth - innerWidth} px wider than its frame (${innerWidth} px)`);
    for (const el of b ? b.querySelectorAll('*') : []) {
      if (cut.length > 6) break;
      const cs = getComputedStyle(el);
      if (el.children.length === 0 && el.textContent.trim() && cs.overflow !== 'visible' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) cut.push(`the text "${el.textContent.trim().slice(0, 40)}" is cut off in its box`);
    }
    return { nodes: b ? b.querySelectorAll('*').length : 0, text: b ? b.innerText.trim().length : 0, canvases: document.querySelectorAll('canvas, svg').length, cut };
  };
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'ping') post({ type: 'pong', n: m.n });
    else if (m.type === 'report') post({ type: 'report', ...report() });
  });
  // Escape belongs to loupe (it closes the large view), even when the reader is inside the scene
  const keyOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, 'key').get); // the native getter and its call, bound before a scene could replace either
  addEventListener('keydown', (e) => { if (e.isTrusted && keyOf(e) === 'Escape') tell({ type: 'key', key: 'Escape' }); }, true); // first, at capture: a scene cannot stop it
  try { parent.postMessage({ type: 'hello' }, '*', [ch.port2]); } catch {}
})();
