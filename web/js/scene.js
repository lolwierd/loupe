// A scene: a short animation of the change's core, a document its writer made for this change (its own HTML, CSS and
// JavaScript), shown in a sandboxed frame loupe serves with no network (/scene-doc). The page gives it loupe's colours
// and type, opens a line of code when it asks, and keeps an eye on it: a scene that stops answering is stopped. Its
// frame is made only near the view and let go a while after it leaves; it is kept, running, while the card around it
// is drawn again, so it never starts over under you.
import { esc, S, fileOf } from './core.js';
import { hooks } from './hooks.js';

const KEYS = ['--bg', '--chrome', '--ink', '--ink-2', '--ink-3', '--rule', '--rule-strong', '--on-act', '--ok', '--warn', '--danger', '--pencil', '--shade', '--lit', '--f-ui', '--f-mono'];
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
const theme = () => { const cs = getComputedStyle(document.documentElement); return JSON.stringify({ dark: isDark(), vars: Object.fromEntries(KEYS.map((k) => [k, cs.getPropertyValue(k).trim()]).filter(([, v]) => v)) }); };
const REF = /^([^\s:]+)(?::(\d+)(?:-\d+)?)?$/; // path, or path:line, or path:a-b
// a scene runs only where its "no connections at all" header is kept (Chromium 152 on), so nothing its script adds can
// reach out; it starts by itself where its frame also has a process of its own (desktop Chromium), so a scene stuck in
// a loop cannot freeze the page and is stopped; elsewhere in Chromium it waits for the reader to start it. A tablet
// asking for desktop sites says it is not mobile, but it still has a touch screen: one of those waits too.
const CHROMIUM = Number(navigator.userAgentData?.brands?.find((b) => b.brand === 'Chromium')?.version) || 0;
const SHUT = CHROMIUM >= 152, ISOLATED = SHUT && navigator.userAgentData.mobile === false && navigator.userAgentData.platform !== 'Android' && navigator.maxTouchPoints === 0;

