// Print textures: the few places loupe draws a halftone, a line screen or a forme of dots instead of a flat colour.
// They live only where nothing is being read (a change opening, a change that could not open, the dim behind a write's
// dialog, the desk under Mote) and each is drawn from the change's own state, never from a picture. docs/COMPONENTS.md
// ("Print textures") holds the rules; this file holds the screens.
//
// A texture is a field, f(x, y) → 0..1 in CSS pixels (0 bare paper, 1 full ink), handed to a screen, which decides
// for every device pixel of its canvas whether ink lands there. The canvas's backing store is its CSS size times the
// device pixel ratio and nothing is scaled or smoothed after, so one entry of a mask is one pixel on the glass.
// Colours are the theme's tokens, read through the page, and a canvas is drawn again when the theme or its size changes.
import { reducedMotion } from './core.js';

export const dpr = () => Math.max(1, Math.round(window.devicePixelRatio || 1));

// size a canvas's backing store to its box, at device pixels; w and h come back in CSS pixels
export function fit(canvas) {
  const r = canvas.getBoundingClientRect(), d = dpr();
  const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  return { W, H, d, w: W / d, h: H / d };
}

// a colour in any CSS form (a token, color-mix) as [r, g, b, a 0..255], resolved by a real element so it matches the page
const probeEl = document.createElement('i');
probeEl.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
const probe = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
export function rgba(css) {
  if (!probeEl.isConnected) document.documentElement.append(probeEl);
  probeEl.style.color = '';
  probeEl.style.color = css;
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = getComputedStyle(probeEl).color; probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data];
}
export const tok = (name) => rgba(`var(${name})`);
export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

// fn now, and again whenever the theme, the motion preference or the element's size changes; returns the way to stop
export function watch(el, fn) {
  let raf = 0;
  const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fn()); };
  const mqs = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'].map((q) => matchMedia(q));
  for (const mq of mqs) mq.addEventListener('change', again);
  const mo = new MutationObserver(() => {
    // A view transition suppresses animation frames during its update callback.
    if (document.documentElement.classList.contains('theme-capture')) { cancelAnimationFrame(raf); fn(); }
    else again();
  }); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const ro = new ResizeObserver(again); if (el) ro.observe(el);
  fn();
  return () => { for (const mq of mqs) mq.removeEventListener('change', again); mo.disconnect(); ro.disconnect(); cancelAnimationFrame(raf); };
}

// ------------------------------------------------------------------ numbers
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export function hash(s) { let h = 2166136261 >>> 0; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// smooth value noise, n(x, y) → 0..1: ink is never perfectly even
export function noise(seed = 1) {
  const r = rng(seed), perm = new Uint8Array(512), val = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; val[i] = r(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  const v = (x, y) => val[perm[(perm[x & 255] + y) & 511]];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    return lerp(lerp(v(xi, yi), v(xi + 1, yi), u), lerp(v(xi, yi + 1), v(xi + 1, yi + 1), u), w);
  };
}
export const fbm = (n, x, y, oct = 3) => { let s = 0, a = 0.5, f = 1, t = 0; for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); t += a; a *= 0.5; f *= 2; } return s / t; };

// ------------------------------------------------------------------ screens
// Each fills a mask: one entry per device pixel, 0 for paper and 1.. for an ink.
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]; // the app's one matrix (pixel.js's --d0..--d16)

// ordered dither on cells of cell device pixels, the field read once at each cell's centre
export function ordered(g, field, { cell = 1, ink = 1, into } = {}) {
  const { W, H, d } = g, mask = into || new Uint8Array(W * H);
  for (let cy = 0; cy * cell < H; cy++) {
    const y = (cy + 0.5) * cell / d;
    for (let cx = 0; cx * cell < W; cx++) {
      const v = field((cx + 0.5) * cell / d, y);
      if (v <= 0 || v * 16 <= BAYER4[(cy & 3) * 4 + (cx & 3)] + 0.5) continue;
      for (let yy = cy * cell, ye = Math.min(H, yy + cell); yy < ye; yy++) for (let xx = cx * cell, xe = Math.min(W, xx + cell); xx < xe; xx++) mask[yy * W + xx] = ink;
    }
  }
  return mask;
}

