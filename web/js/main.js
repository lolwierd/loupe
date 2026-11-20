// The page: which change this URL is, the frame around it (top bar; bin | diff | inspector), live
// updates from the daemon, keys, the palette and home. One URL per change; "/" goes back to the last one.
import { S, $, $$, esc, h, api, wsApi, I, pref, toast, fileOf, convOf, plural, ago } from './core.js';
import { renderCards, renderBody, renderAllBodies, loadFile, toggleFold, setViewed, isViewed, cardEl, openDraft, attachSelection, cancelDraft, updateCard, orderedFiles, lines, updateMark, setMarksHidden, canComment } from './cards.js';
import { renderTree, markCurrent, nextUnviewed } from './tree.js';
import { renderPanel, setTab, renderTabs, openChat, paintMessage } from './panel.js';
import { goLoc, goThread, openViewer, closeViewer, hideTip } from './nav.js';
import { renderProgress, paintProgress, renderGo, renderStack, doAct, liveConv } from './acts.js';
import { menu, closeMenu, shimmerSync } from './ui.js';
import { hooks } from './hooks.js';
import './actions.js';
import { loadShip, sheetOpen, closeSheet } from './sheets.js';
import './eggs.js';
import { spark, icon, avatar } from './pixel.js';

// Every part that shows the review's state, redrawn together, so no part ever disagrees with another. The inspector is
// not one of them: the Overview says nothing about what is viewed, and redrawing it (the PR's description and its
// conversation, as markdown) on every v and ] was the biggest cost of a keypress on a PR.
function progress() { renderTree(); paintProgress(); renderGo(); }
Object.assign(hooks, {
  goLoc, goThread, openViewer, renderTree, renderPanel, openChat, progress,
  loadStack: () => loadStack(), setScope: (s) => setScope(s), setOrder: (o) => setOrder(o),
  stepFile: (d) => stepFile(d), openStackItem: (i) => openStackItem(i), openPrHere: (url) => openTarget(url),
  showPanel: () => setPane('panel', true),
  toggleMarks: () => setMarksHidden(!S.marksHidden),
  marksToggled: () => { if (S.tab === 'review') renderPanel(); },
  shipChanged: () => { renderGo(); renderGhLink(); },
  // After a write: GitHub's side and the review state are read again, so what you did shows where it happened.
  afterAct: async () => {
    const id = S.id;
    const [review, github] = await Promise.all([api(`/api/w/${id}/review`).catch(() => null), api(`/api/w/${id}/github`).catch(() => null)]);
    if (S.id !== id) return;
    if (review) S.review = review;
    if (github) S.github = github;
    for (const f of S.files) updateCard(f.path);
    renderAllBodies(); renderTree(); renderTabs(); renderProgress(); renderGo(); renderChip();
    if (S.tab !== 'chat') renderPanel();
  },
  threadsChanged: (p) => { updateCard(p); renderTree(); renderTabs(); renderGo(); if (S.tab === 'review') renderPanel(); },
  githubChanged: () => { renderAllBodies(); renderTabs(); renderGo(); if (S.tab !== 'chat' && !document.activeElement?.closest?.('#pbody .composer')) renderPanel(); },
});

// ------------------------------------------------------------------ theme
function applyTheme(t) { if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(pref.get('theme', 'system'));

// ------------------------------------------------------------------ boot
async function boot() {
  try { S.app = await api('/api/state'); }
  catch (e) { $('#root').innerHTML = `<div class="state"><div class="box"><div class="big">loupe's daemon is not answering</div><div>${esc(e.message)}</div></div></div>`; return; }
  const path = location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path || path === 'home') { listenHome(); return renderHome(); }
  let r;
  const nav = document.querySelector('meta[name="loupe-nav"]')?.content;
  try { r = await api('/api/resolve?path=' + encodeURIComponent(path)); }
  catch (e) {
    const m = /^([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)/.exec(path);
    if (!m) return renderHome(e.message);
    // A PR link: typed, pasted or bookmarked opens it; one that came from another site asks first.
    if (nav !== 'trusted' && !(await confirmOpen(`${m[1]}/${m[2]}#${m[3]}`))) return;
    try { r = await api('/api/resolve?path=' + encodeURIComponent(path), { method: 'POST' }); } catch (err) { return renderHome(err.message); }
  }
  if (location.pathname !== r.url) history.replaceState(null, '', r.url + location.search + location.hash);
  S.id = r.id;
  S.scope = new URLSearchParams(location.search).get('scope') || 'all';
  frame();
  listenWs();
  await loadWorkspace();
}

function confirmOpen(target) {
  return new Promise((resolve) => {
    $('#root').innerHTML = `<div class="state"><div class="box"><div class="big">Open ${esc(target)} in loupe?</div><div>This link came from another site. Opening it fetches the pull request into your clone and writes its brief.</div><div class="actions"><a class="btn" href="/home">Cancel</a><button class="btn primary" id="yes">Open it</button></div></div></div>`;
    $('#yes').onclick = () => resolve(true);
  });
}
async function openTarget(target) {
  try { const r = await api('/api/workspaces', { method: 'POST', body: { target } }); location.href = r.url; } catch (e) { toast(e.message); }
}

function frame() {
  $('#root').innerHTML = `<div class="app">
  <header class="top">
    <a class="mark" href="/home" title="Home: everything open here, and whose move it is">${icon('loupe', '--pencil')}<span>loupe</span></a>
    <span class="crumb-sep">/</span>
    <button class="wsbtn" data-act="palette" title="Switch, open, or do anything (⌘K)" id="wsbtn"><span class="t">…</span></button>
    <span class="sp"></span>
    <span class="lsp" id="lsp"></span>
    <button class="tally" id="tally" data-act="nextleft"></button>
    <span class="go" id="go"></span>
    <span class="tools"><a class="icon" id="ghlink" target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label="Open on GitHub" hidden>${I.github}</a><button class="icon" data-act="refresh" title="Read the change again (r)">${I.refresh}</button><button class="icon" data-act="theme" title="View: theme, layout, settings">${document.documentElement.dataset.theme === 'dark' ? I.moon : I.sun}</button>
    <span class="layout-toggles"><button class="icon" data-act="togglebin" title="Files (t)">${I.sidebarL}</button><button class="icon" data-act="togglepanel" title="Inspector (p)">${I.sidebarR}</button></span></span>
  </header>
  <div class="main" id="main">
    <aside class="bin" id="bin"><div class="scopebar" id="scopebar"></div><div class="tree-head"><input class="field" id="filter" type="search" placeholder="Find a file" aria-label="Find a file" autocomplete="off"><kbd title="Focus it">/</kbd></div><nav class="tlist" id="tlist" aria-label="Changed files"></nav><div class="resizer" data-resize="bin"></div></aside>
    <main class="viewer-col"><div class="scroller" id="center"><div class="cards" id="cards"><div class="loadd">Loading…</div></div></div>
      <button class="aifab" id="aifab" data-act="askai" title="Ask Claude: about the selected lines, or the whole change (a)"><span class="aispark">${spark(32, true)}</span><span class="ail">Ask Claude</span></button></main>
    <aside class="panel" id="panel"><div class="resizer" data-resize="panel"></div><div class="ptabs" role="tablist"><button class="tab" role="tab" id="ptab-overview" data-tab="overview">Overview</button><button class="tab" role="tab" id="ptab-chat" data-tab="chat">Chat</button><button class="tab" role="tab" id="ptab-review" data-tab="review">Marks</button><span class="sp"></span><button class="icon sm" data-act="keys" title="Keys (?)"><kbd>?</kbd></button></div><div class="pbody" id="pbody"></div></aside>
  </div></div>`;
  applyMode(S.mode, true);
  // only a width you dragged is set here; the defaults live in the style sheet, where the narrow-window rule can change them
  for (const [v, k] of [['--bin-w', 'binW'], ['--panel-w', 'panelW']]) { const w = pref.get(k, null); if (w) document.documentElement.style.setProperty(v, w + 'px'); }
  for (const b of $$('.ptabs .tab')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; renderTree(); });
  $('#center').addEventListener('scroll', onScroll, { passive: true });
}

function wsTitle() {
  const m = S.ws;
  if (!m) return '';
  const icon = m.kind === 'pr' ? I.pr : I.branch;
  const title = m.pr ? m.pr.title : m.branch;
  const sub = m.kind === 'pr' ? `${m.repoFull}#${m.pr?.number ?? ''}` : m.repoName;
  const p = S.github?.pr, who = p?.author || m.pr?.author || null;
  const by = who ? `<span class="au">${avatar(who)}<span>${p?.viewerIsAuthor ? 'you' : esc(who)}</span></span>` : '';
  return `${icon}<span class="t" title="${esc(title)}">${esc(title)}</span>${by}<span class="r" title="${esc(sub)}">${esc(sub)}</span>${I.chev}`;
}

