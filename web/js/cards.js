// The diff column: every changed file as a card in one scroll (tree order, or the guide's), loaded as it nears the
// viewport. Selecting lines, the composer under them, and the threads anchored to them live here.
import { S, $, $$, esc, tick, h, api, wsApi, I, pref, toast, fileOf, convOf, threadsAt, lastRun, rememberRun, plural, ago, reducedMotion } from './core.js';
import { buildRows, buildSplit, wordRanges, rowPlans, findRow, findLine, revealAround, expandGap, loadTokens, tokHTML, headText, rangeLabel, selText } from './diff.js';
import { md } from './md.js';
import { modelKind, msgHTML, runBtn, runOf, grow, menu, shimmerSync } from './ui.js';
import { hooks } from './hooks.js';
import { mapCardHTML, chatMark } from './map.js';
import { sceneSlot, mountScenes, parkScenes } from './scene.js';
import { spark, icon } from './pixel.js';
import { eligibleForNotes, fileNoteKey } from './file-notes.js';
import { checkId } from './check-id.js';

// the glyph of a question: Claude's spark, or a plain bubble for Codex (the spark and orange are Claude's alone)
const askGlyph = (r) => (modelKind(r?.model) === 'codex' ? I.codex : spark(16, true));

export const cardEl = (p) => document.getElementById('f-' + (fileOf(p)?.i ?? 'x'));
const isGo = (p) => p.endsWith('.go');
// Viewed is keyed to this diff of the file (old content to new); marks made before 20 Nov 11:00 were keyed to
// the new content alone and still count until the file changes.
export const viewKey = (f) => `${f.oldBlob || '0'}..${f.blob || 'gone'}`;
const legacyKey = (f) => f.blob || `gone:${f.oldBlob}`;
// Tests and generated files count as viewed until you untick one (the daemon's autoView setting).
export const autoViewed = (f) => !!S.app?.settings?.autoView && (f.kind === 'test' || f.kind === 'generated');
// viewed only because tests and generated files count as viewed (you never ticked it)
export const countedOnly = (f) => autoViewed(f) && isViewed(f) && !(S.review.viewed[f.path] || []).some((k) => k === viewKey(f) || k === legacyKey(f));
export const isViewed = (f) => { const v = S.review.viewed[f.path] || []; return v.includes(viewKey(f)) || v.includes(legacyKey(f)) || (autoViewed(f) && !(S.review.unviewed?.[f.path] || []).includes(viewKey(f))); };
export const isStale = (f) => !!S.review.viewed[f.path]?.length && !isViewed(f);
export const lines = (f) => f.added + f.deleted;

// ------------------------------------------------------------------ order: the tree's, or the guide's sections
export function orderedFiles() {
  const g = S.review.brief?.sections;
  if (S.order === 'guide' && g?.length) {
    const out = [];
    g.forEach((sec, k) => sec.files.forEach((p, j) => { const f = fileOf(p); if (f) out.push({ f, sec: j === 0 ? k : null }); }));
    const seen = new Set(out.map((x) => x.f.path));
    for (const f of S.files) if (!seen.has(f.path)) out.push({ f, sec: null });
    return out;
  }
  return S.files.map((f) => ({ f, sec: null }));
}

const STATUS = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type changed' };
export function statusGlyph(f) { const s = f.untracked ? 'A' : f.status; return `<span class="st ${s}" title="${STATUS[s] || s}${f.untracked ? ', untracked' : ''}">${s}</span>`; }

function fileNoteHTML(f) {
  const notes = S.review.notes;
  const entry = notes?.files?.[f.path];
  if (!entry?.note || !eligibleForNotes(f)) return '';
  const stale = entry.key !== fileNoteKey(f);
  if (stale && notes.pending && !notes.error) return '';
  return tick(entry.note) + (stale ? ' <span class="file-note-stale">Written for an earlier version.</span>' : '');
}

export function updateFileNotes(before) {
  for (const f of S.files) {
    const card = cardEl(f.path);
    const note = card?.querySelector('.file-note');
    if (!note) continue;
    const html = fileNoteHTML(f);
    if (note.innerHTML !== html) note.innerHTML = html;
    const saved = S.review.notes?.files?.[f.path], was = before?.files?.[f.path];
    const landed = saved?.key === fileNoteKey(f) && (saved.key !== was?.key || saved.note !== was?.note);
    if (landed && html && !S.shut.has(f.path) && !reducedMotion()) {
      note.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
    }
  }
}

function cardHTML(f) {
  const k = f.path.lastIndexOf('/');
  const tags = [f.untracked ? '<span class="pill warn">untracked</span>' : f.status === 'A' ? '<span class="pill">new</span>' : '', f.status === 'D' ? '<span class="pill">deleted</span>' : '',
    f.kind === 'generated' ? '<span class="pill">generated</span>' : '', f.kind === 'test' ? '<span class="pill">test</span>' : '', f.binary ? '<span class="pill">binary</span>' : ''].join('');
  const n = threadsAt(f.path).length;
  const oneSided = f.status === 'A' || f.untracked || f.status === 'D';
  return `<section class="file${f.status === 'A' || f.untracked ? ' allnew' : f.status === 'D' ? ' allgone' : ''}${S.layout === 'split' && !oneSided ? ' split' : ''}${S.shut.has(f.path) ? ' shut' : ''}${isViewed(f) ? ' viewed' : ''}${isStale(f) ? ' stale' : ''}${isGo(f.path) ? ' golang' : ''}" id="f-${f.i}" data-p="${esc(f.path)}">` +
    `<div class="fh"><button class="icon sm" data-act="fold" aria-label="Fold the file" title="Fold (o)">${I.chev}</button>${statusGlyph(f)}` +
    `<span class="path" data-act="fold" title="${esc(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)}">${f.oldPath ? `<span class="from">${esc(f.oldPath)} → </span>` : ''}<span class="dir">${esc(f.path.slice(0, k + 1))}</span><span class="base">${esc(f.path.slice(k + 1))}</span></span>` +
    `<span class="stat"><span class="add">+${f.added}</span><span class="del">−${f.deleted}</span></span>${tags}<span class="sp"></span>` +
    `<span class="faint" data-cc>${n ? `${I.cmt} ${n}` : ''}</span>` +
    `<button class="icon sm" data-act="filemenu" aria-label="More" title="More">${I.more}</button>` +
    `<button class="btn sm viewedbox${countedOnly(f) ? ' counted' : ''}" data-act="viewed" aria-pressed="${isViewed(f)}" title="${isStale(f) ? 'Changed since you viewed it' : countedOnly(f) ? `Counted as viewed: ${f.kind} files are, until you untick one. Turn it off in ⌘K or the View menu.` : 'Mark viewed (v)'}"><span class="box">${icon('check', '--on-act')}</span>${isStale(f) ? 'Changed' : 'Viewed'}</button></div>` +
    `<p class="file-note">${fileNoteHTML(f)}</p><div class="relp" hidden></div><div class="fb${S.layout === 'split' ? ' split' : ''}" data-p="${esc(f.path)}"><div class="loadd">${f.binary ? 'Binary file: no text diff.' : 'Loading…'}</div></div></section>`;
}

