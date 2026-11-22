// Pixel art, as a material with rules rather than a costume:
//   - one dither, the 4×4 Bayer matrix: seventeen levels, --d0 (empty) to --d16 (solid), used as CSS masks, so a
//     dither is always a quantity drawn with two colours;
//   - sprites drawn at art resolution on a small canvas and shown with image-rendering: pixelated, crisp at 1x and 2x;
//   - colours only from the theme's tokens, read when drawing, so every sprite works in light and dark.
// The one sprite the app uses is Claude's spark: it turns while Claude works (an answer, the brief, a session on a fix),
// and a still frame marks Claude's words.

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
(function ditherVars() {
  const root = document.documentElement.style;
  for (let lv = 0; lv <= 16; lv++) {
    let rects = '';
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (BAYER[y][x] < lv) rects += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
    root.setProperty(`--d${lv}`, `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'>${rects}</svg>`)}")`);
  }
})();

// ------------------------------------------------------------------ colours from the theme
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
// Keyed by the colour's own text, which is what a theme changes, so a switch of theme needs no flush. Reading a pixel
// back is the slow part, and every redraw of the file tree paints a canvas per check mark.
const rgbOf = new Map();
function rgb(c) {
  let v = rgbOf.get(c);
  if (!v) { probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; v = [d[0], d[1], d[2]]; rgbOf.set(c, v); }
  return v;
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const token = (k) => rgb(getComputedStyle(document.documentElement).getPropertyValue(k).trim());

// ------------------------------------------------------------------ the spark
// Laid out pixel by pixel, not rendered from geometry: at 16 px a sprite is a handful of pixels, and only straight
// and exact-diagonal runs stay crisp. A four-point star with concave sides (wide at the core, one pixel at the tips)
// breathes from + to × and back over eight frames, and one satellite pixel orbits between the arms, so it reads as
// turning. Four flat tones of Claude's colour: tip, body, lit, core.
const SZ = 16, FRAMES = 8, C = 7;  // a 15×15 star centred in a 16×16 canvas
// [length of the + arms, length of the × arms] per frame; frame 7 runs back into frame 0.
const BREATH = [[4, 0], [6, 0], [7, 1], [5, 3], [3, 5], [2, 5], [3, 3], [4, 1]];
function sparkFrames() {
  const claude = token('--claude'), white = [255, 255, 255];
  const theme = document.documentElement.dataset.theme;
  const dark = theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const T = { K: mix(claude, [0, 0, 0], dark ? 0.08 : 0.3), O: claude, L: mix(claude, white, dark ? 0.4 : 0.3), W: mix(claude, white, dark ? 0.78 : 0.62) };
  const out = [];
  for (let f = 0; f <= FRAMES; f++) {           // frame FRAMES is the still mark
    const [pl, xl] = BREATH[f === FRAMES ? 1 : f];
    const px = new Map();
    const put = (x, y, t) => { const k = `${x},${y}`, rank = 'KOLW'; if (!px.has(k) || rank.indexOf(t) > rank.indexOf(px.get(k))) px.set(k, t); };
    // the + arms: three wide near the core, then one wide, the tip in the darkest tone
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let d = 1; d <= pl; d++) {
        const tip = d === pl, t = tip ? 'K' : d <= 1 ? 'W' : d <= pl / 2 ? 'L' : 'O';
        put(C + dx * d, C + dy * d, t);
        if (d <= Math.min(2, pl - 2)) { const w = d === 1 ? 'L' : 'O'; put(C + dx * d + dy, C + dy * d + dx, w); put(C + dx * d - dy, C + dy * d - dx, w); }
      }
    }
    // the × arms: one pixel wide, exact diagonals
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) for (let d = 1; d <= xl; d++) put(C + dx * d, C + dy * d, d === xl ? 'K' : d === 1 ? 'L' : 'O');
    put(C, C, 'W');
    if (pl >= 3) { put(C + 1, C, 'W'); put(C - 1, C, 'W'); put(C, C + 1, 'W'); put(C, C - 1, 'W'); }
    // the satellite: between the arms, one step round per frame
    const a = ((f * 45 + 22.5) * Math.PI) / 180, sx = Math.round(C + Math.cos(a) * 6), sy = Math.round(C + Math.sin(a) * 6);
    if (f < FRAMES && !px.has(`${sx},${sy}`)) put(sx, sy, f % 2 ? 'O' : 'L');
    const c = document.createElement('canvas'); c.width = c.height = SZ;
    const x = c.getContext('2d'), img = x.createImageData(SZ, SZ);
    for (const [k, t] of px) { const [xx, yy] = k.split(',').map(Number); if (xx < 0 || yy < 0 || xx >= SZ || yy >= SZ) continue; const col = T[t]; img.data.set([col[0], col[1], col[2], 255], (yy * SZ + xx) * 4); }
    x.putImageData(img, 0, 0);
    out.push(c);
  }
  return out;
}
// The still mark is the star at its fullest +, without the satellite.
const STILL = FRAMES;

