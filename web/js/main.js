// The page: which change this URL is, the frame around it (top bar; bin | diff | inspector), live
// updates from the daemon, keys, the palette and home. One URL per change; "/" goes back to the last one.
import { S, $, $$, esc, h, api, wsApi, I, pref, toast, fileOf, plural, ago, briefRun, notesRun } from './core.js';
import { renderCards, renderBody, renderAllBodies, renderLayout, loadFile, toggleFold, setViewed, isViewed, cardEl, openDraft, attachSelection, cancelDraft, updateCard, orderedFiles, lines, updateMark, setMarksHidden, canComment, statusGlyph, updateFileNotes } from './cards.js';
import { attemptFileNotes, filesNeedingNotes, resetNotesAttempt, currentNotes } from './file-notes.js';
import { renderTree, updateTreeViewed, markCurrent, nextUnviewed } from './tree.js';
import { renderPanel, setTab, renderTabs, openChat, paintMessage } from './panel.js';
import { goLoc, goThread, openViewer, closeViewer, hideTip, goBack, clearReturns, remember, forget } from './nav.js';
import { renderProgress, paintProgress, paintScrollProgress, renderGo, renderStack, doAct } from './acts.js';
import { menu, closeMenu, shimmerSync, refreshRunButtons, pickRun, runLabel } from './ui.js';
import { hooks } from './hooks.js';
import './actions.js';
import { loadShip, sheetOpen, closeSheet } from './sheets.js';
import './eggs.js';
import './strike.js';
import './stamp.js';
import './sound.js';
import { moteHTML, wakeMotes } from './mote.js';
import { spark, icon, avatar } from './pixel.js';
import { decorateState, endOpening } from './press.js';
import { animateTheme, systemTheme, themeOrigin } from './theme-wave.js';

// Every part that shows the review's state, redrawn together, so no part ever disagrees with another. The inspector is
// not one of them: the Overview says nothing about what is viewed, and redrawing it (the PR's description and its
// conversation, as markdown) on every v and ] was the biggest cost of a keypress on a PR.
function progress(path) {
  if (path) updateTreeViewed(path);
  else renderTree();
  paintProgress();
  if (!path) renderGo();
  hooks.mote?.progress(allViewed(), leftShare());
}
// Mote's two readings of the review, from the same files (every file but the generated ones, whatever the filter shows):
// is every one viewed, and the share of their lines not yet viewed, 0..1 (its lens gathers its light by it). A change of
// no lines (renames only) is all left until every file is viewed, then none.
const reviewed = () => S.files.filter((f) => f.kind !== 'generated');
const allViewed = () => S.files.length > 0 && reviewed().every(isViewed);
function leftShare() {
  const fs = reviewed(), total = fs.reduce((n, f) => n + lines(f), 0);
  if (!total) return fs.every(isViewed) ? 0 : 1;
  return fs.filter((f) => !isViewed(f)).reduce((n, f) => n + lines(f), 0) / total;
}
Object.assign(hooks, {
  goLoc, goThread, openViewer, renderTree, renderPanel, openChat, progress,
  loadStack: () => loadStack(true), setScope: (s) => setScope(s), setOrder: (o) => setOrder(o),
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
    renderAllBodies(); renderTree(); renderTabs(); renderProgress(); renderGo();
    if (S.tab !== 'chat') renderPanel();
  },
  threadsChanged: (p) => { updateCard(p); renderTree(); renderTabs(); renderGo(); if (S.tab === 'review') renderPanel(); },
  githubChanged: () => { renderAllBodies(); renderTabs(); renderGo(); if (S.tab !== 'chat' && !document.activeElement?.closest?.('#pbody .composer')) renderPanel(); },
});

// ------------------------------------------------------------------ theme
let themeChoice = pref.get('theme', 'system');
const effectiveTheme = (choice) => choice === 'light' || choice === 'dark' ? choice : systemTheme();
function renderTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = $('[data-act="theme"]');
  if (toggle) toggle.innerHTML = theme === 'dark' ? I.moon : I.sun;
}
function applyTheme(choice, origin) {
  themeChoice = choice;
  const theme = effectiveTheme(choice);
  animateTheme(() => renderTheme(theme), origin, theme === document.documentElement.dataset.theme);
}
renderTheme(effectiveTheme(themeChoice));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice === 'system') applyTheme('system', themeOrigin($('[data-act="theme"]')));
});

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
  try { const r = await api('/api/workspaces', { method: 'POST', body: { target } }); location.href = r.url; } catch (e) { toast(e.message, { fail: true }); }
}

