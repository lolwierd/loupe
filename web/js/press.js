// The column while a change is not ready, drawn as the print shop would show it (docs/COMPONENTS.md, Print textures).
//
// Opening a pull request: once GitHub has said how big it is (before a byte of it is fetched), the column shows its
// forme, one dot for every changed line, set in rows like type. A brayer rolls ink across it, pass after pass, while the
// fetch runs: ahead of the roller the dots are bare metal (a speck each), under its soft edge they take ink unevenly,
// as rolled ink does, and behind it they stay inked. You see the size of the job before you start it.
//
// A change that could not be opened: two line screens laid over each other, one turned by the base's name and one by
// the head's, out of register, so a moiré rises out of them round the message. Still: it is a fault, not a process.
import { S, reducedMotion } from './core.js';
import { fit, tok, watch, lines, paint, frames, noise, fbm, clamp, smooth, hash, BAYER4 } from './dither.js';

// ------------------------------------------------------------------ the forme
const PITCH = 7, DOT = 4.2, COLS = 64, PASS = 2600; // CSS px between dots, the largest dot, most dots to a row, ms a pass
const MOST = COLS * 40;                              // past this many lines a dot stands for several, so the forme keeps its size
let forme = null; // { id, lines, el, ink, stop, unwatch, running, last }: kept across the state box being drawn again

function buildForme(lines) {
  const per = Math.ceil(lines / MOST), n = Math.ceil(lines / per);
  const el = document.createElement('div');
  el.className = 'forme';
  el.innerHTML = `<canvas aria-hidden="true"></canvas><p class="cap"><b>${lines.toLocaleString()}</b> lines to read${per > 1 ? ` <span class="faint">·</span> a dot for every ${per.toLocaleString()}` : ''}</p>`;
  return { el, cols: 0, n, lines, ink: new Float32Array(n), lumps: noise(n), running: false, last: 0 };
}
// set in rows about 2.6 times as wide as deep, as wide as the column allows at the same pitch (a narrow column gets
// longer rows, not smaller dots); a dot's ink is its own, whatever row it lands in
function layoutForme(f) {
  const st = f.el.closest('.state'), cs = st && getComputedStyle(st);
  const room = st ? st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : COLS * PITCH;
  const cols = Math.max(1, Math.min(COLS, Math.ceil(Math.sqrt(f.n * 2.6)), Math.floor(room / PITCH)));
  if (cols === f.cols) return;
  f.cols = cols;
  f.pass = undefined;
  Object.assign(f.el.querySelector('canvas').style, { width: `${cols * PITCH}px`, height: `${Math.ceil(f.n / cols) * PITCH}px` });
}
function drawForme(f, ms) {
  const c = f.el.querySelector('canvas');
  if (!c.isConnected) { f.running = false; return false; }
  f.last = ms;
  const g = fit(c), w = f.cols * PITCH, { n, cols, ink, lumps } = f;
  const pass = Math.floor(ms / PASS), t = (ms % PASS) / PASS, dir = pass % 2 ? -1 : 1;
  const travel = t * t * (3 - 2 * t);
  const rx = dir > 0 ? -40 + travel * (w + 80) : w + 40 - travel * (w + 80);
  const ctx = c.getContext('2d');
  ctx.setTransform(g.d, 0, 0, g.d, 0, 0);
  ctx.clearRect(0, 0, g.w, g.h);
  if (f.pass !== pass) {
    f.pass = pass;
    f.load = Float32Array.from(ink, (_, i) => {
      const x = ((i % cols) + 0.5) * PITCH, y = (Math.floor(i / cols) + 0.5) * PITCH;
      const load = clamp(0.42 + 0.8 * (fbm(lumps, x / 46 + pass * 3.1, y / 15) - 0.25));
      return load ** (pass ? 1 : 1.8) * Math.min(1, 0.7 + 0.15 * pass);
    });
  }
  const dot = (x, y, radius) => { ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2); };
  ctx.beginPath();
  for (let i = 0; i < n; i++) dot(((i % cols) + 0.5) * PITCH, (Math.floor(i / cols) + 0.5) * PITCH, 0.52);
  ctx.fillStyle = f.bare;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = ((i % cols) + 0.5) * PITCH, y = (Math.floor(i / cols) + 0.5) * PITCH;
    ink[i] = Math.max(ink[i], f.load[i] * smooth(-26, 10, (rx - x) * dir));
    if (ink[i] > 0) dot(x, y, (DOT / 2) * Math.sqrt(ink[i]));
  }
  ctx.fillStyle = f.colour;
  ctx.fill();
  return true;
}
// roll the brayer (again, after the box was drawn without it); a still forme is drawn again on theme changes
function rollForme(f) {
  f.stop?.();
  colourForme(f);
  f.running = true;
  let rolled = false; // reduced motion turned on mid-roll stops it where it is; from the start, it shows the set still
  f.stop = frames((ms, still) => {
    if (still) { f.running = false; return drawForme(f, rolled ? f.last : f.t0 + ms); }
    rolled = true;
    return drawForme(f, f.t0 + ms);
  }, { rest: PASS * 0.55 });
}
function mountForme(box, pr, lines) {
  if (forme?.id !== S.id || forme.lines !== lines) {
    forme?.stop?.(); forme?.unwatch?.();
    const f = forme = { id: S.id, ...buildForme(lines), t0: 0 };
    if (pr.changedFiles) f.el.querySelector('.cap').insertAdjacentHTML('beforeend', ` <span class="faint">·</span> ${pr.changedFiles.toLocaleString()} files`);
    box.append(f.el);
    layoutForme(f);
    rollForme(f);
    watchForme(f);
    return;
  }
  box.append(forme.el); // the same change: the same forme, inking on from where it was (a Try again after a failure)
  layoutForme(forme);
  resume(forme);
}
// a stopped forme rolls on from where it stopped; with reduced motion it is drawn again as it stands
function resume(f) {
  if (f.running) return;
  if (reducedMotion()) drawForme(f, f.last);
  else { f.t0 = f.last; rollForme(f); }
}
// the forme follows the column's width; a still one is drawn again on theme changes and rolls on when motion is
// turned back on. It is watched until the change opens (endOpening), off the page or not (a failure, then Try again)
function colourForme(f) {
  f.colour = `rgba(${tok('--ink').slice(0, 3)},1)`;
  f.bare = `rgba(${tok('--ink-3').slice(0, 3)},1)`;
}
function watchForme(f) {
  f.unwatch = watch(document.getElementById('cards') || f.el, () => {
    if (!f.el.isConnected) return;
    layoutForme(f);
    colourForme(f);
    resume(f); // a running one: its next frame draws it
  });
}

