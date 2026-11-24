// The impression. Approving prints a rubber stamp over the diff, in the app's own screen, with the head you read in it
// ("at 33ee585 · 22 Nov 2026"). It holds, lifts, and leaves its record on the pull request in the inspector: a small
// impression beside the review pills. When the pull request's head moves past the commit you approved, the small one
// slips out of register: a second plate in amber (changed since, its one job) lands two pixels off under the ink, and
// the line beside it says what the head is now. The daemon keeps the verdict (review.json's verdict: event, head,
// number, at), so it survives a reload and another browser.
//
// The ink is a field per device pixel, screened with the 4×4 Bayer matrix (dither.js), so it reads as a print and never
// as a gradient: heavier where the rubber pressed, a squeeze of ink along every edge, a soft spot where it did not quite
// touch, grain. The angle, the lean and the soft spot are seeded by the head's id, so the same head always prints the
// same stamp. It settles into the paper, holds, and lifts. With reduced motion only the small one is printed.
import { S, $, esc, reducedMotion } from './core.js';
import { hooks } from './hooks.js';
import { tok, isDark, watch, smooth, hash, noise, fbm, BAYER4, dpr } from './dither.js';

const short = (sha) => String(sha || '').slice(0, 7);
const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const font = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const LIFT = 1500; // ms the big stamp holds before it lifts; the small one is printed as it does

// ------------------------------------------------------------------ the ink
// the stamp's shapes drawn rotated into an alpha mask at device pixels; the screen is applied after, upright, so its
// dots stay on the glass's grid
function shapes(W, H, d, { word, sub, small, angle }) {
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = c.getContext('2d', { willReadFrequently: true });
  g.translate(W / 2, H / 2); g.rotate((angle * Math.PI) / 180); g.scale(d, d);
  const w = small ? W / d - 6 : 316, h = small ? H / d - 6 : 100, r = small ? 3 : 7; // the big frame leaves room to turn by 9°
  g.strokeStyle = g.fillStyle = '#000';
  const frame = (x, y, ww, hh, rad) => { g.beginPath(); g.roundRect(x, y, ww, hh, rad); g.stroke(); };
  g.lineWidth = small ? 1.5 : 4; frame(-w / 2, -h / 2, w, h, r); // the double rule: a heavy outer line
  if (!small) { g.lineWidth = 1.5; frame(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, r - 3); } // and a fine inner one
  g.textBaseline = 'middle';
  if (small) {
    const set = (k, sp) => { g.font = `600 10px ${font(k)}`; g.letterSpacing = sp; };
    set('--f-ui', '1px'); const ww = g.measureText(word).width;
    set('--f-mono', '0px'); const sw = g.measureText(sub).width, x0 = -(ww + 6 + sw) / 2;
    g.textAlign = 'left';
    set('--f-ui', '1px'); g.fillText(word, x0, 0.5);
    set('--f-mono', '0px'); g.fillText(sub, x0 + ww + 6, 0.5);
  } else {
    g.textAlign = 'center';
    g.font = `600 38px ${font('--f-ui')}`; g.letterSpacing = '6px'; g.fillText(word, 3, -8);
    g.font = `600 12px ${font('--f-mono')}`; g.letterSpacing = '1px'; g.fillText(sub, 0, 24);
  }
  const a = g.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = a[i * 4 + 3] / 255;
  return out;
}
// a box blur, for the ink squeezed out along the edges
function blur(m, W, H, r) {
  const t = new Float32Array(W * H), o = new Float32Array(W * H), n = 2 * r + 1;
  for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x < W + r; x++) { if (x + r < W) s += m[y * W + x + r]; if (x - r - 1 >= 0) s -= m[y * W + x - r - 1]; if (x >= 0 && x < W) t[y * W + x] = s / n; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y < H + r; y++) { if (y + r < H) s += t[(y + r) * W + x]; if (y - r - 1 >= 0) s -= t[(y - r - 1) * W + x]; if (y >= 0 && y < H) o[y * W + x] = s / n; } }
  return o;
}
// a plate's ink before pressure: how much ink each device pixel would take, computed once per stamp (shapes, blur and
// grain are the slow part), then screened at each pressure
function field(W, H, d, opt, seed) {
  const m = shapes(W, H, d, opt), b = blur(m, W, H, Math.max(1, Math.round(1.2 * d))), n = noise(seed), f = new Float32Array(W * H);
  const th = ((seed % 360) * Math.PI) / 180, cx = 0.25 + ((seed >> 9) % 50) / 100, cy = 0.3 + ((seed >> 15) % 40) / 100;
  const cos = Math.cos(th), sin = Math.sin(th);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    const i = Y * W + X, a = m[i];
    if (a < 0.05) continue;
    const u = X / W, v = Y / H;
    const lean = 0.62 + 0.38 * smooth(0.05, 0.95, 0.5 + (u - 0.5) * cos + (v - 0.5) * sin); // pressed harder on one side
    const soft = 0.4 * Math.exp(-(((u - cx) / 0.16) ** 2 + ((v - cy) / 0.3) ** 2)); // where the rubber did not quite touch
    const grain = (fbm(n, X / (3 * d), Y / (3 * d)) - 0.5) * 0.5;
    f[i] = a * (lean - soft + grain) + Math.max(0, a - b[i]) * 1.4; // and the squeeze along every edge
  }
  return f;
}
// that ink at a pressure (0..1), through the 4×4 Bayer screen: which device pixels take it
function plate(f, W, H, press) {
  const out = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) { const v = f[Y * W + X]; if (v > 0 && v * press * 16 > BAYER4[(Y & 3) * 4 + (X & 3)] + 0.5) out[Y * W + X] = 1; }
  return out;
}
function paintPlates(canvas, W, H, layers) {
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer);
  for (const { mask, rgba, dx = 0, dy = 0 } of layers) {
    const c = ((rgba[3] << 24) | (rgba[2] << 16) | (rgba[1] << 8) | rgba[0]) >>> 0;
    for (let Y = Math.max(0, dy); Y < H; Y++) for (let X = Math.max(0, dx); X < W; X++) if (mask[(Y - dy) * W + X - dx]) px[Y * W + X] = c;
  }
  ctx.putImageData(img, 0, 0);
}
const ink = () => { const k = tok('--ink'); return [k[0], k[1], k[2], isDark() ? 235 : 230]; };