let frames = null, phase = 0, raf = 0, start;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
function draw(all) {
  const i = Math.floor(phase), t = phase - i;
  const fade = t * t * (3 - 2 * t);
  for (const cv of document.querySelectorAll(all ? 'canvas.spark' : 'canvas.spark:not(.still)')) {
    const x = cv.getContext('2d');
    x.clearRect(0, 0, SZ, SZ);
    if (cv.classList.contains('still') || motion.matches) { x.drawImage(frames[STILL], 0, 0); continue; }
    // Blend premultiplied pixels so lit points keep their brightness as the star turns.
    x.globalCompositeOperation = 'lighter';
    x.globalAlpha = 1 - fade;
    x.drawImage(frames[i], 0, 0);
    x.globalAlpha = fade;
    x.drawImage(frames[(i + 1) % FRAMES], 0, 0);
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
  }
}
function tick(ts) {
  raf = 0;
  if (motion.matches || !document.querySelector('canvas.spark:not(.still)')) { start = undefined; return; }
  start ??= ts;
  phase = ((ts - start) / 95) % FRAMES;
  draw(false);
  raf = requestAnimationFrame(tick);
}
function wake() {
  frames ||= sparkFrames();
  draw(true);
  if (!raf && !motion.matches && document.querySelector('canvas.spark:not(.still)')) raf = requestAnimationFrame(tick);
}
motion.addEventListener('change', wake);
// New sparks appear whenever a part of the page is drawn: draw them at once, and keep turning while any is busy.
new MutationObserver((ms) => { if (ms.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.('canvas.spark') || n.querySelector?.('canvas.spark'))))) wake(); })
  .observe(document.documentElement, { childList: true, subtree: true });
const retheme = () => { frames = null; if (document.querySelector('canvas.spark')) wake(); };
document.addEventListener('spark-wake', () => wake());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// The spark as HTML: 16 or 32 CSS px (one or two CSS px per art pixel). `still` for Claude's mark, not its work.
export const spark = (size = 16, isStill = false, label = '') =>
  `<canvas class="spark${isStill ? ' still' : ''}" width="${SZ}" height="${SZ}" style="width:${size}px;height:${size}px"${label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"'}></canvas>`;

// ------------------------------------------------------------------ pixel icons
// The same rules as the spark: exact horizontal, vertical and diagonal runs only, two flat tones ('#' the colour, 'o'
// the colour lifted toward the background), drawn at art size and shown at a whole multiple of it, so they stay crisp
// at 1x. Each takes its colour from a token (data-c), so a theme change redraws it.
const ICONS = {
  // the viewed check: bold, two pixels thick
  check: ['........##', '.......###', '......###.', '##...###..', '###.###...', '.#####....', '..###.....', '...#......'],
  // a write on its way: up and to the right
  arrow: ['..#####', '....###', '...#.##', '..#...#', '.#.....', '#......', '.......'],
  // something failed: a small cross, one pixel wide on exact diagonals
  cross: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  // changed since you viewed it
  dot: ['..#..', '.###.', '#####', '.###.', '..#..'],
  // the loupe itself: a two-pixel ring with a glint, and a handle on the diagonal
  loupe: (() => {
    const g = Array.from({ length: 16 }, () => Array(16).fill('.'));
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) {
      const r = Math.hypot(x - 6.5, y - 6.5);
      if (r >= 4.2 && r <= 6.2) g[y][x] = '#';
      if (Math.abs(x - y) <= 1 && x + y >= 21 && x <= 15 && y <= 15) g[y][x] = '#';
    }
    for (const [x, y] of [[4, 4], [5, 3], [3, 5]]) g[y][x] = 'o';
    return g.map((r) => r.join(''));
  })(),
};
function paintIcon(cv) {
  const rows = ICONS[cv.dataset.i];
  if (!rows) return;
  const c = cv.dataset.c || 'currentColor';
  const col = c.startsWith('--') ? token(c) : rgb(c === 'currentColor' ? getComputedStyle(cv).color : c);
  const lit = mix(col, token('--bg'), 0.5);
  const x = cv.getContext('2d'), img = x.createImageData(cv.width, cv.height);
  rows.forEach((row, yy) => [...row].forEach((ch, xx) => { const t = ch === '#' ? col : ch === 'o' ? lit : null; if (t && xx < cv.width && yy < cv.height) img.data.set([t[0], t[1], t[2], 255], (yy * cv.width + xx) * 4); }));
  x.putImageData(img, 0, 0);
  cv.dataset.done = '1';
}
function paintIcons(all) { for (const cv of document.querySelectorAll(all ? 'canvas.pxi' : 'canvas.pxi:not([data-done])')) paintIcon(cv); }
new MutationObserver((ms) => { if (ms.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.('canvas.pxi') || n.querySelector?.('canvas.pxi'))))) paintIcons(false); })
  .observe(document.documentElement, { childList: true, subtree: true });
