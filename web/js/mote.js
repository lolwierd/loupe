// Mote, loupe's helper: a small diff beetle, its shell half added-green and half removed-red, a lens in hand. It floats
// over the diff's bottom-right corner (drag it anywhere; it remembers where) and does what the desk is doing, so a glance tells you without reading: it works while
// an answer or the guide is being written, inspects the result when it lands, slumps when something fails, jumps when
// the last file is viewed or a dialog's send goes through, waits while a dialog asks you something, waves hello when a
// change opens (and when you click it), and turns to look at the pointer when it comes near. Otherwise it is still,
// breathing now and then: it sits beside code you are reading, so it never loops for attention.
//
// The art is the Work Pets v2 sheet scaled down to its own 48 by 52 pixel grid (web/img/mote.png: 8 columns, 11 rows),
// drawn at one sheet pixel per CSS pixel and kept crisp with image-rendering: pixelated. Frame times are the sheet's.
import { S, $, pref, reducedMotion } from './core.js';
import { hooks } from './hooks.js';
import { fit, tok, isDark, watch, ordered, paint, lerp, smooth } from './dither.js';

const W = 48, H = 52;
const ROW = { idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
const ends = (n, each, last) => [...Array(n - 1).fill(each), last];
const TIMES = {
  idle: [280, 110, 110, 140, 140, 320], waving: ends(4, 140, 280), jumping: ends(5, 140, 280), failed: ends(8, 140, 240),
  waiting: ends(6, 150, 260), running: ends(6, 120, 220), review: ends(6, 150, 280), 'running-right': ends(8, 120, 220), 'running-left': ends(8, 120, 220),
};
const HOLD = { failed: 4 }; // the pose a slumped Mote keeps: the failed row's lowest point, not its recovery
const LOOK_NEAR = 36, LOOK_FAR = 480, LOOK_HOLD = 2500; // px: inside is looked at by nobody; beyond is ignored; ms

export const moteHTML = (pose = '') => `<span class="mote"${pose ? ` data-pose="${pose}"` : ''} aria-hidden="true"></span>`;

class Mote {
  // hold: a state whose last frame it keeps when at rest (home's slumped Mote), instead of idling and looking around
  constructor(el, { hold = null } = {}) {
    this.el = el; this.base = 'idle'; this.once = null; this.timer = 0; this.looking = false; this.lookTimer = 0; this.hold = hold;
    this.draw(0, 0); this.rest();
  }
  draw(row, col) { this.el.style.backgroundPosition = `${-col * W}px ${-row * H}px`; }
  stop() { clearTimeout(this.timer); this.timer = 0; }
  pause() { this.stop(); clearTimeout(this.lookTimer); this.looking = false; this.once = null; }
  // play a state's frames: once, then back to what the desk is doing; or around and around for a working state
  run(state, loop) {
    this.stop(); this.looking = false; clearTimeout(this.lookTimer);
    const row = ROW[state], times = TIMES[state];
    if (reducedMotion() || document.hidden) { // a still pose that says the same, held as long as the motion would take
      this.draw(row, state === 'jumping' ? 2 : times.length > 2 ? 1 : 0);
      if (!loop && !document.hidden) this.timer = setTimeout(() => this.done(), Math.max(1200, times.reduce((a, b) => a + b, 0)));
      return;
    }
    let i = 0;
    const step = () => {
      this.draw(row, i);
      const t = times[i];
      i++;
      if (i >= times.length) { if (!loop) { this.timer = setTimeout(() => this.done(), t); return; } i = 0; }
      this.timer = setTimeout(step, t);
    };
    step();
  }
  done() { this.once = null; this.rest(); }
  // still, on the first idle frame, with a breath every seven to twelve seconds
  rest() {
    if (this.once) return; // a move in progress owns the timer and comes back here when it ends
    this.stop();
    if (this.base !== 'idle') return this.run(this.base, true);
    if (this.hold) return this.draw(ROW[this.hold], HOLD[this.hold] ?? TIMES[this.hold].length - 1);
    this.draw(0, 0);
    if (reducedMotion() || document.hidden) return;
    this.timer = setTimeout(() => { if (!this.looking) { this.once = 'breath'; this.run('idle', false); } }, 7000 + Math.random() * 5000);
  }
  set(base) { if (base === this.base) return; this.base = base; if (!this.once) this.rest(); }
  play(state) { if (this.once && this.once !== 'breath') return; this.once = state; this.run(state, false); }
  // look toward a point: 16 directions, clockwise from straight up; near or far, it goes back to rest
  lookAt(x, y) {
    if (this.hold || this.base !== 'idle' || (this.once && this.once !== 'breath') || reducedMotion() || document.hidden) return;
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height * 0.4), d = Math.hypot(dx, dy);
    if (d > LOOK_FAR) return;
    if (d < LOOK_NEAR) { if (this.looking) { this.looking = false; clearTimeout(this.lookTimer); this.rest(); } return; }
    if (this.once === 'breath') this.once = null;
    this.stop(); this.looking = true;
    const k = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360 / 22.5) % 16;
    this.draw(9 + (k >> 3), k & 7);
    clearTimeout(this.lookTimer);
    this.lookTimer = setTimeout(() => { if (this.looking) { this.looking = false; this.rest(); } }, LOOK_HOLD);
  }
}