// ------------------------------------------------------------------ the moiré
let moireStop = null;
function moire(state, refs) {
  moireStop?.(); state.querySelector(':scope > canvas.moire')?.remove(); // a newer record (its real refs) draws it again
  const c = document.createElement('canvas');
  c.className = 'moire'; c.setAttribute('aria-hidden', 'true');
  state.prepend(c);
  const a1 = 30 + (hash(refs[0]) % 300) / 10, a2 = a1 + 2.2 + (hash(refs[1]) % 34) / 10;
  const p1 = 5, p2 = 5 + ((hash(refs.join(' ')) % 5) - 2) * 0.06;
  const stop = moireStop = watch(c, () => {
    if (!c.isConnected) return stop();
    const g = fit(c), box = state.querySelector('.box')?.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const bx = box ? box.left - cr.left + box.width / 2 : g.w / 2, by = box ? box.top - cr.top + box.height / 2 : g.h / 2;
    const bw = (box?.width || 320) / 2 + 40, bh = (box?.height || 120) / 2 + 36;
    // clear round the message, full a little way out, dissolving again toward the column's edges
    const room = (x, y) => smooth(1, 2.4, Math.hypot((x - bx) / bw, (y - by) / bh)) * smooth(0, 200, Math.min(x, g.w - x, y, g.h - y));
    const mask = lines(g, (x, y) => (room(x, y) > 0.02 ? 1.15 / g.d / p1 : 0), { pitch: p1, angle: a1 });
    lines(g, (x, y) => (room(x, y) > 0.02 ? 1.15 / g.d / p2 : 0), { pitch: p2, angle: a2, into: mask });
    for (let Y = 0; Y < g.H; Y++) for (let X = 0; X < g.W; X++) {
      const i = Y * g.W + X;
      if (mask[i] && room((X + 0.5) / g.d, (Y + 0.5) / g.d) * 16 <= BAYER4[(Y & 3) * 4 + (X & 3)] + 0.5) mask[i] = 0;
    }
    paint(c, g, mask, [null, [...tok('--ink-3').slice(0, 3), 150]]);
  });
}

// The change is open. An opening is never cut mid-roll: the brayer finishes the pass it is on, so every dot has taken
// its ink, and only then do the forme and the moiré let go of their clocks and watchers. Resolves when the page may draw
// the change; at once when nothing is rolling (no forme, a still one, reduced motion). Called again while it waits, it
// gives the same wait.
export function endOpening() {
  moireStop?.(); moireStop = null;
  const f = forme;
  if (f?.ending) return f.ending;
  const done = () => { f?.stop?.(); f?.unwatch?.(); if (forme === f) forme = null; };
  if (!f || !f.running || !f.el.isConnected || reducedMotion()) { done(); return Promise.resolve(); }
  const left = PASS - (f.last % PASS) + 1000 / 60; // to the end of this pass, and its last frame drawn
  return (f.ending = new Promise((resolve) => setTimeout(() => { done(); resolve(); }, left)));
}

// Called each time the state box is drawn, and again when a newer record arrives: the box's own state (failed or
// opening) decides what it shows; m is the change's record as the daemon last gave it.
export function decorateState(state, { error, m }) {
  if (error) {
    const pr = m?.rec?.pr, refs = pr ? [pr.baseRefName || 'base', pr.headRefName || 'head'] : [m?.rec?.base || S.id || 'base', m?.rec?.branch || m?.branch || 'head'];
    moire(state, refs);
    return;
  }
  moireStop?.(); moireStop = null; // a Try again: the fault's screen is gone
  const pr = m?.rec?.pr, lines = (pr?.additions || 0) + (pr?.deletions || 0);
  if (lines) mountForme(state.querySelector('.box'), pr, lines);
}