// A chapter head: the guide's section, written once where you read it. Its checks tick in place, kept with the brief
// they came from.
// a tick is kept with the brief it came from, its section and the check's own words (check-id.js)
export const checkKey = (k, j, sec = S.review.brief?.sections?.[k]) => (sec?.id ? `${S.review.brief?.at || 0}:${sec.id}:${checkId(sec.check?.[j])}` : `${S.review.brief?.at || 0}:${k}:${j}`);
function guideHeadHTML(sec, k) {
  const markdown = { images: modelKind(S.review.brief.model) !== 'codex', citations: S.review.brief.citations };
  const files = sec.files.map(fileOf).filter(Boolean);
  const left = files.filter((f) => !isViewed(f) && f.kind !== 'generated').reduce((n, f) => n + lines(f), 0);
  const checks = (sec.check || []).map((c, j) => {
    const on = !!S.review.checks?.[checkKey(k, j, sec)];
    const label = `check-${k}-${j}`;
    return `<div class="gck${on ? ' on' : ''}" data-act="gck" data-key="${esc(checkKey(k, j, sec))}"><button class="b" type="button" aria-pressed="${on}" aria-labelledby="${label}">${icon('check', '--on-act')}</button><span class="x" id="${label}">${md(c, markdown).replace(/^<p>|<\/p>\s*$/g, '')}</span></div>`;
  }).join('');
  const n = S.review.brief.sections.length;
  const scenes = (hooks.scenes?.() || []).filter((s) => sec.id && s.sectionId === sec.id);
  return `<div class="gsec" id="g-${k}"><div class="gmain"><div class="sh"><span>Section ${k + 1} of ${n}</span><span class="dot">·</span><span>${esc(sec.role)}</span>${sec.by === 'chat' ? `<span class="dot">·</span>${chatMark(sec)}` : ''}<span class="sp"></span><span class="n">${left ? `${left.toLocaleString()} lines left` : 'all viewed'}</span></div><h2 class="tick">${tick(sec.title)}</h2>` +
    (sec.context ? `<div class="ctx md">${md(sec.context, markdown)}</div>` : '') + `<div class="why md">${md(sec.why, markdown)}</div></div>${checks ? `<div class="gcks" aria-label="What to check"><div class="sh">What to check</div>${checks}</div>` : ''}` +
    (scenes.length ? `<div class="gscenes">${scenes.map((s) => `<div class="gscene"><div class="sh"><span>${esc(s.title)}</span>${s.by === 'chat' ? `<span class="dot">·</span>${chatMark(s)}` : ''}</div>${sceneSlot(s, `sec-${sec.id}`)}${s.why ? `<p class="gscap">${esc(s.why)}</p>` : ''}</div>`).join('')}</div>` : '') + `</div>`;
}

let io = null;
let preload;
export function renderCards(keepFiles = false) {
  hooks.cardVisibilityChanged?.();
  const order = orderedFiles();
  const sections = S.review.brief?.sections || [];
  const cards = $('#cards');
  parkScenes(cards);
  const banner = bannerHTML();
  // the map of the change comes first: what the code around it does, before any file
  const intro = banner + (order.length ? mapCardHTML(S.review.brief) : '');
  // Moving every card costs more than drawing them again until many bodies are loaded; keep them when that work is
  // worth saving, or when a draft is open in one
  if (keepFiles && (S.draft || S.loaded.size >= 24) && order.length && order.every(({ f }) => cardEl(f.path))) {
    for (const el of [...cards.children]) if (!el.classList.contains('file')) el.remove();
    cards.insertAdjacentHTML('afterbegin', intro);
    // Keep the code, syntax spans and open composers when the same files are rearranged.
    let before = cards.querySelector(':scope > .file');
    for (const { f, sec } of order) {
      const el = cardEl(f.path);
      if (el !== before) cards.insertBefore(el, before);
      if (sec !== null) el.insertAdjacentHTML('beforebegin', guideHeadHTML(sections[sec], sec));
      before = el.nextElementSibling;
    }
    paintSel();
    mountScenes();
    return;
  }
  cards.innerHTML = intro + (order.length ? order.map(({ f, sec }) => (sec !== null ? guideHeadHTML(sections[sec], sec) : '') + cardHTML(f)).join('')
    : `<div class="state"><div class="box"><div class="big">Nothing to review here</div><div>${S.rangeKey === 'wip' ? 'No uncommitted changes.' : 'This scope changes no files.'}</div></div></div>`);
  io?.disconnect();
  preload = { id: S.id, files: order.map(({ f }) => f), started: false };
  const observer = io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      const p = e.target.dataset.p;
      if (S.shut.has(p) || fileOf(p)?.binary) continue;
      loadFile(p).then(() => observer.unobserve(e.target), (err) => bodyError(p, err));
    }
  }, { root: $('#center'), rootMargin: '400px 0px' });
  for (const c of $$('.file', cards)) io.observe(c);
  hooks.filterCards?.();
  mountScenes();
}
function bannerHTML() {
  const m = S.ws;
  const bits = [];
  if (m.kind === 'pr' && !m.worktreeReady) bits.push(`<div class="banner"><span class="working"><span class="shimmer" style="${shimmerSync()}">Making loupe's own checkout of the PR, so review models and gopls can read its files…</span></span></div>`);
  if (S.untrackedSkipped) bits.push(`<div class="banner warn"><span>${S.untrackedSkipped.toLocaleString()} more untracked files are not shown (over 5,000). A .gitignore entry is probably missing.</span></div>`);
  if (S.rangeKey === 'since') bits.push(`<div class="banner"><span>Showing only what changed since you last marked a file viewed${m.sinceCount ? ` (${plural(m.sinceCount, 'new commit')})` : ''}.</span><span class="sp"></span><button class="btn sm" data-act="scope" data-scope="all">Whole change</button></div>`);
  return bits.join('');
}

export function updateCard(p) {
  const f = fileOf(p), c = cardEl(p);
  if (!f || !c) return;
  c.classList.toggle('viewed', isViewed(f));
  c.classList.toggle('stale', isStale(f));
  const vb = c.querySelector('.viewedbox');
  vb.setAttribute('aria-pressed', String(isViewed(f)));
  vb.classList.toggle('counted', countedOnly(f));
  vb.lastChild.textContent = isStale(f) ? 'Changed' : 'Viewed';
  const n = threadsAt(p).length;
  c.querySelector('[data-cc]').innerHTML = n ? `${I.cmt} ${n}` : '';
}

function bodyError(p, e) { const fb = cardEl(p)?.querySelector('.fb'); if (fb) fb.innerHTML = `<div class="loadd err">${esc(e.message)}</div>`; }
const splitFile = (f) => S.layout === 'split' && f.status !== 'A' && f.status !== 'D' && !f.untracked;

// ------------------------------------------------------------------ loading one file
export async function loadFile(p) {
  const f = fileOf(p);
  if (!f || f.binary) return;
  let pending = S.loaded.get(p);
  if (!pending) {
    pending = drawFile(p, f);
    S.loaded.set(p, pending);
  }
  try {
    await pending;
  } catch (e) {
    if (S.loaded.get(p) !== pending) return;
    S.loaded.delete(p);
    throw e;
  }
  const card = cardEl(p);
  if (fileOf(p) === f && S.rows.has(p) && card &&
      (card.querySelector('.fb > .loadd:not(.empty-diff)') || card.classList.contains('split') !== splitFile(f))) renderBody(p);
}