export class ScenePlayer {
  constructor(scene) {
    this.scene = scene;
    const el = this.el = document.createElement('div');
    el.className = 'scn';
    el.innerHTML = `<div class="scnstage" style="height:${Number(scene.height) || 360}px"></div><p class="scnerr" hidden></p>`;
    this.stage = el.querySelector('.scnstage');
    this.listen = (e) => this.heard(e);
    addEventListener('message', this.listen);
    // a hidden tab: the scene's frame goes, and comes back when the tab does
    this.hide = () => { if (document.hidden) this.unmount(); else if (this.visible) this.mount(); };
    document.addEventListener('visibilitychange', this.hide);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="scene-again"]')) { this.dead = false; this.note(''); this.mount(); }
      if (e.target.closest('[data-act="scene-start"]')) { this.started = true; this.stage.querySelector('.scnstart')?.remove(); this.mount(); }
    });
    this.started = ISOLATED;
    if (!SHUT) this.stage.insertAdjacentHTML('beforeend', '<p class="scnstart scnnone">This scene plays in Chrome 152 or later.</p>');
    else if (!ISOLATED) this.stage.insertAdjacentHTML('beforeend', '<button class="link scnstart" data-act="scene-start">Play the scene</button>');
    this.io = new IntersectionObserver(([en]) => { this.visible = en.isIntersecting; if (this.visible) this.mount(); else this.later(); }, { rootMargin: '300px 0px' });
    this.io.observe(el);
    // a new theme: the frame is made again with it
    this.mo = new MutationObserver(() => this.remount());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.mq = matchMedia('(prefers-color-scheme: dark)'); this.mqf = () => this.remount(); this.mq.addEventListener('change', this.mqf);
  }
  mount() {
    clearTimeout(this.drop);
    if (this.frame || !this.el.isConnected || this.dead || !this.started || document.hidden) return;
    const f = this.frame = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.title = this.scene.title;
    this.note(''); // a fresh frame: an error the last one showed is not this one's
    f.src = `/scene-doc/${encodeURIComponent(S.id)}/${encodeURIComponent(this.scene.id)}?t=${encodeURIComponent(theme())}`;
    this.stage.append(f);
    this.heardN = 0; this.heardAt = Date.now();
    this.watch();
  }
  // out of view for a while: its frame goes, and with it whatever it was running
  later() { clearTimeout(this.drop); this.drop = setTimeout(() => { if (!this.visible) this.unmount(); }, 5000); }
  unmount() { clearInterval(this.hb); this.port?.close(); this.port = null; this.frame?.remove(); this.frame = null; }
  remount() { if (!this.frame) return; this.unmount(); if (this.visible) this.mount(); }
  // into another place on the page: moveBefore keeps the frame running; without it a move reloads the frame's document,
  // so the frame is made afresh there instead (with its own channel)
  relocate(into) {
    if (into.moveBefore && this.el.isConnected) { into.moveBefore(this.el, null); return; }
    const had = !!this.frame; this.unmount(); into.append(this.el);
    if (had && this.visible) this.mount();
  }
  // a scene stuck in a loop never answers: after eight seconds of silence its frame goes, and the card says so
  watch() {
    clearInterval(this.hb); this.answered = Date.now(); let n = 0, tick = Date.now();
    this.hb = setInterval(() => {
      if (!this.frame) { clearInterval(this.hb); return; }
      const at = Date.now(), gap = at - tick; tick = at;
      if (document.hidden || gap > 6000) { this.answered = at; if (!document.hidden) this.frame.contentWindow?.postMessage({ type: 'ping', n: ++n }, '*'); return; } // a hidden tab, or a machine that slept: timers stood still, the scene did not go silent
      if (Date.now() - this.answered > 8000) { this.unmount(); this.dead = true; this.note('This scene stopped answering, so loupe stopped it.', true); return; }
      this.frame.contentWindow?.postMessage({ type: 'ping', n: ++n }, '*');
    }, 2000);
  }
  note(text, again = false) {
    const p = this.el.querySelector('.scnerr');
    p.hidden = !text;
    p.innerHTML = text ? `${esc(text)}${again ? ' <button class="link" data-act="scene-again">Run it again</button>' : ''}` : '';
  }
  heard(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    // a scene that floods the page with messages is stopped like one that stops answering
    const now = Date.now();
    if (now - this.heardAt > 1000) { this.heardAt = now; this.heardN = 0; }
    if (++this.heardN > 120) { this.unmount(); this.dead = true; this.note('This scene sent the page too much, so loupe stopped it.', true); return; }
    const m = e.data && typeof e.data === 'object' ? e.data : {}, text = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
    if (m.type === 'pong' || m.type === 'hello') this.answered = now;
    // the shim's first hello brings its private channel; only Escape from the reader, while they are in the scene, comes on it
    if (m.type === 'hello' && !this.port && e.ports?.[0]) { this.port = e.ports[0]; this.port.onmessage = (ev) => this.fromReader(ev.data); }
    else if (m.type === 'error' && text(m.message) && !text(m.message).startsWith('blocked:')) this.note(`This scene's code failed: ${text(m.message)}`);
  }
  // what the reader did inside the scene, on the shim's own channel: Escape, or a code link they clicked (the shim lets
  // one through per click); still only while focus is in the scene, once a second, for a file of this change
  fromReader(m) {
    if (!m || typeof m !== 'object' || document.activeElement !== this.frame || !document.hasFocus()) return;
    if (m.type === 'key' && m.key === 'Escape') { this.el.closest('.sheetscrim')?.close?.(); return; }
    if (m.type !== 'open' || typeof m.ref !== 'string') return;
    const r = REF.exec(m.ref.slice(0, 240)), line = r ? Number(r[2]) || 0 : 0, now = Date.now();
    if (!r || !fileOf(r[1]) || line > 1e6 || now - (this.opened || 0) < 1000) return;
    this.opened = now; this.open(r[1], line);
  }
  // a link from the scene to its code: the large view closes first, and Back opens it again
  open(path, line) {
    const big = this.el.closest('.sheetscrim');
    if (big?.close) { const id = this.scene.id; big.close(); hooks.goLoc?.({ path, line }, null, () => hooks.openScene?.(id), { back: { text: 'the scene' } }); }
    else hooks.goLoc?.({ path, line }, this.el);
  }
  destroy() {
    clearTimeout(this.drop); this.unmount(); removeEventListener('message', this.listen); document.removeEventListener('visibilitychange', this.hide);
    this.io.disconnect(); this.mo.disconnect(); this.mq.removeEventListener('change', this.mqf);
    this.el.remove();
  }
}