function frame() {
  S.view = null; // the whole-file viewer lives in the diff's column, which is drawn again here
  $('#root').innerHTML = `<div class="app">
  <header class="top">
    <a class="btn ghost mark" href="/home" title="Home: everything open here, and whose move it is">${icon('loupe', '--pencil')}<span>loupe</span></a>
    <span class="crumb-sep">/</span>
    <button class="btn ghost wsbtn" data-act="palette" title="Switch, open, or do anything (⌘K)" id="wsbtn"><span class="t">…</span></button>
    <span class="sp"></span>
    <span class="lsp" id="lsp"></span>
    <button class="btn ghost tally" id="tally" data-act="nextleft"></button>
    <span class="go" id="go"></span>
    <span class="tools"><a class="icon" id="ghlink" target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label="Open on GitHub" hidden>${I.github}</a><button class="icon" data-act="refresh" title="Read the change again (r)">${I.refresh}</button><button class="icon" data-act="theme" title="View: theme, layout, settings">${document.documentElement.dataset.theme === 'dark' ? I.moon : I.sun}</button>
    <span class="layout-toggles"><button class="icon" data-act="togglebin" title="Files (t)">${I.sidebarL}</button><button class="icon" data-act="togglepanel" title="Inspector (p)">${I.sidebarR}</button></span></span>
  </header>
  <div class="main" id="main">
    <aside class="bin" id="bin"><div class="scopebar" id="scopebar"></div><div class="tree-head"><span class="fwrap">${I.search}<input class="field" id="filter" type="search" placeholder="Find a file" aria-label="Find a file" autocomplete="off"><kbd class="fkey" aria-hidden="true">/</kbd></span><span id="ordseg"></span></div><nav class="tlist" id="tlist" aria-label="Changed files"></nav><div class="resizer" data-resize="bin"></div></aside>
    <main class="viewer-col"><div class="scroller" id="center"><div class="cards" id="cards"><div class="loadd">Loading…</div></div></div></main>
    <aside class="panel" id="panel"><div class="resizer" data-resize="panel"></div><div class="ptabs" role="tablist"><button class="tab" role="tab" id="ptab-overview" data-tab="overview">Overview</button><button class="tab" role="tab" id="ptab-chat" data-tab="chat">Chat</button><button class="tab" role="tab" id="ptab-review" data-tab="review">Marks</button><span class="sp"></span><button class="icon" data-act="keys" title="Keys (?)" aria-label="Keys">${I.keys}</button></div><div class="pbody" id="pbody"></div></aside><div class="motefloat" id="motedock"></div>
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

// The change's meta, then its files and review state. Called again whenever the change moves. One read of the meta
// runs at a time: a call while one runs asks for one more after it (the calls in between fold into it, keeping a
// change's reason), so answers never cross and the newest is drawn last. The files are read outside the queue (their
// own request number keeps the newest), so a slow one never holds the next read back.
let wsRun = null, wsNext = null;
function loadWorkspace(reason) {
  if (wsRun) { wsNext = { reason: reason ?? wsNext?.reason }; return wsRun; }
  wsRun = (async () => {
    let files = null;
    try {
      for (let n = { reason }; n; n = wsNext, wsNext = null) {
        try { files = (await readWorkspace(n.reason))?.files || files; } catch (e) { console.error(e); } // one read that throws never drops the next
      }
    } finally { wsRun = null; }
    await files;
  })();
  return wsRun;
}
async function readWorkspace(reason) {
  const id = S.id;
  let m;
  try { m = await api(`/api/w/${id}`); } catch (e) { if (S.id === id) showState('Could not open this', e.message, true); return; }
  if (S.id !== id) return;
  if (m.status !== 'ready' || !m.headFull && m.kind === 'pr') {
    S.opening = { ...m, id: S.id }; // what the state box can show while it waits: a pull request's size, the refs of one that failed
    $('#wsbtn').innerHTML = `${m.kind === 'pr' ? I.pr : I.branch}<span class="t">${esc(m.rec?.pr?.title || m.rec?.slug || '')}</span>`;
    return showState(m.status === 'error' ? 'Could not open this' : 'Opening…', m.progress || '', m.status === 'error');
  }
  // the opening's roll finishes its pass before the change is drawn over it
  await endOpening();
  if (S.id !== id) return;
  if (S.ws && (S.ws.branch !== m.branch || S.ws.headFull !== m.headFull)) {
    // A checkout or rebase can change which row is current before the next stack request finishes.
    S.stack = null;
    stackRequest++;
  }
  S.ws = m; S.opening = null;
  $('#wsbtn').innerHTML = wsTitle();
  const files = loadFiles(reason);
  files.catch((e) => console.error(e)); // a read that a newer one replaced is still said, never left unhandled
  return { files };
}
// a daemon's or git's message, said as a sentence: capitalised, with its full stop
// (a program's name leading it, "gh: …" or "git fetch: …", keeps its case)
const sentence = (t = '') => { t = String(t).trim(); return t && (/^([a-z][\w-]*:|(gh|git|gopls|codex|claude|loupe|node|npm)\b)/.test(t) ? t[0] : t[0].toUpperCase()) + t.slice(1) + (/[.!?…)]$/.test(t) ? '' : '.'); };
function showState(title, text, error) {
  hooks.cardVisibilityChanged?.();
  $('#cards').innerHTML = `<div class="state${error ? ' failed' : ''}"><div class="box">${error ? moteHTML('failed') : ''}<div class="big">${esc(title)}</div>${error ? `<div class="why">${esc(sentence(text))}</div><button class="btn" data-act="retry">Try again</button>` : `<div class="working"><span class="shimmer" style="${shimmerSync()}">${esc(text || 'Reading the change…')}</span></div>`}</div></div>`;
  decorateState($('#cards > .state'), { error, m: S.opening?.id === S.id ? S.opening : null });
  wakeMotes($('#cards'));
}

let fileRequest = 0;
async function loadFiles(reason) {
  const id = S.id, request = ++fileRequest;
  const current = () => id === S.id && request === fileRequest;
  const briefAtRequest = S.review.brief;
  const notesAtRequest = S.review.notes;
  const spot = reason ? scrollSpot() : null;
  let files, review;
  const ghReq = api(`/api/w/${S.id}/github`).catch(() => null);
  try {
    [files, review] = await Promise.all([api(wsApi('/files')), api(`/api/w/${S.id}/review`)]);
  } catch (e) { if (current()) showState('Could not read the change', e.message, true); return; }
  if (!current()) return;
  const comparison = `${files.old}:${files.new}`;
  if (S.comparison && S.comparison !== comparison) clearReturns();
  S.comparison = comparison;
  S.rangeKey = files.scope;
  S.untrackedSkipped = files.untrackedSkipped || 0;
  S.files = files.files.map((f, i) => ({ ...f, i }));
  S.byPath = new Map(S.files.map((f) => [f.path, f]));
  // A model result can land while the files request is still in flight.
  if (S.review.brief !== briefAtRequest) review.brief = S.review.brief; // (what can be undone on it travels with it, as brief.edits)
  if (S.review.notes !== notesAtRequest) review.notes = S.review.notes;
  S.review = review;
  S.github ||= { pr: null, threads: [] };
  // GitHub's side (the PR, its checks, its threads) is never waited for: it lands when it lands.
  ghReq.then((gh) => { if (gh && current()) { S.github = gh; hooks.githubChanged(); renderGo(); syncMote(); renderGhLink(); $('#wsbtn').innerHTML = wsTitle(); } });
  S.wsWip = new Set(S.ws.wipPaths || []);
  S.rows.clear(); S.items.clear(); S.tok.clear(); S.loaded.clear(); S.newText.clear(); S.diffs.clear();
  // Generated files, and files you have viewed, start folded.
  S.shut = new Set(S.files.filter((f) => f.kind === 'generated' || isViewed(f)).map((f) => f.path));
  if (S.order === 'guide' && !S.review.brief?.sections?.length) S.order = 'tree';
  if (S.mode === 'guide' && S.review.brief?.sections?.length) S.order = 'guide';
  if (!S.current || !fileOf(S.current)) S.current = orderedFiles()[0]?.f.path || null;
  renderScopebar(); renderTree(); renderCards(); renderPanel(); renderLsp(); syncMote(); renderGhLink();
  hooks.sound?.opened(S.id);
  renderProgress(); renderGo(); renderStack(); hooks.moteMount?.(allViewed(), leftShare());
  requestAnimationFrame(spyNow);
  if (spot) requestAnimationFrame(() => restoreSpot(spot));
  else if (location.hash.length > 1) {
    // #path, #path:L12 or #path:L12-L20: the file, scrolled to the line.
    const m2 = /^(.*?)(?::L(\d+)(?:-L?(\d+))?)?$/.exec(decodeURIComponent(location.hash.slice(1)));
    if (m2 && fileOf(m2[1])) requestAnimationFrame(() => goLoc({ path: m2[1], line: Number(m2[3] || m2[2]) || 0 }));
  }
  if (reason) toast(reason);
  maybeAutoBrief();
  const whole = files.scope === 'all' ? files : await api(`/api/w/${id}/files?scope=all`).catch(() => null);
  if (!current()) return;
  if (whole) {
    if (notesChange?.key !== whole.key || notesChange?.id !== id) {
      notesChange = { id, key: whole.key, quietAt: Date.now() + (S.ws.kind === 'local' ? 20000 : 0) };
    }
    notesChange.files = whole.files;
    maybeAutoNotes();
  }
  loadStack();
  if (S.ws.kind === 'local') loadShip(true);
}

// Read the Overview's stack after the diff opens. Each row opens its checkout or its PR.
let stackRequest = 0;
async function loadStack(fresh = false) {
  const id = S.id, request = ++stackRequest;
  const stack = await api(`/api/w/${id}/stack${fresh ? '?fresh=1' : ''}`).catch(() => null);
  // A reply from the previous workspace or before a newer refresh belongs to that view.
  if (id !== S.id || request !== stackRequest) return;
  S.stack = stack;
  renderStack(); renderGo();
}
async function openStackItem(i) {
  const it = S.stack?.items?.[i];
  if (!it || it.here) return;
  const repo = S.stack?.repo || S.github?.repoFull;
  const target = it.checkout || (it.pr && repo ? `${repo}#${it.pr}` : null);
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
  return api(wsApi('/brief'), { method: 'POST', body: briefRun() }).catch((e) => {
    if (S.id !== id || S.review.brief !== pending) return;
    S.review.brief = { pending: false, error: e.message };
    renderTabs(); if (S.tab === 'overview') renderPanel();
  });
}

// Keep the quiet period tied to the whole change, even while viewing an individual commit.
let notesChange, notesTimer;
function maybeAutoNotes() {
  clearTimeout(notesTimer);
  const change = notesChange;
  if (!change || change.id !== S.id || S.app.settings?.autoNotes === false || S.review.notes?.pending ||
      change.request || change.attempted || !filesNeedingNotes(change.files, currentNotes(S.review.notes)).length) return;
  notesTimer = setTimeout(async () => {
    if (notesChange !== change || changedT || S.app.settings?.autoNotes === false || S.review.notes?.pending) return;
    const retryAt = await attemptFileNotes(change, () => writeNotes({ auto: true, key: change.key }));
    if (retryAt && notesChange === change) maybeAutoNotes();
  }, Math.max(0, Math.max(change.quietAt, change.retryAt || 0) - Date.now()));
}