// a line screen: lines pitch CSS px apart at angle degrees, each as thick (in pitches) as the field says where it runs
export function lines(g, field, { pitch = 4, angle = 45, ink = 1, into } = {}) {
  const { W, H, d } = g, mask = into || new Uint8Array(W * H);
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let Y = 0; Y < H; Y++) {
    const y = (Y + 0.5) / d;
    for (let X = 0; X < W; X++) {
      const x = (X + 0.5) / d, u = x * ca + y * sa, v = (-x * sa + y * ca) / pitch, iv = Math.floor(v), cv = (iv + 0.5) * pitch;
      const c = field(u * ca - cv * sa, u * sa + cv * ca);
      if (c > 0 && Math.abs(v - iv - 0.5) < c / 2) mask[Y * W + X] = ink;
    }
  }
  return mask;
}

// letterpress dots: a square grid pitch CSS px apart, each dot as big as the field at its centre (max CSS px across)
export function dots(g, field, { pitch = 6, max = 4, ink = 1, into } = {}) {
  const { W, H, d } = g, mask = into || new Uint8Array(W * H);
  for (let cy = pitch / 2; cy < g.h; cy += pitch) {
    for (let cx = pitch / 2; cx < g.w; cx += pitch) {
      const v = field(cx, cy);
      if (v <= 0) continue;
      const r = (max / 2) * Math.sqrt(Math.min(1, v)) * d, R = Math.ceil(r), CX = cx * d, CY = cy * d;
      const PX = Math.floor(CX), PY = Math.floor(CY); // the pixel under the centre always takes ink, so a speck shows at 1×
      if (PX >= 0 && PY >= 0 && PX < W && PY < H) mask[PY * W + PX] = ink;
      for (let Y = Math.max(0, Math.floor(CY - R)); Y <= Math.min(H - 1, CY + R); Y++) for (let X = Math.max(0, Math.floor(CX - R)); X <= Math.min(W - 1, CX + R); X++) {
        const dx = X + 0.5 - CX, dy = Y + 0.5 - CY;
        if (dx * dx + dy * dy <= r * r) mask[Y * W + X] = ink;
      }
    }
  }
  return mask;
}

// a mask onto its canvas: palette[k] is ink k as [r, g, b, a]; 0 stays clear
export function paint(canvas, g, mask, palette) {
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(g.W, g.H), px = new Uint32Array(img.data.buffer);
  const pal = palette.map((c) => (c ? ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0 : 0));
  for (let i = 0; i < mask.length; i++) if (mask[i]) px[i] = pal[mask[i]];
  ctx.putImageData(img, 0, 0);
}

