// The map of a change: how the part of the system it lives in works, a drawing of it with the change marked, and
// how to review it. It sits on top of the code, before the first file.
//
// The drawing speaks loupe's own language, so it reads like the rest of the page. A part is a box drawn like a row:
// its name, and under it the file it lives in. What the change touches carries the file tree's letters (M changed,
// A new, D removed) and the ink; what it leaves alone is drawn light, so the change stands out against its context.
// Parts outside this repository sit on the frame's grey. A flow is drawn as lanes: the parts across the top, the steps
// down the page in order, one arrow each.
//
// Claude places the parts of a map on a small grid; everything else is measured here. Boxes are as wide as their
// names, columns as wide as their widest box, the gaps between columns as wide as the labels that sit in them, and
// arrows are routed square around the boxes (never through one), each side's arrows spread so none share a line.
// Nothing is scaled: text is drawn at the page's own sizes, and a sheet wider than its column scrolls.
import { S, esc, pref, $, I } from './core.js';
import { md } from './md.js';
import { hooks } from './hooks.js';
import { briefRunBtn, modelKind } from './ui.js';

const NODE_H = 44, PADX = 12, LETTER = 14, MIN_W = 96, MAX_W = 232, ROW_GAP = 44, ROW_GAP_TB = 56, GUTTER = 48, GUTTER_TB = 40, MAX_GUTTER = 200, PAD = 2;
const CLEAR = 10;                                     // room kept free around a box for line work
const LINE_MAX = 104, LINE_H = 14;                    // an arrow label wraps past this width
const BEND = 28, CROSS = 30, SHARE = 4, CORNER = 12;  // routing costs: a bend, a crossing, per px on another arrow, touching its corner
const LETTERS = { new: 'A', changed: 'M', removed: 'D' };
const KIND_WORD = { external: 'outside this repository', data: 'data', queue: 'queue', actor: 'starts it' };

