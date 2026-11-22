// The plate engine loupe prints with, loaded into every scene's document as LoupeSceneKit for a scene that wants it (a
// scene is its writer's own HTML, CSS and JavaScript; this is material, not a frame it must fit). The ground it draws is
// plain: type, hairlines at one device pixel, flat ink. A plate is pulled the way lolwierd.com pulls its sky and its
// mountain: a tonal field diffused once (Atkinson) into three inks with paper between the dots, so the grain belongs to
// the thing and never reshuffles; an 8×8 ordered screen for air and edges; a threshold that breathes with time, so
// only cells near it are re-decided. Nothing blurs, glows or casts a shadow.
// It is a classic script with no imports: it is inlined into the scene's sandboxed document.

(function () {
const ease = {
  linear: (x) => x,
  in: (x) => x * x * x,
  out: (x) => 1 - Math.pow(1 - x, 3),
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outBack: (x) => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); },
  // a settle: overshoots a little and comes to rest, for something set down
  settle: (x) => (x >= 1 ? 1 : 1 - Math.cos(x * Math.PI * 2.5) * Math.exp(-6 * x) * (1 - x) - (1 - x) * (1 - x) * 0),
};
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------ the plate engine (after lolwierd.com's sky-shared.js)
const B8 = [0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21];
const TIERS = 3; // inks; tier 3 is bare paper
// ink ramps, densest first: loupe's own neutral ink, and red only for what fails
const RAMPS = {
  light: ['#1b1b20', '#5b5b66', '#aeaeb8'], dark: ['#d8d8e0', '#74747f', '#34343c'],
  lightdanger: ['#7d1f1a', '#c2463d', '#e6b3ae'], darkdanger: ['#ffb1aa', '#b8463e', '#55201d'],
};
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };
const hash1 = (v) => { v = Math.imul(v ^ (v >>> 16), 2246822507); v = Math.imul(v ^ (v >>> 13), 3266489909); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
const hash2 = (x, y, s) => hash1(Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519));
const bayer8 = (x, y) => B8[(((y | 0) % 8 + 8) % 8) * 8 + (((x | 0) % 8 + 8) % 8)] / 64;
// smooth value noise, and three octaves of it: the organic part of any field
function noise(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, s = 0) => noise(x, y, s) * 0.6 + noise(x * 2.1 + 9.2, y * 2.1 + 3.7, s + 7) * 0.28 + noise(x * 4.3 + 1.3, y * 4.3 + 8.1, s + 13) * 0.12;
// Atkinson diffusion of paper values (0 full ink, 1 bare paper) into TIERS inks: the tier of every cell
function atkinson(paper, w, h) {
  const work = Float32Array.from(paper), out = new Uint8Array(w * h);
  const put = (x, y, e) => { if (x >= 0 && x < w && y < h) work[y * w + x] += e; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, old = work[i], lv = Math.round(clamp(old) * TIERS); out[i] = lv;
    const e = (old - lv / TIERS) * 0.125; if (!e) continue;
    put(x + 1, y, e); put(x + 2, y, e); put(x - 1, y + 1, e); put(x, y + 1, e); put(x + 1, y + 1, e); put(x, y + 2, e);
  }
  return out;
}