// ------------------------------------------------------------------ the big one, over the diff, for a moment
function stampBig(v) {
  const d = dpr(), w = 380, h = 170, W = w * d, H = h * d, seed = hash(v.head);
  const el = document.createElement('canvas');
  el.className = 'impress'; el.setAttribute('aria-hidden', 'true');
  el.style.width = w + 'px'; el.style.height = h + 'px';
  const r = ($('#center') || document.body).getBoundingClientRect();
  el.style.left = Math.round(r.left + r.width / 2 - w / 2) + 'px'; el.style.top = Math.round(r.top + r.height * 0.3 - h / 2) + 'px';
  document.body.append(el);
  const opt = { word: 'APPROVED', sub: `at ${short(v.head)} · ${day(v.at)}`, angle: -9 + (seed % 50) / 10 }, colour = ink(), f = field(W, H, d, opt, seed);
  paintPlates(el, W, H, [{ mask: plate(f, W, H, 1), rgba: colour }]);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const move = el.animate([
    { offset: 0, opacity: 0.45, transform: 'scale(1.03)', easing: 'cubic-bezier(.2,.7,.2,1)' },
    { offset: 70 / (LIFT + 240), opacity: 1, transform: 'scale(1)' },
    { offset: LIFT / (LIFT + 240), opacity: 1, transform: 'scale(1)', easing: 'ease-out' },
    { offset: 1, opacity: 0, transform: 'scale(1)' },
  ], { duration: LIFT + 240, fill: 'both' });
  const stop = () => { move.cancel(); el.remove(); motion.removeEventListener('change', stop); };
  motion.addEventListener('change', stop);
  move.finished.then(stop, stop);
}