let mctx;
const cssVar = (v, dflt) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || dflt;
function fonts() {
  const ui = cssVar('--f-ui', 'system-ui, sans-serif'), mono = cssVar('--f-mono', 'monospace');
  return { label: `500 13px ${ui}`, ref: `11px ${mono}`, edge: `11px ${ui}` };
}
function tw(s, font) { mctx ||= document.createElement('canvas').getContext('2d'); mctx.font = font; return mctx.measureText(s).width; }
function fit(s, font, max) { if (tw(s, font) <= max) return s; let t = s; while (t.length > 1 && tw(t + '…', font) > max) t = t.slice(0, -1); return t + '…'; }
// a name that does not fit goes on two lines, broken once at its best joint: a space, else a dot, slash or underscore,
// else a camelCase hump, the two lines as even as they can be
function wrapName(s, font, max) { // max 0: no limit, only the best break
  if (max && tw(s, font) <= max) return [s];
  let best = null;
  for (let i = 1; i < s.length; i++) {
    const kind = s[i - 1] === ' ' ? 0 : '._/-'.includes(s[i - 1]) ? 1 : /[a-z0-9]/.test(s[i - 1]) && /[A-Z]/.test(s[i]) ? 2 : -1;
    if (kind < 0) continue;
    const a = kind === 0 ? s.slice(0, i - 1) : s.slice(0, i), b = s.slice(i), wa = tw(a, font), wb = tw(b, font);
    const fits = !max || (wa <= max && wb <= max), score = (fits ? 0 : 1000) + kind * 30 + Math.max(wa, wb);
    if (!best || score < best.score) best = { score, a, b };
  }
  if (!max) return best ? [best.a, best.b] : [s];
  return best ? [fit(best.a, font, max), fit(best.b, font, max)] : [fit(s, font, max)];
}
function wrap(s, font, max) {
  const lines = []; let cur = '';
  for (const w of s.split(/\s+/).filter(Boolean)) { const t = cur ? `${cur} ${w}` : w; if (cur && tw(t, font) > max) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

// a part's box: as wide as its name or its file, with the change letter in front like a row of the file tree
function part(n, f, compact = false) {
  const letter = LETTERS[n.change] || '', mono = !!n.ref, outside = n.kind === 'external' || n.kind === 'data';
  const inset = PADX + (letter ? LETTER : 0), room = (w) => w - inset - PADX;
  if (compact) { // the name on two lines, broken at its best joint; the file stays in the tooltip
    const lines = wrapName(n.label, f.label, 0);
    const w = Math.ceil(Math.max(72, inset + PADX + 1 + Math.max(...lines.map((l) => tw(l, f.label)))));
    return { letter, inset, w, h: NODE_H, mono, outside, lines, sub: '', m: CLEAR };
  }
  const sub = n.ref ? n.ref.split('/').pop() : KIND_WORD[n.kind] || '';
  const w = Math.ceil(Math.min(MAX_W, Math.max(MIN_W, inset + PADX + 1 + Math.max(tw(n.label, f.label), sub ? tw(sub, mono ? f.ref : f.edge) : 0))));
  return { letter, inset, w, h: NODE_H, mono, outside, lines: [fit(n.label, f.label, room(w))], sub: sub && fit(sub, mono ? f.ref : f.edge, room(w)), m: CLEAR };
}

// ------------------------------------------------------------------ layout: grid cells to boxes, empty rows and columns closed up
// dir 'lr' reads left to right as Claude placed it; 'tb' turns the sheet a quarter so it reads top to bottom and fits a
// narrow column (Claude's rows become columns)
function layout(d, gut, rgut, f, dir, narrow) {
  const C = (n) => (dir === 'tb' ? n.row : n.col), Rw = (n) => (dir === 'tb' ? n.col : n.row);
  const cols = [...new Set(d.nodes.map(C))].sort((a, b) => a - b), rows = [...new Set(d.nodes.map(Rw))].sort((a, b) => a - b);
  const sized = d.nodes.map((n) => ({ ...n, ...part(n, f, narrow?.has(n.id) ? 'two' : false), ci: cols.indexOf(C(n)), ri: rows.indexOf(Rw(n)) }));
  const colW = cols.map((_, i) => Math.max(...sized.filter((n) => n.ci === i).map((n) => n.w)));
  const colX = [], rowY = []; let x = 0, y = 0;
  colW.forEach((w, i) => { colX.push(x); x += w + (gut[i] ?? (dir === 'tb' ? GUTTER_TB : GUTTER)); });
  rows.forEach((_, i) => { rowY.push(y); y += NODE_H + (rgut[i] ?? (dir === 'tb' ? ROW_GAP_TB : ROW_GAP)); });
  const at = new Map(sized.map((n) => {
    const nx = Math.round(colX[n.ci] + (colW[n.ci] - n.w) / 2), ny = rowY[n.ri];
    return [n.id, { ...n, x: nx, y: ny, cx: nx + n.w / 2, cy: ny + NODE_H / 2 }];
  }));
  return { at, colX, colW, rowY };
}

// ------------------------------------------------------------------ routing: shortest square path on the free lines between boxes
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1]; // right, left, down, up; a direction's reverse is d ^ 1
const OUT = { R: 0, L: 1, B: 2, T: 3 };
function port(n, side, off = 0) {
  if (side === 'R') return { p: [n.x + n.w, n.cy + off], s: [n.x + n.w + n.m, n.cy + off] };
  if (side === 'L') return { p: [n.x, n.cy + off], s: [n.x - n.m, n.cy + off] };
  if (side === 'B') return { p: [n.cx + off, n.y + n.h], s: [n.cx + off, n.y + n.h + n.m] };
  return { p: [n.cx + off, n.y], s: [n.cx + off, n.y - n.m] };
}
// a side that faces the other box is free; any other costs something, so arrows leave toward where they go
const faces = (a, b, side) => ({ R: b.x >= a.x + a.w, L: b.x + b.w <= a.x, B: b.y >= a.y + a.h, T: b.y + b.h <= a.y })[side];
const sideCost = (a, b, side) => (faces(a, b, side) ? 0 : 60);

function buildGrid(nodes, extra) {
  const obs = nodes.map((n) => [n.x - n.m, n.y - n.m, n.x + n.w + n.m, n.y + n.h + n.m]);
  const bx = new Set(), by = new Set();
  for (const [x1, y1, x2, y2] of obs) { bx.add(x1); bx.add(x2); by.add(y1); by.add(y2); }
  // channels: the middle of every gap between boxes (and two lanes beside it when it is wide), plus a ring outside
  const lanes = (set) => {
    const v = [...set].sort((a, b) => a - b), out = new Set(set);
    for (let i = 1; i < v.length; i++) { const g = v[i] - v[i - 1]; if (g > 20) { const mid = (v[i] + v[i - 1]) / 2; out.add(mid); if (g > 44) { out.add(mid - 9); out.add(mid + 9); } } }
    [v[0] - 14, v[0] - 28, v[v.length - 1] + 14, v[v.length - 1] + 28].forEach((x) => out.add(x));
    return out;
  };
  const xs = lanes(bx), ys = lanes(by);
  for (const n of nodes) { xs.add(n.cx); ys.add(n.cy); }
  extra.x.forEach((v) => xs.add(v)); extra.y.forEach((v) => ys.add(v));
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
  const nx = X.length, ny = Y.length;
  const inside = (x, y) => obs.some(([x1, y1, x2, y2]) => x > x1 && x < x2 && y > y1 && y < y2);
  const blocked = new Uint8Array(nx * ny), segH = new Uint8Array(nx * ny), segV = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    blocked[k] = inside(X[i], Y[j]) ? 1 : 0;
    if (i + 1 < nx) segH[k] = inside((X[i] + X[i + 1]) / 2, Y[j]) ? 1 : 0;
    if (j + 1 < ny) segV[k] = inside(X[i], (Y[j] + Y[j + 1]) / 2) ? 1 : 0;
  }
  // a line along a box's clearance edge hugs the box; it costs a little more than a channel's middle
  const wx = X.map((v) => (bx.has(v) ? 1.2 : 1)), wy = Y.map((v) => (by.has(v) ? 1.2 : 1));
  const ix = new Map(X.map((v, i) => [v, i])), iy = new Map(Y.map((v, i) => [v, i]));
  return { X, Y, nx, ny, blocked, segH, segV, wx, wy, pt: (x, y) => { const i = ix.get(x), j = iy.get(y); return i === undefined || j === undefined ? -1 : j * nx + i; },
    used: new Map(), passH: new Uint8Array(nx * ny), passV: new Uint8Array(nx * ny), corner: new Uint8Array(nx * ny) };
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(c, s) { const a = this.a; a.push([c, s]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

// starts: [{k, dir, cost, side}] (k a grid point, dir the way out); goals: [{k, dir (the way in), cost, side}]
function shortest(G, starts, goals) {
  const N = G.nx * G.ny * 4, dist = new Float64Array(N + 1).fill(Infinity), prev = new Int32Array(N + 1).fill(-1);
  const goalAt = new Map(); goals.forEach((g) => { if (g.k >= 0) (goalAt.get(g.k) || goalAt.set(g.k, []).get(g.k)).push(g); });
  const h = new Heap(); let sinkGoal = null;
  const startOf = new Map();
  for (const s of starts) { if (s.k < 0) continue; const st = s.k * 4 + s.dir; if (s.cost < dist[st]) { dist[st] = s.cost; startOf.set(st, s); h.push(s.cost, st); } }
  while (h.size) {
    const [c, st] = h.pop();
    if (c > dist[st]) continue;
    if (st === N) break;
    const k = st >> 2, d = st & 3;
    for (const g of goalAt.get(k) || []) { const t = c + g.cost + (d === g.dir ? 0 : BEND); if (t < dist[N]) { dist[N] = t; prev[N] = st; sinkGoal = g; h.push(t, N); } }
    const i = k % G.nx, j = (k / G.nx) | 0;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d ^ 1)) continue;
      const ni = i + DX[nd], nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= G.nx || nj >= G.ny) continue;
      const q = nj * G.nx + ni;
      if (G.blocked[q]) continue;
      const horiz = nd < 2, seg = horiz ? Math.min(k, q) : Math.min(k, q);
      if (horiz ? G.segH[seg] : G.segV[seg]) continue;
      const len = horiz ? Math.abs(G.X[ni] - G.X[i]) : Math.abs(G.Y[nj] - G.Y[j]);
      let cost = len * (horiz ? G.wy[j] : G.wx[i]) + (nd !== d ? BEND : 0);
      const key = seg * 2 + (horiz ? 0 : 1);
      if (G.used.has(key)) cost += len * SHARE + 20;
      if (horiz ? G.passV[q] : G.passH[q]) cost += CROSS;
      if (G.corner[q]) cost += CORNER;
      const ns = q * 4 + nd;
      if (c + cost < dist[ns]) { dist[ns] = c + cost; prev[ns] = st; h.push(c + cost, ns); }
    }
  }
  if (!sinkGoal) return null;
  const chain = []; let st = prev[N];
  while (st >= 0) { chain.push(st); st = prev[st]; } // only a start has no way in
  chain.reverse();
  return { ks: chain.map((s) => s >> 2), start: startOf.get(chain[0]), goal: sinkGoal };
}
// remember a routed arrow so the next ones keep off its line, cross it as little as they can, and miss its corners
function mark(G, ks) {
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1], b = ks[i], horiz = Math.abs(a - b) === 1;
    G.used.set(Math.min(a, b) * 2 + (horiz ? 0 : 1), 1);
    if (i + 1 < ks.length) {
      const c = ks[i + 1], straight = Math.abs(b - c) === Math.abs(a - b);
      if (straight) (horiz ? G.passH : G.passV)[b] = 1; else G.corner[b] = 1;
    }
  }
}
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    if (out.length >= 2) { const [a, b] = [out[out.length - 2], out[out.length - 1]]; if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) out.pop(); }
    out.push(p);
  }
  return out;
}