// ------------------------------------------------------------------ its lens's light on the desk
// Mote holds a lens, and a lens held over a desk throws a spot of light on it. The spot is how much of the change is
// left: with most of it unread the light is spread wide and weak, a pale disc inside the lens's shadow; it gathers as
// the lines left fall; with every file viewed it is one point, the shadow deepens round it, and a four-pointed glint
// stands on it while Mote jumps (held, with reduced motion). Drawn on Mote's own grid, one art pixel to a CSS pixel,
// with the app's 4×4 Bayer matrix (docs/COMPONENTS.md, Print textures). The canvas rides in the dock, so it goes
// wherever Mote is dragged, and never takes the pointer.
const LENS_W = 76, LENS_H = 18, FOOT = 9, LX = 46, LY = 11; // the patch of desk, the feet's row on it, where the light lands
let lens = null, share = 1, allNow = false, glintUntil = 0, unwatchLens = null;
function drawLens() {
  if (!lens?.isConnected) return;
  const g = fit(lens), f = share, dark = isDark();
  const r = 1.2 + 10 * f, core = lerp(0.95, 0.3, f), shadowR = 13;
  const field = (x, y) => {
    const fe = ((x - 25) / 17) ** 2 + ((y - FOOT) / 3.2) ** 2; // the contact shadow under its feet
    const contact = fe < 1 ? 0.45 * (1 - smooth(0.4, 1, fe)) + 0.2 : 0;
    const ld = Math.hypot(x - LX, (y - LY) / 0.42); // the lens's shadow, squashed onto the desk; deeper round a gathered point
    const lensShadow = ld < shadowR ? (0.5 + 0.45 * (1 - f) * (1 - smooth(5, 12, ld))) * (1 - smooth(shadowR - 4, shadowR, ld)) : 0;
    const light = ld < r + 1 ? core * (1 - smooth(r * 0.2, r + 1, ld)) : 0;
    return { ink: Math.max(contact, lensShadow * (1 - Math.min(1, light * 2))), light };
  };
  const mask = ordered(g, (x, y) => field(x, y).ink, { cell: g.d, ink: 1 });
  ordered(g, (x, y) => field(x, y).light, { cell: g.d, ink: 2, into: mask });
  if (allNow && (Date.now() < glintUntil || reducedMotion())) {
    const put = (ax, ay) => { for (let Y = ay * g.d; Y < (ay + 1) * g.d; Y++) for (let X = ax * g.d; X < (ax + 1) * g.d; X++) if (X < g.W && Y < g.H) mask[Y * g.W + X] = 3; };
    for (let k = -3; k <= 3; k++) { put(LX + k, LY); put(LX, LY + k); }
    for (const [dx, dy] of [[-1, -1], [1, 1], [1, -1], [-1, 1]]) put(LX + dx, LY + dy);
  }
  const hi = tok('--hi'); // the light is the app's own highlight, light in both themes; the shadow is ink, seen through
  paint(lens, g, mask, [null, dark ? [0, 0, 0, 200] : [...tok('--ink').slice(0, 3), 120], [...hi.slice(0, 3), dark ? 220 : 255], hi]);
}