async function drawFile(p, f) {
  const current = () => fileOf(p) === f;
  const d = await diffOf(p);
  if (!current()) return;
  S.rows.set(p, buildRows(d));
  for (const th of threadsAt(p)) {
    await reanchor(p, th);
    if (!current()) return;
  }
  for (const mark of [...threadsAt(p), ...githubAt(p)]) {
    if (findRow(S.rows.get(p), mark) < 0 && mark.side !== 'old') await revealAround(p, mark.line);
    if (!current()) return;
  }
  if (!current()) return;
  const draw = () => S.files?.length < 24 ? renderBody(p) : queueDraw(p, f);
  await draw();
  if (!current()) return;
  startPreload();
  let lastNew = 0, lastOld = 0;
  if (f.added + f.deleted >= 1024) {
    for (const row of S.rows.get(p)) {
      lastNew = Math.max(lastNew, row.n || 0);
      if (row.t === '-') lastOld = Math.max(lastOld, row.o || 0);
    }
  }
  const oldLength = d.newLen - f.added + f.deleted;
  const jobs = [];
  if (f.status !== 'D') jobs.push(diffHighlight(p, 'new', f, d.newLen - lastNew > 600 ? lastNew : 0));
  if (f.status !== 'A' && !f.untracked && d.hunks.some((hk) => hk.lines.some((l) => l.t === '-'))) {
    jobs.push(diffHighlight(p, 'old', f, oldLength - lastOld > 600 ? lastOld : 0));
  }
  await Promise.allSettled(jobs);
  if (current() && jobs.length) await draw();
}

// Chrome shares a small set of HTTP connections with the metadata and diff requests.
// Keep one full-file highlight in flight for large diffs so short files can pass it.
let longHighlight = Promise.resolve();
function diffHighlight(p, side, f, through) {
  if (f.added + f.deleted < 1024) return loadTokens(p, side);
  const job = longHighlight.then(() => { if (fileOf(p) === f) return loadTokens(p, side, false, through); });
  longHighlight = job.catch(() => {});
  return job;
}

function startPreload() {
  const pass = preload;
  if (!pass || pass.started) return;
  pass.started = true;
  // Very large changes keep the viewport loader rather than building an unbounded DOM in the background.
  if (pass.files.length < 80 || pass.files.length > 500 || pass.files.reduce((n, f) => n + lines(f), 0) > 50_000) return;
  // Give the first cards and their highlights the request slots before filling the rest of the change.
  setTimeout(() => {
    let next = 0;
    const fill = async () => {
      while (preload === pass && S.id === pass.id && next < pass.files.length) {
        const f = pass.files[next++];
        const card = cardEl(f.path);
        if (fileOf(f.path) !== f || f.binary || S.shut.has(f.path) || card?.hidden || S.loaded.has(f.path) ||
            threadsAt(f.path).length || githubAt(f.path).length) continue;
        await loadFile(f.path).catch((error) => { if (preload === pass) bodyError(f.path, error); });
      }
    };
    for (let i = 0; i < 4; i++) fill();
  }, 150);
}

const pendingDraws = new Map();
let drawScheduled = false;
function queueDraw(p, f, front = false) {
  return new Promise((resolve) => {
    const pending = pendingDraws.get(p);
    if (pending?.f === f) {
      pending.done.push(resolve);
      pending.front ||= front;
    } else {
      pending?.done.forEach((done) => done());
      pendingDraws.set(p, { f, front, done: [resolve] });
    }
    if (!drawScheduled) scheduleDraw();
  });
}
function scheduleDraw() {
  drawScheduled = true;
  const run = () => {
    const start = performance.now();
    do {
      let entry = pendingDraws.entries().next().value;
      for (const candidate of pendingDraws) {
        if (candidate[1].front) { entry = candidate; break; }
      }
      const [p, job] = entry;
      pendingDraws.delete(p);
      if (fileOf(p) === job.f) {
        try { renderBody(p); } catch (error) { bodyError(p, error); }
      }
      for (const done of job.done) done();
    } while (pendingDraws.size && performance.now() - start < 5);
    if (pendingDraws.size) scheduleDraw();
    else drawScheduled = false;
  };
  if (globalThis.scheduler) scheduler.postTask(run);
  else setTimeout(run, 0);
}

// One fetch per file's diff, shared by everything that needs it; cleared when the change is read again.
export function diffOf(p) {
  let d = S.diffs.get(p);
  if (!d) { d = api(wsApi('/diff', { path: p })); S.diffs.set(p, d); d.catch(() => { if (S.diffs.get(p) === d) S.diffs.delete(p); }); }
  return d;
}

// Line numbers shift when the branch moves; a thread follows the text of the line it was left on.
async function reanchor(p, th) {
  const want = th.anchorText;
  if (want == null || want === '') return;
  const rows = S.rows.get(p), at = findRow(rows, th);
  if (at >= 0 && rows[at].s === want) return;
  const newSide = th.side !== 'old';
  let best = null;
  const consider = (ln) => { if (best === null || Math.abs(ln - th.line) < Math.abs(best - th.line)) best = ln; };
  for (const r of rows) if (!r.hdr && r.s === want && (newSide ? r.t !== '-' : r.t === '-')) consider(newSide ? r.n : r.o);
  if (best === null && newSide) (await headText(p).catch(() => [])).forEach((s, k) => { if (s === want) consider(k + 1); });
  if (best !== null && best !== th.line) {
    // The whole range moves with its last line, and its label follows.
    const delta = best - th.line;
    th.line = best;
    if (th.startLine) th.startLine += delta;
    if (/^lines? /.test(th.label || '')) th.label = th.startLine && th.startLine !== th.line ? `lines ${th.startLine}–${th.line}` : `line ${th.line}`;
    api(`/api/w/${S.id}/threads/${th.id}`, { method: 'PATCH', body: { line: th.line, startLine: th.startLine, label: th.label } }).catch(() => {});
  }
}

// Review threads already on GitHub. On a PR they sit at their lines in the whole-PR view; on a checkout only while
// it is at the PR's head and the file has no uncommitted edits (else the line numbers would point elsewhere).
export function githubAt(p) {
  const g = S.github;
  if (!g?.pr || !g.threads?.length) return [];
  if (S.ws.kind === 'pr') { if (S.rangeKey !== 'all') return []; }
  else if (g.pr.headRefOid !== S.ws.headFull || !['all', 'branch'].includes(S.rangeKey) || (S.rangeKey === 'all' && S.wsWip?.has(p))) return [];
  return g.threads.filter((t) => t.path === p && !t.outdated && t.line).map((t) => ({ ...t, gh: true }));
}

// A review comment can go where GitHub's threads can sit: on an open PR, in the view whose lines are the PR's.
export function canComment(p) {
  const g = S.github;
  if (!g?.pr || g.pr.state !== 'OPEN') return false;
  if (S.ws.kind === 'pr') return S.rangeKey === 'all';
  return g.pr.headRefOid === S.ws.headFull && ['all', 'branch'].includes(S.rangeKey) && !S.wsWip?.has(p);
}