function routeAll(d, at) {
  const nodes = [...at.values()], sides = ['R', 'L', 'B', 'T'];
  const ends = (n, other, fixed, off, inward) => (fixed ? [fixed] : sides).map((side) => {
    const pp = port(n, side, off);
    return { side, pp, dir: inward ? OUT[side] ^ 1 : OUT[side], cost: sideCost(n, other, side) };
  });
  // first pass: each arrow alone, to learn which side of each box it uses
  let G = buildGrid(nodes, { x: [], y: [] });
  const first = d.edges.map((e) => {
    const a = at.get(e.from), b = at.get(e.to);
    const r = shortest(G, ends(a, b).map((s) => ({ ...s, k: G.pt(...s.pp.s) })), ends(b, a, null, 0, true).map((s) => ({ ...s, k: G.pt(...s.pp.s) })));
    return { e, a, b, out: r?.start.side || 'R', in: r?.goal.side || 'L' };
  });
  // spread the arrows on each side, ordered by where their other end is, so they leave without crossing
  const bySide = new Map();
  first.forEach((r, i) => {
    for (const [n, side, other, end] of [[r.a, r.out, r.b, 'out'], [r.b, r.in, r.a, 'in']]) { const key = `${n.id}|${side}`; (bySide.get(key) || bySide.set(key, []).get(key)).push({ i, other, n, side, end }); }
  });
  const offs = first.map(() => ({ out: 0, in: 0 }));
  for (const list of bySide.values()) {
    const { n, side } = list[0], vertical = side === 'R' || side === 'L';
    list.sort((p, q) => (vertical ? p.other.cy - q.other.cy : p.other.cx - q.other.cx) || p.i - q.i);
    const span = (vertical ? n.h : n.w) - 16, step = list.length > 1 ? Math.min(14, span / (list.length - 1)) : 0;
    list.forEach((p, j) => { offs[p.i][p.end] = Math.round((j - (list.length - 1) / 2) * step); });
  }
  // second pass: fixed sides and spread ports, each arrow keeping off the ones already drawn
  const ex = { x: [], y: [] };
  first.forEach((r, i) => { for (const [n, side, o] of [[r.a, r.out, offs[i].out], [r.b, r.in, offs[i].in]]) { const { s } = port(n, side, o); (side === 'R' || side === 'L' ? ex.y : ex.x).push(s[side === 'R' || side === 'L' ? 1 : 0]); } });
  G = buildGrid(nodes, ex);
  return first.map((r, i) => {
    const src = port(r.a, r.out, offs[i].out), dst = port(r.b, r.in, offs[i].in);
    const res = shortest(G, [{ k: G.pt(...src.s), dir: OUT[r.out], cost: 0 }], [{ k: G.pt(...dst.s), dir: OUT[r.in] ^ 1, cost: 0 }]);
    let pts;
    if (res) { mark(G, res.ks); pts = [src.p, ...res.ks.map((k) => [G.X[k % G.nx], G.Y[(k / G.nx) | 0]]), dst.p]; }
    else pts = [src.p, src.s, [src.s[0], dst.s[1]], dst.s, dst.p]; // no free path: a plain elbow
    return { e: r.e, i, pts: simplify(pts) };
  });
}

