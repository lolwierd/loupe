// Getting around: going to a path:line (in the diff when it is there, else the whole-file viewer), the viewer
// itself, and gopls: hover for docs, ⌘-click for the definition, ⇧⌘-click for references.
import { S, $, esc, h, api, wsApi, toast, fileOf, I } from './core.js';
import { loadTokens, tokHTML, findRow, findLine, revealAround } from './diff.js';
import { cardEl, loadFile, renderBody, toggleFold, flashLines } from './cards.js';
import { md } from './md.js';
import { hooks } from './hooks.js';

export function resolvePath(p) {
  if (fileOf(p)) return p;
  const hit = S.files.find((f) => f.path.endsWith('/' + p));
  return hit ? hit.path : p;
}

const returns = [];
let jump = 0;
// gopls lookups still waiting have their own count: any move (a jump, a step back, ], another click) makes them moot
let lookup = 0;
// Where a jump leaves from, said as the place going back lands on: the map or scene opened large (Back opens it again),
// the line of code clicked, the whole-file viewer under the click (Back reopens it), the map card, else the diff's file.
function placeOf(origin) {
  const big = origin?.closest?.('#mapbig');
  if (big) return { text: big.classList.contains('k-scene') ? 'the scene' : 'the map' };
  const tx = origin?.closest?.('.tx[data-l]'), host = origin?.closest?.('[data-p]');
  const at = tx && host?.dataset.p ? [host.dataset.p, tx.dataset.l] : S.view?.path ? [S.view.path, S.view.line] : null;
  if (at) return { path: at[0], text: `${at[0].slice(at[0].lastIndexOf('/') + 1)}${at[1] ? ':' + at[1] : ''}`, code: true };
  if (origin?.closest?.('#mapcard')) return { text: 'the map' };
  return S.current ? { path: S.current, text: S.current.slice(S.current.lastIndexOf('/') + 1), code: true } : null;
}
// The way back after a jump: [, and the slip at the foot of the diff's column that names where it goes. The slip shows
// only while the newest place to return to is a jump (] keeps a place too, and [ undoes that first), and not over the
// whole-file viewer, which has its own Back in its head.
function paintReturn() {
  const vback = $('#vback');
  if (vback) vback.hidden = !returns.length;
  const back = returns.at(-1)?.back;
  let slip = $('#backslip');
  // [ presses the slip it is leaving: change it once that press has shown (strike.js holds it 90 ms at least)
  // (and it no longer says where a click goes, so it takes none meanwhile)
  if (slip?.querySelector('.struck')) { slip.inert = true; return void setTimeout(paintReturn, 40); }
  if (!back || $('#viewer')) return slip?.remove();
  if (!slip) {
    slip = h(`<div class="backslip" id="backslip"><button class="link" data-act="back">${I.chevL}<span>Back to <b></b></span></button><kbd>[</kbd></div>`);
    ($('.viewer-col') || document.body).append(slip);
    slip.onclick = goBack;
  }
  slip.inert = false;
  const where = slip.querySelector('b');
  where.textContent = back.text;
  where.classList.toggle('mono', !!back.code);
  slip.querySelector('button').title = back.path ? `Back to ${back.path} ([)` : 'Back ([)';
}
export function clearReturns() { jump++; returns.length = 0; closeViewer(); paintReturn(); }
export async function goBack() {
  const prev = returns.pop();
  if (!prev) return;
  const request = ++jump;
  lookup++;
  $('#refs')?.remove(); // its rows were found from where we are leaving
  closeViewer();
  if (prev.filter !== S.filter) hooks.setFilter?.(prev.filter);
  if (prev.view) await openViewer(prev.view);
  if (request !== jump) return;
  await prev.restore?.();
  if (request !== jump) return;
  for (const [id, top, left, offset] of prev.scroll) {
    const el = $(id);
    if (!el) continue;
    const originTop = offset != null && prev.origin?.isConnected ? prev.origin.getBoundingClientRect().top : null;
    el.scrollTop = originTop === null ? top : el.scrollTop + originTop - el.getBoundingClientRect().top - offset;
    el.scrollLeft = left;
  }
  if (prev.origin?.isConnected) prev.origin.focus({ preventScroll: true });
  paintReturn();
}