// ------------------------------------------------------------------ the floating one on a change's page
let main = null, words = null, wordsTimer = 0, helloTimer = 0, lastBusy = new Map(), briefWas = false, allWas = null;
const say = (text, ms = 0) => {
  if (!words) return;
  clearTimeout(wordsTimer);
  words.textContent = text || '';
  if (text) { const dock = $('#motedock'); if (dock) aim(dock); }
  if (main) main.el.title = text || 'Mote';
  if (ms && !document.hidden) wordsTimer = setTimeout(() => say(status()), ms);
};
const kindOf = (m) => (m?.role === 'codex' ? 'Codex' : 'Claude');
// what is running now, in a few words
function status() {
  const b = S.review?.brief;
  if (b?.pending) return b.tldr ? 'Rewriting the guide and map' : 'Writing the guide and map';
  const run = Object.values(S.review?.convs || {}).flatMap((c) => c.messages || []).find((m) => m.pending && m.role !== 'user');
  return run ? `${kindOf(run)} is answering` : '';
}
// where it floats: the spot you dragged it to, as a share of the window so a resize keeps it in view; else the corner,
// where its bubble opens to its left. (The spot is kept under a new name since the corner moved from the bottom left:
// a spot dragged out from the old corner is not kept.)
const SPOT = 'moteSpot';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function place(dock) {
  const at = pref.get(SPOT, null);
  if (!at) { dock.style.left = dock.style.top = dock.style.bottom = ''; aim(dock); return; }
  const x = clamp(at.x * innerWidth, 4, innerWidth - W - 4), y = clamp(at.y * innerHeight, 4, innerHeight - H - 4);
  dock.style.left = `${Math.round(x)}px`; dock.style.top = `${Math.round(y)}px`; dock.style.bottom = 'auto';
  aim(dock);
}
addEventListener('resize', () => { const d = $('#motedock'); if (d) place(d); });
// its bubble opens toward the side with more room (in the corner, over the diff); checked wherever it is put, when it
// has something to say, and when the inspector opens, closes or is resized
let panelWatch = null;
function aim(dock) { const r = dock.getBoundingClientRect(); dock.classList.toggle('flip', r.left > innerWidth - r.right); }
// mount into its floating spot; called when a change opens
hooks.moteMount = (allViewed, left = 1) => {
  const dock = $('#motedock');
  main?.pause();
  clearTimeout(wordsTimer); clearTimeout(helloTimer);
  words = null;
  if (!dock) { main = null; return; }
  dock.innerHTML = `<canvas class="motelight" aria-hidden="true" style="width:${LENS_W}px;height:${LENS_H}px;top:${H - FOOT - 4}px"></canvas>${moteHTML()}<span class="mw"></span>`;
  place(dock);
  panelWatch?.disconnect();
  const panel = $('#panel');
  if (panel) { panelWatch = new ResizeObserver(() => aim(dock)); panelWatch.observe(panel); }
  lens = dock.querySelector('.motelight'); share = left; allNow = !!allViewed; glintUntil = 0;
  unwatchLens?.(); unwatchLens = watch(lens, drawLens);
  main = new Mote(dock.querySelector('.mote'));
  words = dock.querySelector('.mw');
  lastBusy = new Map(); briefWas = !!S.review?.brief?.pending; allWas = !!allViewed;
  hooks.mote.sync();
  if (!document.hidden) helloTimer = setTimeout(() => { if (main.base === 'idle') main.play('waving'); }, 500);
};
hooks.mote = {
  // after any change to answers, the brief or a dialog: the working pose while something runs, and what just ended
  sync() {
    if (!main) return;
    const b = S.review?.brief;
    const pending = new Map();
    for (const c of Object.values(S.review?.convs || {})) for (const m of c.messages || []) if (m.pending && m.role !== 'user') pending.set(m.id, c.id);
    const ended = [...lastBusy.keys()].filter((id) => !pending.has(id));
    let failed = false, landed = false;
    for (const id of ended) {
      const m = S.review?.convs?.[lastBusy.get(id)]?.messages?.find((x) => x.id === id);
      if (m?.error) failed = true; else if (m) landed = true;
    }
    if (briefWas && !b?.pending) { if (b?.error) failed = true; else landed = true; }
    lastBusy = pending; briefWas = !!b?.pending;
    main.set(pending.size || b?.pending ? 'running' : document.querySelector('.sheetscrim') ? 'waiting' : 'idle');
    if (failed) { main.play('failed'); say(ended.length ? 'That answer failed' : 'The guide failed', 5000); }
    else if (landed) { main.play('review'); say(ended.length ? 'Answer ready' : 'Guide ready', 4000); }
    else say(status());
  },
  // after the viewed count changes: a jump when the last file goes viewed, and the lens's light gathered to match
  progress(all, left = share) {
    if (!main) return;
    share = left; allNow = !!all;
    if (allWas === false && all) { main.play('jumping'); say('Every file viewed', 4000); glintUntil = Date.now() + 1400; setTimeout(drawLens, 1450); }
    allWas = all;
    drawLens();
  },
  // what it is doing, for tests and for the curious
  state: () => main && { base: main.base, once: main.once, looking: main.looking, hidden: document.hidden, reduced: reducedMotion() },
  // a dialog's send went through, or did not
  acted(ok) { if (!main) return; main.play(ok ? 'jumping' : 'failed'); hooks.mote.sync(); },
};