// Elapsed milliseconds on the display clock, with one final still if reduced motion comes on.
export function frames(fn, { rest = 0 } = {}) {
  if (reducedMotion()) { fn(rest, true); return () => {}; }
  let start, raf;
  const tick = (now) => {
    if (reducedMotion()) { fn(rest, true); return; }
    start ??= now;
    if (fn(now - start, false) !== false) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

// ------------------------------------------------------------------ the tone screen behind every dialog
// Every dialog's dim is a tone screen: a write's as heavy as it is hard to undo (sheets.js sets data-weight), any other
// (the palette, the keys, the map opened large) at the lightest. One cell of the matrix to a CSS pixel, so it reads as a
// fine screen rather than a grey, nearly even and a little lighter round the dialog. The canvas is drawn at CSS pixels
// and shown pixelated, so a 2× screen draws a quarter of the pixels; it is drawn once, whole, and fades in with the
// dialog, never building up in steps.
const TONE = { local: 0.25, public: 0.375, destructive: 0.5625 }; // a quarter heavier in dark: black on a dark page dims it less
export function toneScreen(scrim, box) {
  const cv = document.createElement('canvas');
  cv.className = 'tone'; cv.setAttribute('aria-hidden', 'true');
  scrim.prepend(cv);
  let drawn;
  const draw = () => {
    const r = cv.getBoundingClientRect(), W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    const weight = scrim.dataset.weight || 'local', dark = isDark();
    const L = (TONE[weight] ?? TONE.local) * (dark ? 1.25 : 1);
    const s = box?.isConnected ? box.getBoundingClientRect() : null, reach = 0.45 * Math.max(W, H);
    const position = s ? [s.left - r.left, s.top - r.top, s.width, s.height].map((v) => Math.round(v / 8)) : [];
    const key = [W, H, weight, dark, ...position].join('/');
    if (key === drawn && cv.width === W && cv.height === H) return;
    drawn = key;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const [R, G, B, A] = rgba(weight === 'destructive' ? 'var(--danger)' : 'var(--tone-ink)');
    const ink = ((A << 24) | (B << 16) | (G << 8) | R) >>> 0;
    const ctx = cv.getContext('2d');
    // Light local dialogs use a single repeated tile across the whole scrim.
    const low = Math.ceil(16 * L * 0.9 - 0.5), high = Math.ceil(16 * L * 1.1 - 0.5);
    if (low === high) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 4;
      const t = tile.getContext('2d'), data = t.createImageData(4, 4);
      new Uint32Array(data.data.buffer).set(BAYER4.map((rank) => rank < low ? ink : 0));
      t.putImageData(data, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = ctx.createPattern(tile, 'repeat');
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer);
    // the level changes slowly, so it is read once per 4×4 tile of the matrix, at the tile's centre
    for (let ty = 0; ty < H; ty += 4) {
      const gy = r.top + ty + 2, dy = s ? Math.max(s.top - gy, 0, gy - s.bottom) : reach;
      for (let tx = 0; tx < W; tx += 4) {
        const gx = r.left + tx + 2, dx = s ? Math.max(s.left - gx, 0, gx - s.right) : reach;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const v16 = 16 * L * (0.9 + 0.2 * smooth(0, reach, distance));
        for (let y = ty, ye = Math.min(H, ty + 4); y < ye; y++) {
          const row = (y & 3) * 4, base = y * W;
          for (let x = tx, xe = Math.min(W, tx + 4); x < xe; x++) if (v16 > BAYER4[row + (x & 3)] + 0.5) px[base + x] = ink;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  };
  // drawn now (watch calls it at once), and again when the window, the theme or the dialog's size changes, or the write
  // turns harder to undo
  const stopWatch = watch(cv, draw);
  const ro = new ResizeObserver(draw); if (box) ro.observe(box);
  const mo = new MutationObserver(draw); mo.observe(scrim, { attributes: true, attributeFilter: ['data-weight'] });
  return () => { stopWatch(); ro.disconnect(); mo.disconnect(); cv.remove(); };
}
// Any dialog the page opens gets its screen, wherever it is put, and loses it (and its observers) when it leaves the page.
const toned = new Map();
const scrimsIn = (n) => (n.nodeType !== 1 ? [] : [...(n.matches('.scrim, .sheetscrim') ? [n] : []), ...n.querySelectorAll('.scrim, .sheetscrim')]);
new MutationObserver((records) => {
  for (const r of records) {
    // the diff, the panels and the file list redraw often and never hold a dialog: their changes are not looked through
    if (r.target.closest?.('#cards, #pbody, #tree, #vbody')) continue;
    for (const n of r.removedNodes) for (const s of scrimsIn(n)) if (toned.has(s) && !s.isConnected) { toned.get(s)(); toned.delete(s); }
    for (const n of r.addedNodes) for (const s of scrimsIn(n)) {
      if (toned.has(s) || !s.isConnected) continue;
      if (!s.dataset.weight) s.dataset.weight = 'local';
      toned.set(s, toneScreen(s, s.querySelector(':scope > .palette, :scope > .sheet') || s.firstElementChild));
    }
  }
}).observe(document.body, { childList: true, subtree: true });