// The change's meta, then its files and review state. Called again whenever the change moves.
async function loadWorkspace(reason) {
  let m;
  try { m = await api(`/api/w/${S.id}`); } catch (e) { return showState('Could not open this', e.message); }
  if (m.status !== 'ready' || !m.headFull && m.kind === 'pr') {
    $('#wsbtn').innerHTML = `${m.kind === 'pr' ? I.pr : I.branch}<span class="t">${esc(m.rec?.pr?.title || m.rec?.slug || '')}</span>`;
    return showState(m.status === 'error' ? 'Could not open this' : 'Opening…', m.progress || '', m.status === 'error');
  }
  S.ws = m;
  $('#wsbtn').innerHTML = wsTitle();
  await loadFiles(reason);
}
function showState(title, text, error) {
  $('#cards').innerHTML = `<div class="state"><div class="box"><div class="big">${esc(title)}</div>${error ? `<div class="err">${esc(text)}</div><button class="btn" data-act="retry">Try again</button>` : `<div class="working"><span class="shimmer" style="${shimmerSync()}">${esc(text || 'Reading the change…')}</span></div>`}</div></div>`;
}

let fileRequest = 0;
async function loadFiles(reason) {
  const id = S.id, request = ++fileRequest;
  const current = () => id === S.id && request === fileRequest;
  const spot = reason ? scrollSpot() : null;
  let files, review;
  const ghReq = api(`/api/w/${S.id}/github`).catch(() => null);
  try {
    [files, review] = await Promise.all([api(wsApi('/files')), api(`/api/w/${S.id}/review`)]);
  } catch (e) { if (current()) showState('Could not read the change', e.message, true); return; }
  if (!current()) return;
  S.rangeKey = files.scope;
  S.untrackedSkipped = files.untrackedSkipped || 0;
  S.files = files.files.map((f, i) => ({ ...f, i }));
  S.byPath = new Map(S.files.map((f) => [f.path, f]));
  S.review = review;
  S.github ||= { pr: null, threads: [] };
  // GitHub's side (the PR, its checks, its threads) is never waited for: it lands when it lands.
  ghReq.then((gh) => { if (gh && current()) { S.github = gh; hooks.githubChanged(); renderGo(); renderFab(); renderGhLink(); $('#wsbtn').innerHTML = wsTitle(); } });
  S.wsWip = new Set(S.ws.wipPaths || []);
  S.rows.clear(); S.items.clear(); S.tok.clear(); S.loaded.clear(); S.newText.clear(); S.diffs.clear();
  // Generated files, and files you have viewed, start folded.
  S.shut = new Set(S.files.filter((f) => f.kind === 'generated' || isViewed(f)).map((f) => f.path));
  if (S.order === 'guide' && !S.review.brief?.sections?.length) S.order = 'tree';
  if (S.mode === 'guide' && S.review.brief?.sections?.length) S.order = 'guide';
  if (!S.current || !fileOf(S.current)) S.current = orderedFiles()[0]?.f.path || null;
  renderScopebar(); renderTree(); renderCards(); renderPanel(); renderChip(); renderLsp(); renderFab(); renderGhLink();
  renderProgress(); renderGo(); renderStack();
  requestAnimationFrame(spyNow);
  if (spot) requestAnimationFrame(() => restoreSpot(spot));
  else if (location.hash.length > 1) {
    // #path, #path:L12 or #path:L12-L20: the file, scrolled to the line.
    const m2 = /^(.*?)(?::L(\d+)(?:-L?(\d+))?)?$/.exec(decodeURIComponent(location.hash.slice(1)));
    if (m2 && fileOf(m2[1])) requestAnimationFrame(() => goLoc({ path: m2[1], line: Number(m2[3] || m2[2]) || 0 }));
  }
  if (reason) toast(reason);
  maybeAutoBrief();
  loadStack();
  if (S.ws.kind === 'local') loadShip(true);
}

// The stack this change sits in, drawn as number chips beside the title: GitHub's own stack, else the PR base chain,
// else local branches. Each opens its checkout when there is one, else its PR.
async function loadStack() {
  S.stack = await api(`/api/w/${S.id}/stack`).catch(() => null);
  renderStack(); renderGo();
}
async function openStackItem(i) {
  const it = S.stack?.items?.[i];
  if (!it || it.here) return;
  const target = it.checkout || (it.pr && S.github?.repoFull ? `${S.github.repoFull}#${it.pr}` : null);
  if (!target) return toast(`${it.branch} is not checked out here and has no PR`);
  openTarget(target);
}

// A PR gets its brief written the first time it is opened (Sonnet by default; change it in the Overview).
function maybeAutoBrief() {
  const b = S.review.brief;
  if (S.ws.kind !== 'pr' || b?.tldr || b?.pending || b?.error || !S.app.settings?.autoBrief || !S.files.length) return;
  const id = S.id;
  const pending = S.review.brief = { pending: true };
  renderTabs(); if (S.tab === 'overview') renderPanel();
  return api(wsApi('/brief'), { method: 'POST', body: { model: pref.get('briefModel', S.app.defaults.briefModel), effort: pref.get('briefEffort', S.app.defaults.briefEffort) } }).catch((e) => {
    if (S.id !== id || S.review.brief !== pending) return;
    S.review.brief = { pending: false, error: e.message };
    renderTabs(); if (S.tab === 'overview') renderPanel();
  });
}

// ------------------------------------------------------------------ the top bar: what you are looking at
function scopeLabel() {
  const k = S.rangeKey;
  if (k === 'all') return S.ws.kind === 'pr' ? 'Whole pull request' : S.ws.dirty ? 'Branch + uncommitted' : 'Whole branch';
  if (k === 'branch') return 'Committed only';
  if (k === 'wip') return 'Uncommitted only';
  if (k === 'since') return 'Since you last looked';
  if (k === 'stack') return 'Whole stack';
  const c = S.ws.commits.find((x) => x.sha === k);
  return c ? `${c.short.slice(0, 7)} ${c.subject}` : k.slice(0, 9);
}
function renderScopebar() {
  const k = S.ws.commits.findIndex((c) => c.sha === S.rangeKey);
  const step = k >= 0 ? `<button class="icon sm" data-act="scope" data-scope="${S.ws.commits[k + 1]?.sha || ''}" title="Older commit"${S.ws.commits[k + 1] ? '' : ' disabled'}>${I.chevL}</button><button class="icon sm" data-act="scope" data-scope="${S.ws.commits[k - 1]?.sha || ''}" title="Newer commit"${k > 0 ? '' : ' disabled'}>${I.chevR}</button>` : '';
  const t = S.files.reduce((a, f) => ({ add: a.add + f.added, del: a.del + f.deleted }), { add: 0, del: 0 });
  $('#scopebar').classList.toggle('steps', k >= 0);
  $('#scopebar').innerHTML = `<button class="scopebtn" data-act="scopemenu" title="What to compare: ${esc(scopeLabel())}"><span class="l">${esc(scopeLabel())}</span>${I.chev}</button>${step}` +
    `<span class="what"><span class="num">${plural(S.files.length, 'file')}</span><span class="delta"><span class="add num">+${t.add.toLocaleString()}</span><span class="del num">−${t.del.toLocaleString()}</span></span></span>`;
}
// The floating spark: still while Claude is idle, turning while it answers anything in this change.
function renderFab() {
  const cv = $('#aifab canvas.spark');
  if (!cv) return;
  const busy = Object.values(S.review?.convs || {}).some((c) => c.busy || c.messages?.some((m) => m.pending)) || !!S.review?.brief?.pending;
  cv.classList.toggle('still', !busy);
  $('#aifab').classList.toggle('busy', busy);
  $('#aifab').title = busy ? 'Claude is working. Click to ask something else (a)' : 'Ask Claude: about the selected lines, or the whole change (a)';
  if (busy) cv.dispatchEvent(new Event('spark-wake', { bubbles: true }));
}
hooks.renderFab = renderFab;
function askAi() {
  if (S.sel && !S.draft) return openDraft('ask');
  setPane('panel', true);
  openChat();
}
// The Claude Code session this change is linked to, if any: the live one first, else a fork.
function renderChip() {
  return; // the linked session is shown in Chat (its picker), not in the top bar
  const el = $('#schip');
  if (!el || !S.review) return;
  const linked = S.review.chats.map(convOf).filter((c) => c?.linked);
  const c = liveConv() || linked.find((x) => x.linked.live) || linked.at(-1);
  if (!c) { el.innerHTML = ''; return; }
  const l = c.linked, busy = c.messages.some((m) => m.pending);
  el.innerHTML = `<button class="schip${l.live ? '' : ' fork'}${l.offline ? ' offline' : ''}" data-act="gochat" data-conv="${esc(c.id)}" title="${esc((l.title || l.sessionId?.slice(0, 8) || 'session') + ': ' + (l.live ? (l.offline ? 'the live session stopped answering; run /loupe live in it again' : 'live, questions and fixes go into this Claude Code session') : 'a read-only fork of this Claude Code session; the session itself is untouched'))}"><i></i><span>${esc(l.title || l.sessionId?.slice(0, 8) || 'session')}</span>${busy ? spark(16, false, 'working') : ''}</button>`;
}
// The GitHub icon: the PR when there is one, else the branch once it is on GitHub, else nothing.
function renderGhLink() {
  const a = $('#ghlink');
  if (!a || !S.ws) return;
  const p = S.github?.pr, repo = S.github?.repoFull || S.ws.repoFull;
  const url = p?.url || S.ws.pr?.url || (S.ws.kind === 'local' && repo && S.ship?.remoteSha && S.ws.branch ? `https://github.com/${repo}/tree/${encodeURIComponent(S.ws.branch)}` : null);
  a.hidden = !url;
  if (url) { a.href = url; a.title = p?.url || S.ws.pr?.url ? `Open #${p?.number || S.ws.pr?.number} on GitHub` : `Open ${S.ws.branch} on GitHub`; }
}
hooks.renderGhLink = renderGhLink;
function renderLsp() {
  const s = S.ws?.lsp;
  $('#lsp').textContent = s && s !== 'off' && s !== 'ready' && s !== 'idle' ? `gopls ${s}` : '';
}