// ------------------------------------------------------------------ labels: on the arrow's longest free run, never on a box or another label
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
function placeLabels(routes, at, f, { colX, colW, rowY }) {
  const blocks = [...at.values()].map((n) => [n.x - 4, n.y - 4, n.x + n.w + 4, n.y + n.h + 4]);
  const placed = [], grow = {}, growRow = {};
  const out = routes.map((r) => {
    const lines = r.e.label ? wrap(r.e.label, f.edge, LINE_MAX) : [];
    if (!lines.length && !r.e.step) return null;
    const textW = Math.max(0, ...lines.map((l) => tw(l, f.edge))), badge = r.e.step ? 16 : 0;
    const bw = Math.ceil(textW + (badge ? badge + (lines.length ? 5 : 0) : 0) + 8), bh = Math.max(lines.length * LINE_H, badge) + 4;
    const cands = [];
    for (let i = 1; i < r.pts.length; i++) {
      const [x1, y1] = r.pts[i - 1], [x2, y2] = r.pts[i], horiz = y1 === y2, len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      const need = horiz ? bw + 20 : bh + 16;
      const at1 = (t) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      const spots = len >= need * 2 ? [0.5, (need / 2 + 4) / len, 1 - (need / 2 + 4) / len] : [0.5];
      for (const t of spots) cands.push({ c: at1(t), fits: len >= need, horiz, len, seg: [x1, y1, x2, y2], pref: (len >= need ? 0 : 100) + (horiz ? 0 : 6) - len / 100 + Math.abs(t - 0.5) * 2 });
    }
    cands.sort((p, q) => p.pref - q.pref);
    const box = (c) => [c[0] - bw / 2, c[1] - bh / 2, c[0] + bw / 2, c[1] + bh / 2];
    let pick = cands.find((c) => c.fits && !blocks.some((b) => hit(box(c.c), b)) && !placed.some((b) => hit(box(c.c), b)));
    if (!pick) {
      // a spot clear of every box and label: anywhere along the arrow in 6 px steps, then just beside it; the old
      // fallback (clear of boxes only, else the first) is the last resort
      const clear = (c) => !blocks.some((b) => hit(box(c), b)) && !placed.some((b) => hit(box(c), b));
      let spot = null;
      for (let i = 1; i < r.pts.length && !spot; i++) {
        const [x1, y1] = r.pts[i - 1], [x2, y2] = r.pts[i], len = Math.abs(x2 - x1) + Math.abs(y2 - y1), horiz = y1 === y2;
        for (let t = 0; t <= len && !spot; t += 6) {
          const c = [x1 + Math.sign(x2 - x1) * t, y1 + Math.sign(y2 - y1) * t];
          const beside = horiz ? [[c[0], c[1] - bh / 2 - 3], [c[0], c[1] + bh / 2 + 3]] : [[c[0] + bw / 2 + 4, c[1]], [c[0] - bw / 2 - 4, c[1]]];
          spot = [c, ...beside].find(clear) || null;
        }
      }
      pick = spot ? { c: spot } : cands.find((c) => !blocks.some((b) => hit(box(c.c), b))) || cands[0];
      // ask for a wider gap where the label wanted to sit
      const best = cands.reduce((p, q) => (q.len > p.len ? q : p));
      const mx = (best.seg[0] + best.seg[2]) / 2, my = (best.seg[1] + best.seg[3]) / 2;
      const gi = colX.findIndex((x, i) => i + 1 < colX.length && mx > x + colW[i] && mx < colX[i + 1]);
      const ri = rowY.findIndex((y, i) => i + 1 < rowY.length && my > y + NODE_H && my < rowY[i + 1]);
      if (best.horiz && gi >= 0) grow[gi] = Math.max(grow[gi] || 0, bw + 2 * CLEAR + 24);
      else if (!best.horiz && ri >= 0) growRow[ri] = Math.max(growRow[ri] || 0, bh + 2 * CLEAR + 20);
      else if (gi >= 0) grow[gi] = Math.max(grow[gi] || 0, bw + 2 * CLEAR + 12);
    }
    const b = box(pick.c); placed.push(b);
    return { r, lines, b, badge, textW };
  });
  return { labels: out.filter(Boolean), grow, growRow };
}


// ------------------------------------------------------------------ drawing
function pathOf(pts, r = 6) {
  let p = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i === pts.length - 1) { p += ` L${x},${y}`; break; }
    const [px, py] = pts[i - 1], [nx, ny] = pts[i + 1];
    const d1 = Math.min(r, Math.hypot(x - px, y - py) / 2), d2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
    p += ` L${x - Math.sign(x - px) * d1},${y - Math.sign(y - py) * d1} Q${x},${y} ${x + Math.sign(nx - x) * d2},${y + Math.sign(ny - y) * d2}`;
  }
  return p;
}
function partSVG(n) {
  const tx = n.x + n.inset, two = !!n.sub || n.lines.length > 1;
  const ly = n.y + (two ? 19 : 27);
  return `<g class="nd ${n.change}${n.outside ? ' out' : ''}" data-id="${esc(n.id)}"${n.ref ? ` data-ref="${esc(n.ref)}" role="link" tabindex="0"` : ''}>` +
    `<title>${esc(n.label)}${n.ref ? `\n${esc(n.ref)}` : ''}${n.letter ? `\n${{ A: 'New', M: 'Changed', D: 'Removed' }[n.letter]} in this change` : ''}</title>` +
    `<rect x="${n.x + 0.5}" y="${n.y + 0.5}" width="${n.w - 1}" height="${n.h - 1}" rx="6"/>` +
    (n.letter ? `<text class="lt ${n.letter}" x="${n.x + PADX}" y="${ly}">${n.letter}</text>` : '') +
    n.lines.map((l, k) => `<text class="lb" x="${tx}" y="${ly + k * 16}">${esc(l)}</text>`).join('') +
    (n.sub ? `<text class="rf${n.mono ? '' : ' kw'}" x="${tx}" y="${n.y + 34}">${esc(n.sub)}</text>` : '') + `</g>`;
}
const marker = (id, c) => `<marker id="${id}-${c}" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="ah ${c}" d="M0,0.6 L8,4 L0,7.4 Z"/></marker>`;
const markers = (id) => `<defs>${['none', 'changed', 'new', 'removed'].map((c) => marker(id, c)).join('')}</defs>`;
const sheet = (x0, y0, w, h, title, body) => `<svg class="dgsvg" viewBox="${x0} ${y0} ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">${body}</svg>`;