// A place to come back to with [, taken now: the scroll of every column, and what to undo on the way back. ] takes one
// before it marks a file viewed and moves on, so [ un-views that file and returns to it.
export function remember(restore) {
  lookup++; // ] moves on: a definition still being looked up goes nowhere
  const scroll = ['#center', '#pbody', '#vbody'].flatMap((id) => { const el = $(id); return el ? [[id, el.scrollTop, el.scrollLeft, null]] : []; });
  const entry = { scroll, restore, view: S.view, filter: S.filter };
  returns.push(entry);
  if (returns.length > 24) returns.shift();
  paintReturn();
  return entry;
}
// a place taken for something that then did nothing
export function forget(entry) { const i = returns.lastIndexOf(entry); if (i >= 0) returns.splice(i, 1); paintReturn(); }
export async function goLoc(loc, origin, restore, { remembered = false, back = null } = {}) {
  if (loc.external && !loc.readable) return toast(`Defined outside the repository: ${loc.path}:${loc.line}`);
  const scope = S.scope, id = S.id;
  const request = ++jump;
  lookup++;
  const current = () => request === jump && S.scope === scope && S.id === id;
  if (!remembered && (origin || restore || S.view)) {
    const scroll = ['#center', '#pbody', '#vbody'].flatMap((id) => {
      const el = $(id);
      if (!el) return [];
      const offset = origin && el.contains?.(origin) ? origin.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
      return [[id, el.scrollTop, el.scrollLeft, offset]];
    });
    returns.push({ scroll, origin, restore, view: S.view, filter: S.filter, back: back || placeOf(origin) });
    if (returns.length > 24) returns.shift();
    paintReturn();
  }
  hideTip(); $('#refs')?.remove();
  if (loc.external) return openViewer({ path: loc.path, line: loc.line, ext: true });
  const p = loc.exact ? loc.path : resolvePath(loc.path);
  if (loc.excerpt && loc.line) {
    const resolved = await api(wsApi('/citation', { path: p, line: loc.line, side: loc.side || 'new', excerpt: loc.excerpt })).catch(() => null);
    if (!current()) return;
    const needsCheck = !resolved?.line;
    origin?.classList.toggle('citation-check', needsCheck);
    if (needsCheck) toast('Citation needs checking. No unique nearby match.');
    loc = { ...loc, line: resolved?.line || 0 };
  }
  if (!fileOf(p)) return openViewer({ path: p, line: loc.line, side: loc.side });
  closeViewer();
  const card = cardEl(p);
  if (!card) return openViewer({ path: p, line: loc.line, side: loc.side });
  if (card.hidden) hooks.clearFilter?.();
  if (card.classList.contains('shut')) toggleFold(p, false);
  try { await loadFile(p); } catch (e) { if (current()) toast(e.message, { fail: true }); return; }
  if (!current() || cardEl(p) !== card) return;
  hooks.setCurrent?.(p);
  if (!loc.line) { card.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
  const side = loc.side === 'old' ? 'old' : 'new';
  let rows = S.rows.get(p);
  if (findRow(rows, { side, line: loc.line }) < 0 && side === 'new') { if (await revealAround(p, loc.line)) renderBody(p); rows = S.rows.get(p); }
  if (!current() || cardEl(p) !== card) return;
  // a range is found by its first line, or by its last when the first is context the old side does not hold
  let i = findLine(rows, { side, line: loc.line });
  if (i < 0 && loc.end) i = findRow(rows, { side, line: loc.end });
  if (i < 0) return openViewer({ path: p, line: loc.line, side });
  // a range (loc.end: a mark's lines) is centred on its first line and every line of it flashes, to the end (cards.js)
  const items = S.items.get(p), k = items.findIndex((it) => it.i === i || it.L === i || it.R === i);
  card.querySelector(`.ln[data-k="${k}"]`)?.scrollIntoView({ block: 'center' });
  const lines = [];
  for (let line = loc.line, last = Math.max(loc.line, loc.end || loc.line); line <= last && lines.length < 400; line++) lines.push(line);
  flashLines(p, side, lines);
}

export async function goThread(id) {
  const th = S.review.threads.find((t) => t.id === id);
  if (!th) return;
  if (/^[0-9a-f]{40}$/.test(th.scope || '') && th.scope !== S.rangeKey) await hooks.setScope?.(th.scope);
  else if (/^[0-9a-f]{40}$/.test(S.rangeKey) && !/^[0-9a-f]{40}$/.test(th.scope || '')) await hooks.setScope?.('all');
  const card = cardEl(th.path);
  if (!card) return toast('That file is not in this view.');
  if (card.hidden) hooks.clearFilter?.();
  if (card.classList.contains('shut')) toggleFold(th.path, false);
  await loadFile(th.path);
  // the mark opens beside the code first (it draws its file again), then the page goes to its lines and they flash
  hooks.openMark?.(th.id);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return goLoc({ path: th.path, line: th.startLine || th.line, end: th.line, side: th.side });
}

// ------------------------------------------------------------------ the whole-file viewer
export async function openViewer(v) {
  const side = v.side === 'old' ? 'old' : 'new';
  let el = $('#viewer');
  if (!el) {
    // it takes the diff's column exactly, as another pane would, and its head is a file's head: the panes either side stay
    el = h(`<div class="viewer" id="viewer" role="region" aria-label="The whole file"><div class="vhead"><button class="icon sm" id="vback" title="Back" aria-label="Back" hidden>${I.chevL}</button><span class="vpath" id="vpath"></span><span class="vnote" id="vnote"></span><span class="sp"></span><button class="icon sm" id="vclose" title="Close (esc)" aria-label="Close">${I.x}</button></div><div class="vbody" id="vbody"></div></div>`);
    ($('.viewer-col') || document.body).append(el);
    $('#vclose').onclick = closeViewer;
    $('#vback').onclick = goBack;
  }
  S.view = v;
  paintReturn();
  const k = v.path.lastIndexOf('/');
  $('#vpath').innerHTML = `<span class="dir">${esc(v.path.slice(0, k + 1))}</span><span class="base">${esc(v.path.slice(k + 1))}</span>`;
  $('#vpath').title = v.path;
  $('#vnote').textContent = v.ext ? 'outside the repository, read-only' : fileOf(v.path) ? `the whole file, ${side} side` : 'unchanged by this change';
  const body = $('#vbody');
  body.dataset.p = v.ext ? '' : v.path;
  body.className = 'vbody' + (!v.ext && v.path.endsWith('.go') ? ' golang' : '');
  body.innerHTML = '<div class="loadd">Loading…</div>';
  try {
    const f = v.ext ? await api(`/api/w/${S.id}/ext?file=${encodeURIComponent(v.path)}`) : await api(wsApi('/file', { side, path: v.path }));
    if (S.view !== v) return;
    await loadTokens(v.path, side, !!v.ext).catch(() => {});
    if (S.view !== v) return;
    const rowSide = v.ext ? 'ext' : side, key = rowSide + ':' + v.path;
    body.innerHTML = f.lines.map((s, i) => `<div class="ln" data-l="${i + 1}"><span class="no">${i + 1}</span><span class="cd"><span class="tx" data-r="${rowSide}" data-l="${i + 1}">${tokHTML(key, i + 1, s)}</span></span></div>`).join('');
    const row = body.querySelector(`.ln[data-l="${v.line || 1}"]`);
    if (row) { row.scrollIntoView({ block: 'center' }); if (v.line) row.classList.add('flash'); }
  } catch (e) { if (S.view === v) body.innerHTML = `<div class="loadd err">${esc(e.message)}</div>`; }
}
export function closeViewer() { $('#viewer')?.remove(); if (S.view) $('#refs')?.remove(); S.view = null; paintReturn(); }

// The mouse's back button and ⌘[ are the browser's Back, which would leave the review: while there is a place to go back
// to, they go back to it, as [ does.
document.addEventListener('mousedown', (e) => { if (e.button === 3 && returns.length) e.preventDefault(); });
document.addEventListener('mouseup', (e) => { if (e.button === 3 && returns.length) { e.preventDefault(); goBack(); } });
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.shiftKey || e.altKey || e.key !== '[' || !returns.length) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || $('.scrim, .sheetscrim')) return; // as [ does
  e.preventDefault(); goBack();
});