async function setScope(scope) {
  if (!scope || scope === S.rangeKey || scope === S.scope) return;
  S.scope = scope; S.sel = null; S.draft = null;
  const u = new URL(location.href);
  if (scope === 'all') u.searchParams.delete('scope'); else u.searchParams.set('scope', scope);
  history.replaceState(null, '', u);
  await loadFiles();
  $('#center').scrollTop = 0;
}
function setOrder(o) {
  if (o === S.order) return;
  S.order = o; pref.set('order', o);
  renderTree(); renderCards(); renderProgress(); if (S.tab === 'overview') renderPanel();
  $('#center').scrollTop = 0;
  requestAnimationFrame(spyNow);
}

// ------------------------------------------------------------------ where the reader is
function scrollSpot() {
  const c = $('#center'), r = c.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + 100);
  const card = el?.closest('.file');
  if (!card) return null;
  const tx = el.closest('.ln')?.querySelector('.tx[data-r="new"]');
  return { path: card.dataset.p, line: tx ? Number(tx.dataset.l) : null, off: (tx || card).getBoundingClientRect().top - r.top };
}
async function restoreSpot(s) {
  const card = s && cardEl(s.path);
  if (!card) return;
  if (s.line) await loadFile(s.path).catch(() => {});
  const tx = s.line && card.querySelector(`.tx[data-r="new"][data-l="${s.line}"]`);
  $('#center').scrollTop += (tx || card).getBoundingClientRect().top - $('#center').getBoundingClientRect().top - s.off;
}
// Which file you are reading: the last card whose top is above the line 90 px down, except when a guide heading sits
// between it and the line, which means you are at the start of the heading's first file.
function spyNow() {
  const c = $('#center');
  if (!c) return;
  const line = c.getBoundingClientRect().top + 90;
  let cur = null, after = false;
  for (const el of $$('#cards > .file:not([hidden]), #cards > .gsec')) {
    if (el.getBoundingClientRect().top > line) { if (after && el.classList.contains('file')) cur = el; break; }
    if (el.classList.contains('gsec')) after = true; else { cur = el; after = false; }
  }
  const p = cur?.dataset.p || orderedFiles()[0]?.f.path || null;
  if (p !== S.current) { S.current = p; markCurrent(); paintProgress(); }
  // How far into each open file the bottom of the screen has reached: the strip shows it as a dither.
  const bottom = c.getBoundingClientRect().bottom;
  let moved = false;
  for (const el of $$('#cards > .file:not(.shut):not([hidden])')) {
    const r = el.getBoundingClientRect();
    if (r.top > bottom || r.bottom < c.getBoundingClientRect().top) continue;
    const f = Math.max(0, Math.min(1, (bottom - r.top) / Math.max(1, r.height)));
    if (f > (S.readFrac.get(el.dataset.p) || 0) + 0.02) { S.readFrac.set(el.dataset.p, f); moved = true; }
  }
  if (moved) paintProgress();
}
let spy = false;
function onScroll() {
  if (spy) return; spy = true;
  requestAnimationFrame(() => { spy = false; spyNow(); hideTip(); });
}
// Next left: you are done with this file. It is marked viewed and you go to the next one left after it.
function nextLeft() {
  const cur = S.current, f = cur && fileOf(cur);
  const next = nextUnviewed();
  if (f && !isViewed(f) && f.kind !== 'generated') setViewed(cur, true);
  const to = next && next !== cur ? next : nextUnviewed();
  if (to) setTimeout(() => goLoc({ path: to, line: 0 }), 60); else toast('Every file is viewed.');
}
hooks.nextLeft = nextLeft;
hooks.clearFilter = () => { S.filter = ''; const f = $('#filter'); if (f) f.value = ''; renderTree(); };
hooks.setCurrent = (p) => { if (p && p !== S.current) { S.current = p; markCurrent(); paintProgress(); } };
const visibleFiles = () => orderedFiles().map(({ f }) => f.path).filter((p) => !cardEl(p)?.hidden);
function stepFile(d) {
  const files = visibleFiles(), i = files.indexOf(S.current);
  const p = files[Math.max(0, Math.min(files.length - 1, i + d))];
  if (p) goLoc({ path: p, line: 0 });
}

