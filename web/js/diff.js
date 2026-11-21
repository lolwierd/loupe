// Diff rows: hunks into rows (with the hidden stretches between them), split-view pairing, the characters that
// changed inside a modified line, and Shiki tokens drawn as spans. Pure functions of the data, plus the token cache.
import { S, $, esc, api, wsApi, fileOf } from './core.js';

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
  const { id, scope } = S, file = fileOf(p);
  const r = await api(ext ? `/api/w/${S.id}/ext?hl=1&file=${encodeURIComponent(p)}` : wsApi('/hl', { side, path: p }));
  if (S.id !== id || S.scope !== scope || fileOf(p) !== file) return;
  const pal = r.palette.map(([l, d, fs]) => cls(l, d, fs));
  const lines = r.lines.map((line) => line.map(([t, k]) => [t, pal[k]]));
  S.tok.set(key, lines);
  return lines;
}
// One line as highlighted spans. Each [a, b) marks a separate edit.
export function tokHTML(key, line, text, ranges = []) {
  let toks = S.tok.get(key)?.[line - 1];
  if (!toks || toks.map((t) => t[0]).join('') !== text) toks = [[text, '']];
  let c = 0, edit = 0, out = '';
  for (const [t, k] of toks) {
    const end = c + t.length;
    let at = c;
    while (at < end) {
      while (ranges[edit]?.[1] <= at) edit++;
      const range = ranges[edit];
      const changed = range && range[0] <= at;
      const next = Math.min(end, changed ? range[1] : range?.[0] ?? end);
      out += `<span class="${k}${changed ? ' wd' : ''}" data-c="${at}">${esc(t.slice(at - c, next - c))}</span>`;
      at = next;
    }
    c = end;
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
// a line of a range, which may be context: an old-side number then finds the context row it is on
export function findLine(rows, a) {
  const i = findRow(rows, a);
  return i >= 0 || a?.side !== 'old' || !rows ? i : rows.findIndex((r) => !r.hdr && r.t === ' ' && r.o === a.line);
}
export async function headText(p) {
  if (S.newText.has(p)) return S.newText.get(p);
  const file = fileOf(p);
  const { lines } = await api(wsApi('/file', { side: 'new', path: p }));
  if (fileOf(p) === file) S.newText.set(p, lines);
  return lines;
}
const ctxRows = (lines, g, a, b) => { const out = []; for (let n = a; n <= b; n++) out.push({ t: ' ', n, o: n - g.delta, s: lines[n - 1] ?? '' }); return out; };

export async function expandGap(p, i, dir) {
  const rows = S.rows.get(p), r = rows?.[i], g = r?.gap;
  if (!g) return;
  const lines = await headText(p);
  if (S.rows.get(p) !== rows || rows[i] !== r || r.gap !== g) return;
  const size = g.to - g.from + 1, cnt = dir === 'all' ? size : Math.min(20, size);
  if (dir === 'down') { rows.splice(i, 0, ...ctxRows(lines, g, g.from, g.from + cnt - 1)); g.from += cnt; }
  else { rows.splice(i + 1, 0, ...ctxRows(lines, g, g.to - cnt + 1, g.to)); g.to -= cnt; }
  if (g.from > g.to) { r.gap = null; if (!r.h) rows.splice(rows.indexOf(r), 1); }
}
// Show new-side line n and three lines around it, splitting the gap that hides it.
export async function revealAround(p, n) {
  const rows = S.rows.get(p);
  if (!rows) return false;
  const i = rows.findIndex((r) => r.hdr && r.gap && n >= r.gap.from && n <= r.gap.to);
  if (i < 0) return false;
  const r = rows[i], lines = await headText(p), g = r.gap;
  if (S.rows.get(p) !== rows || rows[i] !== r || !g || g.from > n || g.to < n) return false;
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

// Match whole words, punctuation and whitespace. Peel off equal ends before aligning the middle.
function editRanges(a, b) {
  if (a.length > 2048 || b.length > 2048) return null;
  const tokens = (s) => [...s.matchAll(/[\p{L}\p{N}_$]+|\s+|./gu)];
  const left = tokens(a), right = tokens(b);
  let start = 0, xEnd = left.length, yEnd = right.length;
  while (start < xEnd && start < yEnd && left[start][0] === right[start][0]) start++;
  while (xEnd > start && yEnd > start && left[xEnd - 1][0] === right[yEnd - 1][0]) {
    xEnd--; yEnd--;
  }
  const width = yEnd - start + 1, height = xEnd - start + 1;
  if (width * height > 4096) return null;
  const score = new Uint16Array(width * height);
  for (let i = height - 2; i >= 0; i--) {
    for (let j = width - 2; j >= 0; j--) {
      const at = i * width + j, token = left[start + i][0];
      score[at] = token === right[start + j][0]
        ? score[at + width + 1] + token.length
        : Math.max(score[at + 1], score[at + width]);
    }
  }
  const offset = (list, i, size) => list[i]?.index ?? size;
  const shared = offset(left, start, a.length) + a.length - offset(left, xEnd, a.length) + score[0];
  if (shared < 0.3 * Math.max(a.length, b.length)) return null;
  const old = [], next = [];
  let x = start, y = start, fromX = x, fromY = y;
  const flush = () => {
    if (x > fromX) old.push([offset(left, fromX, a.length), offset(left, x, a.length)]);
    if (y > fromY) next.push([offset(right, fromY, b.length), offset(right, y, b.length)]);
  };
  while (x < xEnd && y < yEnd) {
    const at = (x - start) * width + y - start;
    if (left[x][0] === right[y][0]) {
      flush();
      fromX = ++x; fromY = ++y;
    } else if (score[at + width] >= score[at + 1]) x++;
    else y++;
  }
  x = xEnd; y = yEnd; flush();
  return [old, next];
}

export function wordRanges(rows, pairs = buildSplit(rows)) {
  const out = new Map();
  for (const it of pairs) {
    if (it.L == null || it.R == null || it.L === it.R) continue;
    const ranges = editRanges(rows[it.L].s, rows[it.R].s);
    if (ranges?.[0].length) out.set(it.L, ranges[0]);
    if (ranges?.[1].length) out.set(it.R, ranges[1]);
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