function makeKit(canvas, { colors, dark = false, beats = [], fonts = {}, dpr: given = 0 } = {}) {
  const dpr = Math.max(1, Math.round(given || globalThis.devicePixelRatio || 1));
  const g = canvas.getContext('2d');
  const L = { canvas, g, dpr, dark, c: colors, ease, clamp, lerp };
  L.fonts = { ui: fonts.ui || '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', mono: fonts.mono || 'ui-monospace, "SF Mono", Menlo, monospace' };
  L.size = (w, h) => {
    L.W = w; L.H = h;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (canvas.style) { canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; } // an OffscreenCanvas has none
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.imageSmoothingEnabled = false;
  };
  // ------------------------------------------------------------ time
  let at = 0;
  L.beats = beats.map((b) => { const x = { ...b, start: at }; at += b.ms; return x; });
  L.T = at;
  L.at = (i, ms = 0) => (L.beats[i] ? L.beats[i].start + ms : L.T); // beat i's start, plus ms
  // progress through [a, b] (absolute ms), eased; 0 before, 1 after
  L.span = (t, a, b, e = ease.inOut) => (b <= a ? (t >= b ? 1 : 0) : e(clamp((t - a) / (b - a))));
  // a value along keys [[ms, v], ...], eased between each pair
  L.keys = (t, ks, e = ease.inOut) => {
    if (t <= ks[0][0]) return ks[0][1];
    for (let i = 1; i < ks.length; i++) if (t <= ks[i][0]) { const [a, va] = ks[i - 1], [b, vb] = ks[i]; return lerp(va, vb, e(clamp((t - a) / (b - a || 1)))); }
    return ks[ks.length - 1][1];
  };
  L.beat = (t) => { let i = 0; for (let k = 0; k < L.beats.length; k++) if (t >= L.beats[k].start) i = k; return { i, local: t - (L.beats[i]?.start || 0) }; };
  // ------------------------------------------------------------ pixels
  L.snap = (v) => Math.round(v * dpr) / dpr;               // to the nearest device pixel: moving art stays crisp
  L.hash = (x, y, s = 0) => { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  // the ordered screen, for air and edges: level 0 (paper) to 1 (solid) on the 8×8 matrix, one dot per `cell` CSS px;
  // anchored at (ax, ay) so a screen moves with what it shades instead of swimming under it
  const pats = new Map();
  function pattern(level, color, cell) {
    const lv = Math.round(clamp(level) * 64), key = `${lv}|${color}|${cell}`;
    if (pats.has(key)) return pats.get(key);
    const s = 8 * cell * dpr, c = new OffscreenCanvas(s, s), x = c.getContext('2d');
    x.fillStyle = color;
    for (let i = 0; i < 64; i++) if (B8[i] < lv) x.fillRect((i % 8) * cell * dpr, Math.floor(i / 8) * cell * dpr, cell * dpr, cell * dpr);
    const p = g.createPattern(c, 'repeat'); pats.set(key, p); return p;
  }
  L.dither = (x, y, w, h, level, color = L.c.ink3, { cell = 1, ax = 0, ay = 0 } = {}) => {
    if (level <= 0 || w <= 0 || h <= 0) return;
    const p = pattern(level, color, cell);
    p.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, L.snap(ax), L.snap(ay)]));
    g.fillStyle = p; g.fillRect(L.snap(x), L.snap(y), L.snap(w), L.snap(h));
  };
  // ------------------------------------------------------------ plates
  L.bayer = bayer8; L.noise = noise; L.fbm = fbm; L.smooth = smooth;
  // the theme's inks, densest first, as [r, g, b] (L.inks()) or as colours (L.inks(tone, true)); tone 'danger' is red
  const inkCache = new Map();
  L.inks = (tone = null, css = false) => {
    const k = `${dark ? 'dark' : 'light'}${tone === 'danger' ? 'danger' : ''}`;
    if (css) return RAMPS[k].slice();
    if (!inkCache.has(k)) inkCache.set(k, RAMPS[k].map(hex));
    return inkCache.get(k);
  };
  // a plate: field(x, y) -> paper value at each cell (1 CSS px), 0 full ink to 1 bare paper, diffused once into the
  // inks. Make plates at the top level (or once, by key): a draw gets a second, the setup four.
  const plates = new Map();
  L.plate = (w, h, field, key = null) => {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const k = key === null ? null : `${key}|${w}x${h}`;
    if (k && plates.has(k)) return plates.get(k);
    const paper = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) paper[y * w + x] = clamp(field(x, y));
    const p = { w, h, tiers: atkinson(paper, w, h) };
    if (k) plates.set(k, p);
    return p;
  };
  // print cells at (x, y), w by h CSS px: cell(cx, cy) -> [r, g, b] or null (paper), one dot per CSS px, landed on
  // whole device pixels; what is under the paper shows through
  const buffer = (W, H) => { const c = new OffscreenCanvas(W, H), x2 = c.getContext('2d'); return { c, x2, im: x2.createImageData(W, H) }; };
  const bufs = new Map(); // one buffer per size, reused frame to frame
  const press = (w, h, cell, b = null) => {
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr)), k = `${W}x${H}`;
    if (!b) { b = bufs.get(k); if (!b) bufs.set(k, (b = buffer(W, H))); }
    const px = b.im.data; px.fill(0);
    for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
      const col = cell(cx, cy); if (!col) continue;
      const x0 = Math.round(cx * dpr), x1 = Math.round((cx + 1) * dpr), y0 = Math.round(cy * dpr), y1 = Math.round((cy + 1) * dpr);
      for (let yy = y0; yy < y1 && yy < H; yy++) for (let xx = x0; xx < x1 && xx < W; xx++) { const o = (yy * W + xx) * 4; px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255; }
    }
    b.x2.putImageData(b.im, 0, 0);
    return b.c;
  };
  // placed at whole device pixels: (x, y) is moved by the translate in effect, a scale or rotation is not applied to it
  L.blit = (bmp, x, y) => { const m = g.getTransform(), X = Math.round(m.e + x * dpr), Y = Math.round(m.f + y * dpr); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.imageSmoothingEnabled = false; g.drawImage(bmp, X, Y); g.restore(); };
  L.print = (x, y, w, h, cell) => L.blit(press(Math.round(w), Math.round(h), cell), x, y);
  // the same, for a plate that never changes: pressed once, by key, then only placed
  const stamps = new Map();
  L.stamp = (key, x, y, w, h, cell) => {
    const W = Math.round(w), H = Math.round(h), k = `${key}|${W}x${H}`;
    if (!stamps.has(k)) stamps.set(k, press(W, H, cell, buffer(Math.max(1, Math.round(W * dpr)), Math.max(1, Math.round(H * dpr)))));
    L.blit(stamps.get(k), x, y);
  };
  // the breathing threshold: a slow, smooth wander in -0.5..0.5 for a cell's seed at time t (a new value every 900 ms)
  L.breathe = (seed, t) => { const u = t / 900 + seed, i = Math.floor(u), f = u - i, a = hash1(Math.floor(seed * 1e4) * 31 + i), b = hash1(Math.floor(seed * 1e4) * 31 + i + 1); return a + (b - a) * (f * f * (3 - 2 * f)) - 0.5; };
  // ------------------------------------------------------------ ink
  L.text = (str, x, y, { size = 11, weight = 400, mono = false, color = L.c.ink, align = 'left', base = 'alphabetic', alpha = 1 } = {}) => {
    g.save(); g.globalAlpha *= alpha;
    g.font = `${weight} ${size}px ${mono ? L.fonts.mono : L.fonts.ui}`;
    g.fillStyle = color; g.textAlign = align; g.textBaseline = base;
    g.fillText(str, x, y); g.restore();
  };
  L.measure = (str, { size = 11, weight = 400, mono = false } = {}) => { g.save(); g.font = `${weight} ${size}px ${mono ? L.fonts.mono : L.fonts.ui}`; const w = g.measureText(str).width; g.restore(); return w; };
  // a hairline that lands on whole device pixels
  L.line = (x1, y1, x2, y2, { color = L.c.ink, width = 1, alpha = 1, dash = null } = {}) => {
    g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = width; if (dash) g.setLineDash(dash);
    const o = (width * dpr) % 2 ? 0.5 / dpr : 0;
    g.beginPath(); g.moveTo(L.snap(x1) + (y1 === y2 ? 0 : o), L.snap(y1) + (y1 === y2 ? o : 0)); g.lineTo(L.snap(x2) + (y1 === y2 ? 0 : o), L.snap(y2) + (y1 === y2 ? o : 0)); g.stroke(); g.restore();
  };
  L.rect = (x, y, w, h, { fill = null, stroke = null, alpha = 1, r = 0 } = {}) => {
    g.save(); g.globalAlpha *= alpha;
    g.beginPath(); g.roundRect ? g.roundRect(L.snap(x) + 0.5 / dpr, L.snap(y) + 0.5 / dpr, L.snap(w) - 1 / dpr, L.snap(h) - 1 / dpr, r) : g.rect(x, y, w, h);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1 / dpr * Math.max(1, dpr / 2) * 2 / 2; g.stroke(); }
    g.restore();
  };
  // a cubic from p0 to p3, as a function of 0..1
  L.bez = (p0, p1, p2, p3) => (u) => { const v = 1 - u; return [v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0], v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1]]; };
  // a thread of single pixels along a path, `gap` px apart; `upto` draws it on from its start
  L.dots = (f, { color = L.c.ink3, gap = 3, upto = 1, from = 0, alpha = 1, size = 1 } = {}) => {
    let len = 0, prev = f(0); const N = 64, pts = [[0, prev]];
    for (let i = 1; i <= N; i++) { const p = f(i / N); len += Math.hypot(p[0] - prev[0], p[1] - prev[1]); pts.push([len, p]); prev = p; }
    g.save(); g.globalAlpha *= alpha; g.fillStyle = color;
    let k = 1;
    for (let d = from * len; d <= upto * len; d += gap) {
      while (k < pts.length - 1 && pts[k][0] < d) k++;
      const [d0, a] = pts[k - 1], [d1, b] = pts[k], u = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
      g.fillRect(Math.round(lerp(a[0], b[0], u)), Math.round(lerp(a[1], b[1], u)), size, size);
    }
    g.restore();
  };
  // ------------------------------------------------------------ the plain ground
  // a rule one device pixel thick, axis-aligned: walls, roads, ticks
  L.hair = (x1, y1, x2, y2, color = L.c.ruleStrong) => {
    const t = 1 / dpr;
    g.save(); g.fillStyle = color;
    g.fillRect(L.snap(Math.min(x1, x2)), L.snap(Math.min(y1, y2)), Math.max(t, L.snap(Math.abs(x2 - x1))), Math.max(t, L.snap(Math.abs(y2 - y1))));
    g.restore();
  };
  // a hairline arrow, the map's: soft ink by default, ink-2 and a little heavier for the change; f(u) -> [x, y]
  L.arrow = (f, { color = L.c.lineSoft || L.c.ink3, width = 1, upto = 1, head = true, alpha = 1, dash = null } = {}) => {
    const N = 48;
    g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = width; if (dash) g.setLineDash(dash); g.lineCap = 'round';
    g.beginPath(); for (let i = 0; i <= N * upto; i++) { const [x, y] = f(i / N); i ? g.lineTo(x, y) : g.moveTo(x, y); } const [ex, ey] = f(upto); g.lineTo(ex, ey); g.stroke();
    if (head && upto > 0.98) {
      const [ax, ay] = f(Math.max(0, upto - 0.02)), a = Math.atan2(ey - ay, ex - ax);
      g.setLineDash([]); g.fillStyle = color; g.translate(ex, ey); g.rotate(a);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(-7, -3.2); g.lineTo(-7, 3.2); g.closePath(); g.fill();
    }
    g.restore();
  };
  L.straight = (x1, y1, x2, y2) => (u) => [x1 + (x2 - x1) * u, y1 + (y2 - y1) * u];
  // a section's label: 11 px 600 capitals, tracked, ink-3
  L.label = (s, x, y, { alpha = 1, align = 'left', color = L.c.ink3 } = {}) => {
    g.save(); g.globalAlpha *= alpha; g.font = `600 11px ${L.fonts.ui}`; g.fillStyle = color; g.textAlign = align;
    if ('letterSpacing' in g) g.letterSpacing = '0.55px';
    g.fillText(s.toUpperCase(), x, y); g.restore();
  };
  // the file tree's letters for what a change does to a thing: M changed, A new, D removed
  L.letter = (ch, x, y, { alpha = 1 } = {}) => L.text(ch, x, y, { size: 11, weight: 600, mono: true, color: { M: L.c.warn, A: L.c.ok, D: L.c.danger }[ch] || L.c.ink3, alpha });
  L.clear = () => { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); g.restore(); };
  return L;
}

// A clock value in words: "6 h", "6 h 18 min", "0.25 s".
function hours(v) { const h = Math.floor(v + 1e-9), m = Math.round((v - h) * 60); return m === 60 ? `${h + 1} h` : m ? (h ? `${h} h ${m} min` : `${m} min`) : `${h} h`; }
globalThis.LoupeSceneKit = { makeKit, ease, hours };
})();
