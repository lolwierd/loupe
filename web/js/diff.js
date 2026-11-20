// Diff rows: hunks into rows (with the hidden stretches between them), split-view pairing, the characters that
// changed inside a modified line, and Shiki tokens drawn as spans. Pure functions of the data, plus the token cache.
import { S, $, esc, api, wsApi } from './core.js';

// ------------------------------------------------------------------ tokens
const tokClass = new Map();
function cls(light, dark, fs) {
  const k = `${light}|${dark}|${fs}`;
  if (tokClass.has(k)) return tokClass.get(k);
  const c = 'k' + tokClass.size;
  tokClass.set(k, c);
  const sheet = $('#tokcss').sheet;
  const style = (fs & 1 ? 'font-style:italic;' : '') + (fs & 2 ? 'font-weight:600;' : '');
  if (light) sheet.insertRule(`.${c}{color:${light};${style}}`, sheet.cssRules.length);
  if (dark) {
    sheet.insertRule(`:root[data-theme="dark"] .${c}{color:${dark}}`, sheet.cssRules.length);
    sheet.insertRule(`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .${c}{color:${dark}}}`, sheet.cssRules.length);
  }
  return c;
}
export async function loadTokens(p, side, ext = false) {
  const key = (ext ? 'ext' : side) + ':' + p;
  if (S.tok.has(key)) return S.tok.get(key);
  const r = await api(ext ? `/api/w/${S.id}/ext?hl=1&file=${encodeURIComponent(p)}` : wsApi('/hl', { side, path: p }));
  const pal = r.palette.map(([l, d, fs]) => cls(l, d, fs));
  const lines = r.lines.map((line) => line.map(([t, k]) => [t, pal[k]]));
  S.tok.set(key, lines);
  return lines;
}
// One line as highlighted spans; [a, b) marks the characters that changed in a modified line.
export function tokHTML(key, line, text, range) {
  let toks = S.tok.get(key)?.[line - 1];
  if (!toks || toks.map((t) => t[0]).join('') !== text) toks = [[text, '']];
  const [ra, rb] = range && range[1] > range[0] ? range : [-1, -1];
  let c = 0, out = '';
  for (const [t, k] of toks) {
    const cuts = [...new Set([0, t.length, ...[ra - c, rb - c].filter((x) => x > 0 && x < t.length)])].sort((x, y) => x - y);
    for (let q = 0; q < cuts.length - 1; q++) {
      const a = cuts[q], b = cuts[q + 1];
      const w = c + a >= ra && c + b <= rb;
      out += `<span class="${k}${w ? ' wd' : ''}" data-c="${c + a}">${esc(t.slice(a, b))}</span>`;
    }
    c += t.length;
  }
  return out || '';
}

// ------------------------------------------------------------------ rows
// A header row stands for a hunk (h) and the hidden lines above it (gap). A trailing gap has no hunk.
export function buildRows(d) {
  const rows = [];
  let prevEnd = 0, prevDelta = 0;
  for (const hk of d.hunks) {
    const delta = hk.newStart - hk.oldStart;
    const gap = d.newLen && hk.newStart - 1 >= prevEnd + 1 ? { from: prevEnd + 1, to: hk.newStart - 1, delta } : null;
    rows.push({ hdr: true, h: hk, gap });
    for (const l of hk.lines) rows.push(l);
    prevEnd = hk.newStart + hk.newLines - 1;
    prevDelta = (hk.newStart + hk.newLines) - (hk.oldStart + hk.oldLines);
  }
  if (d.newLen && d.hunks.length && prevEnd < d.newLen) rows.push({ hdr: true, h: null, gap: { from: prevEnd + 1, to: d.newLen, delta: prevDelta } });
  return rows;
}
export function findRow(rows, a) {
  if (!rows || !a) return -1;
  return a.side === 'old' ? rows.findIndex((r) => !r.hdr && r.t === '-' && r.o === a.line) : rows.findIndex((r) => !r.hdr && r.t !== '-' && r.n === a.line);
}
export async function headText(p) {
  if (!S.newText.has(p)) S.newText.set(p, (await api(wsApi('/file', { side: 'new', path: p }))).lines);
  return S.newText.get(p);
}
const ctxRows = (lines, g, a, b) => { const out = []; for (let n = a; n <= b; n++) out.push({ t: ' ', n, o: n - g.delta, s: lines[n - 1] ?? '' }); return out; };