const repaint = () => paintIcons(true);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);
new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
// An icon as HTML, shown at `scale` CSS px per art pixel.
export function icon(name, color = 'currentColor', scale = 1, cls = '') {
  const rows = ICONS[name], w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  return `<canvas class="pxi ${cls}" data-i="${name}" data-c="${color}" width="${w}" height="${h}" style="width:${w * scale}px;height:${h * scale}px" aria-hidden="true"></canvas>`;
}
// For looking at the icons side by side (not used by the app).
export function iconStrip(scale = 8) { const d = document.createElement('div'); d.style.cssText = 'display:flex;gap:24px;align-items:center'; d.innerHTML = Object.keys(ICONS).map((k) => icon(k, '--ink', scale)).join(''); return d; }

// For looking at the frames side by side (not used by the app).
export function sparkStrip(scale = 8) { frames ||= sparkFrames(); const c = document.createElement('canvas'); c.width = frames.length * (SZ + 2); c.height = SZ; const x = c.getContext('2d'); frames.forEach((f, i) => x.drawImage(f, i * (SZ + 2), 0)); c.style.width = c.width * scale + 'px'; c.style.height = SZ * scale + 'px'; c.style.imageRendering = 'pixelated'; return c; }

// ------------------------------------------------------------------ people: GitHub avatars as pixel portraits
// The avatar is drawn down to 10×10 (smoothly, so it keeps its likeness) and shown at 20 px with image-rendering:
// pixelated: a portrait in the same pixels as the rest. Loaded once per login per page, from loupe's own copy (the
// daemon keeps each one: src/server.mjs, serveAvatar), so it is there as the page is, not two trips to GitHub later.
const faces = new Map();
function paintAvatar(cv) {
  const login = cv.dataset.login;
  if (!login || cv.dataset.done) return;
  cv.dataset.done = '1';
  let img = faces.get(login);
  if (!img) { img = new Image(); img.src = `/avatar/${encodeURIComponent(login)}`; faces.set(login, img); }
  const draw = () => { const x = cv.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, cv.width, cv.height); cv.classList.add('in'); };
  // a login with no picture (a bot, a deleted account) draws nothing: the portrait steps out of the row instead of leaving a hole
  const gone = () => { cv.hidden = true; };
  if (img.complete && img.naturalWidth) draw(); else if (img.complete) gone(); else { img.addEventListener('load', draw, { once: true }); img.addEventListener('error', gone, { once: true }); }
}
new MutationObserver((ms) => { if (ms.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.('canvas.avatar') || n.querySelector?.('canvas.avatar'))))) for (const cv of document.querySelectorAll('canvas.avatar:not([data-done])')) paintAvatar(cv); })
  .observe(document.documentElement, { childList: true, subtree: true });
const BOT = /\[bot\]$|^(github-actions|dependabot|renovate|aikido-pr-checks|codecov|sonarcloud|vercel)/i;
export const avatar = (login, size = 20) => (!login ? '' :
  `<canvas class="avatar${BOT.test(login) ? ' bot' : ''}" data-login="${String(login).replace(/[^\w.\-[\]]/g, '')}" width="${size / 2}" height="${size / 2}" style="width:${size}px;height:${size}px" title="${String(login).replace(/"/g, '')}" aria-hidden="true"></canvas>`);