// lay a map out: boxes, then routes, then labels, widening a gap where a label had no room, up to four times
function mapLayout(d, f, dir, narrow) {
  let gut = {}, rgut = {}, L, routes, lab;
  for (let pass = 0; pass < 4; pass++) {
    L = layout(d, gut, rgut, f, dir, narrow); routes = routeAll(d, L.at); lab = placeLabels(routes, L.at, f, L);
    const colBase = dir === 'tb' ? GUTTER_TB : GUTTER, more = Object.entries(lab.grow).filter(([i, w]) => w > (gut[i] ?? colBase) && (gut[i] ?? colBase) < MAX_GUTTER);
    const rowBase = dir === 'tb' ? ROW_GAP_TB : ROW_GAP, moreR = Object.entries(lab.growRow).filter(([i, h]) => h > (rgut[i] ?? rowBase) && (rgut[i] ?? rowBase) < 120);
    if (!more.length && !moreR.length) break;
    gut = { ...gut }; for (const [i, w] of more) gut[i] = Math.min(MAX_GUTTER, w);
    rgut = { ...rgut }; for (const [i, h] of moreR) rgut[i] = Math.min(120, h);
  }
  const { at } = L;
  const ext = [Infinity, Infinity, -Infinity, -Infinity], add = (x1, y1, x2, y2) => { ext[0] = Math.min(ext[0], x1); ext[1] = Math.min(ext[1], y1); ext[2] = Math.max(ext[2], x2); ext[3] = Math.max(ext[3], y2); };
  for (const n of at.values()) add(n.x, n.y, n.x + n.w, n.y + n.h);
  for (const r of routes) for (const [x, y] of r.pts) add(x - 4, y - 4, x + 4, y + 4);
  for (const l of lab.labels) add(...l.b);
  const boxes = (d.groups || []).map((g) => {
    const ns = g.nodes.map((gid) => at.get(gid)).filter(Boolean);
    if (!ns.length) return null;
    const b = [Math.min(...ns.map((n) => n.x)) - 16, Math.min(...ns.map((n) => n.y)) - 28, Math.max(...ns.map((n) => n.x + n.w)) + 16, Math.max(...ns.map((n) => n.y + n.h)) + 16];
    add(...b);
    return { g, b };
  }).filter(Boolean);
  return { at, routes, lab, ext, boxes, w: Math.round(ext[2] - ext[0]) + PAD * 2 };
}
// a map at most `limit` wide: while it is wider, the widest box that can puts its name on two lines
function mapSVG(d, f, id, dir, limit = 0) {
  const narrow = new Set();
  const tighten = (at) => {
    const next = [...at.values()].filter((n) => !narrow.has(n.id) && part(n, f, true).w < n.w).sort((a, b) => b.w - a.w)[0];
    if (!next) return false;
    narrow.add(next.id);
    return true;
  };
  if (limit) {
    // The boxes and base gaps set a lower bound. Route only after that fits or no box can shrink.
    let grid = layout(d, {}, {}, f, dir, narrow);
    while (grid.colX.at(-1) + grid.colW.at(-1) + PAD * 2 > limit && tighten(grid.at)) {
      grid = layout(d, {}, {}, f, dir, narrow);
    }
  }
  let m = mapLayout(d, f, dir, narrow);
  while (limit && m.w > limit && tighten(m.at)) m = mapLayout(d, f, dir, narrow);
  const { at, routes, lab, ext } = m;
  const groups = m.boxes.map(({ g, b: [x1, y1, x2, y2] }) => `<g class="gr"><rect x="${x1 + 0.5}" y="${y1 + 0.5}" width="${x2 - x1 - 1}" height="${y2 - y1 - 1}" rx="8"/><text x="${x1 + 12}" y="${y1 + 17}">${esc(g.label.toUpperCase())}</text></g>`).join('');
  const edges = routes.map((r) => `<path class="ed ${r.e.change}" data-e="${r.i}" data-a="${esc(r.e.from)}" data-b="${esc(r.e.to)}" d="${pathOf(r.pts)}" marker-end="url(#${id}-${r.e.change})"/>`).join('');
  const labels = lab.labels.map(({ r, lines, b }) => {
    const top = (b[1] + b[3]) / 2 - (lines.length * LINE_H) / 2;
    return `<g class="el ${r.e.change}" data-e="${r.i}"><rect class="bg" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>` +
      lines.map((l, k) => `<text x="${(b[0] + b[2]) / 2}" y="${(top + k * LINE_H + 10.5).toFixed(1)}" text-anchor="middle">${esc(l)}</text>`).join('') + `</g>`;
  }).join('');
  const [x0, y0, x1, y1] = [ext[0] - PAD, ext[1] - PAD, ext[2] + PAD, ext[3] + PAD].map(Math.round);
  return sheet(x0, y0, x1 - x0, y1 - y0, d.title, `${markers(id)}${groups}${edges}${[...at.values()].map(partSVG).join('')}${labels}`);
}