// ------------------------------------------------------------------ panes
const PANE = { bin: ['no-bin', 'binShown', '--bin-w', 'binW', 520], panel: ['no-panel', 'panelOpen', '--panel-w', 'panelW', 760] };
function setPane(which, open) {
  $('#main').classList.toggle(PANE[which][0], !open);
  $(`[data-act="toggle${which}"]`)?.setAttribute('aria-pressed', String(open));
  if (S.mode === 'panes') pref.set(PANE[which][1], open);
}
// Two layouts. Panes: files | code | inspector. Guide: the left column is Claude's guide (sections, their checks and
// files), and the inspector opens when a mark or a chat needs it.
function applyMode(mode, first) {
  S.mode = mode; pref.set('mode', mode);
  const app = $('.app');
  app.classList.toggle('mode-guide', mode === 'guide');
  if (mode === 'panes') { setPane('bin', pref.get('binShown', true)); setPane('panel', pref.get('panelOpen', true)); }
  else { $('#main').classList.remove('no-bin'); $('#main').classList.add('no-panel'); }
  if (mode === 'guide' && S.review?.brief?.sections?.length && S.order !== 'guide') { S.order = 'guide'; pref.set('order', 'guide'); }
  if (!first) { renderTree(); renderCards(); renderProgress(); requestAnimationFrame(spyNow); }
}
hooks.applyMode = applyMode;
const paneOpen = (which) => !$('#main').classList.contains(PANE[which][0]);
function setLayout(l) { S.layout = l; pref.set('layout', l); S.sel = null; renderAllBodies(); }
document.addEventListener('mousedown', (e) => {
  const r = e.target.closest?.('[data-resize]');
  if (!r) return;
  e.preventDefault();
  const which = r.dataset.resize, [, , cssVar, key, max] = PANE[which], startX = e.clientX;
  const start = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
  r.classList.add('drag');
  const move = (ev) => {
    const w = Math.max(200, Math.min(max, start + (which === 'bin' ? ev.clientX - startX : startX - ev.clientX)));
    document.documentElement.style.setProperty(cssVar, w + 'px');
    pref.set(key, w);
  };
  const up = () => { r.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});

// ------------------------------------------------------------------ live updates
let wsEs = null;
function listenWs() {
  wsEs?.close();
  const es = wsEs = new EventSource(`/api/w/${S.id}/events`);
  const on = (ev, fn) => es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(ev, err); } });
  // A reconnect can have missed events (an answer's last one): read everything again, quietly.
  es.addEventListener('error', () => { S.lost = true; });
  on('hello', (d) => {
    if (S.boot && S.boot !== d.boot) loadWorkspace('loupe restarted; the change is read again');
    else if (S.lost && S.ws) loadWorkspace();
    S.lost = false; S.boot = d.boot;
  });
  on('progress', (d) => { if (!S.ws || S.ws.status !== 'ready') { if (d.status === 'ready' && !d.text) loadWorkspace(); else if (d.text) showState(d.status === 'error' ? 'Could not open this' : 'Opening…', d.text, d.status === 'error'); } });
  on('changed', (d) => {
    if (!S.ws) return loadWorkspace();
    clearTimeout(changedT);
    changedT = setTimeout(() => loadWorkspace(d.reason === 'files changed' || d.reason === 'worktree ready' ? '' : `${d.reason[0].toUpperCase()}${d.reason.slice(1)}: the diff is updated`), 150);
  });
  on('settings', (st) => { S.app.settings = st; for (const f of S.files) updateCard(f.path); progress(); });
  on('review', (d) => {
    if (d.viewed) S.review.viewed = d.viewed;
    if (d.unviewed) S.review.unviewed = d.unviewed;
    if (d.checks) { S.review.checks = d.checks; for (const b of $$('.gck')) { const on = !!d.checks[b.dataset.key]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } }
    for (const f of S.files) updateCard(f.path);
    progress();
  });
  on('thread', (d) => {
    let p = null;
    if (d.deleted) { const th = S.review.threads.find((t) => t.id === d.deleted); p = th?.path; S.review.threads = S.review.threads.filter((t) => t.id !== d.deleted); }
    else {
      const i = S.review.threads.findIndex((t) => t.id === d.thread.id);
      if (i >= 0) S.review.threads[i] = d.thread; else S.review.threads.push(d.thread);
      if (d.conv) S.review.convs[d.conv.id] = { ...d.conv, messages: mergeMsgs(S.review.convs[d.conv.id]?.messages, d.conv.messages) };
      p = d.thread.path;
    }
    if (p && S.rows.has(p) && !document.activeElement?.closest?.(`.file[data-p="${CSS.escape(p)}"] .composer`)) renderBody(p);
    if (p) hooks.threadsChanged(p);
  });
  on('message', (d) => {
    const conv = S.review.convs[d.conv] || (S.review.convs[d.conv] = { id: d.conv, messages: [] });
    const i = conv.messages.findIndex((m) => m.id === d.msg.id);
    if (i >= 0) conv.messages[i] = d.msg; else conv.messages.push(d.msg);
    if (d.msg.model && d.msg.role === 'claude') { conv.model = d.msg.model; conv.effort = d.msg.effort; }
    conv.busy = !!d.busy;
    const th = S.review.threads.find((t) => t.conv === d.conv);
    if (!document.querySelector(`[data-conv="${d.conv}"]`)) {
      if (S.tab === 'chat' && S.chat === d.conv) renderPanel();
    } else paintMessage(d.conv, d.msg);
    if (th) {
      if (!d.busy && d.msg.role === 'claude' && !d.msg.pending && S.mark !== th.id) { S.unreadAns.add(th.id); renderTree(); }
      updateMark(th); if (!d.busy && S.tab === 'review' && S.mark !== th.id) renderPanel();
    }
    renderTabs(); renderChip(); renderFab();
  });
  on('chat', (d) => {
    if (d.deleted) { delete S.review.convs[d.deleted]; S.review.chats = S.review.chats.filter((x) => x !== d.deleted); if (S.chat === d.deleted) S.chat = null; }
    else { S.review.convs[d.conv.id] = { ...d.conv, messages: mergeMsgs(S.review.convs[d.conv.id]?.messages, d.conv.messages) }; if (!S.review.chats.includes(d.conv.id)) S.review.chats.push(d.conv.id); }
    if (S.tab === 'chat' && !document.activeElement?.closest?.('#chatbox')) renderPanel(); else renderTabs();
    renderChip(); renderGo(); renderFab();
  });
  on('brief', (d) => {
    S.review.brief = d;
    renderFab();
    if (S.tab === 'overview') renderPanel(); else renderTabs();
    if (S.order === 'guide') { renderTree(); renderCards(); renderProgress(); }
  });
  on('github', async () => { S.github = await api(`/api/w/${S.id}/github`).catch(() => S.github); hooks.githubChanged(); if (S.ws) $('#wsbtn').innerHTML = wsTitle(); });
  on('page', () => location.reload());
}
let changedT = null;
// Every minute while the page is in view, and when you come back to it, GitHub is asked again in the background (the
// daemon answers from cache at once and sends 'github' if anything changed).
const ghPoke = () => { if (S.id && !document.hidden) api(`/api/w/${S.id}/github`).catch(() => {}); };
setInterval(ghPoke, 60000);
document.addEventListener('visibilitychange', ghPoke);
const mergeMsgs = (a = [], b = []) => { const out = [...b]; for (const m of a) if (!out.some((x) => x.id === m.id)) out.push(m); return out.sort((x, y) => x.at - y.at); };
let homeEs = null;
// A tab left in the background gives its stream back after 20 s (a browser allows six connections per host, and idle
// loupe tabs used to starve the next page); coming back reconnects and reads the change again.
let sleepT = null, asleep = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(sleepT); sleepT = setTimeout(() => { wsEs?.close(); homeEs?.close(); asleep = true; S.lost = true; }, 20000); return; }
  clearTimeout(sleepT);
  if (!asleep) return;
  asleep = false;
  if (S.id) listenWs(); else listenHome();
});
// A page kept in the back/forward cache would hold its stream open and starve the next page's requests.
addEventListener('pagehide', () => { wsEs?.close(); homeEs?.close(); });
addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
function listenHome() {
  const es = homeEs = new EventSource('/api/events');
  es.addEventListener('page', () => location.reload());
  es.addEventListener('workspaces', () => { if (!S.id) renderHome(); });
}