// ------------------------------------------------------------------ gopls
let tipTimer = null, tipFor = null;
function lspTarget(e) {
  if (/^[0-9a-f]{40}$/.test(S.rangeKey) || !S.ws?.worktreeReady) return null; // gopls reads the files on disk
  const span = e.target.closest?.('.golang .tx[data-r="new"] span[data-c]');
  if (!span) return null;
  const tx = span.closest('.tx'), host = span.closest('[data-p]');
  if (!host?.dataset.p) return null;
  let col = Number(span.dataset.c);
  const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (r && span.contains(r.startContainer)) col += r.startOffset;
  return { path: host.dataset.p, line: Number(tx.dataset.l), col, span };
}
const lspQ = (op, t) => api(`/api/w/${S.id}/lsp/${op}?path=${encodeURIComponent(t.path)}&line=${t.line}&col=${t.col}`);
export function hideTip() { $('#tip')?.remove(); }
document.addEventListener('mousemove', (e) => {
  document.body.classList.toggle('cmd', e.metaKey);
  if (S.dragging) return;
  const t = lspTarget(e);
  if (!t) { if (!e.target.closest?.('#tip')) { clearTimeout(tipTimer); tipFor = null; hideTip(); } return; }
  if (tipFor === t.span) return;
  tipFor = t.span; clearTimeout(tipTimer); hideTip();
  tipTimer = setTimeout(async () => {
    try {
      const r = await lspQ('hover', t);
      if (tipFor !== t.span || !r.markdown) return;
      const tip = h(`<div class="tip" id="tip"><div class="md">${md(r.markdown, { links: false })}</div><div class="foot"><kbd>⌘</kbd> click for the definition · <kbd>⇧</kbd><kbd>⌘</kbd> click for references</div></div>`);
      document.body.append(tip);
      const rect = t.span.getBoundingClientRect();
      const top = rect.bottom + 6 + tip.offsetHeight > innerHeight ? rect.top - tip.offsetHeight - 6 : rect.bottom + 6;
      tip.style.top = Math.max(8, top) + 'px';
      tip.style.left = Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 12)) + 'px';
    } catch { /* gopls still loading, or nothing there */ }
  }, 450);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Meta') document.body.classList.add('cmd');
  if (e.key === 'Enter' && e.target.matches?.('a.loc[role="link"]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('keyup', (e) => { if (e.key === 'Meta') document.body.classList.remove('cmd'); });
document.addEventListener('mousedown', (e) => { if (e.metaKey && lspTarget(e)) e.preventDefault(); if (!e.target.closest?.('#refs')) $('#refs')?.remove(); }, true);
document.addEventListener('click', async (e) => {
  const loc = e.target.closest?.('a.loc');
  if (loc && !loc.closest('#mapbig')) { e.preventDefault(); e.stopPropagation(); return goLoc({ path: loc.dataset.p, line: Number(loc.dataset.l), excerpt: loc.dataset.excerpt }, loc); }
  const att = e.target.closest?.('[data-act="goatt"]');
  if (att && !e.target.closest('.x')) return goLoc({ path: att.dataset.p, line: Number(att.dataset.l), side: att.dataset.side }, att);
  if (!e.metaKey) return;
  const t = lspTarget(e);
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  // An answer that lands after you moved on (another comparison, another click, a jump, ] or a step back, the whole-file
  // viewer opened or closed) goes nowhere. One that lands after a redraw (s, a fold) still goes, and the way back names the line clicked.
  const id = S.id, scope = S.scope, mine = ++lookup, view = S.view; // a newer click supersedes this one
  const stale = () => S.id !== id || S.scope !== scope || mine !== lookup || S.view !== view;
  const back = { path: t.path, text: `${t.path.slice(t.path.lastIndexOf('/') + 1)}:${t.line}`, code: true };
  const go = (loc) => goLoc(loc, t.span, null, { back }); // a detached span still keeps the place; its scroll is restored without it
  try {
    if (e.shiftKey) {
      const r = await lspQ('refs', t);
      if (stale()) return;
      $('#refs')?.remove();
      const box = h(`<div class="menu" id="refs"><div class="sh">${r.total} reference${r.total === 1 ? '' : 's'}</div>${r.locations.map((l, i) => `<button class="mi" data-i="${i}"><span class="two"><span class="mono">${esc(l.path)}:${l.line}</span><span class="mono">${esc(l.text || '')}</span></span></button>`).join('') || '<div class="none">None outside its declaration.</div>'}</div>`);
      document.body.append(box);
      const rect = t.span.isConnected ? t.span.getBoundingClientRect() : { left: e.clientX, bottom: e.clientY }; // redrawn meanwhile: under the click
      box.style.width = '560px';
      box.style.top = Math.min(rect.bottom + 6, innerHeight - box.offsetHeight - 10) + 'px';
      box.style.left = Math.max(8, Math.min(rect.left, innerWidth - 572)) + 'px';
      box.onclick = (ev) => { const b = ev.target.closest('.mi'); if (b && !stale()) go(r.locations[Number(b.dataset.i)]); };
      return;
    }
    const r = await lspQ('def', t);
    if (stale()) return;
    if (!r.locations.length) return toast('gopls found no definition there.');
    go(r.locations[0]);
  } catch (err) { if (!stale()) toast(/loading|took too long/.test(err.message) ? 'gopls is still loading the module.' : `gopls: ${err.message}`, { fail: !/loading|took too long/.test(err.message) }); }
}, true);