// a flow as lanes: the parts across the top in the order the steps first reach them, a line down from each, and one
// numbered arrow per step, each lane gap wide enough for the labels that cross it
function flowSVG(d, f, id, width = 0) {
  const steps = d.edges.map((e, i) => ({ ...e, i, n: e.step || i + 1 })).sort((a, b) => a.n - b.n || a.i - b.i);
  const order = [];
  for (const e of steps) for (const k of [e.from, e.to]) if (!order.includes(k)) order.push(k);
  for (const n of d.nodes) if (!order.includes(n.id)) order.push(n.id);
  const lane = new Map(order.map((k, i) => [k, i]));
  const nodes = order.map((k) => d.nodes.find((n) => n.id === k));
  const full = nodes.map((n) => part(n, f)), two = nodes.map((n) => part(n, f, 'two'));
  const need = (e) => 16 + (e.label ? 6 + tw(e.label, f.edge) : 0) + 28;
  const span = (e) => Math.abs(lane.get(e.from) - lane.get(e.to));
  const bySpan = [...steps].sort((a, b) => span(a) - span(b));
  // lane centres: boxes 16 apart, and every step's arrow long enough for its number and label
  const centres = (use) => {
    const cx = [];
    use.forEach((p, i) => { cx[i] = i ? cx[i - 1] + (use[i - 1].w + p.w) / 2 + 16 : p.w / 2; });
    for (const e of bySpan) {
      const lo = Math.min(lane.get(e.from), lane.get(e.to)), hi = Math.max(lane.get(e.from), lane.get(e.to)), short = need(e) - (cx[hi] - cx[lo]);
      if (short > 0) for (let k = lo + 1; k < cx.length; k++) cx[k] += k >= hi ? short : (short * (k - lo)) / (hi - lo);
    }
    return cx;
  };
  // every box starts with its whole name and file; while the lanes are wider than the column, the widest box that
  // can narrows to its name on two lines
  const limit = width ? width - PAD * 2 : Infinity, use = full.slice();
  let cx = centres(use);
  while (cx[cx.length - 1] + use[use.length - 1].w / 2 > limit) {
    let k = -1;
    use.forEach((u, i) => { if (u !== two[i] && two[i].w < u.w && (k < 0 || u.w > use[k].w)) k = i; });
    if (k < 0) break;
    use[k] = two[k]; cx = centres(use);
  }
  if (width && cx.length > 1) { // what is left over spreads evenly, so the lanes fill the column
    const spare = limit - (cx[cx.length - 1] + use[use.length - 1].w / 2);
    if (spare > 0) for (let k = 1; k < cx.length; k++) cx[k] += (spare * k) / (cx.length - 1);
  }
  const parts = nodes.map((n, i) => ({ ...n, ...use[i] }));
  const ROW = 40, first = NODE_H + 40, last = first + (steps.length - 1) * ROW;
  const xs = cx.map(Math.round);
  const heads = parts.map((p, i) => partSVG({ ...p, x: xs[i] - Math.round(p.w / 2), y: 0 })).join('');
  const lines = parts.map((p, i) => `<path class="ll" d="M${xs[i] + 0.5},${NODE_H} L${xs[i] + 0.5},${last + 16}"/>`).join('');
  const arrows = steps.map((e, k) => {
    const a = xs[lane.get(e.from)], b = xs[lane.get(e.to)], y = first + k * ROW + 0.5, dir = Math.sign(b - a);
    const tw0 = e.label ? tw(e.label, f.edge) : 0, total = 16 + (e.label ? 6 + tw0 : 0), x = Math.round((a + b) / 2 - total / 2);
    return `<path class="ed ${e.change}" data-e="${e.i}" data-a="${esc(e.from)}" data-b="${esc(e.to)}" d="M${a + dir},${y} L${b - dir},${y}" marker-end="url(#${id}-${e.change})"/>` +
      `<g class="el ${e.change}" data-e="${e.i}"><rect class="bg" x="${x - 3}" y="${y - 21}" width="${Math.ceil(total) + 6}" height="18"/><rect class="sb" x="${x}" y="${y - 20}" width="16" height="16" rx="4"/>` +
      `<text class="sn" x="${x + 8}" y="${y - 8}" text-anchor="middle">${e.n}</text>${e.label ? `<text x="${x + 22}" y="${y - 8}">${esc(e.label)}</text>` : ''}</g>`;
  }).join('');
  const x0 = Math.floor(Math.min(...parts.map((p, i) => xs[i] - Math.round(p.w / 2)))), x1 = Math.ceil(Math.max(...parts.map((p, i) => xs[i] - Math.round(p.w / 2) + p.w)));
  return sheet(x0 - PAD, -PAD, x1 - x0 + PAD * 2, last + 16 + PAD * 2, d.title, `${markers(id)}${lines}${arrows}${heads}`);
}

const drawn = new Map(); // a drawing depends only on its diagram and its turn, and the card re-renders often
let uid = 0;
// a map turns ('lr' or 'tb'); a flow keeps its lanes and narrows its part names ('lr' or 'tb', which means compact)
function draw(d, dir = 'lr') {
  const width = dir === 'tb' ? Math.floor(room() / 8) * 8 : 0; // a turned map and narrow lanes fit the column
  const key = dir + width + JSON.stringify(d);
  if (!drawn.has(key)) {
    if (drawn.size > 24) drawn.clear();
    const f = fonts(), id = `dg${++uid}`;
    const svg = d.kind === 'flow' ? flowSVG(d, f, id, width) : mapSVG(d, f, id, dir, width);
    drawn.set(key, { svg, w: Number(/ width="(\d+)"/.exec(svg)?.[1]) || 0 });
  }
  return drawn.get(key);
}
export const diagramSVG = (d, dir) => draw(d, dir).svg;
// the room the drawing has inside the card; a map that does not fit across turns to read top to bottom
const room = () => { const c = $('#cards'); return c ? c.clientWidth - 2 * 16 - 2 - 2 * 16 : innerWidth - 700; };
// opening it large helps only when the whole drawing, as Claude laid it out, fits the window but not the column
function pickDir(d) {
  const lr = draw(d, 'lr').w;
  if (lr <= room()) return 'lr';
  return draw(d, 'tb').w < lr ? 'tb' : 'lr';
}