// ------------------------------------------------------------------ the palette (⌘K): open anything, do anything
// The same acts the buttons run, grouped by the stage of the work they belong to.
function commands() {
  if (!S.ws) return [];
  const m = S.ws;
  const next = (S.acts || []).filter((a) => !a.disabled).map((a) => ({ group: 'NEXT', label: a.label, run: () => doAct(a) }));
  const pr = S.github?.pr, isPr = m.kind === 'pr', local = m.kind === 'local';
  const cur = S.current && fileOf(S.current), name = S.current?.split('/').pop();
  const panel = (tab) => () => { setPane('panel', true); setTab(tab); };
  const setting = (k, on, label) => ({ group: 'SETTINGS', label: `${on ? 'Turn off' : 'Turn on'}: ${label}`, run: async () => { try { S.app.settings = await api('/api/settings', { method: 'POST', body: { [k]: !on } }); } catch (e) { return toast(e.message); } for (const f of S.files) updateCard(f.path); progress(); toast(`${label}: ${on ? 'off' : 'on'}.`); } });
  const scopes = [
    ['all', isPr ? 'Whole pull request' : m.dirty ? 'Branch + uncommitted' : 'Whole branch'],
    ...(local ? [['branch', 'Committed only'], ...(m.dirty ? [['wip', `Uncommitted only (${plural(m.dirty, 'file')})`]] : [])] : []),
    ...(m.sinceCount ? [['since', `Since you last looked (${plural(m.sinceCount, 'commit')})`]] : []),
    ...(m.trunkMergeBase ? [['stack', `Whole stack, from ${m.trunk || 'the trunk'}`]] : []),
  ].filter(([k]) => k !== S.rangeKey);
  const ghUrl = $('#ghlink')?.hidden === false ? $('#ghlink').href : null;
  const c = [
    ...next,
    { group: 'READ', label: 'Done with this file: mark it viewed, go to the next left', key: ']', run: () => nextLeft() },
    cur && { group: 'READ', label: `${isViewed(cur) ? 'Unmark' : 'Mark'} ${name} viewed`, key: 'v', run: () => setViewed(S.current, !isViewed(cur)) },
    { group: 'READ', label: 'Next file', key: 'j', run: () => stepFile(1) },
    { group: 'READ', label: 'Previous file', key: 'k', run: () => stepFile(-1) },
    cur && { group: 'READ', label: `${S.shut.has(S.current) ? 'Unfold' : 'Fold'} ${name}`, key: 'o', run: () => toggleFold(S.current) },
    { group: 'READ', label: 'Fold every file you have viewed', run: () => { for (const f of S.files) if (isViewed(f) || f.kind === 'generated') toggleFold(f.path, true); } },
    { group: 'READ', label: 'Unfold every file', run: () => { for (const f of S.files) if (S.shut.has(f.path)) toggleFold(f.path, false); } },
    S.review.brief?.sections?.length && { group: 'READ', label: S.order === 'guide' ? 'Files in tree order' : "Files in the guide's order", key: 'g', run: () => setOrder(S.order === 'guide' ? 'tree' : 'guide') },
    { group: 'READ', label: S.layout === 'split' ? 'Unified diff' : 'Split diff', key: 's', run: () => setLayout(S.layout === 'split' ? 'unified' : 'split') },
    ...scopes.map(([k, label]) => ({ group: 'COMPARE', label, run: () => setScope(k) })),
    local && { group: 'COMPARE', label: `Compare with another base (now ${m.base})`, run: () => { const b = $('[data-act="scopemenu"]'); if (b) baseMenu(b); } },
    ...m.commits.filter((x) => x.sha !== S.rangeKey).map((x) => ({ group: 'COMPARE', label: `Commit ${x.short.slice(0, 7)} ${x.subject}`, sub: ago(x.at), typed: true, run: () => setScope(x.sha) })),
    { group: 'CLAUDE', label: 'Ask about the whole change', key: 'a', run: () => { setPane('panel', true); openChat(); } },
    { group: 'CLAUDE', label: S.review.brief?.tldr ? 'Write the brief again' : 'Write the brief', run: () => { setPane('panel', true); setTab('overview'); requestAnimationFrame(() => $('[data-act="brief"]')?.click()); } },
    { group: 'CLAUDE', label: 'New chat', run: () => hooks.newChat?.() },
    { group: 'CLAUDE', label: 'Link a Claude Code session…', run: () => hooks.linkSession?.() },
    { group: 'INSPECTOR', label: 'Overview', key: '1', run: panel('overview') },
    { group: 'INSPECTOR', label: 'Chat', key: '2', run: panel('chat') },
    { group: 'INSPECTOR', label: 'Marks', key: '3', run: panel('review') },
    isPr && pr && !pr.viewerIsAuthor && { group: 'REVIEW', label: 'Submit your review…', run: () => hooks.openSheet?.('review') },
    isPr && pr && { group: 'REVIEW', label: `Comment on #${pr.number}`, run: () => hooks.focusComment?.() },
    (pr?.checks?.length || S.github?.checks?.length) && { group: 'REVIEW', label: 'Show the checks', run: () => hooks.showChecks?.() },
    local && { group: 'SHIP', label: 'Commit…', run: () => hooks.openSheet?.('commit') },
    local && { group: 'SHIP', label: 'Push…', run: () => hooks.openSheet?.('push') },
    local && !S.ws.pr && { group: 'SHIP', label: 'Open a pull request…', run: () => hooks.openSheet?.('openpr') },
    m.trunkMergeBase && { group: 'STACK', label: S.rangeKey === 'stack' ? 'Just this change' : 'The whole stack, from the trunk', run: () => setScope(S.rangeKey === 'stack' ? 'all' : 'stack') },
    ...(S.stack?.items || []).filter((i) => !i.here).map((i) => ({ group: 'STACK', label: `${i.pr ? `#${i.pr} ` : ''}${i.branch}`, sub: i.checkout ? 'checkout' : 'PR', run: () => openStackItem(S.stack.items.indexOf(i)) })),
    ...[['panes', 'Layout: three panes'], ['guide', 'Layout: guide']].filter(([x]) => x !== S.mode).map(([x, label]) => ({ group: 'VIEW', label, run: () => applyMode(x) })),
    { group: 'VIEW', label: S.marksHidden ? 'Show the marks in the code' : 'Hide the marks in the code', key: 'm', run: () => setMarksHidden(!S.marksHidden) },
    { group: 'VIEW', label: paneOpen('bin') ? 'Hide the files' : 'Show the files', key: 't', run: () => setPane('bin', !paneOpen('bin')) },
    { group: 'VIEW', label: paneOpen('panel') ? 'Hide the inspector' : 'Show the inspector', key: 'p', run: () => setPane('panel', !paneOpen('panel')) },
    ...['system', 'light', 'dark'].filter((t) => t !== pref.get('theme', 'system')).map((t) => ({ group: 'VIEW', label: `Theme: ${t}`, run: () => { pref.set('theme', t); applyTheme(t); } })),
    setting('autoView', !!S.app.settings?.autoView, 'Count tests and generated files as viewed'),
    setting('autoBrief', !!S.app.settings?.autoBrief, 'Write the brief when a PR opens'),
    ghUrl && { group: 'GO', label: 'Open on GitHub', run: () => open(ghUrl, '_blank', 'noopener') },
    { group: 'GO', label: 'Copy the link to this page', run: () => navigator.clipboard.writeText(location.href).then(() => toast('Link copied.'), () => toast('Could not copy.')) },
    { group: 'GO', label: 'Read the change again', key: 'r', run: () => $('[data-act="refresh"]')?.click() },
    { group: 'GO', label: 'Home', run: () => { location.href = '/home'; } },
    { group: 'GO', label: 'Keys', key: '?', run: keySheet },
    { group: 'GO', label: 'Close this change here', sub: 'forgets its marks and chats', typed: true, run: async () => { if (!confirm('Close this change in loupe? Its marks and chats are forgotten; the code is untouched.')) return; try { await api(`/api/w/${S.id}`, { method: 'DELETE' }); location.href = '/home'; } catch (e) { toast(e.message); } } },
    ...S.files.map((f) => ({ group: 'FILES', label: f.path, sub: isViewed(f) ? 'viewed' : `${(f.added + f.deleted).toLocaleString()} lines`, typed: true, file: true, run: () => goLoc({ path: f.path, line: 0 }) })),
  ];
  return c.filter(Boolean);
}

// The palette draws this many rows and says how many more there are, so a change of 300 files stays instant.
const PAL_ROWS = 60;
let palClose = null, keysClose = null;
function openPalette() {
  if (palClose) return palClose();
  keysClose?.();
  closeMenu();
  // Drawn at once from what the page already has; the daemon's own list replaces the workspace rows when it arrives.
  let st = S.app || { workspaces: [], display: location.origin };
  const scrim = h(`<div class="scrim" role="dialog" aria-label="Open or do"><div class="palette"><input placeholder="Paste a PR link, owner/repo#123 or a path, or type what to do" aria-label="Open or do"><div class="list"></div><div class="foot"><span><kbd>↵</kbd> go</span><span><kbd>↑</kbd><kbd>↓</kbd> pick</span><span><kbd>esc</kbd> close</span><span class="sp"></span><span>${esc(st.display)}</span></div></div></div>`);
  document.body.append(scrim);
  const input = scrim.querySelector('input'), list = scrim.querySelector('.list');
  let cur = 0, shown = [];
  // Lower-cased once per open, not per keystroke; a file also keeps its own name apart from its folders.
  const cmds = commands().map((c) => { const lab = c.label.toLowerCase(); return { ...c, lab, hay: `${lab} ${c.group.toLowerCase()}`, base: c.file ? lab.slice(lab.lastIndexOf('/') + 1) : '' }; });
  // How well something matches what was typed. A file's own name outranks a command that only mentions it ("Fold
  // cards.js" for "cards"); a command that begins with what you typed still beats a file that merely contains it.
  const score = (c, q) => {
    if (!c.file) return c.lab.startsWith(q) ? 75 : c.lab.includes(q) ? 45 : 40;
    if (c.base === q || c.base.replace(/\.[^.]*$/, '') === q) return 100; // the name, with or without its extension
    if (c.lab.endsWith('/' + q)) return 95; // the end of its path
    return c.base.startsWith(q) ? 80 : c.base.includes(q) ? 70 : 50;
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const ws = st.workspaces.filter((w) => !q || `${w.title} ${w.repo} ${w.slug} ${w.number || ''}`.toLowerCase().includes(q)).map((w) => ({ ws: w, group: 'OPEN HERE', s: q && [w.title, w.repo, w.slug].some((t) => String(t || '').toLowerCase().startsWith(q)) ? 75 : 45 }));
    const words = q.split(/\s+/).filter(Boolean);
    const cs = cmds.filter((c) => (q ? words.every((w) => c.hay.includes(w)) : !c.typed)).map((c) => ({ cmd: c, group: c.group, s: q ? score(c, q) : 0 }));
    // Typed: each group stays whole under its own heading, the group holding the best match first, and the best match first
    // within it. Nothing typed: the next act first, then what is open here, then the rest. At most PAL_ROWS rows are
    // drawn (the arrow keys walk only those); a group that matches hundreds of files leaves a few rows to each group after
    // it, so the commands that match are never the rows that get cut.
    let total, rows;
    if (q) {
      const groups = new Map();
      for (const x of [...cs, ...ws]) { let g = groups.get(x.group); if (!g) groups.set(x.group, (g = { rows: [], best: 0, at: groups.size })); g.rows.push(x); g.best = Math.max(g.best, x.s); }
      const order = [...groups.values()].sort((a, b) => b.best - a.best || a.at - b.at);
      total = order.reduce((n, g) => n + g.rows.length, 0);
      let room = PAL_ROWS;
      rows = order.flatMap((g, i) => {
        const later = order.slice(i + 1).reduce((n, h) => n + Math.min(3, h.rows.length), 0);
        const take = Math.min(g.rows.length, Math.max(Math.min(3, g.rows.length), room - later));
        room -= take;
        return g.rows.sort((a, b) => b.s - a.s).slice(0, take);
      });
    } else { rows = [...cs.filter((x) => x.group === 'NEXT'), ...ws, ...cs.filter((x) => x.group !== 'NEXT')]; total = rows.length; }
    shown = rows.slice(0, PAL_ROWS);
    const more = total - shown.length;
    if (q && /\/|#\d|^\d+$|^~/.test(input.value.trim())) { if (cs.length) shown.push({ target: input.value.trim() }); else shown.unshift({ target: input.value.trim() }); }
    cur = Math.min(cur, Math.max(0, shown.length - 1));
    let last = null;
    // when the open change is listed, every row ends in the same check column, so the keys and counts on the right keep one edge
    const anyCur = shown.some((x) => x.ws?.id === S.id);
    const mc = (on) => (anyCur ? `<span class="mc">${on ? I.check : ''}</span>` : '');
    list.innerHTML = shown.map((x, i) => {
      const head = x.group && x.group !== last ? `<div class="mh">${x.group}</div>` : '';
      last = x.group || last;
      if (x.target) return `<button class="mi" data-i="${i}" aria-selected="${i === cur}">${I.plus}<span class="two"><span>Open “${esc(x.target)}”</span><span>a PR link, owner/repo#123, #123 or a path</span></span>${mc(false)}</button>`;
      if (x.cmd?.file) { const k = x.cmd.label.lastIndexOf('/'); return head + `<button class="mi" data-i="${i}" aria-selected="${i === cur}">${I.file}<span class="fp ml" title="${esc(x.cmd.label)}"><span class="d">${esc(x.cmd.label.slice(0, k + 1))}</span>${esc(x.cmd.label.slice(k + 1))}</span><span class="sub">${esc(x.cmd.sub)}</span>${mc(false)}</button>`; }
      if (x.cmd) return head + `<button class="mi" data-i="${i}" aria-selected="${i === cur}">${I.chevR}<span class="ml" title="${esc(x.cmd.label)}">${esc(x.cmd.label)}</span>${x.cmd.key ? `<span class="sub"><kbd>${esc(x.cmd.key)}</kbd></span>` : x.cmd.sub ? `<span class="sub">${esc(x.cmd.sub)}</span>` : ''}${mc(false)}</button>`;
      const w = x.ws;
      return head + `<button class="mi" data-i="${i}" aria-selected="${i === cur}"${w.id === S.id ? ' aria-current="true"' : ''}>${w.kind === 'pr' ? I.pr : I.branch}<span class="two"><span>${w.kind === 'pr' ? `#${w.number} ` : ''}${esc(w.title)}</span><span>${esc(w.repo)} · ${esc(st.display.replace(/^https?:\/\//, ''))}${esc(w.url)}</span></span><span class="sub">${w.left ? (w.left.lines ? `${w.left.lines.toLocaleString()} left` : 'all viewed') : ''}</span>${mc(w.id === S.id)}</button>`;
    }).join('') || `<button class="mi" data-i="-1" aria-selected="true">${I.plus}<span class="two"><span>Open “${esc(input.value.trim())}”</span><span>a PR link, owner/repo#123, #123 or a path</span></span>${mc(false)}</button>`;
    if (more > 0) list.insertAdjacentHTML('beforeend', `<div class="more">and ${more.toLocaleString()} more: keep typing to narrow them</div>`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { scrim.remove(); palClose = null; };
  palClose = close;
  api('/api/state').then((fresh) => { if (palClose === close) { st = fresh; draw(); } }, () => { /* the page's own list stands */ });
  const go = async (i) => {
    const x = shown[i];
    if (x?.ws) { close(); location.href = x.ws.url; return; }
    if (x?.cmd) { close(); return x.cmd.run(); }
    const target = (x?.target || input.value).trim(); if (!target) return;
    input.disabled = true;
    try { const r = await api('/api/workspaces', { method: 'POST', body: { target, cwd: S.ws?.root || undefined } }); close(); location.href = r.url; }
    catch (e) { input.disabled = false; list.insertAdjacentHTML('afterbegin', `<div class="err">${esc(e.message)}</div>`); }
  };
  input.addEventListener('input', () => { cur = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(shown.length - 1, cur + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(shown.length ? cur : -1); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('.mi'); if (b) go(Number(b.dataset.i)); });
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  draw(); input.focus();
}

// ------------------------------------------------------------------ home: whose move it is
async function renderHome(error) {
  S.id = null;
  const st = await api('/api/state').catch(() => S.app);
  document.title = 'loupe';
  const host = esc(st.display.replace(/^https?:\/\//, ''));
  const hidden = new Set((st.settings?.hiddenOrgs || S.app?.settings?.hiddenOrgs || []).map((o) => o.toLowerCase()));
  const ownerOf = (repo = '') => repo.split('/')[0] || '';
  const short = (repo = '') => repo.split('/')[1] || repo;
  const here = new Map(st.workspaces.filter((w) => w.kind === 'pr').map((w) => [`${w.repo}#${w.number}`, w]));
  // one column grid for every row on the page: who, what, where it stands, how big, how far you got, how old
  // how far you got, under the stage: only for what is open here
  const progress = (w) => {
    if (!w?.left?.total) return '';
    const cells = Math.round((1 - w.left.lines / w.left.total) * 12);
    return `<small class="prog" title="${w.left.lines ? `${w.left.lines.toLocaleString()} of ${w.left.total.toLocaleString()} lines left` : 'all viewed'}"><span class="px"><i style="width:${cells * 4}px"></i></span>${w.left.lines ? `${w.left.lines.toLocaleString()} left` : 'viewed'}</small>`;
  };
  const stageCell = (word, tone, w) => `<span class="hc stg ${tone}">${word ? `<span class="w">${esc(word)}</span>` : ''}${progress(w)}</span>`;
  const size = (p) => (p.add == null ? '<span class="hc sz"></span>' : `<span class="hc sz"><span><span class="add">+${p.add.toLocaleString()}</span> <span class="del">−${p.del.toLocaleString()}</span></span><small>${plural(p.files, 'file')}</small></span>`);
  // the stage in one or two words, coloured only when it asks something of you
  const stageOf = (p) => {
    if (p.checks === 'FAILURE' || p.checks === 'ERROR') return ['Checks failing', 'fail'];
    // in Review the section already says it is yours to read: the stage only adds what else is true
    if (p.whose === 'review') return p.isDraft ? ['Draft', 'quiet'] : p.decision === 'APPROVED' ? ['Approved', 'quiet'] : p.decision === 'CHANGES_REQUESTED' ? ['Changes asked', 'quiet'] : p.checks === 'PENDING' ? ['Checks running', 'quiet'] : ['', ''];
    if (p.decision === 'CHANGES_REQUESTED') return ['Changes asked', 'warn'];
    if (p.decision === 'APPROVED') return p.checks === 'PENDING' ? ['Approved · checks', ''] : ['Ready to merge', 'ok'];
    if (p.isDraft) return ['Draft', 'quiet'];
    return [p.checks === 'PENDING' ? 'Checks running' : 'In review', 'quiet'];
  };
  const prRow = (p, rail) => {
    const w = here.get(`${p.repo}#${p.number}`), [stage, tone] = stageOf(p);
    return `<div class="hrow${rail ? ` rail ${rail}` : ''}" data-owner="${esc(ownerOf(p.repo))}" data-gh="${esc(p.url)}"${w ? ` data-ws="${esc(w.id)}"` : ''}><a class="hl" href="${esc(w ? w.url : `/${p.repo}/pull/${p.number}`)}">` +
      `<span class="hc who">${p.author ? avatar(p.author) : I.pr}</span><span class="hc ti"><b title="${esc(p.title)}"><span class="no">#${p.number}</span> ${esc(p.title)}</b><small title="${esc(p.repo)}">${esc(short(p.repo))}${p.author ? ` · ${esc(p.author)}` : ''}${p.head ? ` · <span class="br">${esc(p.head)}</span>` : ''}</small></span>` +
      `${stageCell(stage, tone, w)}${size(p)}<span class="hc age">${esc(ago(Date.parse(p.updatedAt)))}</span></a><button class="hm" data-hm aria-label="More">${I.more}</button></div>`;
  };
  const wsRow = (w) => `<div class="hrow" data-ws="${esc(w.id)}"><a class="hl" href="${esc(w.url)}">` +
    `<span class="hc who">${w.kind === 'pr' && w.author ? avatar(w.author) : w.kind === 'pr' ? I.pr : I.branch}</span><span class="hc ti"><b title="${esc(w.title)}">${w.kind === 'pr' ? `<span class="no">#${w.number}</span> ` : ''}${esc(w.title)}</b><small>${esc(w.kind === 'pr' ? short(w.repo) : w.repo)}${w.kind === 'pr' && w.author ? ` · ${esc(w.author)}` : ''}${w.session ? ` · <span class="sess" title="${esc(w.session.live ? 'A live Claude Code session' : 'The Claude Code session working on it')}: ${esc(w.session.title)}">${spark(12, !w.session.live)}${esc(w.session.title)}</span>` : ''}</small></span>` +
    `${stageCell(w.dirty ? plural(w.dirty, 'uncommitted file') : w.kind === 'pr' ? '' : 'Checkout', w.dirty ? 'warn' : 'quiet', w)}<span class="hc sz"></span><span class="hc age">${w.openedAt ? esc(ago(w.openedAt)) : ''}</span></a><button class="hm" data-hm aria-label="More">${I.more}</button></div>`;
  // PRs whose base is another's head in the same repo are one stack: drawn together, base first, joined by a rail
  const stacked = (rows) => {
    const key = (p) => `${p.repo}:${p.head}`, byHead = new Map(rows.filter((p) => p.head).map((p) => [key(p), p]));
    const below = (p) => byHead.get(`${p.repo}:${p.base}`);
    const out = [], used = new Set();
    for (const p of rows) {
      if (used.has(p)) continue;
      let root = p; while (below(root) && !used.has(below(root)) && below(root) !== p) root = below(root);
      const chain = [root]; used.add(root);
      for (let next; (next = rows.find((x) => !used.has(x) && below(x) === chain.at(-1)));) { chain.push(next); used.add(next); }
      out.push(chain);
    }
    return out.map((c) => c.length < 2 ? prRow(c[0]) : c.map((p, i) => prRow(p, i === 0 ? 'first' : i === c.length - 1 ? 'last' : 'mid')).join('')).join('');
  };
  const section = (id, title, n, rows, empty) => `<section class="hsect" id="${id}"><h2 class="hh">${title}${n ? `<span class="n">${n}</span>` : ''}</h2>${rows ? `<div class="hlist">${rows}</div>` : `<div class="hempty">${empty}</div>`}</section>`;
  const draw = (ib) => {
    const rows = ib ? (ib.prs || []) : [];
    const shown = rows.filter((p) => !hidden.has(ownerOf(p.repo).toLowerCase()));
    const humans = shown.filter((p) => !p.bot), bots = shown.length - humans.length;
    // review: what others asked you to read, longest waiting first; yours: your own and those assigned to you
    const review = humans.filter((p) => p.whose === 'review').sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const yours = humans.filter((p) => p.whose === 'mine' || p.whose === 'assigned');
    const listed = new Set(humans.map((p) => `${p.repo}#${p.number}`));
    const open = st.workspaces.filter((w) => w.kind !== 'pr' || !listed.has(`${w.repo}#${w.number}`));
    const hiddenN = rows.length - shown.length;
    // the section heads already count each list; the footer says only what they do not: what is left out
    const counts = bots ? plural(bots, 'bot PR') + ' not shown' : '';
    return `<div class="home"><div class="homein">
      <div class="brand">${icon('loupe', '--pencil', 2)}<span class="nm">loupe</span><span class="host">${esc(st.display)}</span></div>
      <form class="go" id="go"><input class="field" name="t" placeholder="Paste a PR link, owner/repo#123, or a local path" autocomplete="off" autofocus><button class="btn primary">Open</button></form>
      ${error ? `<div class="lost">${icon('loupe', '--ink-3', 3)}<div><b>Nothing under the loupe.</b><div class="faint">${esc(error)}</div></div></div>` : ''}
      ${ib?.error ? `<div class="err">${esc(ib.error)}</div>` : ''}
      ${section('h-review', 'Review', review.length, ib ? stacked(review) : '', ib ? `<span class="calm">${icon('loupe', '--ink-3', 2)}<span>Nothing is waiting on your review.</span></span>` : '<span class="calm">Asking GitHub…</span>')}
      ${section('h-yours', 'Yours', yours.length, ib ? stacked(yours) : '', ib ? '<span class="calm">No open pull requests of yours.</span>' : '<span class="calm">Asking GitHub…</span>')}
      ${section('h-open', 'Open here', open.length, open.map(wsRow).join(''), '<span class="calm">Nothing else open. Paste a pull request above, or run <code>loupe</code> in a repository.</span>')}
      <footer class="homefoot">${counts || hidden.size ? `<p>${counts}${hidden.size ? `${counts ? ' · ' : ''}Hiding ${[...hidden].map((o) => `<button class="link unhide" data-unhide="${esc(o)}" title="Show ${esc(o)}'s pull requests again">${esc(o)} ×</button>`).join(' ')}${hiddenN ? ` (${hiddenN})` : ''}` : ''}</p>` : ''}
      <p>Swap <code>github.com</code> for <code>${host}</code> in a pull request link to open it here. <code>loupe</code> in a repository opens its branch and uncommitted work. <span class="nobr"><kbd>j</kbd> <kbd>k</kbd> move, <kbd>↵</kbd> opens.</span></p></footer>
    </div></div>`;
  };
  const paint = (ib) => {
    const v = $('#go')?.t?.value || '', focused = document.activeElement?.closest?.('.hrow')?.querySelector('.hl')?.getAttribute('href');
    $('#root').innerHTML = draw(ib);
    if (v) $('#go').t.value = v;
    if (focused) $(`.hl[href="${CSS.escape(focused)}"]`)?.focus();
    $('#go').addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = e.target.t.value.trim(); if (!t) return;
      try { const r = await api('/api/workspaces', { method: 'POST', body: { target: t } }); location.href = r.url; } catch (err) { renderHome(err.message); }
    });
  };
  const setHidden = async (list) => {
    try { S.app.settings = await api('/api/settings', { method: 'POST', body: { hiddenOrgs: list } }); } catch (e) { return toast(e.message); }
    renderHome();
  };
  paint(null);
  $('#root').onclick = async (e) => {
    const u = e.target.closest('[data-unhide]');
    if (u) return setHidden([...hidden].filter((o) => o !== u.dataset.unhide));
    const m = e.target.closest('[data-hm]');
    if (!m) return;
    const row = m.closest('.hrow'), owner = row.dataset.owner, ws = row.dataset.ws, gh = row.dataset.gh;
    menu(m, [
      ...(gh ? [{ label: 'Open on GitHub', value: 'gh' }] : []),
      // hiding needs a daemon that keeps the list (settings.hiddenOrgs); an older one does not offer it
      ...(owner && Array.isArray(st.settings?.hiddenOrgs) ? [{ label: `Hide ${owner}'s pull requests`, value: 'hide' }] : []),
      ...(ws ? [{ sep: true }, { label: 'Close it here', sub: 'forgets its marks and chats', value: 'close', danger: true }] : []),
    ], async (it) => {
      if (it.value === 'gh') open(gh, '_blank', 'noopener');
      if (it.value === 'hide') setHidden([...hidden, owner.toLowerCase()]);
      if (it.value === 'close') { await api(`/api/w/${ws}`, { method: 'DELETE' }).catch((err) => toast(err.message)); renderHome(); }
    }, { align: 'right', width: 280 });
  };
  const ib = await api('/api/inbox').catch((e) => ({ error: e.message, prs: [] }));
  if (!S.id && $('.home')) paint(ib);
}
// Home's keys: j and k move between the rows, Enter follows the focused one (it is a link), / goes to the box.
document.addEventListener('keydown', (e) => {
  if (S.id || !$('.home') || e.metaKey || e.ctrlKey || e.altKey || $('.scrim, .menu')) return;
  const inField = e.target.closest?.('input, textarea');
  if (e.key === '/' && !inField) { e.preventDefault(); return $('#go input')?.focus(); }
  if (inField) { if (e.key === 'ArrowDown' || (e.key === 'Escape')) { e.preventDefault(); e.target.blur(); $('.hl')?.focus(); } return; }
  if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const all = $$('.home .hl'), i = all.indexOf(document.activeElement);
  const next = all[Math.max(0, Math.min(all.length - 1, i < 0 ? 0 : i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))];
  next?.focus(); next?.scrollIntoView({ block: 'nearest' });
});

function keySheet() {
  const k = (keys, what) => `<span class="k">${keys.map((x) => `<kbd>${x}</kbd>`).join('')}</span><span>${what}</span>`;
  // a mouse action is not a key: the modifier is a key, the click or hover is a word
  const m = (mods, action, what) => `<span class="k">${mods.map((x) => `<kbd>${x}</kbd>`).join('')}<span class="mouse">${action}</span></span><span>${what}</span>`;
  const scrim = h(`<div class="scrim"><div class="palette keysheet"><div class="keys">
    <h3>MOVING</h3>${k(['j'], 'next file')}${k(['k'], 'previous file')}${k([']'], 'done with this file: mark it viewed, go to the next left')}${k(['/'], 'find a file')}${k(['⌘', 'K'], 'open or do anything')}
    <h3>REVIEWING</h3>${k(['v'], 'mark the file viewed, or not viewed again')}${k(['o'], 'fold or unfold the file')}${k(['s'], 'unified or split')}${k(['g'], 'guide order or file order')}${k(['m'], 'hide or show the marks in the code')}
    <h3>ON SELECTED LINES</h3>${k(['a'], 'ask Claude there')}${k(['c'], 'comment for your GitHub review (pending until you submit)')}${k(['l'], 'add them to the chat')}${k(['⌘', '↵'], 'send')}${k(['esc'], 'cancel')}
    <h3>PANELS</h3>${k(['1'], 'overview')}${k(['2'], 'chat')}${k(['3'], 'marks')}${k(['t'], 'files')}${k(['p'], 'inspector')}${k(['r'], 'read the change again')}
    <h3>GO</h3>${m([], 'hover', 'Go docs')}${m(['⌘'], 'click', 'definition')}${m(['⇧', '⌘'], 'click', 'references')}${k(['⌥'], 'hold over code for the loupe')}
  </div><div class="foot"><span><kbd>esc</kbd> close</span></div></div></div>`);
  document.body.append(scrim);
  // The palette closes this sheet through keysClose, so its capture listener never outlives it.
  const close = () => { scrim.remove(); removeEventListener('keydown', esc1, true); keysClose = null; };
  const esc1 = (e) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); close(); } };
  addEventListener('keydown', esc1, true);
  keysClose = close;
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
}

async function baseMenu(btn) {
  let r;
  try { r = await api(`/api/w/${S.id}/refs`); } catch (e) { return toast(e.message); }
  const items = [{ header: 'COMPARE WITH' }, { label: 'The remote\'s default branch', sub: 'origin/HEAD', value: '' },
    { sep: true }, ...r.refs.map((x) => ({ label: x.name, sub: ago(x.at), value: x.name, current: x.name === r.base }))];
  menu(btn, items, async (it) => {
    try { await api(`/api/w/${S.id}/base`, { method: 'POST', body: { base: it.value } }); } catch (e) { toast(e.message); }
  }, { width: 380 });
}
hooks.baseMenu = baseMenu;

function scopeMenu(btn) {
  const m = S.ws;
  const items = [
    { label: m.kind === 'pr' ? 'Whole pull request' : m.dirty ? 'Branch + uncommitted' : 'Whole branch', value: 'all', current: S.rangeKey === 'all' },
    ...(m.kind === 'local' ? [{ label: 'Committed only', value: 'branch', current: S.rangeKey === 'branch' }, { label: 'Uncommitted only', sub: m.dirty ? plural(m.dirty, 'file') : 'none', value: 'wip', current: S.rangeKey === 'wip' }] : []),
    ...(m.sinceCount ? [{ label: 'Since you last looked', sub: plural(m.sinceCount, 'commit'), value: 'since', current: S.rangeKey === 'since' }] : []),
    ...(m.trunkMergeBase ? [{ label: 'Whole stack', sub: `from ${m.trunk || 'the trunk'}`, value: 'stack', current: S.rangeKey === 'stack' }] : []),
    ...(m.kind === 'local' ? [{ sep: true }, { label: `Compare with ${m.base}`, sub: 'change…', value: '__base' }] : []),
    ...(m.commits.length ? [{ sep: true }, { header: `COMMITS (${m.commits.length})` }, ...m.commits.map((c) => ({ two: [c.subject, `${c.short.slice(0, 7)} · ${c.author} · ${ago(c.at)}`], value: c.sha, current: S.rangeKey === c.sha }))] : []),
  ];
  menu(btn, items, (it) => (it.value === '__base' ? baseMenu(btn) : setScope(it.value)), { width: 420 });
}

// ------------------------------------------------------------------ clicks in the frame
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-act]');
  if (b && b.closest('.top, .ptabs, .state, #aifab')) {
    const act = b.dataset.act;
    if (act === 'palette') openPalette();
    if (act === 'layout') setLayout(b.dataset.l);
    if (act === 'refresh') { b.disabled = true; try { await api(`/api/w/${S.id}/refresh`, { method: 'POST' }); await loadWorkspace('Read again'); } catch (err) { toast(err.message); } b.disabled = false; }
    if (act === 'theme') {
      const cur = pref.get('theme', 'system'), st = S.app.settings || {};
      // choices (layout, theme, diff) and settings (on or off) each show their state as one check in one column;
      // a key that switches a group sits on the group's header, a key that flips a setting on its row
      menu(b, [{ header: 'LAYOUT' }, { label: 'Three panes', value: { mode: 'panes' }, current: S.mode === 'panes' }, { label: 'Guide', value: { mode: 'guide' }, current: S.mode === 'guide' },
        { sep: true }, { header: 'THEME' }, { label: 'System', value: { theme: 'system' }, current: cur === 'system' }, { label: 'Light', value: { theme: 'light' }, current: cur === 'light' }, { label: 'Dark', value: { theme: 'dark' }, current: cur === 'dark' },
        { sep: true }, { header: 'DIFF', key: 's' }, { label: 'Split', value: { layout: 'split' }, current: S.layout === 'split' }, { label: 'Unified', value: { layout: 'unified' }, current: S.layout === 'unified' },
        { sep: true }, { header: 'SHOW' }, { label: 'Marks in the code', key: 'm', value: { marks: true }, on: !S.marksHidden },
        { sep: true }, { header: 'REVIEW' },
        { label: 'Count tests and generated files as viewed', value: { autoView: !st.autoView }, on: !!st.autoView },
        { label: 'Write the brief when a PR opens', value: { autoBrief: !st.autoBrief }, on: !!st.autoBrief }], async (it) => {
        if (it.value.theme) { pref.set('theme', it.value.theme); applyTheme(it.value.theme); b.innerHTML = it.value.theme === 'dark' ? I.moon : I.sun; return; }
        if (it.value.layout) return setLayout(it.value.layout);
        if (it.value.mode) return applyMode(it.value.mode);
        if (it.value.marks) return setMarksHidden(!S.marksHidden);
        try { S.app.settings = await api('/api/settings', { method: 'POST', body: it.value }); } catch (err) { return toast(err.message); }
        for (const f of S.files) updateCard(f.path);
        progress();
      }, { align: 'right', width: 340 });
    }
    if (act === 'togglebin') setPane('bin', !paneOpen('bin'));
    if (act === 'togglepanel') setPane('panel', !paneOpen('panel'));
    if (act === 'keys') keySheet();
    if (act === 'scopemenu') scopeMenu(b);
    if (act === 'scope') setScope(b.dataset.scope);
    if (act === 'askai') return askAi();
    if (act === 'gochat') { setPane('panel', true); S.chat = b.dataset.conv; setTab('chat'); }
    if (act === 'retry') { await api(`/api/w/${S.id}/refresh`, { method: 'POST' }).catch(() => {}); loadWorkspace(); }
    return;
  }
  const tab = e.target.closest?.('.ptabs .tab');
  if (tab) return setTab(tab.dataset.tab);
  const gs = e.target.closest?.('#tlist [data-act="gosec"]');
  if (gs) { const g = document.getElementById('g-' + gs.dataset.k); const first = S.review.brief?.sections?.[Number(gs.dataset.k)]?.files?.[0]; return first ? goLoc({ path: first, line: 0 }) : g?.scrollIntoView({ block: 'start' }); }
  const wb = e.target.closest?.('#tlist [data-act="writebrief"]');
  if (wb) { setPane('panel', true); setTab('overview'); return requestAnimationFrame(() => $('[data-act="brief"]')?.click()); }
  const tr = e.target.closest?.('.trow');
  if (tr) {
    if (tr.dataset.d !== undefined) { S.dirShut.has(tr.dataset.d) ? S.dirShut.delete(tr.dataset.d) : S.dirShut.add(tr.dataset.d); return renderTree(); }
    return goLoc({ path: tr.dataset.p, line: 0 });
  }
});

// ------------------------------------------------------------------ keys
document.addEventListener('keydown', (e) => {
  // again: closes it. Not over a dialog: that is modal, and its Tab trap and Esc would take the palette's keys.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return sheetOpen() ? undefined : openPalette(); }
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || !S.ws) return;
  if ($('.scrim, .sheetscrim')) return; // an overlay (palette, keys, a dialog) owns the keys
  if (e.key === 'Escape') {
    if ($('#viewer')) return closeViewer();
    if (sheetOpen()) return closeSheet();
    if (S.mark) return hooks.closeMark?.();
    hideTip(); closeMenu(); $('#refs')?.remove();
    if (S.draft || S.sel) cancelDraft();
    return;
  }
  const key = e.key;
  const go = (p) => p && goLoc({ path: p, line: 0 });
  if (S.sel && !S.draft && (key === 'a' || key === 'l')) { e.preventDefault(); return key === 'l' ? attachSelection() : openDraft('ask'); }
  if (S.sel && !S.draft && key === 'c' && canComment(S.sel.path)) { e.preventDefault(); return openDraft('comment'); }
  if (key === 'a' && !S.sel) { e.preventDefault(); return askAi(); }
  if (key === 'j') stepFile(1);
  else if (key === 'k') stepFile(-1);
  else if (key === ']') nextLeft();
  else if (key === 'v' && S.current) { const on = !isViewed(fileOf(S.current)); const next = on ? nextUnviewed() : null; setViewed(S.current, on); if (next && next !== S.current) setTimeout(() => go(next), 60); }
  else if (key === 'o' && S.current) toggleFold(S.current);
  else if (key === 's') setLayout(S.layout === 'split' ? 'unified' : 'split');
  else if (key === 'g' && S.review.brief?.sections?.length) setOrder(S.order === 'guide' ? 'tree' : 'guide');
  else if (key === 't') setPane('bin', !paneOpen('bin'));
  else if (key === 'p') setPane('panel', !paneOpen('panel'));
  else if (key === 'm') setMarksHidden(!S.marksHidden);
  else if (key === '1' || key === '2' || key === '3') { setPane('panel', true); setTab(['overview', 'chat', 'review'][Number(key) - 1]); }
  else if (key === '/') { e.preventDefault(); setPane('bin', true); $('#filter').focus(); }
  else if (key === 'r') $('[data-act="refresh"]')?.click();
  else if (key === '?') keySheet();
  else return;
  e.preventDefault();
});

boot();