// ------------------------------------------------------------------ drawing a file's body
// The digits of the number in a line's gutter, as a class: the + and a hidden mark's pin centre in the room left of it
// (style.css). A unified row takes the wider of its two numbers, so the + keeps its place across added and kept lines.
const nw = (...ns) => ' nw' + Math.min(5, String(Math.max(0, ...ns.map((n) => n || 0))).length);
function rowHTML(p, r, k, range, marks) {
  const c = r.t === '+' ? 'a' : r.t === '-' ? 'd' : '';
  const side = r.t === '-' ? 'old' : 'new', ln = r.t === '-' ? r.o : r.n;
  const mk = marks.get(`${side}:${ln}`);
  return `<div class="ln ${c}${mk ? ' marked' + (mk.startsWith('claude') ? ' claude' : '') + (mk.endsWith(' lit') ? ' lit' : '') : ''}" data-k="${k}"><span class="no">${r.o ?? ''}</span><span class="no">${r.n ?? ''}</span>` +
    `<span class="cd${nw(r.o, r.n)}"><button class="plus" tabindex="-1" aria-label="Select this line">${I.plus}</button><span class="mk">${r.t === ' ' ? '' : r.t === '-' ? '−' : '+'}</span>` +
    `<span class="tx" data-r="${side}" data-l="${ln}">${tokHTML(side + ':' + p, ln, r.s, range)}</span></span></div>`;
}
function splitRowHTML(p, rows, it, k, wd) {
  const half = (i, left) => {
    if (i == null) return '<span class="no e"></span><span class="cd e"></span>';
    const r = rows[i], ch = r.t !== ' ', c = ch ? (left ? ' d' : ' a') : '';
    const side = left && ch ? 'old' : 'new', ln = left && ch ? r.o : r.n;
    return `<span class="no${c}">${left ? r.o ?? '' : r.n ?? ''}</span><span class="cd${c}${nw(left ? r.o : r.n)}"><button class="plus" tabindex="-1" aria-label="Select this line">${I.plus}</button>` +
      `<span class="mk">${ch ? (left ? '−' : '+') : ''}</span><span class="tx" data-r="${side}" data-l="${ln}">${tokHTML(side + ':' + p, ln, r.s, wd.get(i))}</span></span>`;
  };
  return `<div class="ln" data-k="${k}">${half(it.L, true)}${half(it.R, false)}</div>`;
}
function hdrHTML(r, k, first, last) {
  const g = r.gap;
  let b = '';
  if (g) {
    const size = g.to - g.from + 1;
    if (size <= 20) b = `<button class="icon sm" data-act="expand" data-x="all" title="Show ${size} hidden line${size === 1 ? '' : 's'}">${I.updown}</button>`;
    else {
      if (!first) b += `<button class="icon sm" data-act="expand" data-x="down" title="Show 20 more lines">${I.down}</button>`;
      if (!last) b += `<button class="icon sm" data-act="expand" data-x="up" title="Show 20 more lines">${I.up}</button>`;
    }
  }
  const text = r.h ? `@@ −${r.h.oldStart},${r.h.oldLines} +${r.h.newStart},${r.h.newLines} @@ ${esc(r.h.context || '')}` : g ? `${(g.to - g.from + 1).toLocaleString()} unchanged lines` : '';
  return `<div class="hk" data-k="${k}"><span class="hx">${b}</span><span class="ht">${text}</span></div>`;
}

// A flash on lines (a jump to them) runs its 1.6 s to the end: a redraw of the file in that time draws it again at the
// point it had reached, and a second jump to a line still flashing leaves it running. S.flash: { path, side, lines, t0 }.
const FLASH_MS = 1600;
export function flashLines(p, side, lines) {
  const prev = S.flash, now = performance.now();
  const again = prev && prev.path === p && prev.side === side && now - prev.t0 < FLASH_MS && lines.every((l) => prev.lines.includes(l));
  if (!again) S.flash = { path: p, side, lines, t0: now };
  reflash(p);
}
function reflash(p) {
  const f = S.flash, card = cardEl(p);
  if (!f || f.path !== p || !card) return;
  const at = performance.now() - f.t0;
  if (at >= FLASH_MS) { S.flash = null; return; }
  const rows = S.rows.get(p), items = S.items.get(p);
  if (!rows || !items) return;
  for (const line of f.lines) {
    const r = findLine(rows, { side: f.side, line });
    const k = r >= 0 ? items.findIndex((it) => it.i === r || it.L === r || it.R === r) : -1;
    const el = k >= 0 && card.querySelector(`.ln[data-k="${k}"]`);
    if (!el || el.classList.contains('flash')) continue;
    el.style.setProperty('--flash-at', `-${Math.round(at)}ms`);
    el.dataset.fs = f.side; // split view lights only that side's half of the row
    el.classList.add('flash');
  }
}
// a flash that has run its course leaves no class behind (a fold and unfold must not play it again)
// (its cells start and end together, so the first to end clears the row)
const unflash = (ln) => { ln.classList.remove('flash'); ln.style.removeProperty('--flash-at'); delete ln.dataset.fs; };
document.addEventListener('animationend', (e) => {
  if (e.animationName !== 'flash') return;
  const ln = e.target.closest?.('.ln.flash');
  if (ln) unflash(ln);
});
export function renderBody(p) { drawBody(p); reflash(p); }
function drawBody(p) {
  const card = cardEl(p), fb = card?.querySelector('.fb');
  const rows = S.rows.get(p);
  if (!fb || !rows) return;
  const split = splitFile(fileOf(p));
  fb.classList.toggle('split', split);
  card.classList.toggle('split', split); // the guide head and used-by panel follow the code's edge too
  let plan = rowPlans.get(rows);
  if (!plan) {
    const pairs = buildSplit(rows);
    plan = { pairs, words: wordRanges(rows, pairs) };
    rowPlans.set(rows, plan);
  }
  const items = split ? plan.pairs : (plan.unified ||= rows.map((r, i) => (r.hdr ? { hdr: i } : { i })));
  S.items.set(p, items);
  const keyOf = (a) => {
    const i = findRow(rows, a);
    if (i < 0) return -1;
    return split ? items.findIndex((it) => it.L === i || it.R === i) : items.findIndex((it) => it.i === i);
  };
  const after = new Map();
  const put = (k, html) => { if (k >= 0) (after.get(k) || after.set(k, []).get(k)).push(html); };
  const marks = new Map();
  // With the marks hidden, each one keeps its glyph at its line, over the left edge of the line-number gutter.
  const pins = new Map();
  const pin = (k, x) => { if (k >= 0) (pins.get(k) || pins.set(k, []).get(k)).push(x); };
  for (const th of threadsAt(p)) {
    if (!S.marksHidden) put(keyOf(th), markHTML(th)); else pin(keyOf(th), pinOf(th));
    for (let n = th.startLine || th.line; n <= th.line; n++) marks.set(`${th.side}:${n}`, 'claude' + (S.mark === th.id ? ' lit' : ''));
  }
  for (const g of githubAt(p)) { if (!S.marksHidden) put(keyOf(g), githubHTML(g)); else pin(keyOf(g), ghPinOf(g)); }
  const draftK = S.draft?.path === p ? keyOf(S.draft) : -1;
  const hadFocus = S.draft?.path === p && document.activeElement?.closest?.('.draft');
  const wd = plan.words;
  const lastK = items.length - 1;
  // Unified rows carry the marks in the gutter; split rows don't (the gutter is per side).
  const html = items.map((it, k) => {
    let out = it.hdr !== undefined ? hdrHTML(rows[it.hdr], k, k === 0, k === lastK) : split ? splitRowHTML(p, rows, it, k, wd) : rowHTML(p, rows[it.i], k, wd.get(it.i), marks);
    // the pin goes last in the row, so the cells keep their places (split view finds a side by its index)
    if (pins.has(k) && out.endsWith('</div>')) {
      // the pin sits in the first column: by its number, else (an added line in split) the one beside it
      const w = split ? (it.L != null ? nw(rows[it.L].o) : nw(rows[it.R]?.n)) : nw(rows[it.i].o, rows[it.i].n);
      out = out.slice(0, -6) + laneHTML(pins.get(k), w) + '</div>';
    }
    for (const x of after.get(k) || []) out += x;
    if (k === draftK) out += draftHTML();
    return out;
  });
  const chunks = [];
  if (html.length > 512 || html.length && S.files.length >= 80) {
    const size = html.length > 512 ? 32 : html.length;
    for (let i = 0; i < html.length; i += size) {
      const part = html.slice(i, i + size);
      const headers = items.slice(i, i + size).filter((it) => it.hdr !== undefined).length;
      chunks.push(`<div class="diff-chunk" style="--diff-height:${part.length * 20 + headers * 8}px">${part.join('')}</div>`);
    }
  }
  fb.classList.toggle('chunked', chunks.length > 0);
  fb.innerHTML = (chunks.length ? chunks : html).join('') || '<div class="loadd empty-diff">No text changes (a mode or rename only).</div>';
  if (draftK >= 0) {
    const ta = fb.querySelector('.draft textarea');
    ta.value = S.draft.value || '';
    grow(ta);
    if (hadFocus || S.draft.focus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); S.draft.focus = false; }
  }
  paintSel();
  hooks.bodyDrawn?.(p);
}
export function renderAllBodies() { for (const p of S.rows.keys()) renderBody(p); }
let layoutPass;
export function renderLayout() {
  const viewport = S.files.length >= 24 ? $('#center').getBoundingClientRect() : null;
  const shells = [], offscreen = layoutPass = [];
  for (const { f } of orderedFiles()) {
    const card = cardEl(f.path);
    if (!card) continue;
    const split = splitFile(f);
    if (card.classList.contains('split') === split) continue;
    if (!S.rows.has(f.path)) {
      shells.push({ card, split });
      continue;
    }
    if (!viewport) { renderBody(f.path); continue; }
    const rect = card.getBoundingClientRect();
    if (rect.bottom >= viewport.top && rect.top <= viewport.bottom || S.draft?.path === f.path) queueDraw(f.path, f, true);
    else {
      offscreen.push(f);
      io?.observe(card);
    }
  }
  for (const { card, split } of shells) {
    card.classList.toggle('split', split);
    card.querySelector('.fb').classList.toggle('split', split);
  }
  paintSel();
  if (offscreen.length) finishLayout(offscreen);
}