function writeNotes(options) {
  return api(`/api/w/${S.id}/notes`, { method: 'POST', body: { ...notesRun(), ...options } })
    .catch((e) => { if (!options.auto) toast(e.message, { fail: true }); });
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
  $('#bin').classList.add('ready'); // the find field shows once there are files to find
  $('#scopebar').innerHTML = `<button class="scopebtn" data-act="scopemenu" title="What to compare: ${esc(scopeLabel())}"><span class="l">${esc(scopeLabel())}</span>${I.chev}</button>${step}` +
    `<span class="what" title="${esc(`${plural(S.files.length, 'file')}, ${t.add.toLocaleString()} lines added and ${t.del.toLocaleString()} removed`)}"><span class="add num">+${t.add.toLocaleString()}</span><span class="del num">−${t.del.toLocaleString()}</span></span>`;
  // the count is said where it is used: in the field that finds among them
  const ff = $('#filter'); if (ff) ff.placeholder = `Find in ${plural(S.files.length, 'file')}`;
  // the list is a tree or the guide's sections: a switch beside the filter, the same height, when there is a guide (g)
  const ord = $('#ordseg');
  if (ord) ord.innerHTML = S.review.brief?.sections?.length ? `<span class="seg" role="group" aria-label="Order of the files">${[['tree', 'Tree'], ['guide', 'Guide']].map(([o, l]) => `<button data-act="setorder" data-o="${o}" aria-pressed="${S.order === o}" title="Files in ${o === 'tree' ? 'tree' : "the guide's"} order (g)">${l}</button>`).join('')}</span>` : '';
}
// Mote shows when an answer or the brief is being written; a is how you ask
function syncMote() { hooks.mote?.sync(); }
hooks.syncMote = syncMote;
function askAi() {
  if (S.sel && !S.draft) return openDraft('ask');
  setPane('panel', true);
  openChat();
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
  clearReturns();
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
  renderScopebar(); renderTree(); renderCards(true); renderProgress(); if (S.tab === 'overview') renderPanel();
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
let spyCards;
hooks.cardVisibilityChanged = () => { spyCards = null; };
function spyNow() {
  const c = $('#center');
  if (!c) return;
  const { top, bottom } = c.getBoundingClientRect(), line = top + 90;
  const cards = spyCards ||= [...$('#cards').children].filter((el) =>
    el.classList.contains('gsec') || el.classList.contains('file') && !el.hidden);
  let lo = 0, hi = cards.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cards[mid].getBoundingClientRect().top <= line) lo = mid + 1; else hi = mid;
  }
  const el = cards[lo - 1];
  const cur = el?.classList.contains('gsec') ? cards[lo] : el;
  const p = cur?.dataset.p || orderedFiles()[0]?.f.path || null;
  // How far into each open file the bottom of the screen has reached: the strip shows it as a dither.
  let moved = false;
  let start = lo - 1;
  while (start > 0 && cards[start].getBoundingClientRect().top > top) start--;
  for (let i = Math.max(start, 0); i < cards.length; i++) {
    const el = cards[i];
    const r = el.getBoundingClientRect();
    if (r.top > bottom) break;
    if (!el.classList.contains('file') || el.classList.contains('shut') || r.bottom < top) continue;
    const f = Math.max(0, Math.min(1, (bottom - r.top) / Math.max(1, r.height)));
    if (f > (S.readFrac.get(el.dataset.p) || 0) + 0.02) { S.readFrac.set(el.dataset.p, f); moved = true; }
  }
  const changed = p !== S.current;
  if (changed) { S.current = p; markCurrent(); }
  if (changed || moved) paintScrollProgress();
}
let spy = false;
function onScroll() {
  if (spy) return; spy = true;
  // Read the scroller after this frame's layout, so scrolling and the meter do not each flush it.
  requestAnimationFrame(() => setTimeout(() => { spy = false; spyNow(); hideTip(); }, 0));
}
// Next left: you are done with this file. It is marked viewed and you go to the next one left after it.
// ] is done with this file: viewed, and on to the next one left. [ undoes it: the file goes back to unviewed and the page
// back to where you were in it.
let nextT = 0;
function nextLeft() {
  const cur = S.current, f = cur && fileOf(cur);
  const next = nextUnviewed();
  const marking = !!(f && !isViewed(f) && f.kind !== 'generated');
  // one place to come back to per ], taken before anything moves (marking can fold the file), dropped if ] did nothing
  const entry = remember(() => { clearTimeout(nextT); if (marking) return setViewed(cur, false); });
  if (marking) setViewed(cur, true);
  const to = next && next !== cur ? next : nextUnviewed();
  if (!marking && !to) forget(entry);
  if (!to) return toast('Every file is viewed.');
  const id = S.id, scope = S.scope;
  clearTimeout(nextT);
  nextT = setTimeout(() => { if (S.id === id && S.scope === scope) goLoc({ path: to, line: 0 }, null, null, { remembered: true }); }, 60);
}
hooks.nextLeft = nextLeft;
hooks.setFilter = (value) => { S.filter = value; const f = $('#filter'); if (f) f.value = value; renderTree(); };
hooks.clearFilter = () => hooks.setFilter('');
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
  if (!first) { renderTree(); renderCards(true); renderProgress(); requestAnimationFrame(spyNow); }
}
hooks.applyMode = applyMode;
const paneOpen = (which) => !$('#main').classList.contains(PANE[which][0]);
function setLayout(l) {
  if (S.layout === l) return;
  S.layout = l; pref.set('layout', l); S.sel = null;
  renderLayout();
}
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
  const models = ({ models, efforts, defaults }) => {
    if (!models) return;
    Object.assign(S.app, { models, efforts, defaults });
    refreshRunButtons();
  };
  on('models', models);
  // A reconnect can have missed events (an answer's last one): read everything again, quietly.
  es.addEventListener('error', () => { S.lost = true; });
  on('hello', (d) => {
    models(d);
    if (S.boot && S.boot !== d.boot) {
      notesChange = undefined;
      loadWorkspace('loupe restarted; the change is read again');
    } else if (S.lost && S.ws) {
      resetNotesAttempt(notesChange);
      loadWorkspace();
    } else if (d.status && d.status !== 'ready' && d.progress) opening({ status: d.status, text: d.progress, pr: d.pr }); // opened mid-fetch
    S.lost = false; S.boot = d.boot;
  });
  // A line from a change still opening. Once GitHub has said how big the pull request is (and its refs), every line
  // carries that, so the state box can draw it while the fetch runs (the change's record waits for the fetch).
  function opening(d) {
    if (S.ws && S.ws.status === 'ready') return;
    if (d.status === 'ready') { if (!d.text) loadWorkspace(); return; } // a line after it opened (its worktree) is not an opening line
    if (!d.text) return;
    if (d.pr) S.opening = { id: S.id, status: d.status, rec: { pr: d.pr } };
    showState(d.status === 'error' ? 'Could not open this' : 'Opening…', d.text, d.status === 'error');
  }
  on('progress', opening);
  on('changed', (d) => {
    if (!S.ws) return loadWorkspace();
    clearTimeout(changedT);
    clearTimeout(notesTimer);
    if (d.reason === 'files changed' && notesChange?.id === S.id) notesChange.quietAt = Date.now() + 20000;
    changedT = setTimeout(async () => {
      changedT = null;
      await loadWorkspace(d.reason === 'files changed' || d.reason === 'worktree ready' ? '' : `${d.reason[0].toUpperCase()}${d.reason.slice(1)}: the diff is updated`);
    }, 150);
  });
  on('settings', (st) => { S.app.settings = st; for (const f of S.files) updateCard(f.path); progress(); maybeAutoNotes(); });
  on('review', (d) => {
    const before = S.review.viewed, unviewed = S.review.unviewed;
    if (d.viewed) S.review.viewed = d.viewed;
    if (d.unviewed) S.review.unviewed = d.unviewed;
    if ('verdict' in d) { S.review.verdict = d.verdict; if (S.tab === 'overview') renderPanel(); } // your verdict, sent from another page too
    if (d.checks) { S.review.checks = d.checks; for (const b of $$('.gck')) { const on = !!d.checks[b.dataset.key]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } }
    const same = (a = [], b = []) => a.length === b.length && a.every((value, i) => value === b[i]);
    const files = S.files.filter(({ path }) => !same(before[path], S.review.viewed[path]) ||
      !same(unviewed?.[path], S.review.unviewed?.[path]));
    for (const f of files) updateCard(f.path);
    if (files.length || d.checks || 'verdict' in d) progress(files.length === 1 && !d.checks ? files[0].path : null);
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
    if (d.msg.model && d.msg.role !== 'user') { conv.modelKind = d.msg.role; conv.model = d.msg.model; conv.effort = d.msg.effort; }
    conv.busy = !!d.busy;
    const th = S.review.threads.find((t) => t.conv === d.conv);
    if (!document.querySelector(`[data-conv="${d.conv}"]`)) {
      if (S.tab === 'chat' && S.chat === d.conv) renderPanel();
    } else paintMessage(d.conv, d.msg);
    if (th) {
      if (!d.busy && d.msg.role !== 'user' && !d.msg.pending && S.mark !== th.id) { S.unreadAns.add(th.id); renderTree(); }
      updateMark(th); if (!d.busy && S.tab === 'review' && S.mark !== th.id) renderPanel();
    }
    renderTabs(); syncMote();
  });
  on('chat', (d) => {
    if (d.deleted) { delete S.review.convs[d.deleted]; S.review.chats = S.review.chats.filter((x) => x !== d.deleted); if (S.chat === d.deleted) S.chat = null; }
    else { S.review.convs[d.conv.id] = { ...d.conv, messages: mergeMsgs(S.review.convs[d.conv.id]?.messages, d.conv.messages) }; if (!S.review.chats.includes(d.conv.id)) S.review.chats.push(d.conv.id); }
    if (S.tab === 'chat' && !document.activeElement?.closest?.('#chatbox')) renderPanel(); else renderTabs();
    renderGo(); syncMote();
  });
  on('brief', (d) => {
    const was = S.review.brief;
    S.review.brief = d; // it carries what can be undone on it (brief.edits): one event, so the two never disagree
    guideEditsChanged(was?.edits, d.edits);
    // while it is being written, only the line that says what it is reading changes (unless a chat changed the guide meanwhile)
    const guideOf = (x) => JSON.stringify([x?.tldr, x?.sections, x?.diagrams, (x?.scenes || []).map((s) => [s.id, s.at, s.by]), x?.scene, x?.edits]);
    if (d.pending && was?.pending && guideOf(d) === guideOf(was)) { hooks.briefStep?.(); hooks.mapStep?.(); return; }
    syncMote(); if (S.ws) renderScopebar();
    if (S.tab === 'overview') renderPanel(); else renderTabs();
    if (S.order === 'guide') { renderTree(); renderCards(true); renderProgress(); } else hooks.mapChanged?.();
  });
  on('notes', (d) => {
    const before = S.review.notes;
    S.review.notes = d;
    if (!d.pending && d.error) resetNotesAttempt(notesChange);
    updateFileNotes(before);
    maybeAutoNotes();
  });
  on('github', async () => {
    const id = S.id, github = await api(`/api/w/${S.id}/github`).catch(() => null);
    if (id !== S.id || !github) return;
    S.github = github; hooks.githubChanged();
    if (S.ws) { $('#wsbtn').innerHTML = wsTitle(); loadStack(); }
  });
  on('page', () => location.reload());
}
let changedT = null;
let undoToast = null; // the chat edit the toast offers to undo
// a chat changed the guide: say so, with a way to take it back while it can be
function guideEditsChanged(before = [], edits = []) {
  const seen = new Set(before.map((e) => e.id));
  if (undoToast && !edits.some((e) => e.id === undoToast && e.undo)) { if ($('#toast')?.dataset.edit === undoToast) $('#toast').hidden = true; undoToast = null; }
  const fresh = edits.find((e) => !seen.has(e.id) && !e.undone);
  if (!fresh) return;
  const what = fresh.kind === 'tldr' ? 'the TLDR' : `the ${fresh.kind === 'scene' ? 'animation' : fresh.kind} \u201c${fresh.title}\u201d`;
  toast(`Chat ${{ add: 'added', replace: 'replaced', remove: 'removed' }[fresh.op]} ${what}.`, fresh.undo ? { action: 'Undo', run: () => undoEdit(fresh.id) } : {});
  const t = $('#toast'); if (t && fresh.undo) { t.dataset.edit = fresh.id; undoToast = fresh.id; }
}
// a chat's edit to the guide, taken back; the brief's scene, drawn again
function undoEdit(id) {
  return api(wsApi('/guide/undo'), { method: 'POST', body: { id } }).then((r) => toast(r.message)).catch((e) => toast(e.message, { fail: true })); // the brief comes back by its event
}
hooks.undoEdit = undoEdit;
hooks.redrawScene = () => api(wsApi('/scene'), { method: 'POST', body: {} }).catch((e) => toast(e.message, { fail: true }));
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
// with desk sounds on, a hidden tab keeps its stream while an answer or the guide is being written, so the bell for it can
// ring there; it lets go once nothing is
const writing = () => !!S.review?.brief?.pending || !!S.review?.brief?.scene?.pending || Object.values(S.review?.convs || {}).some((c) => c.messages?.some((m) => m.pending && m.role !== 'user'));
function sleep() {
  if (S.id && hooks.sound?.on() && writing()) { sleepT = setTimeout(sleep, 20000); return; }
  wsEs?.close(); homeEs?.close(); asleep = true; S.lost = true;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(sleepT); sleepT = setTimeout(sleep, 20000); return; }
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
  const setting = (k, on, label) => ({ group: 'VIEW', label, on, run: async () => { try { S.app.settings = await api('/api/settings', { method: 'POST', body: { [k]: !on } }); } catch (e) { return toast(e.message, { fail: true }); } for (const f of S.files) updateCard(f.path); progress(); toast(`${label}: ${on ? 'off' : 'on'}.`); } });
  const scopes = [
    ['all', isPr ? 'Whole pull request' : m.dirty ? 'Branch + uncommitted' : 'Whole branch'],
    ...(local ? [['branch', 'Committed only'], ...(m.dirty ? [['wip', `Uncommitted only (${plural(m.dirty, 'file')})`]] : [])] : []),
    ...(m.sinceCount ? [['since', `Since you last looked (${plural(m.sinceCount, 'commit')})`]] : []),
    ...(m.trunkMergeBase ? [['stack', `Whole stack, from ${m.trunk || 'the trunk'}`]] : []),
  ].filter(([k]) => k !== S.rangeKey);
  const ghUrl = $('#ghlink')?.hidden === false ? $('#ghlink').href : null;
  const c = [
    ...next,
    { group: 'READ', label: 'Search the repository', key: 'f', run: openRepositorySearch },
    { group: 'READ', label: 'Mark viewed, go to the next file', key: ']', run: () => nextLeft() },
    cur && { group: 'READ', label: `${isViewed(cur) ? 'Unmark' : 'Mark'} ${name} viewed`, key: 'v', run: () => setViewed(S.current, !isViewed(cur)) },
    { group: 'READ', label: 'Next file', key: 'j', run: () => stepFile(1) },
    { group: 'READ', label: 'Previous file', key: 'k', run: () => stepFile(-1) },
    cur && { group: 'READ', label: `${S.shut.has(S.current) ? 'Unfold' : 'Fold'} ${name}`, key: 'o', run: () => toggleFold(S.current) },
    { group: 'READ', label: 'Fold the viewed files', run: () => { for (const f of S.files) if (isViewed(f) || f.kind === 'generated') toggleFold(f.path, true); } },
    { group: 'READ', label: 'Unfold all files', run: () => { for (const f of S.files) if (S.shut.has(f.path)) toggleFold(f.path, false); } },
    S.review.brief?.sections?.length && { group: 'READ', label: S.order === 'guide' ? 'Tree order' : 'Guide order', key: 'g', run: () => setOrder(S.order === 'guide' ? 'tree' : 'guide') },
    { group: 'READ', label: S.layout === 'split' ? 'Unified diff' : 'Split diff', key: 's', run: () => setLayout(S.layout === 'split' ? 'unified' : 'split') },
    ...scopes.map(([k, label]) => ({ group: 'COMPARE', label, run: () => setScope(k) })),
    local && { group: 'COMPARE', label: 'Compare with another base', sub: m.base, run: () => { const b = $('[data-act="scopemenu"]'); if (b) baseMenu(b); } },
    ...m.commits.filter((x) => x.sha !== S.rangeKey).map((x) => ({ group: 'COMPARE', label: `Commit ${x.short.slice(0, 7)} ${x.subject}`, sub: ago(x.at), typed: true, run: () => setScope(x.sha) })),
    { group: 'REVIEW', label: 'Ask about the whole change', key: 'a', run: () => { setPane('panel', true); openChat(); } },
    { group: 'REVIEW', label: S.review.brief?.tldr ? 'Regenerate the guide and map' : 'Write the guide and map', run: () => { setPane('panel', true); setTab('overview'); hooks.rebrief?.(); } },
    { group: 'REVIEW', label: 'File notes model…', sub: runLabel(notesRun()), run: () => pickRun($('#wsbtn'), { purpose: 'notes', run: notesRun() }) },
    { group: 'REVIEW', label: 'Write the file notes again', run: () => writeNotes({ again: true }) },
    { group: 'REVIEW', label: 'New chat', run: () => hooks.newChat?.() },
    { group: 'REVIEW', label: 'Link a Claude Code session…', run: () => hooks.linkSession?.() },
    { group: 'VIEW', label: 'Overview tab', key: '1', run: panel('overview') },
    { group: 'VIEW', label: 'Chat tab', key: '2', run: panel('chat') },
    { group: 'VIEW', label: 'Marks tab', key: '3', run: panel('review') },
    isPr && pr && (!(pr.viewerIsAuthor || pr.viewerIsAssignee) || S.github?.pending?.comments?.length) && { group: 'REVIEW', label: 'Submit your review…', run: () => hooks.openSheet?.('review') },
    isPr && pr && { group: 'REVIEW', label: `Comment on #${pr.number}`, run: () => hooks.focusComment?.() },
    (pr?.checks?.length || S.github?.checks?.length) && { group: 'REVIEW', label: 'Show the checks', run: () => hooks.showChecks?.() },
    local && { group: 'SHIP', label: 'Commit…', run: () => hooks.openSheet?.('commit') },
    local && { group: 'SHIP', label: 'Push…', run: () => hooks.openSheet?.('push') },
    local && !S.ws.pr && { group: 'SHIP', label: 'Open a pull request…', run: () => hooks.openSheet?.('openpr') },
    m.trunkMergeBase && { group: 'STACK', label: S.rangeKey === 'stack' ? 'Just this change' : 'The whole stack, from the trunk', run: () => setScope(S.rangeKey === 'stack' ? 'all' : 'stack') },
    ...(S.stack?.items || []).filter((i) => !i.here).map((i) => ({ group: 'STACK', label: `${i.pr ? `#${i.pr} ` : ''}${i.branch}`, sub: i.checkout ? 'checkout' : 'PR', run: () => openStackItem(S.stack.items.indexOf(i)) })),
    ...[['panes', 'Layout: three panes'], ['guide', 'Layout: guide']].filter(([x]) => x !== S.mode).map(([x, label]) => ({ group: 'VIEW', label, run: () => applyMode(x) })),
    { group: 'VIEW', label: S.marksHidden ? 'Show the marks in the code' : 'Hide the marks in the code', key: 'm', run: () => setMarksHidden(!S.marksHidden) },
    hooks.mote?.isAway && { group: 'VIEW', label: hooks.mote.isAway() ? 'Show Mote' : 'Hide Mote', sub: hooks.mote.isAway() ? 'he flies back in' : 'the beetle in the corner flies off', also: 'pet sprite beetle bug mascot helper', run: () => hooks.mote.away(!hooks.mote.isAway()) },
    { group: 'VIEW', label: hooks.sound?.on() ? 'Turn desk sounds off' : 'Turn desk sounds on', sub: 'a tick per file viewed, a stamp, a typebar', run: () => hooks.sound?.set(!hooks.sound.on()) },
    { group: 'VIEW', label: paneOpen('bin') ? 'Hide the files' : 'Show the files', key: 't', run: () => setPane('bin', !paneOpen('bin')) },
    { group: 'VIEW', label: paneOpen('panel') ? 'Hide the inspector' : 'Show the inspector', key: 'p', run: () => setPane('panel', !paneOpen('panel')) },
    ...['system', 'light', 'dark'].filter((t) => t !== pref.get('theme', 'system')).map((t) => ({ group: 'VIEW', label: `Theme: ${t}`, run: (origin) => { pref.set('theme', t); applyTheme(t, origin); } })),
    setting('autoView', !!S.app.settings?.autoView, 'Count tests and generated files as viewed'),
    setting('autoBrief', !!S.app.settings?.autoBrief, 'Write the brief when a PR opens'),
    ghUrl && { group: 'GO', label: 'Open on GitHub', run: () => open(ghUrl, '_blank', 'noopener') },
    { group: 'GO', label: "Copy this page's link", run: () => navigator.clipboard.writeText(location.href).then(() => toast('Link copied.'), () => toast('Could not copy.', { fail: true })) },
    { group: 'GO', label: 'Read the change again', key: 'r', run: () => $('[data-act="refresh"]')?.click() },
    { group: 'GO', label: 'Home', run: () => { location.href = '/home'; } },
    { group: 'GO', label: 'Keys', key: '?', run: keySheet },
    { group: 'GO', label: 'Close this change here…', sub: 'its marks stay for next time', typed: true, run: () => hooks.openSheet?.('close') },
    ...S.files.map((f) => ({ group: 'FILES', label: f.path, f, typed: true, file: true, run: () => goLoc({ path: f.path, line: 0 }) })),
  ];
  return c.filter(Boolean);
}

// The palette draws this many rows and says how many more there are, so a change of 300 files stays instant.
const PAL_ROWS = 60;
// With nothing typed the groups come in the order of the work: what is next, the other changes open here, then reading,
// comparing, reviewing, shipping, the view, and leaving.
const PAL_CHANGES = 6;
const PAL_GROUPS = ['NEXT', 'CHANGES', 'READ', 'COMPARE', 'REVIEW', 'SHIP', 'STACK', 'VIEW', 'GO', 'FILES'];
let palClose = null, keysClose = null;
// Every row is the file list's row: a 14 px glyph column, the label, and a trailing column of quiet figures (a key, a
// count, the viewed check). Commands leave the glyph column empty so every label starts on one edge.
const palGlyph = (x = '') => `<span class="g">${x}</span>`;
const palTrail = (x = '') => `<span class="tr">${x}</span>`;
const fileLeft = (f) => (isViewed(f) ? icon('check', '--ok') : f.kind === 'generated' ? 'gen' : lines(f).toLocaleString());

// The palette is the title opened, the way a browser's address bar opens: flush to the top of the window, its field on
// the top bar's own row with the typed text where the title's text was, and the rows' glyphs in a column under the
// title's icon. The field, the rows and the heads share one inset in the style sheet, so placing the box is one number,
// measured rather than assumed. Home has no title, and a narrow window has no room beside it: there it stands centred.
function palOpen(label, glyph, placeholder, foot) {
  const scrim = h(`<div class="scrim" role="dialog" aria-label="${esc(label)}"><div class="palette"><div class="pfield">${glyph}<input placeholder="${esc(placeholder)}" aria-label="${esc(label)}" autocomplete="off" spellcheck="false"></div><div class="list"></div>${foot ? `<div class="foot">${foot}</div>` : ''}</div></div>`);
  document.body.append(scrim);
  const box = $('.palette', scrim);
  const place = () => {
    const ic = $('#wsbtn svg'), bar = $('.top');
    const on = !!(ic && bar && ic.getBoundingClientRect().width && innerWidth >= 760);
    scrim.classList.toggle('anchored', on);
    box.style.left = box.style.width = '';
    if (!on) return;
    const w = Math.min(560, innerWidth - 16);
    scrim.style.setProperty('--bar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
    box.style.width = `${w}px`;
    box.style.left = '0px';
    const inset = $('.pfield > svg', scrim).getBoundingClientRect().left - box.getBoundingClientRect().left;
    box.style.left = `${Math.max(8, Math.min(Math.round(ic.getBoundingClientRect().left - inset), innerWidth - 8 - w))}px`;
  };
  place();
  addEventListener('resize', place);
  return { scrim, input: $('input', scrim), list: $('.list', scrim), done: () => { removeEventListener('resize', place); scrim.remove(); } };
}

function openRepositorySearch(snapshot = {}) {
  palClose?.();
  keysClose?.();
  closeMenu();
  const { scrim, input, list, done } = palOpen('Search the repository', I.search, 'Search the repository', '<span class="revision"></span>');
  input.maxLength = 160;
  const scope = S.scope;
  let selected = snapshot.selected ?? 0, result, timer, request;
  const close = () => { clearTimeout(timer); request?.abort(); done(); palClose = null; };
  palClose = close;
  const pick = () => {
    list.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
    const row = list.children[selected];
    row?.setAttribute('aria-selected', 'true');
    row?.scrollIntoView({ block: 'nearest' });
  };
  const draw = (r) => {
    result = r;
    const rev = $('.revision', scrim);
    rev.title = r.revision;
    rev.textContent = r.revision === 'Working tree' ? 'In the working tree' : `At ${r.revision.slice(0, 12)}`;
    // a hit in a file this change touches carries the file list's letter, so the change's own lines stand out
    const changed = new Map(S.files.map((f) => [f.path, f]));
    list.innerHTML = r.matches.map((m, i) => `<button class="mi repo-hit" data-i="${i}" aria-selected="false">${palGlyph(changed.has(m.path) ? statusGlyph(changed.get(m.path)) : '')}<span class="mono where" title="${esc(m.path)}:${m.line}">${esc(m.path)}:${m.line}</span><span class="mono excerpt" title="${esc(m.excerpt)}">${esc(m.excerpt)}</span></button>`).join('')
      + (r.more ? '<div class="more">The first 60 matches. Keep typing to narrow them.</div>' : '');
    if (!r.matches.length) list.innerHTML = `<div class="none">${input.value.trim() ? 'No matches.' : 'Type text to find in the source.'}</div>`;
    if (r.matches.length) { selected = Math.min(selected, r.matches.length - 1); pick(); }
  };
  const search = () => {
    result = null;
    clearTimeout(timer);
    request?.abort();
    list.innerHTML = '<div class="none">Searching…</div>';
    timer = setTimeout(async () => {
      const controller = request = new AbortController();
      try {
        const r = await api(wsApi('/search', { q: input.value.trim() }), { signal: controller.signal });
        if (!controller.signal.aborted && scope === S.scope) draw(r);
      } catch (e) {
        if (!controller.signal.aborted) list.innerHTML = `<div class="none err">${esc(e.message)}</div>`;
      }
    }, 150);
  };
  const open = (i) => {
    const match = result?.matches[i];
    if (!match) return;
    const back = { query: input.value, result, selected: i, scroll: list.scrollTop };
    close();
    return goLoc({ ...match, exact: true }, null, () => openRepositorySearch(back));
  };
  input.value = snapshot.query || '';
  input.addEventListener('input', () => { selected = 0; search(); });
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); open(selected); }
    else if (result?.matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      selected = Math.max(0, Math.min(result.matches.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
      pick();
    }
  });
  list.onclick = (e) => { const row = e.target.closest('.mi'); if (row) open(Number(row.dataset.i)); };
  scrim.onmousedown = (e) => { if (e.target === scrim) close(); };
  if (snapshot.result) { draw(snapshot.result); list.scrollTop = snapshot.scroll; } else search();
  input.focus();
}
function openPalette() {
  if (palClose) return palClose();
  keysClose?.();
  closeMenu();
  // Drawn at once from what the page already has; the daemon's own list replaces the workspace rows when it arrives.
  let st = S.app || { workspaces: [], display: location.origin };
  // The field keeps the title's icon in the title's place: this is that change's title, opened.
  const here = S.ws ? (S.ws.kind === 'pr' ? I.pr : I.branch) : I.search;
  const { scrim, input, list, done } = palOpen('Open or do', here, 'Find a file, a change or something to do', 'Paste a PR link, owner/repo#123 or a path to open it.');
  let cur = 0, shown = [];
  // Lower-cased once per open, not per keystroke; a file also keeps its own name apart from its folders.
  // a command can answer to other words for what it is (`also`: Mote is a pet, a sprite, a beetle)
  const cmds = commands().map((c) => { const lab = c.label.toLowerCase(); return { ...c, lab, hay: `${lab} ${c.group.toLowerCase()} ${c.also || ''}`, base: c.file ? lab.slice(lab.lastIndexOf('/') + 1) : '' }; });
  // How well something matches what was typed. A file's own name outranks a command that only mentions it ("Fold
  // cards.js" for "cards"); a command that begins with what you typed still beats a file that merely contains it.
  const score = (c, q) => {
    if (!c.file) return c.lab.startsWith(q) ? 75 : c.lab.includes(q) ? 45 : c.also?.split(' ').some((w) => w.startsWith(q)) ? 60 : 40;
    if (c.base === q || c.base.replace(/\.[^.]*$/, '') === q) return 100; // the name, with or without its extension
    if (c.lab.endsWith('/' + q)) return 95; // the end of its path
    return c.base.startsWith(q) ? 80 : c.base.includes(q) ? 70 : 50;
  };
  const openRow = (t, i) => `<button class="mi" data-i="${i}" aria-selected="${i === cur}">${palGlyph(I.plus)}<span class="ml" title="${esc(t)}">Open “${esc(t)}”</span>${palTrail()}</button>`;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    // the change you are on is the title itself, so it is not offered as somewhere to go
    const ws = st.workspaces.filter((w) => w.id !== S.id && (!q || `${w.title} ${w.repo} ${w.slug} ${w.number || ''}`.toLowerCase().includes(q))).map((w) => ({ ws: w, group: 'CHANGES', s: q && [w.title, w.repo, w.slug].some((t) => String(t || '').toLowerCase().startsWith(q)) ? 75 : 45 }));
    const words = q.split(/\s+/).filter(Boolean);
    const cs = cmds.filter((c) => (q ? words.every((w) => c.hay.includes(w)) : !c.typed)).map((c) => ({ cmd: c, group: c.group, s: q ? score(c, q) : 0 }));
    // Typed: each group stays whole under its own heading, the group holding the best match first, and the best match first
    // within it. Nothing typed: the groups in the order of the work. At most PAL_ROWS rows are drawn (the arrow keys walk
    // only those); a group that matches hundreds of files leaves a few rows to each group after it, so the commands that
    // match are never the rows that get cut.
    let total, rows, moreChanges = 0;
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
    } else {
      const rank = (x) => { const i = PAL_GROUPS.indexOf(x.group); return i < 0 ? PAL_GROUPS.length : i; };
      // with nothing typed, the most recent few changes stand for the rest, so the commands are still in the first view
      // (on home the changes are all there is, so they are all shown)
      const few = S.ws ? ws.slice(0, PAL_CHANGES) : ws;
      moreChanges = ws.length - few.length;
      rows = [...cs, ...few].map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([x]) => x);
      total = rows.length;
    }
    shown = rows.slice(0, PAL_ROWS);
    const more = total - shown.length;
    if (q && /\/|#\d|^\d+$|^~/.test(input.value.trim())) { if (cs.length) shown.push({ target: input.value.trim() }); else shown.unshift({ target: input.value.trim() }); }
    cur = Math.min(cur, Math.max(0, shown.length - 1));
    let last = null;
    list.innerHTML = shown.map((x, i) => {
      const rest = last === 'CHANGES' && x.group !== 'CHANGES' && moreChanges ? `<div class="gmore">and ${moreChanges.toLocaleString()} more: type to find them</div>` : '';
      const head = rest + (x.group && x.group !== last ? `<div class="sh">${x.group}</div>` : '');
      last = x.group || last;
      if (x.target) return openRow(x.target, i);
      const c = x.cmd, sel = `data-i="${i}" aria-selected="${i === cur}"`;
      if (c?.file) { const k = c.label.lastIndexOf('/'); return head + `<button class="mi" ${sel}>${palGlyph(statusGlyph(c.f))}<span class="fp ml" title="${esc(c.label)}"><span class="d">${esc(c.label.slice(0, k + 1))}</span><span class="n">${esc(c.label.slice(k + 1))}</span></span>${palTrail(fileLeft(c.f))}</button>`; }
      if (c) return head + `<button class="mi" ${sel}>${palGlyph()}<span class="ml" title="${esc(c.label)}">${esc(c.label)}</span>${palTrail(c.key ? `<kbd>${esc(c.key)}</kbd>` : c.on ? I.check : c.sub ? esc(c.sub) : '')}</button>`;
      const w = x.ws, left = w.left ? (w.left.lines ? w.left.lines.toLocaleString() : icon('check', '--ok')) : '';
      const repo = w.repo && w.repo !== w.title ? `<span class="rp">${esc(w.repo)}</span>` : '';
      return head + `<button class="mi" ${sel}>${palGlyph(w.kind === 'pr' ? I.pr : I.branch)}<span class="ml" title="${esc(w.title)}${w.repo ? ` · ${esc(w.repo)}` : ''}">${w.kind === 'pr' && !w.title.endsWith(`#${w.number}`) ? `#${w.number} ` : ''}${esc(w.title)}${repo}</span>${palTrail(left)}</button>`;
    }).join('') || `<div class="none">${q ? `Nothing matches “${esc(input.value.trim())}”.` : 'Nothing to show.'}</div>`;
    if (more > 0) list.insertAdjacentHTML('beforeend', `<div class="more">and ${more.toLocaleString()} more: keep typing to narrow them</div>`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { done(); palClose = null; };
  palClose = close;
  api('/api/state').then((fresh) => { if (palClose === close) { st = fresh; draw(); } }, () => { /* the page's own list stands */ });
  const go = async (i) => {
    const x = shown[i];
    if (x?.ws) { close(); location.href = x.ws.url; return; }
    if (x?.cmd) {
      const origin = themeOrigin(list.querySelector(`[data-i="${i}"]`));
      close(); return x.cmd.run(origin);
    }
    const target = x?.target; if (!target) return;
    input.disabled = true;
    try { const r = await api('/api/workspaces', { method: 'POST', body: { target, cwd: S.ws?.root || undefined } }); close(); location.href = r.url; }
    catch (e) { input.disabled = false; list.insertAdjacentHTML('afterbegin', `<div class="err">${esc(e.message)}</div>`); }
  };
  input.addEventListener('input', () => { cur = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(shown.length - 1, cur + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown.length) go(cur); }
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
      `${stageCell(stage, tone, w)}${size(p)}<span class="hc age">${esc(ago(Date.parse(p.updatedAt)))}</span></a><button class="icon hm" data-hm aria-label="More">${I.more}</button></div>`;
  };
  const wsRow = (w) => `<div class="hrow" data-ws="${esc(w.id)}"><a class="hl" href="${esc(w.url)}">` +
    `<span class="hc who">${w.kind === 'pr' && w.author ? avatar(w.author) : w.kind === 'pr' ? I.pr : I.branch}</span><span class="hc ti"><b title="${esc(w.title)}">${w.kind === 'pr' && !w.title.endsWith(`#${w.number}`) ? `<span class="no">#${w.number}</span> ` : ''}${esc(w.title)}</b><small>${esc(w.kind === 'pr' ? short(w.repo) : w.repo === w.title ? (w.root || w.repo).split('/').slice(-2).join('/') : w.repo)}${w.kind === 'pr' && w.author ? ` · ${esc(w.author)}` : ''}${w.session ? ` · <span class="sess" title="${esc(w.session.live ? 'A live Claude Code session' : 'The Claude Code session working on it')}: ${esc(w.session.title)}">${spark(12, !w.session.live)}${esc(w.session.title)}</span>` : ''}</small></span>` +
    `${stageCell(w.dirty ? plural(w.dirty, 'uncommitted file') : w.kind === 'pr' ? '' : 'Checkout', w.dirty ? 'warn' : 'quiet', w)}<span class="hc sz"></span><span class="hc age">${w.openedAt ? esc(ago(w.openedAt)) : ''}</span></a><button class="icon hm" data-hm aria-label="More">${I.more}</button></div>`;
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
  const section = (id, title, n, rows, empty) => `<section class="hsect" id="${id}"><h2 class="sh">${title}${n ? `<span class="n">${n}</span>` : ''}</h2>${rows ? `<div class="hlist">${rows}</div>` : `<div class="hempty">${empty}</div>`}</section>`;
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
      <form class="openbox" id="go"><input class="field lg" name="t" placeholder="Paste a PR link, owner/repo#123, or a local path" autocomplete="off" autofocus><button class="btn primary">Open</button></form>
      ${error ? `<div class="lost">${moteHTML('failed')}<div><b>Nothing under the loupe.</b><div class="faint">${esc(sentence(error))}</div></div></div>` : ''}
      ${ib?.error ? `<div class="err">${esc(ib.error)}</div>` : ''}
      ${section('h-review', 'Review', review.length, ib ? stacked(review) : '', ib ? `<span class="calm">${moteHTML('idle')}<span>Nothing is waiting on your review.</span></span>` : '<span class="calm">Asking GitHub…</span>')}
      ${section('h-yours', 'Yours', yours.length, ib ? stacked(yours) : '', ib ? '<span class="calm">No open pull requests of yours.</span>' : '<span class="calm">Asking GitHub…</span>')}
      ${section('h-open', 'Open here', open.length, open.map(wsRow).join(''), '<span class="calm">Nothing else open. Paste a pull request above, or run <code>loupe</code> in a repository.</span>')}
      <footer class="homefoot">${counts || hidden.size ? `<p>${counts}${hidden.size ? `${counts ? ' · ' : ''}Hiding ${[...hidden].map((o) => `<button class="link unhide" data-unhide="${esc(o)}" title="Show ${esc(o)}'s pull requests again">${esc(o)} ×</button>`).join(' ')}${hiddenN ? ` (${hiddenN})` : ''}` : ''}</p>` : ''}
      <p>Swap <code>github.com</code> for <code>${host}</code> in a pull request link to open it here. <code>loupe</code> in a repository opens its branch and uncommitted work. <span class="nobr"><kbd>j</kbd> <kbd>k</kbd> move, <kbd>↵</kbd> opens.</span></p></footer>
    </div></div>`;
  };
  const paint = (ib) => {
    const v = $('#go')?.t?.value || '', focused = document.activeElement?.closest?.('.hrow')?.querySelector('.hl')?.getAttribute('href');
    $('#root').innerHTML = draw(ib);
    $('.home')?.style.setProperty('--drift-at', `-${Math.round(performance.now() % 80000)}ms`); // the drift goes there and back in 80 s
    wakeMotes();
    if (v) $('#go').t.value = v;
    if (focused) $(`.hl[href="${CSS.escape(focused)}"]`)?.focus();
    $('#go').addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = e.target.t.value.trim(); if (!t) return;
      try { const r = await api('/api/workspaces', { method: 'POST', body: { target: t } }); location.href = r.url; } catch (err) { renderHome(err.message); }
    });
  };
  const setHidden = async (list) => {
    try { S.app.settings = await api('/api/settings', { method: 'POST', body: { hiddenOrgs: list } }); } catch (e) { return toast(e.message, { fail: true }); }
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
      ...(ws ? [{ sep: true }, { label: 'Close it here', sub: 'its marks stay for next time', value: 'close', confirm: ws.startsWith('pr-') ? "Close it? loupe's checkout of it goes" : 'Close it? Its marks stay' }] : []),
    ], async (it) => {
      if (it.value === 'gh') open(gh, '_blank', 'noopener');
      if (it.value === 'hide') setHidden([...hidden, owner.toLowerCase()]);
      if (it.value === 'close') { await api(`/api/w/${ws}`, { method: 'DELETE' }).catch((err) => toast(err.message, { fail: true })); renderHome(); }
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

// Every key on one sheet that needs no scrolling: the groups on a grid, each row a key and a few words. The palette (⌘K)
// holds the rest, so the sheet says so.
function keySheet() {
  const k = (keys, what) => `<div class="kr"><span class="k">${keys.map((x) => `<kbd>${x}</kbd>`).join('')}</span><span class="w">${what}</span></div>`;
  // a mouse action is not a key: the modifier is a key, the click or hover is a word
  const m = (mods, action, what) => `<div class="kr"><span class="k">${mods.map((x) => `<kbd>${x}</kbd>`).join('')}<span class="mouse">${action}</span></span><span class="w">${what}</span></div>`;
  const g = (title, rows) => `<section class="kg"><h3 class="sh">${title}</h3>${rows.join('')}</section>`;
  const scrim = h(`<div class="scrim"><div class="palette keysheet" role="dialog" aria-label="Keys"><div class="keys">
    ${g('MOVING', [k(['j'], 'next file'), k(['k'], 'previous file'), k([']'], 'viewed, then the next file left'), k(['['], 'back: undo ], or a jump'), k(['/'], 'find a file'), k(['f'], 'search the repository'), k(['⌘', 'K'], 'do anything')])}
    ${g('REVIEWING', [k(['v'], 'viewed, or not'), k(['o'], 'fold or unfold'), k(['s'], 'split or unified'), k(['g'], 'guide or tree order'), k(['m'], 'hide or show the marks'), k(['r'], 'read the change again')])}
    ${g('ON SELECTED LINES', [k(['a'], 'ask there'), k(['c'], 'comment for your review'), k(['l'], 'add them to the chat'), k(['↵'], 'send the question'), k(['⇧', '↵'], 'new line'), k(['⌘', '↵'], 'add the review comment'), k(['esc'], 'cancel')])}
    ${g('PANELS', [k(['1'], 'overview'), k(['2'], 'chat'), k(['3'], 'marks'), k(['t'], 'files'), k(['p'], 'inspector'), k(['?'], 'these keys')])}
    ${g('POINTER', [m([], 'hover', 'Go docs'), m(['⌘'], 'click', 'definition'), m(['⇧', '⌘'], 'click', 'references'), k(['⌥'], 'hold over code: the loupe')])}
  </div><div class="foot"><span><kbd>esc</kbd> close</span><span class="sp"></span><span>everything else is in <kbd>⌘</kbd><kbd>K</kbd></span></div></div></div>`);
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
  try { r = await api(`/api/w/${S.id}/refs`); } catch (e) { return toast(e.message, { fail: true }); }
  const items = [{ header: 'COMPARE WITH' }, { label: 'The remote\'s default branch', sub: 'origin/HEAD', value: '' },
    { sep: true }, ...r.refs.map((x) => ({ label: x.name, sub: ago(x.at), value: x.name, current: x.name === r.base }))];
  menu(btn, items, async (it) => {
    try { await api(`/api/w/${S.id}/base`, { method: 'POST', body: { base: it.value } }); } catch (e) { toast(e.message, { fail: true }); }
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
  if (b && b.closest('.top, #scopebar, .tree-head, .ptabs, .state')) { // the scope bar and order switch sit in the file list's head
    const act = b.dataset.act;
    if (act === 'palette') openPalette();
    if (act === 'layout') setLayout(b.dataset.l);
    if (act === 'refresh') { b.disabled = true; try { await api(`/api/w/${S.id}/refresh`, { method: 'POST' }); await loadWorkspace('Read again'); await loadStack(true); } catch (err) { toast(err.message, { fail: true }); } b.disabled = false; }
    if (act === 'theme') {
      const cur = pref.get('theme', 'system'), st = S.app.settings || {};
      // choices (layout, theme, diff) and settings (on or off) each show their state as one check in one column;
      // a key that switches a group sits on the group's header, a key that flips a setting on its row
      menu(b, [{ header: 'LAYOUT' }, { label: 'Three panes', value: { mode: 'panes' }, current: S.mode === 'panes' }, { label: 'Guide', value: { mode: 'guide' }, current: S.mode === 'guide' },
        { sep: true }, { header: 'THEME' }, { label: 'System', value: { theme: 'system' }, current: cur === 'system' }, { label: 'Light', value: { theme: 'light' }, current: cur === 'light' }, { label: 'Dark', value: { theme: 'dark' }, current: cur === 'dark' },
        { sep: true }, { header: 'DIFF', key: 's' }, { label: 'Split', value: { layout: 'split' }, current: S.layout === 'split' }, { label: 'Unified', value: { layout: 'unified' }, current: S.layout === 'unified' },
        { sep: true }, { header: 'SHOW' }, { label: 'Marks in the code', key: 'm', value: { marks: true }, on: !S.marksHidden },
        ...(hooks.mote?.isAway ? [{ label: 'Mote', sub: 'the beetle in the corner', value: { mote: true }, on: !hooks.mote.isAway() }] : []),
        { sep: true }, { header: 'REVIEW' },
        { label: 'Count tests and generated files as viewed', value: { autoView: !st.autoView }, on: !!st.autoView },
        { label: 'Write the brief when a PR opens', value: { autoBrief: !st.autoBrief }, on: !!st.autoBrief },
        { label: 'Write file notes when a change opens', value: { autoNotes: st.autoNotes === false }, on: st.autoNotes !== false }], async (it) => {
        if (it.value.theme) { pref.set('theme', it.value.theme); applyTheme(it.value.theme, themeOrigin(b)); return; }
        if (it.value.layout) return setLayout(it.value.layout);
        if (it.value.mode) return applyMode(it.value.mode);
        if (it.value.marks) return setMarksHidden(!S.marksHidden);
        if (it.value.mote) return hooks.mote.away(!hooks.mote.isAway());
        try { S.app.settings = await api('/api/settings', { method: 'POST', body: it.value }); } catch (err) { return toast(err.message, { fail: true }); }
        for (const f of S.files) updateCard(f.path);
        progress();
        maybeAutoNotes();
      }, { align: 'right', width: 340 });
    }
    if (act === 'togglebin') setPane('bin', !paneOpen('bin'));
    if (act === 'togglepanel') setPane('panel', !paneOpen('panel'));
    if (act === 'keys') keySheet();
    if (act === 'scopemenu') scopeMenu(b);
    if (act === 'setorder') setOrder(b.dataset.o);
    if (act === 'scope') setScope(b.dataset.scope);
    if (act === 'gochat') { setPane('panel', true); S.chat = b.dataset.conv; setTab('chat'); }
    if (act === 'retry') { await api(`/api/w/${S.id}/refresh`, { method: 'POST' }).catch(() => {}); loadWorkspace(); }
    return;
  }
  const tab = e.target.closest?.('.ptabs .tab');
  if (tab) return setTab(tab.dataset.tab);
  const gs = e.target.closest?.('#tlist [data-act="gosec"]');
  if (gs) { const g = document.getElementById('g-' + gs.dataset.k); const first = S.review.brief?.sections?.[Number(gs.dataset.k)]?.files?.[0]; return first ? goLoc({ path: first, line: 0 }) : g?.scrollIntoView({ block: 'start' }); }
  const wb = e.target.closest?.('#tlist [data-act="writebrief"]');
  if (wb) { setPane('panel', true); setTab('overview'); return hooks.rebrief?.({ button: wb }); }
  if (e.target.closest?.('#tlist [data-act="clearfilter"]')) { hooks.clearFilter(); $('#filter').focus(); return; }
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
  if (key === '[') goBack();
  else if (key === 'f') openRepositorySearch();
  else if (key === 'j') stepFile(1);
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
