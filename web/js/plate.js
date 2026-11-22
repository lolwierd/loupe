// Plates: loupe's dither. A plate is a print of a real tonal subject in a few inks, with paper between the dots. It is
// never laid over something to dim it; the subject is printed. The method is lolwierd.com's sky (its sky-shared.js):
// an 8×8 ordered screen for air, Atkinson error diffusion into three inks for mass, ink ramps per theme. docs/COMPONENTS.md
// ("Plates") holds the rules; this file holds the engine and the one plate every write pulls: the page behind its dialog.
//
//   plateOf(el, weight)   prints a live element through an SVG filter: its own luminance, the 8×8 screen, an uneven air,
//                         four tones, the ink ramp. The words on it are not screened over, they become part of the print.
//   tiers(paper, w, h)    Atkinson diffusion of a paper-value field (1 bare paper, 0 full ink) into TIERS inks.
//
// The pure part (the screen, the grain, the inks) is plate-core.js, which a sandboxed scene can load on its own.
import { reducedMotion } from './core.js';
import './plate-core.js';

export const { B8, bayer8, TIERS, hash2, fbm, tiers, RAMPS } = globalThis.LoupePlate;
const { clamp } = globalThis.LoupePlate;


// ------------------------------------------------------------------ the plate of a live element
// How the element's luminance is exposed onto the plate: [gain, lift], by weight. 0 is something opened over the page
// that writes nothing (the keys, the map opened large); 1 a write you can undo here; 2 one others will see; 3 one that
// cannot be undone, which also prints in red. The page's words land in the middle ink, so they sit back in the print.
const EXPOSE = {
  light: [[0.52, 0.35], [0.60, 0.215], [0.56, 0.17], [0.52, 0.11]],
  dark: [[0.66, 0.10], [0.62, 0.115], [0.56, 0.135], [0.52, 0.16]],
};
export const WEIGHTS = { view: 0, local: 1, public: 2, destructive: 3 };
// The filter is checked in Chromium (Chrome, Edge, Arc, Brave). Elsewhere the page behind a dialog steps back under a
// flat wash until it has been looked at there; ?plates in the address turns it on to try.
const CAN = !!(navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium') || window.chrome) || new URLSearchParams(location.search).has('plates');
if (!CAN) document.documentElement.dataset.plates = 'off';
const off = () => !CAN || matchMedia('(forced-colors: active)').matches; // with forced colours the system's colours stay as they are
const CELL = 1; // one dot, in CSS px: the size of a pixel in Mote and the spark
const NS = 'http://www.w3.org/2000/svg';
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
const rgb = (c) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };

