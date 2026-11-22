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
import { BAYER4, fit, rgba, isDark, lerp, smooth } from './dither.js';

const PITCH = 3; // CSS px between lamp centres
const ROWS = 4;
const HEAD = 16; // CSS px above the board where sparks fly (the canvas reaches up into the bar)
const hashf = (a, b) => { let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export function meter(host, { onPick, onHover } = {}) {
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  host.append(cv);
  let segs = [], hover = null, alive = 0, raf = 0, last = 0, time = 0, edge = 0, glint = -1, openingAt = null, colors = null, settled = false;
  const shown = new Map(), level = new Map(), read = new Map(), burns = new Map(), sparks = [];
  const prev = new Map(); // a block's state before its last change, for the part of it the burning edge has not reached
  const theme = () => {
    colors = { left: rgba('var(--ink-3)'), read: rgba('var(--ink-2)'), done: rgba('var(--ok)'), stale: rgba('var(--warn)'), hi: rgba(isDark() ? 'var(--hi)' : 'var(--ink)') };
  };
  theme();
  const mix = (from, to, t) => from === to || t <= 0 ? from : t >= 1 ? to : from.slice(0, 3).map((v, i) => Math.round(lerp(v, to[i], t)));
  const css = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

  // where each block sits this frame, in CSS px from the board's left edge
  function placed(w) {
    const out = []; let x = 0;
    const total = segs.reduce((n, s) => n + (shown.get(s.path) || 0), 0) || 1;
    const fill = Math.min(1, total); // during the opening the blocks have not all grown in yet
    for (const s of segs) { const v = (shown.get(s.path) || 0) / total * fill * w; out.push({ s, x0: x, x1: x + v }); x += v; }
    return { out, filled: x };
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016); last = now; time += dt;
    const still = reducedMotion();
    let moving = false;
    const openingNow = openingAt !== null;
    const opening = openingAt === null ? 1 : still ? 1 : smooth(0, 600, now - (openingAt ||= now));
    if (opening === 1) openingAt = null;
    else moving = true;
    const sum = segs.reduce((n, s) => n + s.w, 0) || 1;
    for (const s of segs) {
      const want = s.w / sum, from = shown.get(s.path) ?? 0;
      let to = openingNow ? want * opening : still ? want : lerp(from, want, -Math.expm1(-dt * 9));
      if (Math.abs(want - to) < 0.0002) to = want; else moving = true;
      shown.set(s.path, to);
      const lw = hover === null ? (s.cur ? 1.25 : 1) : hover === s.path ? 1.3 : 0.38;
      const lf = level.get(s.path) ?? lw;
      let ln = still ? lw : lf + (lw - lf) * (-Math.expm1(-dt * 12));
      if (Math.abs(lw - ln) < 0.01) ln = lw; else moving = true;
      level.set(s.path, ln);
      const before = read.get(s.path) ?? s.read;
      const amount = still ? s.read : lerp(before, s.read, -Math.expm1(-dt * 12));
      if (Math.abs(s.read - amount) > 0.001) { read.set(s.path, amount); moving = true; }
      else read.set(s.path, s.read);
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
      if (!p) continue;
      const inBlock = p.x1 - p.x0 < PITCH * 2 ? 1
        : smooth(0, PITCH * 0.6, Math.min(cx - p.x0, p.x1 - cx));
      const coverage = inBlock * smooth(-PITCH / 2, PITCH / 2, filled - cx);
      if (!coverage) continue;
      // the white edge: growing in at the opening, burning across a block as it is viewed, crossing the board at the end
      const lead = edge > 0 ? (1 - smooth(0, PITCH * 3, Math.abs(filled - cx))) * Math.min(1, edge * 2) : 0;
      const b = p && burns.get(p.s.path), bx = b ? p.x0 + (p.x1 - p.x0) * Math.min(1, b.t) : 0;
      const burn = b ? (1 - smooth(0, PITCH * 2, Math.abs(cx - bx))) * (1 - smooth(1, 1.25, b.t)) : 0;
      const gx = glint >= 0 ? glint * (w + PITCH * 6) - PITCH * 3 : -99, gl = 1 - smooth(0, PITCH * 3.5, Math.abs(cx - gx));
      const hot = Math.max(lead, burn, gl);
      if (b && burn > 0 && !still && Math.random() < -Math.expm1(-dt * 45)) spark(cx, top + Math.random() * ROWS * PITCH, p.s.state);
      for (let row = 0; row < ROWS; row++) {
        const cy = top + row * PITCH + PITCH / 2;
        const s = p.s, lv = level.get(s.path) ?? 1;
        const kind = hashf(c, row), phase = hashf(row + 101, c + 17);
        const flicker = 1 - alive * 0.3 * (0.5 + 0.5 * Math.sin(time * (1.2 + phase * 3) + phase * 40));
        const rank = (BAYER4[(row & 3) * 4 + (c & 3)] + 0.5) / 16;
        const reading = smooth(rank - 0.06, rank + 0.06, read.get(s.path) ?? 0);
        const ink = (state) => state === 'done'
          ? [kind > 0.88 ? colors.hi : colors.done, kind > 0.88 ? 0.9 : 0.55 + 0.4 * (kind / 0.88)]
          : state === 'stale' ? [colors.stale, 0.85] : [mix(colors.left, colors.read, reading), lerp(0.42, 0.9, reading)];
        let [col, a] = ink(s.state);
        if (b && prev.has(s.path)) {
          const [before, alpha] = ink(prev.get(s.path));
          const passed = Math.max(smooth(-PITCH, PITCH, bx - cx), smooth(0.96, 1.25, b.t));
          col = mix(before, col, passed);
          a = lerp(alpha, a, passed);
        }
        const heat = hot * (1 - smooth(0.27 + hot * 0.65, 0.43 + hot * 0.65, kind));
        ctx.fillStyle = css(mix(col, colors.hi, heat), lerp(a, 1, heat) * lv * flicker * coverage);
        dot(ctx, cx, cy, r);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const q = sparks[i];
      q.life -= dt; if (q.life <= 0) { sparks.splice(i, 1); continue; }
      q.vy -= 40 * dt; q.vx *= 1 - Math.min(1, dt * 1.5); q.x += q.vx * dt; q.y += q.vy * dt;
      ctx.fillStyle = css(q.col, Math.min(1, (q.life / q.span) * 1.4));
      ctx.fillRect(q.x, q.y, 1, 1);
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
  const retheme = () => {
    theme();
    if (document.documentElement.classList.contains('theme-capture')) { cancelAnimationFrame(raf); frame(performance.now()); }
    else kick();
  };
  mq.addEventListener('change', retheme);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  motion.addEventListener('change', kick);
  const mo = new MutationObserver(retheme); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const ro = new ResizeObserver(kick); ro.observe(host);

  return {
    // segs: [{ path, w (lines), state: 'left'|'done'|'stale', read 0..1, cur }], in reading order
    update(next, { opening = false } = {}) {
      const was = new Map(segs.map((s) => [s.path, s.state]));
      const still = reducedMotion();
      if (opening) { openingAt = 0; shown.clear(); level.clear(); read.clear(); burns.clear(); prev.clear(); sparks.length = 0; glint = -1; edge = still ? 0 : 1; }
      for (const s of next) {
        const before = was.get(s.path);
        if (!opening && !still && before && before !== 'done' && s.state === 'done') { prev.set(s.path, before); burns.set(s.path, { t: 0 }); }
      }
      segs = next;
      kick();
    },
    glint() { if (!reducedMotion()) { glint = 0; kick(); } },
    get settled() { return settled; },
    destroy() { cancelAnimationFrame(raf); raf = 0; mq.removeEventListener('change', retheme); motion.removeEventListener('change', kick); mo.disconnect(); ro.disconnect(); onHover?.(null); },
  };
}