// ------------------------------------------------------------------ the small one, on the pull request
// The verdict that belongs here: yours, an approval, on this pull request.
const verdict = () => {
  const v = S.review?.verdict, p = S.github?.pr, repo = String(S.github?.repoFull || '').toLowerCase();
  if (p?.viewer && 'viewerReview' in p) return p.viewerReview?.event === 'APPROVE' ? p.viewerReview : null;
  return v?.event === 'APPROVE' && p && v.number === p.number && v.head && (!v.repo || v.repo.toLowerCase() === repo) ? v : null;
};
export function impressionHTML() {
  const v = verdict(); if (!v) return '';
  const head = S.github.pr.headRefOid || '', moved = !!head && head !== v.head;
  const line = moved ? `<span class="faint">The head is now <span class="moved">${esc(short(head))}</span>.</span>` : '';
  const title = moved ? 'New commits came after your approval: what you approved is not what is there now.' : `Approved ${day(v.at)}: your approval is of this head.`;
  return `<span class="impressrow" title="${esc(title)}"><canvas class="impress-sm" data-head="${esc(v.head)}" data-moved="${moved ? 1 : ''}" data-at="${v.at}" role="img" aria-label="Approved ${esc(short(v.head))}"></canvas>${line}</span>`; // a span: it also sits inside a fact's line
}
function paintSmall(cv) {
  if (cv.dataset.done) return;
  cv.dataset.done = '1';
  const d = dpr(), w = 128, h = 22, W = w * d, H = h * d, seed = hash(cv.dataset.head), moved = !!cv.dataset.moved;
  const opt = { word: 'APPROVED', sub: short(cv.dataset.head), small: true, angle: -3 + (seed % 20) / 10 };
  const f = field(W, H, d, opt, seed), f2 = moved ? field(W, H, d, opt, seed + 1) : null;
  const draw = () => {
    if (!cv.isConnected) return;
    const warn = tok('--warn');
    paintPlates(cv, W, H, moved
      ? [{ mask: plate(f2, W, H, 0.85), rgba: [warn[0], warn[1], warn[2], 255], dx: 2 * d, dy: d }, { mask: plate(f, W, H, 0.7), rgba: ink() }]
      : [{ mask: plate(f, W, H, 1), rgba: ink() }]);
  };
  // a fresh approval is printed here as the big stamp lifts; an older one at once
  const wait = Number(cv.dataset.at) + LIFT - Date.now();
  let stop = null;
  stop = watch(cv, () => { if (!cv.isConnected) return stop?.(); if (wait <= 0 || reducedMotion() || cv.dataset.printed) draw(); });
  const timer = wait > 0 && !reducedMotion() ? setTimeout(() => { cv.dataset.printed = '1'; draw(); }, wait) : 0;
  live.set(cv, () => { stop?.(); clearTimeout(timer); });
}
const live = new Map(); // painted impressions → how to let go of them when the panel draws them again
new MutationObserver((ms) => {
  for (const [cv, end] of live) if (!cv.isConnected) { end(); live.delete(cv); }
  if (!ms.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.('canvas.impress-sm') || n.querySelector?.('canvas.impress-sm'))))) return;
  for (const cv of document.querySelectorAll('canvas.impress-sm:not([data-done])')) paintSmall(cv);
}).observe(document.body, { childList: true, subtree: true });

// Approving stamps the diff, the way a reviewer signs off (sheets.js, after an approval is sent).
hooks.stamp = (v) => { hooks.sound?.play('stamp'); if (v?.head && !reducedMotion()) stampBig({ head: v.head, at: v.at || Date.now() }); };