function finishLayout(files) {
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 0 }), 0));
  files.sort((a, b) => lines(a) - lines(b));
  let next = 0;
  function batch(deadline) {
    if (layoutPass !== files) return;
    const start = performance.now();
    do {
      const f = files[next++], card = cardEl(f.path);
      if (fileOf(f.path) === f && card?.classList.contains('split') !== splitFile(f)) renderBody(f.path);
    } while (next < files.length && deadline.timeRemaining() > 4 && performance.now() - start < 5);
    if (next < files.length) idle(batch, { timeout: 180 });
  }
  // The viewport is already queued. Coalesce quick toggles before touching offscreen bodies.
  setTimeout(() => {
    if (layoutPass === files) idle(batch, { timeout: 180 });
  }, 180);
}

// A hidden mark's pin: the same glyph as its line in the code (Claude's spark, GitHub's mark),
// its first words in the title, Claude's pixel when an answer waits unread, and a count when a line holds more.
function pinOf(th) {
  const conv = convOf(th.conv) || { messages: [] }, mine = conv.messages.find((m) => m.role === 'user');
  return { attr: `data-t="${th.id}"`, cls: conv.modelKind === 'codex' ? 'ask codex' : 'ask', glyph: conv.modelKind === 'codex' ? I.chat : spark(16, !busyConv(conv), 'Claude'),
    title: `Your question: ${oneLine(mine?.text, 120)}`, unread: S.unreadAns.has(th.id), done: th.resolved, lit: S.mark === th.id };
}
function ghPinOf(g) {
  const first = g.comments[0];
  return { attr: `data-gh="${esc(g.id)}"`, cls: g.pending ? 'gh pend' : 'gh', glyph: I.github, title: `${g.pending ? 'Your pending comment' : first?.author || 'GitHub'}: ${oneLine(first?.body, 120)}`, unread: false, done: g.resolved, lit: S.mark === 'gh:' + g.id };
}
function laneHTML(list, w = '') {
  const x = list.find((m) => !m.done) || list[0], n = list.length;
  return `<button class="mpin${w} ${x.cls}${x.done ? ' done' : ''}${x.lit ? ' lit' : ''}" data-act="mark-open" ${x.attr} title="${esc(x.title)}${n > 1 ? ` (and ${n - 1} more on this line)` : ''}">${x.glyph}${x.unread ? '<i class="sat"></i>' : ''}${n > 1 ? `<span class="mc">${n}</span>` : ''}</button>`;
}