// Players by scene: a card drawn again finds its scene's player and takes it back, still where it was. Before a card
// is drawn again its players are parked outside it, moved (moveBefore, where the browser has it, keeps a frame
// running instead of loading it again), then put in the new card's slots; one that finds no slot goes.
const players = new Map(); // key -> player
const keyOf = (s, where) => `${where}|${s.id}|${s.edit || ''}|${s.at}|${(s.html || '').length}`; // each edit its own player
let park = null, held = null; // held: the scene and place of a player parked while the reader was on its controls
const move = (into, el) => (into.moveBefore && el.isConnected ? into.moveBefore(el, null) : into.append(el));
export function sceneSlot(scene, where) { return `<div class="scnslot" data-scene="${esc(scene.id)}" data-where="${esc(where)}"></div>`; }
// call before a part of the page holding scenes is drawn again
export function parkScenes(root = document) {
  if (!players.size) return;
  if (!park) { park = document.createElement('div'); park.className = 'scnpark'; park.setAttribute('aria-hidden', 'true'); document.body.append(park); }
  for (const [k, p] of players) {
    if (!p.el.isConnected || !root.contains(p.el) || p.el.parentElement === park) continue;
    if (p.el.contains(document.activeElement)) held = { id: p.scene.id, where: k.split('|')[0] }; // before it moves: a move without moveBefore drops focus
    p.relocate(park);
  }
}
export function mountScenes(root = document) {
  const scenes = new Map((hooks.scenes?.() || []).map((s) => [s.id, s]));
  for (const slot of root.querySelectorAll('.scnslot[data-scene]')) {
    const s = scenes.get(slot.dataset.scene);
    if (!s) { // its scene is gone: so is its player, and a large view of it closes
      for (const [k2, p2] of players) if (p2.el.parentElement === slot) { p2.destroy(); players.delete(k2); }
      const big = slot.closest('.sheet.k-scene')?.closest('.sheetscrim');
      if (big) queueMicrotask(() => big.close?.()); // through its own close: its keys go, focus comes back
      continue;
    }
    // a large view says what its scene now says
    const sheet = slot.closest('.sheet.k-scene');
    if (sheet) { const t = sheet.querySelector('#scenebigt'), c = sheet.querySelector('.mbcap'); if (t && t.textContent !== s.title) t.textContent = s.title; if (c) { const html = hooks.sceneCaption?.(s) || ''; if (c.drawn !== html) { c.drawn = html; c.innerHTML = html; c.hidden = !s.why; } } } // the caption against what it last drew, not what the browser serializes
    const k = keyOf(s, slot.dataset.where);
    let p = players.get(k);
    if (!p) { p = new ScenePlayer(s); players.set(k, p); }
    // a slot holds one player: one for an earlier version of its scene goes
    let refocus = false;
    if (held && held.id === s.id && held.where === slot.dataset.where) { refocus = !p.el.contains(document.activeElement); held = null; } // a redraw parked it with the reader on it
    for (const [k2, p2] of players) if (p2 !== p && p2.el.parentElement === slot) { refocus ||= p2.el.contains(document.activeElement); p2.destroy(); players.delete(k2); }
    if (p.el.parentElement !== slot) p.relocate(slot);
    if (refocus) (p.el.querySelector('iframe') || sheet?.querySelector('[data-mb="close"]'))?.focus({ preventScroll: true }); // the reader was in the old scene: on to the new one
  }
  if (root === document) { held = null; sweep(); }
}
// a player whose slot is gone (however the page around it was drawn) or still parked goes, with its frame and listeners
function sweep() { for (const [k, p] of players) if (!p.el.isConnected || p.el.parentElement === park) { p.destroy(); players.delete(k); } }
// and on a timer, for a page drawn another way (an error state, a closed card) or a redraw that never put its scenes back
setInterval(() => { if (players.size) sweep(); }, 4000);
