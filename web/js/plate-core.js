// The pure part of loupe's plates: the screen, the grain and the inks. No imports and no DOM, and it is one function
// that hangs its parts on globalThis.LoupePlate, so it loads the same as a module (plate.js imports it for its effect)
// and as a classic script (a scene's sandboxed frame, where a module fetch is refused). The method is lolwierd.com's
// sky: an 8×8 ordered screen for air, Atkinson error diffusion into three inks for mass.
(function () {
const B8 = [
  0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];
const bayer8 = (x, y) => B8[((((y | 0) % 8) + 8) % 8) * 8 + ((((x | 0) % 8) + 8) % 8)] / 64;
const TIERS = 3; // inks, densest first; tier TIERS is bare paper
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const hash = (v) => { v = Math.imul(v ^ (v >>> 16), 2246822507); v = Math.imul(v ^ (v >>> 13), 3266489909); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
const hash2 = (x, y, s) => hash(Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519));
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// three octaves of value noise, 0..1: the organic part of any field
const fbm = (x, y, s = 1) => vnoise(x, y, s) * 0.6 + vnoise(x * 2.1 + 9.2, y * 2.1 + 3.7, s + 7) * 0.28 + vnoise(x * 4.3 + 1.3, y * 4.3 + 8.1, s + 13) * 0.12;

// Atkinson error diffusion, quantising to TIERS + 1 evenly spaced tones. Returns the tier per cell: 0 the densest ink,
// TIERS bare paper. The kernel is the classic one; more inks to land in is what gives a mass depth instead of a cutout.
function tiers(paper, w, h) {
  const work = new Float32Array(paper), out = new Uint8Array(w * h);
  const put = (x, y, e) => { if (x >= 0 && x < w && y < h) work[y * w + x] += e; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, old = work[i], level = Math.round(clamp(old) * TIERS);
    out[i] = level;
    const e = (old - level / TIERS) * 0.125;
    if (!e) continue;
    put(x + 1, y, e); put(x + 2, y, e); put(x - 1, y + 1, e); put(x, y + 1, e); put(x + 1, y + 1, e); put(x, y + 2, e);
  }
  return out;
}

// Ink ramps, densest first, then paper. Neutral, in loupe's own ink; red only for a write that cannot be undone.
const RAMPS = {
  light: { ink: ['#1b1b20', '#5b5b66', '#aeaeb8'], paper: '#f4f4f5' },
  dark: { ink: ['#d8d8e0', '#74747f', '#34343c'], paper: '#0e0e11' },
  lightRed: { ink: ['#7d1f1a', '#c2463d', '#e6b3ae'], paper: '#f8f1f0' },
  darkRed: { ink: ['#ffb1aa', '#b8463e', '#55201d'], paper: '#120c0c' },
};

globalThis.LoupePlate = { B8, bayer8, TIERS, hash2, fbm, tiers, RAMPS, clamp, smooth };
})();
