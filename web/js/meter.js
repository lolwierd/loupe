// The meter: the top bar's strip of the change, drawn as a board of lamps. One block per file in reading order, as wide as
// its changed lines; a file not yet read is dim, the share of it you have scrolled through is lit, a viewed file is green
// (with a few lamps burning hot), and one that changed since you viewed it is amber. Hot is white on a dark page and ink on
// a light one, where white would vanish. It is an instrument, so it moves
// only when something happened:
// - the blocks grow into place when a change opens, behind a white leading edge;
// - marking a file viewed burns a white edge across its block, which turns it green as it passes and throws sparks up;
// - the last file viewed sends one edge across the whole board;
// - touching it wakes it: the block under the pointer lights, the rest dim, the lamps flicker, and the label below names
//   the file; a click goes there.
// With reduced motion every one of these is its end state at once.
import { reducedMotion } from './core.js';
import { fit, rgba, isDark } from './dither.js';

const PITCH = 3; // CSS px between lamp centres
const ROWS = 4;
const HEAD = 16; // CSS px above the board where sparks fly (the canvas reaches up into the bar)
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const hashf = (a, b) => { let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export function meter(host, { onPick, onHover } = {}) {
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  host.append(cv);
  let segs = [], hover = null, alive = 0, raf = 0, last = 0, time = 0, edge = 0, glint = -1, colors = null, settled = false;
  const shown = new Map(), level = new Map(), burns = new Map(), sparks = [];
  const prev = new Map(); // a block's state before its last change, for the part of it the burning edge has not reached
  const theme = () => {
    colors = { left: rgba('var(--ink-3)'), read: rgba('var(--ink-2)'), done: rgba('var(--ok)'), stale: rgba('var(--warn)'), hi: rgba(isDark() ? 'var(--hi)' : 'var(--ink)') };
  };
  theme();
  const css = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

  // where each block sits this frame, in CSS px from the board's left edge
  function placed(w) {
    const out = []; let x = 0;
    const total = segs.reduce((n, s) => n + (shown.get(s.path) || 0), 0) || 1;
    const fill = Math.min(1, total); // during the opening the blocks have not all grown in yet
    for (const s of segs) { const v = (shown.get(s.path) || 0) / Math.max(1, total) * fill * w; out.push({ s, x0: x, x1: x + v }); x += v; }
    return { out, filled: x };
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016); last = now; time += dt;
    const still = reducedMotion();
    let moving = false;
    const sum = segs.reduce((n, s) => n + s.w, 0) || 1;
    for (const s of segs) {
      const want = s.w / sum, from = shown.get(s.path) ?? 0;
      let to = still ? want : from + (want - from) * Math.min(1, dt * 9);
      if (Math.abs(want - to) < 0.0002) to = want; else moving = true;
      shown.set(s.path, to);
      const lw = hover === null ? (s.cur ? 1.25 : 1) : hover === s.path ? 1.3 : 0.38;
      const lf = level.get(s.path) ?? lw;
      let ln = still ? lw : lf + (lw - lf) * Math.min(1, dt * 12);
      if (Math.abs(lw - ln) < 0.01) ln = lw; else moving = true;
      level.set(s.path, ln);
    }
    const aw = hover !== null && !still ? 1 : 0;
    alive += (aw - alive) * Math.min(1, dt * 6); if (Math.abs(aw - alive) > 0.01) moving = true; else alive = aw;
    if (alive > 0) moving = true; // the lamps flicker for as long as the pointer is on the board
    if (still) { edge = 0; burns.clear(); prev.clear(); glint = -1; sparks.length = 0; }
    edge = Math.max(0, edge - dt * 1.6); if (edge > 0) moving = true;
    for (const [p, b] of burns) { b.t += dt / 0.42; if (b.t >= 1.25) { burns.delete(p); prev.delete(p); } else moving = true; }
    if (glint >= 0) { glint += dt / 0.6; if (glint > 1.3) glint = -1; else moving = true; }

    const g = fit(cv), ctx = cv.getContext('2d');
    ctx.setTransform(g.d, 0, 0, g.d, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    const top = g.h - ROWS * PITCH, w = g.w;
    const { out, filled } = placed(w);
    const cols = Math.floor(w / PITCH), off = (w - cols * PITCH) / 2, r = PITCH * 0.27;
    let k = 0;
    for (let c = 0; c < cols; c++) {
      const cx = off + c * PITCH + PITCH / 2;
      while (k < out.length - 1 && cx >= out[k].x1) k++;
      const p = out[k];
      // a block two lamps wide or more keeps a gap at its edges; a narrower one takes whatever column its centre owns, so
      // a change of thousands of files still shows what is viewed
      const within = p && (p.x1 - p.x0 < PITCH * 2 || (cx >= p.x0 + PITCH * 0.3 && cx <= p.x1 - PITCH * 0.3));
      // the white edge: growing in at the opening, burning across a block as it is viewed, crossing the board at the end
      const lead = edge > 0 && cx <= filled ? Math.max(0, 1 - (filled - cx) / (PITCH * 3)) * Math.min(1, edge * 2) : 0;
      const b = p && burns.get(p.s.path), bx = b ? p.x0 + (p.x1 - p.x0) * Math.min(1, b.t) : 0;
      const burn = b && b.t < 1.1 ? Math.max(0, 1 - Math.abs(cx - bx) / (PITCH * 2)) : 0;
      const gx = glint >= 0 ? glint * (w + PITCH * 6) - PITCH * 3 : -99, gl = Math.max(0, 1 - Math.abs(cx - gx) / (PITCH * 2.5));
      const hot = Math.max(lead, burn, gl);
      if (b && burn > 0 && !still && Math.random() < 0.55) spark(cx, top + Math.random() * ROWS * PITCH, p.s.state);
      for (let row = 0; row < ROWS; row++) {
        const cy = top + row * PITCH + PITCH / 2;
        if (!within) { ctx.fillStyle = css(colors.left, 0.1); dot(ctx, cx, cy, r * 0.8); continue; }
        const s = p.s, lv = level.get(s.path) ?? 1;
        const state = b && cx > bx ? (prev.get(s.path) || s.state) : s.state;
        const kind = hashf(c, row), phase = hashf(row + 101, c + 17);
        const flicker = 1 - alive * 0.3 * (0.5 + 0.5 * Math.sin(time * (1.2 + phase * 3) + phase * 40));
        let col, a;
        if (hot > 0 && kind < 0.35 + hot * 0.65) { col = colors.hi; a = 0.65 + hot * 0.35; }
        else if (state === 'done') { col = kind > 0.88 ? colors.hi : colors.done; a = kind > 0.88 ? 0.9 : 0.55 + 0.4 * (kind / 0.88); }
        else if (state === 'stale') { col = colors.stale; a = 0.85; }
        else if (s.read > 0 && BAYER4[(row & 3) * 4 + (c & 3)] < s.read * 16) { col = colors.read; a = 0.9; }
        else { col = colors.left; a = 0.42; }
        ctx.fillStyle = css(col, a * lv * flicker);
        dot(ctx, cx, cy, r);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const q = sparks[i];
      q.life -= dt; if (q.life <= 0) { sparks.splice(i, 1); continue; }
      q.vy -= 40 * dt; q.vx *= 1 - Math.min(1, dt * 1.5); q.x += q.vx * dt; q.y += q.vy * dt;
      ctx.fillStyle = css(q.col, Math.min(1, (q.life / q.span) * 1.4));
      ctx.fillRect(Math.round(q.x * g.d) / g.d, Math.round(q.y * g.d) / g.d, 1, 1);
    }
    if (sparks.length) moving = true;
    if (moving) raf = requestAnimationFrame(frame); else { last = 0; settled = true; }
  }
  const dot = (ctx, x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
  function spark(x, y, state) {
    if (sparks.length > 90) return;
    const span = 0.45 + Math.random() * 0.5;
    sparks.push({ x: x + (Math.random() - 0.5) * PITCH, y, vx: (Math.random() - 0.5) * 24, vy: -(18 + Math.random() * 46), life: span, span,
      col: Math.random() < 0.4 ? colors.hi : state === 'stale' ? colors.stale : colors.done });
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // the pointer: which block is under it, named below the board; a click goes to it
  const at = (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    return placed(r.width).out.find((p) => x >= p.x0 && x < p.x1)?.s || null;
  };
  const onMove = (e) => { const s = at(e); if ((s?.path ?? null) !== hover) { hover = s?.path ?? null; kick(); } onHover?.(s, e); };
  host.addEventListener('mousemove', onMove);
  host.addEventListener('mouseleave', () => { hover = null; onHover?.(null); kick(); });
  host.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); const s = at(e); if (s) onPick?.(s); });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const retheme = () => { theme(); kick(); };
  mq.addEventListener('change', retheme);
  const mo = new MutationObserver(retheme); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const ro = new ResizeObserver(kick); ro.observe(host);

  return {
    // segs: [{ path, w (lines), state: 'left'|'done'|'stale', read 0..1, cur }], in reading order
    update(next, { opening = false } = {}) {
      const was = new Map(segs.map((s) => [s.path, s.state]));
      const still = reducedMotion();
      if (opening) { shown.clear(); edge = still ? 0 : 1; }
      for (const s of next) {
        const before = was.get(s.path);
        if (!opening && !still && before && before !== 'done' && s.state === 'done') { prev.set(s.path, before); burns.set(s.path, { t: 0 }); }
      }
      segs = next;
      kick();
    },
    glint() { if (!reducedMotion()) { glint = 0; kick(); } },
    get settled() { return settled; },
    destroy() { cancelAnimationFrame(raf); raf = 0; mq.removeEventListener('change', retheme); mo.disconnect(); ro.disconnect(); onHover?.(null); },
  };
}