// ------------------------------------------------------------------ the still ones on home
// home's quiet states: Mote at rest where nothing waits on you, slumped where a link led nowhere
const homeMotes = new Set();
function pruneHomeMotes() {
  for (const m of homeMotes) if (!m.el.isConnected) { m.pause(); homeMotes.delete(m); }
}
export function wakeMotes(root = document) {
  pruneHomeMotes();
  for (const el of root.querySelectorAll('.mote[data-pose]:not([data-awake])')) {
    el.dataset.awake = '1';
    const failed = el.dataset.pose === 'failed', m = new Mote(el, { hold: failed ? 'failed' : null });
    if (failed) m.play('failed');
    homeMotes.add(m);
  }
}

// ------------------------------------------------------------------ the pointer, and a click to say hello
let raf = 0, px = 0, py = 0;
document.addEventListener('pointermove', (e) => {
  px = e.clientX; py = e.clientY;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (main?.el.isConnected) main.lookAt(px, py);
    pruneHomeMotes();
    for (const m of homeMotes) m.lookAt(px, py);
  });
}, { passive: true });
// a press that moves carries it; one that does not says hello
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const m = e.target.closest?.('#motedock .mote');
  if (!m || e.button !== 0) return;
  const dock = m.parentElement, r = dock.getBoundingClientRect();
  drag = { dock, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
  m.setPointerCapture?.(e.pointerId); e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  drag.moved = true; drag.dock.classList.add('drag');
  const x = clamp(e.clientX - drag.dx, 4, innerWidth - W - 4), y = clamp(e.clientY - drag.dy, 4, innerHeight - H - 4);
  Object.assign(drag.dock.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto' });
  aim(drag.dock);
});
document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null; d.dock.classList.remove('drag');
  if (!d.moved) { main?.play('waving'); return; }
  const r = d.dock.getBoundingClientRect();
  pref.set(SPOT, { x: r.left / innerWidth, y: r.top / innerHeight });
});
// a double click sends it back to its corner
document.addEventListener('dblclick', (e) => { const dock = e.target.closest?.('#motedock'); if (dock) { pref.set(SPOT, null); place(dock); } });
// a hidden tab keeps no timers; it picks up again on the right frame
document.addEventListener('visibilitychange', () => {
  pruneHomeMotes();
  if (document.hidden) {
    clearTimeout(wordsTimer); clearTimeout(helloTimer);
    main?.pause();
    for (const m of homeMotes) m.pause();
  } else {
    if (main) { main.pause(); main.rest(); say(status()); }
    for (const m of homeMotes) { m.pause(); m.rest(); }
  }
});