// ------------------------------------------------------------------ marks at their lines
// A mark at its lines is one line, never a block, so the code stays continuous. A question shows your words, Claude's
// first words and its state; a GitHub thread its author and first words. The conversation opens in the inspector,
// where long prose reads well.
export const oneLine = (s, n = 160) => { const t = String(s || '').replace(/```[\s\S]*?```/g, ' … ').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const busyConv = (c) => !!c && (c.busy || c.messages.some((m) => m.pending));
export function markHTML(th) {
  const conv = convOf(th.conv) || { messages: [] };
  const mine = conv.messages.filter((m) => m.role === 'user'), answers = conv.messages.filter((m) => m.role !== 'user');
  const on = S.mark === th.id ? ' on' : '', done = th.resolved ? ' done' : '';
  const ans = answers.at(-1), busy = busyConv(conv);
  return `<div class="mrow ask${ans?.role === 'codex' ? ' codex' : ''}${done}${on}" data-t="${th.id}" data-act="mark-open" role="button" tabindex="0" title="Open the conversation"><span class="mg">${ans?.role === 'codex' ? I.codex : spark(16, !busy, 'Claude')}</span><span class="mq" title="${esc(oneLine(mine[0]?.text, 600))}">${esc(oneLine(mine[0]?.text, 140))}</span>` +
    (ans?.text ? `<span class="ma" title="${esc(oneLine(ans.text, 600))}"><span>${esc(oneLine(ans.text, 260))}</span></span>` : '') +
    (busy ? `<span class="mst working shimmer" style="${shimmerSync()}">answering</span>` : !ans ? '<span class="mst">no answer yet</span>' : '') +
    (conv.messages.length > 2 ? `<span class="mn">${plural(conv.messages.length - 2, 'more', 'more')}</span>` : '') + `<span class="mo">${I.chevR}</span></div>`;
}
function githubHTML(t) {
  const first = t.comments[0], n = t.comments.length;
  const on = S.mark === 'gh:' + t.id ? ' on' : '';
  return `<div class="mrow gh${t.resolved ? ' done' : ''}${t.pending ? ' pending' : ''}${on}" data-gh="${esc(t.id)}" data-act="mark-open" role="button" tabindex="0" title="${t.pending ? 'Your pending review comment: only you see it until you submit the review' : 'Open the thread'}"><span class="mg">${I.github}</span><span class="mq">${esc(first?.author || '')}</span><span class="ma" title="${esc(oneLine(first?.body, 600))}">${esc(oneLine(first?.body, 260))}</span>` +
    (n > 1 ? `<span class="mn">${plural(n - 1, 'reply', 'replies')}</span>` : '') + (t.pending ? '<span class="mst pend">pending</span>' : t.resolved ? '<span class="mst">resolved</span>' : '') + `<span class="mo">${I.chevR}</span></div>`;
}
// Asking at the lines, or commenting for your GitHub review: one slim field there. A question is sent with ↵, like a chat;
// a comment is GitHub writing, kept as GitHub keeps it: ↵ is a new paragraph and ⌘↵ adds it. The send is drawn like the
// selection bar's buttons, quiet until there is something to send.
const draftSend = (label, empty, gh) => `<button class="btn primary sm send" data-act="draft-send"${empty ? ' disabled' : ''} title="${gh ? '⌘↵ adds it to your review' : '↵ sends, ⇧↵ starts a new line'}"><span>${label}</span><kbd>${gh ? '⌘↵' : '↵'}</kbd></button>`;
const askWho = (run) => (modelKind(run?.model) === 'codex' ? 'Codex' : 'Claude');
function draftHTML() {
  const d = S.draft, empty = !d.value?.trim();
  if (d.kind === 'comment') return `<div class="mrow draft gh"><span class="mg">${I.github}</span>` +
    `<textarea rows="1" placeholder="Comment on ${esc(d.label)}: it waits in your review until you submit" title="Only you see it on GitHub until you submit your review" aria-label="Review comment"></textarea>` +
    `<span class="mdk">${draftSend('Add to review', empty, true)}</span></div>`;
  const run = d.run || lastRun();
  return `<div class="mrow draft ask${modelKind(run.model) === 'codex' ? ' codex' : ''}"><span class="mg">${askGlyph(run)}</span>` +
    `<textarea rows="1" placeholder="Ask ${askWho(run)} about ${esc(d.label)}" aria-label="Review question"></textarea>` +
    `<span class="mdk">${runBtn(run)}${draftSend('Ask', empty)}</span></div>`;
}
// Picking another model in the draft turns its mark and its words to that model.
document.addEventListener('runpicked', (e) => {
  const row = e.target.closest?.('.mrow.draft.ask');
  if (!row || !S.draft) return;
  S.draft.run = { ...e.detail };
  row.classList.toggle('codex', modelKind(e.detail.model) === 'codex');
  row.querySelector('.mg').innerHTML = askGlyph(e.detail);
  const ta = row.querySelector('textarea'); ta.placeholder = `Ask ${askWho(e.detail)} about ${S.draft.label}`; ta.focus();
});

// Hide the marks in the code (their gutter ticks stay, and the Marks tab lists them), or show them again.
document.documentElement.classList.toggle('marks-hidden', !!S.marksHidden);
export function setMarksHidden(on) {
  S.marksHidden = on; pref.set('marksHidden', on);
  document.documentElement.classList.toggle('marks-hidden', on);
  renderAllBodies(); hooks.marksToggled?.();
}
// Redraw one mark's line in place (an answer streaming in, a state change), without redrawing its file.
export function updateMark(th) {
  const el = document.querySelector(`.mrow[data-t="${th.id}"]`);
  if (el && !el.classList.contains('draft')) el.outerHTML = markHTML(th);
}

// ------------------------------------------------------------------ selecting lines
function selIdx() {
  const s = S.sel; if (!s) return [];
  const items = S.items.get(s.path) || [];
  const [a, b] = [Math.min(s.a, s.b), Math.max(s.a, s.b)];
  const set = new Set();
  for (let k = a; k <= b; k++) { const it = items[k]; if (!it || it.hdr !== undefined) continue; if (it.i != null) set.add(it.i); if (it.L != null && (s.side !== 'new' || it.L === it.R)) set.add(it.L); if (it.R != null && s.side !== 'old') set.add(it.R); }
  return [...set].sort((x, y) => x - y);
}
let selectionPath = null;
export function paintSel() {
  if (selectionPath) {
    const old = cardEl(selectionPath);
    if (old) for (const el of $$('.ln.sel', old)) el.classList.remove('sel');
    $('#seltools')?.remove();
  }
  const s = S.sel;
  selectionPath = s?.path ?? null;
  if (!s) return;
  const fb = cardEl(s.path)?.querySelector('.fb'); if (!fb) return;
  const [a, b] = [Math.min(s.a, s.b), Math.max(s.a, s.b)];
  for (let k = a; k <= b; k++) fb.querySelector(`.ln[data-k="${k}"]`)?.classList.add('sel');
  if (!S.dragging && !S.draft) showSeltools(fb, b);
}
function showSeltools(fb, k) {
  const row = fb.querySelector(`.ln[data-k="${k}"]`);
  if (!row) return;
  const center = $('#center'), cr = center.getBoundingClientRect(), rr = row.getBoundingClientRect();
  const n = selIdx().length;
  const el = h(`<div class="seltools" id="seltools" role="toolbar"><span class="n">${plural(n, 'line')}</span>` +
    `<button class="btn ghost sm" data-act="sel-ask">${askGlyph(lastRun())}<span>Ask ${modelKind(lastRun().model) === 'codex' ? 'Codex' : 'Claude'}</span><kbd>a</kbd></button>${canComment(S.sel?.path) ? `<button class="btn ghost sm" data-act="sel-comment">${I.github}<span>Comment</span><kbd>c</kbd></button>` : ''}` +
    `<button class="btn ghost sm" data-act="sel-chat">${I.chat}<span>Add to chat</span><kbd>l</kbd></button><button class="btn ghost sm" data-act="sel-link" title="Copy a link to these lines (⇧ for GitHub's)">${I.link}<span>Link</span></button></div>`);
  center.append(el);
  el.style.top = (rr.bottom - cr.top + center.scrollTop + 4) + 'px';
  el.style.left = Math.min(rr.left - cr.left + 96, cr.width - el.offsetWidth - 16) + 'px';
}
export function selection() {
  const idx = selIdx(); if (!idx.length) return null;
  const p = S.sel.path, rows = S.rows.get(p), sel = idx.map((i) => rows[i]);
  const last = sel[sel.length - 1];
  const side = last.t === '-' ? 'old' : 'new';
  const first = sel.find((r) => side === 'old' ? r.o != null : r.n != null);
  return {
    path: p, side, line: side === 'old' ? last.o : last.n, startLine: side === 'old' ? first?.o : first?.n,
    anchorText: last.s, label: rangeLabel(sel), snippet: selText(sel), preview: sel.slice(0, 14).map((r) => ({ t: r.t, s: r.s })),
  };
}
export function openDraft(kind) {
  const s = selection(); if (!s) return;
  const prev = S.draft;
  S.draft = { ...s, kind, value: prev?.path === s.path ? prev.value : '', focus: true, run: lastRun() };
  if (prev && prev.path !== s.path) renderBody(prev.path);
  renderBody(s.path);
}
export function cancelDraft() { const p = S.draft?.path || S.sel?.path; S.draft = null; S.sel = null; if (p) renderBody(p); else paintSel(); }

$('#root').addEventListener('mousedown', (e) => {
  const hit = e.target.closest('.fb .plus, .fb .ln .no');
  if (!hit || e.button !== 0) return;
  const row = hit.closest('.ln'), fb = hit.closest('.fb');
  if (!row || !fb || hit.classList.contains('e')) return;
  e.preventDefault();
  const p = fb.dataset.p, wasSplit = fb.classList.contains('split');
  let k = Number(row.dataset.k);
  // In split view, the side you started on is the side you select.
  const cell = hit.classList.contains('no') ? hit : hit.closest('.cd');
  let side = wasSplit ? ([...row.children].indexOf(cell) < 2 ? 'old' : 'new') : null;
  const split = splitFile(fileOf(p));
  if (wasSplit !== split) {
    // This card can still show the previous layout. Resolve the clicked line before replacing its row map.
    const item = S.items.get(p)[k];
    const i = wasSplit ? (side === 'old' ? item.L : item.R) : item.i;
    if (i == null) return;
    if (split) side = S.rows.get(p)[i].t === '-' ? 'old' : 'new';
    else side = null;
    renderBody(p);
    k = S.items.get(p).findIndex((it) => it.i === i || it.L === i || it.R === i);
    if (k < 0) return;
  }
  if (!e.shiftKey && !S.draft && S.sel?.path === p && S.sel.a === k && S.sel.b === k) { S.sel = null; paintSel(); return; } // the same line again: let go
  S.sel = e.shiftKey && S.sel?.path === p ? { ...S.sel, b: k } : { path: p, a: k, b: k, side };
  if (S.draft && S.draft.path === p && e.shiftKey) { const s = selection(); Object.assign(S.draft, s); S.dragging = false; renderBody(p); return; }
  S.dragging = true;
  paintSel();
});
// a plain click anywhere else in the code (not on a number, the bar or a draft) lets go of the lines too
$('#root').addEventListener('mousedown', (e) => {
  if (!S.sel || S.draft || S.dragging || e.button !== 0 || e.shiftKey) return;
  if (e.target.closest('.fb .plus, .fb .ln .no, #seltools, .mrow, .menu') || !e.target.closest('#cards')) return;
  S.sel = null; paintSel();
});
$('#root').addEventListener('mouseover', (e) => {
  if (!S.dragging) return;
  const row = e.target.closest('.ln'), fb = e.target.closest('.fb');
  if (row && fb?.dataset.p === S.sel.path) { S.sel.b = Number(row.dataset.k); paintSel(); }
});
window.addEventListener('mouseup', () => { if (S.dragging) { S.dragging = false; paintSel(); } });

// ------------------------------------------------------------------ actions on cards, drafts and threads
export async function setViewed(p, on) {
  const f = fileOf(p); if (!f) return;
  const card = on ? cardEl(p) : null;
  const offset = card && card.getBoundingClientRect().top - $('#center').getBoundingClientRect().top;
  const key = viewKey(f);
  S.review.unviewed ||= {};
  for (const [map, add] of [[S.review.viewed, on], [S.review.unviewed, !on]]) {
    const list = (map[p] || []).filter((b) => b !== key);
    if (add) list.push(key);
    if (list.length) map[p] = list; else delete map[p];
  }
  // viewed folds the file away; unviewed opens it again, since you are going back to read it
  toggleFold(p, on);
  updateCard(p);
  hooks.progress?.(p);
  hooks.sound?.viewed(S.id); // a tick up the ladder (with desk sounds on)
  // Mote is pleased (a hop and a check off his head), then looks at the file's row in the list, where its check lands
  if (on) { hooks.mote?.viewed(); hooks.mote?.glance(() => document.querySelector(`.trow[data-p="${CSS.escape(p)}"]`), 420); }
  api(`/api/w/${S.id}/viewed`, { method: 'POST', body: { path: p, blob: key, viewed: on } }).catch((e) => toast(e.message, { fail: true }));
  if (on) {
    if (offset < 44 && Math.abs(offset - 40) > 1) card?.scrollIntoView({ block: 'start' });
    toast(`${p.split('/').pop()} viewed`, { action: 'Undo', run: () => { setViewed(p, false); toggleFold(p, false); hooks.goLoc?.({ path: p, line: 0 }); } });
  }
}
export function toggleFold(p, shut) {
  const c = cardEl(p); if (!c) return;
  const s = shut ?? !c.classList.contains('shut');
  c.classList.toggle('shut', s);
  s ? S.shut.add(p) : S.shut.delete(p);
  if (s && S.flash?.path === p) { c.querySelectorAll('.ln.flash').forEach(unflash); S.flash = null; }
  // Always: loadFile knows a file that is loaded (a card redrawn while it was folded only needs its body drawn again, and
  // nothing else will do it, since the card was already in view), one still loading, and one not read yet.
  if (!s) loadFile(p).catch((err) => bodyError(p, err));
}

async function sendDraft() {
  const d = S.draft, id = S.id;
  const ta = $('.draft textarea');
  const text = (ta?.value || d?.value || '').trim();
  if (!d || !text) return;
  const run = runOf($('.draft'));
  rememberRun(run);
  S.draft = null; S.sel = null;
  if (d.kind === 'comment') {
    // a comment for your review goes to GitHub, as a pending comment of your review; GitHub's answer redraws the lines
    renderBody(d.path);
    const r = await hooks.act?.('reviewcomment', { path: d.path, line: d.line, startLine: d.startLine, side: d.side, body: text });
    if (!r && S.id === id && !S.draft) { S.draft = { ...d, value: text, focus: true }; renderBody(d.path); }
    return;
  }
  const body = { path: d.path, side: d.side, line: d.line, startLine: d.startLine, anchorText: d.anchorText, label: d.label, snippet: d.snippet, preview: d.preview, kind: d.kind, text, ...run };
  try {
    const r = await api(wsApi('/threads'), { method: 'POST', body });
    if (S.id !== id) return;
    if (!S.review.threads.some((t) => t.id === r.thread.id)) S.review.threads.push(r.thread);
    S.review.convs[r.conv.id] = { ...(S.review.convs[r.conv.id] || {}), ...r.conv, messages: S.review.convs[r.conv.id]?.messages?.length > r.conv.messages.length ? S.review.convs[r.conv.id].messages : r.conv.messages };
    hooks.threadsChanged?.(d.path);
    // You asked, so you are waiting for the answer: it opens beside the code, streaming.
    hooks.openMark?.(r.thread.id);
    hooks.mote?.glance(() => document.querySelector(`.mrow[data-t="${CSS.escape(r.thread.id)}"]`)); // and Mote at the mark you made
  } catch (e) { toast(e.message, { fail: true }); if (S.id === id && !S.draft) { S.draft = { ...d, value: text }; renderBody(d.path); } }
}

export function attachSelection() {
  const s = selection(); if (!s) return;
  S.attach.push({ path: s.path, side: s.side, line: s.line, label: s.label, text: s.snippet });
  S.sel = null; paintSel();
  hooks.openChat?.();
}

function fileMenu(btn, p) {
  const f = fileOf(p);
  const root = S.ws.root;
  const items = [
    { label: isViewed(f) ? 'Mark not viewed' : 'Mark viewed', value: 'viewed', key: 'v' },
    { label: 'Used by and same folder', value: 'usedby' },
    { label: 'View the whole file', value: 'whole' },
    { sep: true },
    { label: 'Copy path', value: 'copy' },
    ...(root ? [{ label: 'Open in VS Code', value: 'code' }] : []),
  ];
  menu(btn, items, (it) => {
    if (it.value === 'viewed') setViewed(p, !isViewed(f));
    if (it.value === 'usedby') toggleUsedBy(p);
    if (it.value === 'whole') hooks.openViewer?.({ path: p, line: 1 });
    if (it.value === 'copy') navigator.clipboard.writeText(p).then(() => toast('Copied ' + p));
    if (it.value === 'code') location.href = `vscode://file${root}/${p}:1`;
  }, { align: 'right' });
}
async function toggleUsedBy(p) {
  const panel = cardEl(p).querySelector('.relp');
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<span class="faint">Looking for the files that use it…</span>';
  try {
    const r = await api(wsApi('/related', { path: p }));
    // three short lists under one rule each, on the note's edge: what this file changes, who names it (each place a line
    // you can open), and its neighbours; a list with nothing in it says so once, or is left out
    const path = (q) => { const k = q.lastIndexOf('/'); return `<span class="dir">${esc(q.slice(0, k + 1))}</span><span class="base">${esc(q.slice(k + 1))}</span>`; };
    const sect = (title, n, body) => `<section><div class="sh"><span>${title}</span>${n ? `<span class="n">${n}</span>` : ''}</div>${body}</section>`;
    panel.innerHTML =
      (r.idents.length ? sect('Changed here', r.idents.length, `<div class="ids">${r.idents.map((x) => `<code>${esc(x)}</code>`).join('')}</div>`) : '') +
      sect('Used by', r.usedBy.length, r.usedBy.length ? r.usedBy.map((u) => `<div class="use"><button class="link up" data-act="open" data-p="${esc(u.path)}" data-l="${u.hits[0]?.line || 1}">${path(u.path)}</button>${u.changed ? '<span class="chg">changed here too</span>' : ''}` +
        u.hits.map((x) => `<button class="link hit" data-act="open" data-p="${esc(u.path)}" data-l="${x.line}"><span class="no">${x.line}</span><span>${esc(x.text.trim())}</span></button>`).join('') + '</div>').join('')
        : `<div class="none">${r.idents.length ? 'Nothing else in the repository names them.' : 'No Go functions or types to follow in this file.'}</div>`) +
      (r.siblings.length ? sect('Same folder', r.siblings.length, `<div class="sibs">${r.siblings.map((s) => `<button class="link" data-act="open" data-p="${esc(s.path)}" data-l="1">${esc(s.path.split('/').pop())}${s.changed ? '<span class="dotm" title="Changed here"></span>' : ''}</button>`).join('')}</div>`) : '');
  } catch (e) { panel.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

$('#root').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !b.closest('#cards, #seltools, #tlist')) return;
  const act = b.dataset.act;
  const card = b.closest('.file'), p = card?.dataset.p;
  if (act === 'gck') {
    const on = !b.classList.contains('on');
    for (const x of $$(`.gck[data-key="${CSS.escape(b.dataset.key)}"]`)) { x.classList.toggle('on', on); x.querySelector('.b')?.setAttribute('aria-pressed', String(on)); }
    S.review.checks ||= {};
    if (on) S.review.checks[b.dataset.key] = Date.now(); else delete S.review.checks[b.dataset.key];
    if (S.mode === 'guide') hooks.renderTree?.(); // the contents count the ticks
    return api(`/api/w/${S.id}/checks`, { method: 'POST', body: { key: b.dataset.key, on } }).catch((err) => toast(err.message, { fail: true }));
  }
  if (act === 'fold') return toggleFold(p);
  if (act === 'viewed') return setViewed(p, !isViewed(fileOf(p)));
  if (act === 'filemenu') return fileMenu(b, p);
  if (act === 'open') return hooks.goLoc?.({ path: b.dataset.p, line: Number(b.dataset.l) || 1 }, b);
  if (act === 'expand') { const hk = b.closest('.hk'); const it = S.items.get(p)[Number(hk.dataset.k)]; await expandGap(p, it.hdr, b.dataset.x); return renderBody(p); }
  if (act === 'sel-ask') return openDraft('ask');
  if (act === 'sel-comment') return openDraft('comment');
  if (act === 'sel-chat') return attachSelection();
  if (act === 'sel-link') {
    // loupe's own link (#path:L12-L20), or with shift the GitHub permalink at the commit you are reading.
    const s = selection(); if (!s) return;
    const a = s.startLine && s.startLine !== s.line ? `L${s.startLine}-L${s.line}` : `L${s.line}`;
    const head = S.ws.kind === 'pr' ? S.ws.headFull : S.github?.pr?.headRefOid === S.ws.headFull ? S.ws.headFull : null;
    const repo = S.github?.repoFull || S.ws.repoFull;
    const url = e.shiftKey && head && repo ? `https://github.com/${repo}/blob/${head}/${s.path}#${a}` : `${S.app.display}${S.ws.url}#${encodeURIComponent(s.path)}:${a}`;
    return navigator.clipboard.writeText(url).then(() => toast(e.shiftKey && head ? 'GitHub permalink copied' : 'Link copied'), () => toast(url));
  }
  if (act === 'draft-send') return sendDraft();
  if (act === 'scope') return hooks.setScope?.(b.dataset.scope);
  const ght = b.closest('[data-gh]')?.dataset.gh;
  if (ght && act === 'mark-open') return hooks.openMark?.('gh:' + ght);
  const th = S.review.threads.find((t) => t.id === b.closest('[data-t]')?.dataset.t);
  if (!th) return;
  if (act === 'mark-open') return hooks.openMark?.(th.id);
  if (act === 'resolve' || act === 'unresolve') return setResolved(th, act === 'resolve');
  if (act === 'delete') {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete it?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Delete'; }, 3000); return; }
    return deleteMark(th);
  }
});
export function setResolved(th, on) {
  th.resolved = on;
  renderBody(th.path); hooks.threadsChanged?.(th.path);
  return api(`/api/w/${S.id}/threads/${th.id}`, { method: 'PATCH', body: { resolved: on } }).catch((err) => toast(err.message, { fail: true }));
}
export function deleteMark(th) {
  S.review.threads = S.review.threads.filter((t) => t !== th);
  if (S.mark === th.id) hooks.closeMark?.();
  renderBody(th.path); hooks.threadsChanged?.(th.path);
  return api(`/api/w/${S.id}/threads/${th.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, { fail: true }));
}
// The draft's text survives the redraws a live update causes.
document.addEventListener('input', (e) => {
  const row = e.target.closest?.('.mrow.draft');
  if (!row || !S.draft) return;
  S.draft.value = e.target.value;
  row.querySelector('.send')?.toggleAttribute('disabled', !e.target.value.trim());
});
document.addEventListener('keydown', (e) => {
  const box = e.target.closest?.('.mrow.draft');
  if (!box || e.target.tagName !== 'TEXTAREA') {
    // a question or GitHub mark is a button: Enter opens it
    const mk = e.target.closest?.('.mrow[data-act="mark-open"]');
    if (mk && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); mk.click(); }
    return;
  }
  // a question: ↵ sends (⌘↵ too, from habit) and ⇧↵ is a new line; a review comment: ⌘↵ adds it, ↵ is a new paragraph.
  // ↵ while an input method is still composing belongs to it.
  const send = S.draft?.kind === 'comment' ? e.metaKey || e.ctrlKey : !e.shiftKey && !e.isComposing && e.keyCode !== 229;
  if (e.key === 'Enter' && send) { e.preventDefault(); if (!e.repeat) sendDraft(); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return cancelDraft(); }
});