// the screen as an image, one block per cell at device pixels, so no browser has to scale it
const tiles = new Map();
function screenTile(k) {
  if (tiles.has(k)) return tiles.get(k);
  const c = document.createElement('canvas'); c.width = c.height = 8 * k;
  const g = c.getContext('2d');
  B8.forEach((v, i) => { const q = Math.round(((v + 0.5) / 64) * 255); g.fillStyle = `rgb(${q},${q},${q})`; g.fillRect((i % 8) * k, (i >> 3) * k, k, k); });
  const url = c.toDataURL(); tiles.set(k, url); return url;
}
// The air: an uneven field over the whole plate, so its ground is mottled like inked paper and not flat. Drawn once per
// seed on a small canvas and stretched smoothly over the element, so a repaint under the plate costs a few per-pixel
// steps and the plate is the same in every browser.
const airs = new Map();
function airTile(seed) {
  if (airs.has(seed)) return airs.get(seed);
  if (airs.size >= 8) airs.delete(airs.keys().next().value);
  const W = 192, H = 120, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), im = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.round(255 * clamp(0.5 + (fbm(x * 0.055, y * 0.085, seed) - 0.5) * 1.5)), i = (y * W + x) * 4;
    im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const url = c.toDataURL(); airs.set(seed, url); return url;
}
let defs = null;
function filterFor(theme, weight, seed) {
  if (!defs) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
    svg.id = 'plates'; svg.style.position = 'absolute';
    defs = document.createElementNS(NS, 'defs'); svg.append(defs); document.body.append(svg);
  }
  const ratio = window.devicePixelRatio || 1, k = Math.max(1, Math.round(CELL * ratio)), span = ((8 * k) / ratio).toFixed(4);
  const id = `plate-${theme}-${weight}-${k}-${span.replace('.', '_')}-${seed}`; // the device cell and the span are both in the key: two screens can share one and differ in the other
  if (document.getElementById(id)) return id;
  // a filter carries its air as an image, so the shelf is kept short: the oldest go, never one that is on the page
  for (const f of [...defs.children]) { if (defs.children.length < 12) break; if (!document.querySelector(`[data-plate][style*="${f.id}"]`)) f.remove(); }
  const ramp = RAMPS[weight === 3 ? `${theme}Red` : theme], [gain, lift] = EXPOSE[theme][weight];
  const tones = theme === 'dark' ? [ramp.paper, ramp.ink[2], ramp.ink[1], ramp.ink[0]] : [ramp.ink[0], ramp.ink[1], ramp.ink[2], ramp.paper]; // by rising luminance
  const table = (i) => tones.map((c) => (rgb(c)[i] / 255).toFixed(4)).join(' ');
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722].map((c) => (c * gain).toFixed(4)), row = `${lr} ${lg} ${lb} 0 ${lift}`, tile = screenTile(k), air = airTile(seed);
  const airGain = theme === 'dark' ? 0.11 : 0.16; // how far the air moves a tone: less in dark, where a dark patch would bury the words
  // luminance, exposed; plus the screen (a quarter of a tone either way) and the air; cut to four tones; inked.
  // The last three steps develop it: the plate appears dot by dot in the screen's own order (the .dev matrix's offset).
  defs.insertAdjacentHTML('beforeend', `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB" primitiveUnits="userSpaceOnUse">
<feColorMatrix in="SourceGraphic" type="matrix" values="${row}  ${row}  ${row}  0 0 0 0 1" result="lum"/>
<feImage href="${tile}" xlink:href="${tile}" x="0" y="0" width="${span}" height="${span}" preserveAspectRatio="none" result="t"/><feTile in="t" result="screen"/>
<feImage href="${air}" xlink:href="${air}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="air"/>
<feComposite in="lum" in2="screen" operator="arithmetic" k1="0" k2="1" k3="0.25" k4="-0.125" result="a"/>
<feComposite in="a" in2="air" operator="arithmetic" k1="0" k2="1" k3="${airGain}" k4="${-airGain / 2}" result="b"/>
<feComponentTransfer in="b" result="q"><feFuncR type="discrete" tableValues="0 0.33333 0.66667 1"/><feFuncG type="discrete" tableValues="0 0.33333 0.66667 1"/><feFuncB type="discrete" tableValues="0 0.33333 0.66667 1"/></feComponentTransfer>
<feComponentTransfer in="q" result="plate"><feFuncR type="table" tableValues="${table(0)}"/><feFuncG type="table" tableValues="${table(1)}"/><feFuncB type="table" tableValues="${table(2)}"/></feComponentTransfer>
<feColorMatrix class="dev" in="screen" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0.5" result="m0"/>
<feComponentTransfer in="m0" result="m"><feFuncA type="discrete" tableValues="0 1"/></feComponentTransfer>
<feComposite in="plate" in2="m" operator="in" result="shown"/>
<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shown"/></feMerge></filter>`);
  return id;
}
const DEV = (off) => `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 ${off.toFixed(4)}`;
// Develop a plate: its dots come up in the screen's own order over ms, eased. There is one clock: a plate swapped for
// another while it develops (the write turned heavier, the window was resized) carries on from where it was. With
// reduced motion it is simply there.
const dev = { t0: 0, ms: 0, raf: 0, id: null };
const setDev = (id, off) => document.getElementById(id)?.querySelector('.dev')?.setAttribute('values', DEV(off));
function develop(id, ms) {
  cancelAnimationFrame(dev.raf);
  const now = performance.now(), running = dev.ms && now < dev.t0 + dev.ms;
  if (dev.id && dev.id !== id) setDev(dev.id, 0.5); // the one left behind is whole, for its next use
  if (ms) { dev.t0 = now; dev.ms = ms; } else if (!running) dev.ms = 0;
  dev.id = id;
  if (!dev.ms || reducedMotion()) { dev.ms = 0; setDev(id, 0.5); return; }
  const step = (at) => {
    const t = Math.min(1, (at - dev.t0) / dev.ms), e = 1 - Math.pow(1 - t, 3);
    if (t >= 1 || reducedMotion()) { dev.ms = 0; setDev(id, 0.5); return; }
    setDev(id, -0.5 + e); dev.raf = requestAnimationFrame(step);
  };
  setDev(id, -0.5 + (1 - Math.pow(1 - Math.min(1, (now - dev.t0) / dev.ms), 3))); dev.raf = requestAnimationFrame(step);
}
function settle() { cancelAnimationFrame(dev.raf); if (dev.id) setDev(dev.id, 0.5); dev.ms = 0; dev.id = null; }
// One change always pulls the same plate: its air is seeded by what is open.
const seedOf = () => { let h = 7; for (const c of location.pathname) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return 1 + (Math.abs(h) % 997); };