// ------------------------------------------------------------------ the card
// the key shows only what this drawing uses
function legend(d) {
  const has = (c) => d.nodes.some((n) => n.change === c);
  const lt = (c, l, word) => (has(c) ? `<span><b class="st ${l}">${l}</b>${word}</span>` : '');
  return `<div class="dglegend">${lt('changed', 'M', 'changed')}${lt('new', 'A', 'new')}${lt('removed', 'D', 'removed')}` +
    `${d.nodes.some((n) => n.kind === 'external' || n.kind === 'data') ? `<span><i class="sw"></i>outside this repository</span>` : ''}` +
    `<span><i class="ln on"></i>the change</span><span><i class="ln"></i>around it</span></div>`;
}
const inline = (s, o) => md(s, o).replace(/^<p>|<\/p>\s*$/g, '');
const stepLine = (b) => (b.step ? `Regenerating · reading ${b.step}` : 'Regenerating…');

export function mapCardHTML(b) {
  if (!b?.context?.system && !b?.diagrams?.length) return '';
  queueMicrotask(watchWidth);
  const open = pref.get('mapOpen', true);
  const c = b.context || {}, ds = b.diagrams || [], plan = b.plan || {};
  const o = { images: modelKind(b.model) !== 'codex', citations: b.citations };
  const which = Math.max(0, Math.min(ds.length - 1, Number(pref.get('mapTab', 0)) || 0));
  const d = ds[which], dir = d ? pickDir(d) : 'lr';
  const big = `<button class="link dgbig" data-act="mapbig" title="The drawing across the whole window">Open large</button>`;
  const fig = d ? `<figure class="dg" data-dir="${dir}" data-room="${Math.round(room())}"><div class="dgbar">${ds.length > 1 ? `<div class="dgtabs" role="tablist">${ds.map((x, i) => `<button role="tab" data-act="maptab" data-i="${i}" aria-selected="${i === which}">${esc(x.title || (x.kind === 'flow' ? 'Flow' : 'Map'))}</button>`).join('')}</div>` : `<div class="dgtabs"><span class="one">${esc(d.title || 'Map')}</span></div>`}${big}</div>` +
    `<div class="dgview">${diagramSVG(d, dir)}</div>${d.caption ? `<figcaption>${inline(d.caption, o)}</figcaption>` : ''}${legend(d)}</figure>` : '';
  const text = `<div class="mtext">` +
    (c.system ? `<h3>How this part works</h3><div class="md">${md(c.system, o)}</div>` : '') +
    (c.before || c.after ? `<dl class="ba">${c.before ? `<dt>Before</dt><dd class="md">${md(c.before, o)}</dd>` : ''}${c.after ? `<dt>After</dt><dd class="md">${md(c.after, o)}</dd>` : ''}</dl>` : '') +
    (c.glossary?.length ? `<h3>Words you will meet</h3><dl class="gl">${c.glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${inline(g.meaning, o)}${g.where ? ` <span class="wh">${inline(g.where, o)}</span>` : ''}</dd>`).join('')}</dl>` : '') + `</div>`;
  const how = `<div class="mplan">` +
    (plan.steps?.length ? `<h3>How to review it</h3>${plan.why ? `<p class="why">${inline(plan.why, o)}</p>` : ''}<ol>${plan.steps.map((x) => `<li>${inline(x, o)}</li>`).join('')}</ol>` : '') +
    (b.questions?.length ? `<h3>Worth asking</h3><ul>${b.questions.map((x) => `<li>${inline(x, o)}</li>`).join('')}</ul>` : '') + `</div>`;
  const tools = (plan.start ? `<button class="link" data-act="mapstart" data-p="${esc(plan.start)}">Start with ${esc(plan.start.split('/').pop())}</button>` : '') +
    (b.pending ? `<span class="mstate shimmer">${esc(stepLine(b))}</span>` : `<span class="mre">${briefRunBtn()}<button class="link" data-act="maprebrief" title="Write the guide and this map again with this model">Regenerate</button></span>`);
  return `<section class="mapcard${open ? '' : ' shut'}" id="mapcard"><header class="mh"><button class="mtoggle" data-act="maptoggle" aria-expanded="${open}"><span class="lbl">Map of this change</span></button><span class="sp"></span>${tools}</header>` +
    `<div class="mapbody">${fig}<div class="mcols">${text}${how}</div></div></section>`;
}
// after the brief changes: redraw the card in place, or put it in when the first brief lands
hooks.mapChanged = () => {
  const m = $('#mapcard'), html = mapCardHTML(S.review.brief);
  if (m) { m.outerHTML = html; return; }
  const cards = $('#cards');
  if (!html || !cards || !cards.querySelector(':scope > .file')) return;
  const after = cards.querySelector(':scope > .banner');
  if (after) after.insertAdjacentHTML('afterend', html); else cards.insertAdjacentHTML('afterbegin', html);
};
hooks.mapStep = () => { const t = $('#mapcard .mstate'); if (t && S.review.brief) t.textContent = stepLine(S.review.brief); };
hooks.briefPending = () => hooks.mapChanged();

// the drawing across the whole window, as Claude laid it out, in the same dialog frame as the rest of loupe
function openLarge(focusNode, diagram) {
  const b = S.review.brief, ds = b?.diagrams || [];
  const active = diagram || ds[Math.max(0, Math.min(ds.length - 1, Number(pref.get('mapTab', 0)) || 0))];
  if (!active) return;
  const opener = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'sheetscrim';
  scrim.innerHTML = `<div class="sheet k-map" role="dialog" aria-modal="true" aria-labelledby="mapbigt" id="mapbig"><header class="shh"><h2 class="t" id="mapbigt">${esc(active.title || 'Map')}</h2>${legend(active)}<button class="icon" data-mb="close" title="Close (esc)" aria-label="Close">${I.x}</button></header>` +
    `<div class="mbview">${diagramSVG(active, 'lr')}</div>${active.caption ? `<p class="mbcap">${inline(active.caption, { images: modelKind(b?.model) !== 'codex', citations: b?.citations })}</p>` : ''}</div>`;
  const close = () => { scrim.remove(); document.removeEventListener('keydown', key, true); if (opener?.isConnected) opener.focus(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  scrim.addEventListener('click', (e) => {
    if (e.target.closest('[data-mb="close"]')) return close();
    const nd = e.target.closest('.nd[data-ref]'), link = e.target.closest('a.loc');
    if (nd || link) {
      const view = scrim.querySelector('.mbview'), { scrollTop, scrollLeft } = view;
      close();
      const restore = () => {
        openLarge(nd?.dataset.id, active);
        const restored = $('#mapbig .mbview');
        if (restored) { restored.scrollTop = scrollTop; restored.scrollLeft = scrollLeft; }
      };
      if (nd) goRef(nd, restore);
      else hooks.goLoc?.({ path: link.dataset.p, line: Number(link.dataset.l), excerpt: link.dataset.excerpt }, link, restore);
    }
  });
  document.addEventListener('keydown', key, true);
  document.body.append(scrim);
  requestAnimationFrame(() => {
    const node = focusNode && scrim.querySelector(`.nd[data-id="${CSS.escape(focusNode)}"]`);
    (node || scrim.querySelector('[data-mb="close"]'))?.focus({ preventScroll: true });
  });
}
// the column changes width when a pane opens or closes: turn the drawing when the other way fits better
let watched = null, observer = null, rz = 0;
function watchWidth() {
  const cards = $('#cards');
  if (watched === cards || typeof ResizeObserver === 'undefined') return;
  observer?.disconnect();
  clearTimeout(rz);
  watched = cards;
  if (!cards) return;
  observer = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => {
    const fig = $('#mapcard .dg'), ds = S.review.brief?.diagrams || [], d = ds[Math.max(0, Math.min(ds.length - 1, Number(pref.get('mapTab', 0)) || 0))];
    if (!fig || !d) return;
    const dir = pickDir(d), lanes = dir === 'tb' && Math.abs(room() - Number(fig.dataset.room)) >= 8;
    if (fig.dataset.dir !== dir || lanes) hooks.mapChanged?.();
  }, 120); });
  observer.observe(cards);
}

// ------------------------------------------------------------------ what you can do on it
function goRef(node, restore) {
  const m = /^(.*?)(?::(\d+))?$/.exec(node.dataset.ref);
  if (!m) return;
  hooks.goLoc?.({ path: m[1], line: Number(m[2]) || 0, excerpt: S.review.brief?.citations?.[node.dataset.ref], side: node.classList.contains('removed') ? 'old' : 'new' }, node, restore);
}
// pointing at a part lights its arrows and the parts at their other ends; the rest of the sheet recedes
function light(svg, id) {
  if (!svg) return;
  svg.classList.toggle('focus', !!id);
  const on = new Set(), near = new Set([id]);
  svg.querySelectorAll('path.ed').forEach((p) => { if (id && (p.dataset.a === id || p.dataset.b === id)) { on.add(p.dataset.e); near.add(p.dataset.a); near.add(p.dataset.b); } });
  svg.querySelectorAll('.ed, .el').forEach((x) => x.classList.toggle('hl', on.has(x.dataset.e)));
  svg.querySelectorAll('.nd').forEach((x) => x.classList.toggle('hl', !!id && near.has(x.dataset.id)));
}
document.addEventListener('pointerover', (e) => { const svg = e.target.closest?.('#mapcard .dgsvg, #mapbig .dgsvg'); if (svg) light(svg, e.target.closest('.nd')?.dataset.id || null); });
document.addEventListener('pointerout', (e) => { const svg = e.target.closest?.('#mapcard .dgsvg, #mapbig .dgsvg'); if (svg && !svg.contains(e.relatedTarget)) light(svg, null); });
document.addEventListener('focusin', (e) => { const nd = e.target.closest?.('#mapcard .nd, #mapbig .nd'); if (nd) light(nd.closest('.dgsvg'), nd.dataset.id); });
document.addEventListener('focusout', (e) => { const nd = e.target.closest?.('#mapcard .nd, #mapbig .nd'); if (nd) light(nd.closest('.dgsvg'), null); });
document.addEventListener('click', (e) => {
  const card = e.target.closest?.('#mapcard');
  if (!card) return;
  const b = e.target.closest('[data-act]');
  if (b?.dataset.act === 'maptoggle') { const open = card.classList.toggle('shut') === false; pref.set('mapOpen', open); b.setAttribute('aria-expanded', String(open)); return; }
  if (b?.dataset.act === 'maptab') { pref.set('mapTab', Number(b.dataset.i)); card.outerHTML = mapCardHTML(S.review.brief); return; }
  if (b?.dataset.act === 'mapstart') return hooks.goLoc?.({ path: b.dataset.p, line: 0 }, b);
  if (b?.dataset.act === 'maprebrief') return hooks.rebrief?.();
  if (b?.dataset.act === 'mapbig') return openLarge();
  const nd = e.target.closest('.nd[data-ref]');
  if (nd) return goRef(nd);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest?.('#mapcard .nd[data-ref], #mapbig .nd[data-ref]');
  if (t) { e.preventDefault(); t.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});