export async function expandGap(p, i, dir) {
  const rows = S.rows.get(p), r = rows[i], g = r?.gap;
  if (!g) return;
  const lines = await headText(p);
  const size = g.to - g.from + 1, cnt = dir === 'all' ? size : Math.min(20, size);
  if (dir === 'down') { rows.splice(i, 0, ...ctxRows(lines, g, g.from, g.from + cnt - 1)); g.from += cnt; }
  else { rows.splice(i + 1, 0, ...ctxRows(lines, g, g.to - cnt + 1, g.to)); g.to -= cnt; }
  if (g.from > g.to) { r.gap = null; if (!r.h) rows.splice(rows.indexOf(r), 1); }
}
// Show new-side line n and three lines around it, splitting the gap that hides it.
export async function revealAround(p, n) {
  const rows = S.rows.get(p);
  const i = rows.findIndex((r) => r.hdr && r.gap && n >= r.gap.from && n <= r.gap.to);
  if (i < 0) return false;
  const lines = await headText(p), r = rows[i], g = r.gap;
  const a = Math.max(g.from, n - 3), b = Math.min(g.to, n + 3);
  const before = a > g.from ? [{ hdr: true, h: null, gap: { from: g.from, to: a - 1, delta: g.delta } }] : [];
  const keep = b < g.to || r.h;
  r.gap = b < g.to ? { from: b + 1, to: g.to, delta: g.delta } : null;
  rows.splice(i, 1, ...before, ...ctxRows(lines, g, a, b), ...(keep ? [r] : []));
  return true;
}

// Split view pairs a run of removed lines with the added run after it; context sits on both sides.
export function buildSplit(rows) {
  const out = []; let dels = [], adds = [];
  const flush = () => { for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ L: dels[k] ?? null, R: adds[k] ?? null }); dels = []; adds = []; };
  rows.forEach((r, i) => {
    if (r.hdr) { flush(); out.push({ hdr: i }); return; }
    if (r.t === '-') { if (adds.length) flush(); dels.push(i); return; }
    if (r.t === '+') { adds.push(i); return; }
    flush(); out.push({ L: i, R: i });
  });
  flush();
  return out;
}

// Pair each removed line with the added line that replaced it, and mark the stretch that differs, widened to
// whole words. Lines that share less than 30% are left whole (marking them would be noise).
export function wordRanges(rows) {
  const out = new Map(), word = /[\w$]/;
  for (const it of buildSplit(rows)) {
    if (it.L == null || it.R == null || it.L === it.R) continue;
    const a = rows[it.L].s, b = rows[it.R].s;
    let i = 0;
    const n = Math.min(a.length, b.length);
    while (i < n && a[i] === b[i]) i++;
    let j = 0;
    while (j < n - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    if (i + j < 0.3 * Math.max(a.length, b.length)) continue;
    const widen = (s, x, y) => { while (x > 0 && word.test(s[x - 1]) && word.test(s[x] ?? '')) x--; while (y < s.length && word.test(s[y]) && word.test(s[y - 1] ?? '')) y++; return [x, y]; };
    out.set(it.L, widen(a, i, a.length - j));
    out.set(it.R, widen(b, i, b.length - j));
  }
  return out;
}

export function rangeLabel(sel) {
  const f = (r) => (r.t === '-' ? `L${r.o}` : `${r.n}`);
  if (sel.length === 1) return `line ${f(sel[0])}`;
  return `lines ${f(sel[0])}–${f(sel[sel.length - 1])}`;
}
export function selText(sel) {
  const w = String(Math.max(...sel.map((x) => Math.max(x.n || 0, x.o || 0)))).length;
  return sel.map((x) => `${String(x.o ?? '').padStart(w)} | ${String(x.n ?? '').padStart(w)} ${x.t} ${x.s}`).join('\n');
}