export function plateOf(el, weight = 1, { develop: ms = 0 } = {}) {
  if (off()) { plateOff(el); return; } // the scrim's wash sets the page back
  const id = filterFor(isDark() ? 'dark' : 'light', clamp(weight | 0, 0, 3), seedOf()), url = `url(#${id})`;
  if (el.dataset.plate === String(weight) && el.style.filter.includes(id)) return; // already this plate: a resize, a redraw or a second call changes nothing
  el.dataset.plate = String(weight); el.style.filter = url;
  develop(id, ms);
}
export function plateOff(el) { if (el.dataset.plate === undefined) return; delete el.dataset.plate; el.style.filter = ''; settle(); }

// ------------------------------------------------------------------ what opens over the page pulls a plate of it
// A write's dialog prints the page behind it, as heavily as the write is hard to undo (sheets.js sets data-weight). The
// keys and the map opened large print it at the lightest. The palette is the top bar opened, and the bar stays lit, so
// it pulls no plate: the page under it only steps back under a wash. The plate holds still while the dialog is open:
// someone is writing in front of it.
const behind = () => document.querySelector('#root > .app, #root > .home, #root > *');
const weightOf = (scrim) => (scrim.classList.contains('scrim') && scrim.querySelector(':scope > .palette:not(.keysheet)') ? null : WEIGHTS[scrim.dataset.weight] ?? 0);
const open = new Map(); // scrim -> its observer
const zOf = (el) => parseInt(getComputedStyle(el).zIndex, 10) || 0;
const onTop = () => [...open.keys()].filter((s) => s.isConnected).sort((a, b) => zOf(a) - zOf(b) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).pop();
let plated = null;        // the element that carries the plate now
function refresh(first) {
  const el = behind();
  if (plated && plated !== el) { plateOff(plated); plated = null; } // the page was replaced: the old one is let go, wherever it went
  if (!el) return;
  const top = onTop(), w = top ? weightOf(top) : null; // the one on top decides: by stacking order, then by where it sits in the page
  if (w === null) { plateOff(el); plated = null; return; }
  plateOf(el, w, { develop: first === true && el.dataset.plate === undefined ? 180 : 0 });
  plated = el.dataset.plate === undefined ? null : el;
}
const scrimsIn = (n) => (n.nodeType !== 1 ? [] : [...(n.matches('.scrim, .sheetscrim') ? [n] : []), ...n.querySelectorAll('.scrim, .sheetscrim')]);
new MutationObserver((records) => {
  for (const r of records) {
    // the diff, the panels and the file list redraw often and never hold a dialog: their changes are not looked through
    if (r.target.closest?.('#cards, #pbody, #tree, #vbody')) continue;
    if (r.target.id === 'root') { if (open.size) refresh(); else if (r.addedNodes.length) soon(); } // the page was drawn again or taken away: under an open dialog, or as another change
    for (const n of r.removedNodes) for (const s of scrimsIn(n)) if (open.has(s) && !s.isConnected) { open.get(s).disconnect(); open.delete(s); refresh(); }
    for (const n of r.addedNodes) for (const s of scrimsIn(n)) {
      if (open.has(s) || !s.isConnected) continue;
      const mo = new MutationObserver(() => refresh()); mo.observe(s, { attributes: true, attributeFilter: ['data-weight'] });
      open.set(s, mo); refresh(true);
    }
  }
}).observe(document.body, { childList: true, subtree: true });
// The filters for this theme are made while the page is idle, so the first dialog opens without a hitch: drawing the
// screen and the air and reading the inks otherwise lands in the frame the dialog opens in.
const warm = () => { warming = 0; if (!off() && document.querySelector('#root > *')) for (let w = 0; w <= 3; w++) filterFor(isDark() ? 'dark' : 'light', w, seedOf()); };
let warming = 0;
function soon() { if (!warming) warming = (window.requestIdleCallback || ((f) => setTimeout(f, 600)))(warm, { timeout: 2000 }) || 1; }
soon();
// the theme, the screen or forced colours changed under an open dialog: pull the plate again (or let it go)
const again = () => { if (open.size) refresh(); };
new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
for (const q of ['(prefers-color-scheme: dark)', '(forced-colors: active)']) matchMedia(q).addEventListener('change', again);
addEventListener('resize', again);
