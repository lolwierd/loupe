// The inspector beside the diff, three questions:
//   Overview: what is this change, and what have others said about it? (PR header, checks, reviewers, the brief and
//             guide, the description, the conversation)
//   Chat:     talk to Claude about it (fresh, a fork of a Claude Code session, or the live session)
//   Review:   what have I marked? (your questions, and GitHub's threads). What you do about them, submitting
//             the review or handing the fixes back, is the top bar's next act, not a form here.
import { S, $, $$, esc, api, wsApi, I, pref, toast, convOf, lastRun, rememberRun, ago, plural, fileOf, modelName, briefRun } from './core.js';
import { md } from './md.js';
import { msgHTML, runBtn, briefRunBtn, runOf, grow, menu, shimmerSync, modelKind } from './ui.js';
import { isViewed, lines, setResolved, deleteMark, cardEl, renderBody, oneLine } from './cards.js';
import { hooks } from './hooks.js';
import { spark, avatar } from './pixel.js';

const TABS = ['overview', 'chat', 'review'];
if (!TABS.includes(S.tab)) S.tab = { brief: 'overview', notes: 'review' }[S.tab] || 'overview';
export function setTab(tab) {
  S.tab = TABS.includes(tab) ? tab : 'overview'; pref.set('tab', S.tab);
  for (const b of $$('.ptabs .tab')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  renderPanel();
}
export function renderTabs() {
  const busy = Object.values(S.review.convs).some((c) => c.kind === 'chat' && c.messages.some((m) => m.pending));
  const open = S.review.threads.filter((t) => !t.resolved && !t.posted).length;
  const ghOpen = (S.github?.threads || []).filter((t) => !t.resolved).length;
  $('#ptab-overview').innerHTML = `Overview${S.review.brief?.pending ? spark(16, false, 'writing the brief') : ''}`;
  $('#ptab-chat').innerHTML = `Chat${busy ? spark(16, false, 'answering') : ''}`;
  $('#ptab-review').innerHTML = `Marks${open + ghOpen ? ` <span class="pill">${open + ghOpen}</span>` : ''}`;
}
export function renderPanel() {
  renderTabs();
  for (const b of $$('.ptabs .tab')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  const body = $('#pbody');
  const keep = body.scrollTop;
  if (S.tab === 'chat') return renderChat(body);
  if (S.tab === 'review') renderReview(body); else renderOverview(body);
  body.scrollTop = keep;
}
const gh = () => S.github?.pr || null;
const pill = (cls, text, title = '') => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;

// ------------------------------------------------------------------ overview
function prState(p) {
  if (p.state === 'MERGED') return pill('', 'merged');
  if (p.state === 'CLOSED') return pill('danger', 'closed');
  return p.isDraft ? pill('', 'draft') : pill('', 'open');
}
function checksPill(p) {
  const c = p.checkSummary;
  if (!c || !p.checks.length) return '';
  if (c.fail) return `<button class="pill danger" data-act="gochecks" title="Checks">✕ ${c.fail} failing</button>`;
  if (c.run) return `<button class="pill" data-act="gochecks" title="Checks">● ${c.run} running</button>`;
  return `<button class="pill ok" data-act="gochecks" title="Checks">✓ ${c.pass} passed</button>`;
}
function decisionPill(p) {
  return { APPROVED: pill('ok', 'approved'), CHANGES_REQUESTED: pill('danger', 'changes requested'), REVIEW_REQUIRED: pill('', 'review required') }[p.reviewDecision] || '';
}
function mergeLine(p) {
  if (p.state !== 'OPEN') return '';
  const why = { BLOCKED: 'blocked (reviews or checks)', BEHIND: 'behind its base', DIRTY: 'has conflicts', UNSTABLE: 'checks failing', CLEAN: 'ready to merge', HAS_HOOKS: 'ready to merge', DRAFT: 'still a draft', UNKNOWN: 'being worked out' }[p.mergeStateStatus] || '';
  return why ? `<span class="faint">Merge: ${why}</span><a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">merge on GitHub ${I.ext}</a>` : '';
}
function reviewersHTML(p) {
  if (!p.reviewers?.length) return '';
  const mark = { approved: 'ok', 'changes requested': 'danger', commented: '', dismissed: '', requested: '' };
  return `<div class="row">${p.reviewers.map((r) => `<span class="pill ${mark[r.state] ?? ''}" title="${esc(r.state)}">${esc(r.login)}${r.state === 'requested' ? ' · requested' : r.state === 'approved' ? ' ✓' : r.state === 'changes requested' ? ' ✕' : ''}</span>`).join('')}</div>`;
}
function headHTML() {
  const m = S.ws, p = gh();
  if (m.kind === 'pr') {
    const t = p || m.pr;
    return `<div class="prhead"><div class="row">${p ? prState(p) : ''}${p ? checksPill(p) : ''}${p ? decisionPill(p) : ''}<span class="sp"></span><a href="${esc(t.url)}" target="_blank" rel="noopener" title="Open on GitHub" class="link">${I.github} GitHub</a></div><h1>${esc(t.title)}</h1>` +
      `<div class="row"><span class="by">#${t.number} by ${avatar(t.author)}<b>${esc(t.author)}</b></span><span class="chip" title="${esc(t.headRefName)}">${esc(t.headRefName)}</span><span class="faint">→</span><span class="chip" title="${esc(t.baseRefName)}">${esc(t.baseRefName)}</span></div>` +
      (p ? reviewersHTML(p) : '') + (p ? `<div class="row">${mergeLine(p)}</div>` : '') +
      (t.labels?.length ? `<div class="row">${t.labels.map((l) => `<span class="pill">${esc(l)}</span>`).join('')}</div>` : '') + `</div>`;
  }
  const behind = p && p.headRefOid !== m.headFull ? `<div class="warnline">GitHub has ${p.headRefOid.slice(0, 7)}, this checkout is at ${m.head.slice(0, 7)}</div>` : '';
  const prCard = p ? `<div class="card prcard"><div class="row"><span class="by">${I.pr}<b>#${p.number}</b>${avatar(p.author)}<span>${p.viewerIsAuthor ? 'you' : esc(p.author || '')}</span></span><span class="sp"></span><button class="btn sm" data-act="openprws" title="Open the pull request as GitHub has it">Open the PR</button></div>` +
    `<div class="row">${prState(p)}${checksPill(p)}${decisionPill(p)}</div><div class="ptitle" title="${esc(p.title)}">${esc(p.title)}</div>${behind}</div>` : '';
  return `<div class="prhead"><h1>${esc(m.branch)}</h1><div class="row"><span>into</span><button class="chip" data-act="basemenu" title="Compare with another branch">${esc(m.base)}${I.chev}</button><span>${plural(m.commits.length, 'commit')}</span>${m.dirty ? `<span class="pill warn">${plural(m.dirty, 'uncommitted file')}</span>` : ''}</div><div class="path" title="${esc(m.root)}"><bdi dir="ltr">${esc(m.root)}</bdi></div></div>${prCard}`;
}
// A brief written before 20 Nov can hold its TLDR as a JSON array of sentences.
const tldrText = (t) => {
  if (Array.isArray(t)) return t.join(' ');
  if (typeof t === 'string' && t.trim().startsWith('[')) { try { const a = JSON.parse(t); if (Array.isArray(a)) return a.join(' '); } catch { /* prose that starts with a bracket */ } }
  return t || '';
};
function tldrHTML() {
  const b = S.review.brief;
  const write = (label) => `<div class="row"><button class="link" data-act="brief">${label}</button>${briefRunBtn()}</div>`;
  if (b?.pending) return `<div class="card tldr"><div class="working big">${modelKind(briefRun().model) === 'claude' ? spark(32) : ''}<span class="shimmer" style="${shimmerSync()}">${b.step ? `Reading ${esc(b.step)}` : `Reading the change and the code around it${b.tldr ? ' again' : ''}…`}</span></div>${b.tldr ? `<div class="md">${md(tldrText(b.tldr), { images: modelKind(b.model) !== 'codex' })}</div>` : ''}</div>`;
  if (!b?.tldr) {
    return `<div class="card tldr"><div class="empty"><p class="big">No brief yet.</p><p>The model you pick reads the change and the code around it, then writes what it does and why, how that part of the system works, a map with the change marked on it, and how to review it.</p>${b?.error ? `<p class="err">${esc(b.error)}</p>` : ''}</div>${write('Write the brief')}</div>`;
  }
  const risk = { low: 'ok', typical: '', high: 'warn', 'very high': 'danger' }[b.risk] ?? '';
  return `<div class="card tldr">` +
    (b.stale ? `<div class="banner warn tight"><span>Written for an earlier version of the change.</span><span class="sp"></span><button class="btn sm" data-act="brief">Regenerate</button></div>` : '') +
    `<div class="md">${md(tldrText(b.tldr), { images: modelKind(b.model) !== 'codex' })}</div><div class="risk"><span class="pill ${risk}">${esc(b.risk)} risk</span><span>${md(b.riskWhy || '', { images: modelKind(b.model) !== 'codex' }).replace(/^<p>|<\/p>\s*$/g, '')}</span></div>` +
    (b.startHere ? `<div class="risk"><span class="faint">Start with</span><button class="chip" data-act="gofile" data-p="${esc(b.startHere)}"><span>${esc(b.startHere)}</span></button></div>` : '') +
    (b.context?.system || b.diagrams?.length ? `<div class="risk"><button class="link" data-act="gomap">The map of this change, above the code</button></div>` : '') +
    `<div class="mfoot"><span>${esc(modelName(b.model))} · ${esc(b.effort)}${b.ms ? ' · ' + (b.ms / 1000).toFixed(0) + ' s' : ''}${b.cost ? ' · $' + b.cost.toFixed(2) : ''} · ${ago(b.at)}</span></div>` +
    `<div class="row rebrief"><span class="sp"></span>${briefRunBtn()}<button class="link" data-act="brief" title="Write the guide and the map again with this model">Regenerate</button></div>` +
    (b.error ? `<div class="err">${esc(b.error)}</div>` : '') + `</div>`;
}
function descHTML() {
  const body = (gh() || S.ws.pr)?.body?.trim();
  if (!body) return '';
  const open = pref.get('descOpen', body.length < 1500);
  return `<details class="sect" ${open ? 'open' : ''} data-pref="descOpen"><summary class="sh">DESCRIPTION</summary><div class="card md">${md(body)}</div></details>`;
}
function checksHTML() {
  const p = gh();
  if (!p?.checks?.length) return '';
  const order = { fail: 0, run: 1, pass: 2, skip: 3 };
  const list = [...p.checks].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const glyph = { fail: '<span class="fail">✕</span>', run: '<span>●</span>', pass: '<span>✓</span>', skip: '<span class="faint">–</span>' };
  const c = p.checkSummary;
  return `<details class="sect" id="checks" data-pref="checksOpen" ${pref.get('checksOpen', false) ? 'open' : ''}><summary class="sh">CHECKS<span class="n">${[c.fail && `${c.fail} failing`, c.run && `${c.run} running`, `${c.pass} passed`, c.skip && `${c.skip} skipped`].filter(Boolean).join(' · ')}</span></summary>` +
    `<div class="clist">${list.map((k) => `<a class="citem" ${k.url ? `href="${esc(k.url)}" target="_blank" rel="noopener"` : ''}><span>${glyph[k.kind]}</span><span class="x">${esc(k.workflow ? `${k.workflow} / ${k.name}` : k.name)}</span><span class="s">${esc(k.state)}</span></a>`).join('')}</div></details>`;
}
function conversationHTML() {
  const p = gh();
  if (!p) return S.github?.error ? `<div class="sect"><div class="sh">ON GITHUB</div><div class="err">${esc(S.github.error)}</div></div>` : '';
  const badge = { APPROVED: pill('ok', 'approved'), CHANGES_REQUESTED: pill('danger', 'requested changes'), COMMENTED: pill('', 'reviewed'), DISMISSED: pill('', 'dismissed') };
  const items = p.timeline.map((t) => `<div class="card tl"><div class="mmeta">${avatar(t.author)}<span class="who">${esc(t.author)}</span>${t.kind === 'review' ? badge[t.state] || '' : ''}<span class="t">${ago(Date.parse(t.at))}</span><span class="sp"></span>${t.url ? `<a class="link" href="${esc(t.url)}" target="_blank" rel="noopener" title="On GitHub">${I.ext}</a>` : ''}</div>${t.body?.trim() ? `<div class="md">${md(t.body)}</div>` : ''}</div>`).join('');
  const canComment = p.state === 'OPEN' || p.state === 'CLOSED';
  return `<div class="sect"><div class="sh">CONVERSATION<span class="n">${p.timeline.length}</span><span class="sp"></span><button class="link" data-act="ghrefresh" title="Read GitHub again">${I.refresh}</button></div>${items || '<div class="faint">No comments yet.</div>'}` +
    (canComment ? `<div class="composer" id="commentbox"><textarea rows="2" placeholder="Comment on #${p.number}…" aria-label="Comment on the pull request">${esc(S.commentDraft || '')}</textarea><div class="row"><span class="hint">posted on GitHub as ${esc(p.viewer || 'you')}</span><span class="sp"></span><button class="btn sm primary" data-act="ghcomment">Comment <kbd>⌘↵</kbd></button></div></div>` : '') + `</div>`;
}
function renderOverview(body) {
  body.innerHTML = `<div class="pane">${headHTML()}${stackHTML()}<div class="sect"><div class="sh">TLDR</div>${tldrHTML()}</div>${descHTML()}${checksHTML()}${conversationHTML()}</div>`;
}
// The stack this change is part of, bottom (nearest the trunk) to top: each a row that opens it, this one marked.
function stackHTML() {
  const s = S.stack;
  if (!s?.items?.length || s.items.length < 2) return '';
  const kind = s.kind === 'github' ? `GitHub stack #${s.stackNumber}` : s.kind === 'chain' ? 'PRs based on each other' : 'branches built on each other';
  const state = (it) => (it.merged ? 'merged' : it.state === 'closed' ? 'closed' : it.draft ? 'draft' : it.pr ? 'open' : 'local');
  return `<div class="sect stack"><div class="sh">STACK<span class="n" title="${esc(kind)}">${s.items.length}</span></div>` +
    s.items.map((it, i) => `<button class="srow${it.here ? ' here' : ''}" data-act="stackopen" data-si="${i}" title="${esc(it.title || it.branch || '')}"><span class="no">${it.pr ? `#${it.pr}` : ''}</span><span class="b">${esc(it.title || String(it.branch || '').split('/').pop())}</span><span class="ss">${it.here ? 'this one' : state(it)}</span></button>`).join('') +
    (S.ws.trunkMergeBase ? `<button class="link" data-act="scope" data-scope="${S.rangeKey === 'stack' ? 'all' : 'stack'}">${S.rangeKey === 'stack' ? 'Back to this change alone' : 'Read the whole stack together'}</button>` : '') + '</div>';
}

// ------------------------------------------------------------------ chat
const chats = () => S.review.chats.map(convOf).filter(Boolean);
function renderChat(body) {
  let conv = convOf(S.chat);
  if (!conv) { conv = chats().at(-1) || null; S.chat = conv?.id || null; }
  const title = conv ? conv.title || (conv.linked ? conv.linked.title : 'New chat') : 'New chat';
  const linked = conv?.linked;
  const empty = `<div class="pane"><div class="empty"><p class="big">Ask about the whole change.</p>` +
    `<p>Select lines in the diff and press <kbd>l</kbd> to put them in your question. Questions about a few lines can also stay at those lines: press <kbd>a</kbd> instead.</p>` +
    `<p>Link a Claude Code session to ask the session that wrote the code: it answers from what it already knows, as a read-only fork, and the session itself is left alone.</p>` +
    `<p><button class="link" data-act="linkpick">${I.link} Link a Claude Code session</button></p></div></div>`;
  body.innerHTML = `<div class="pane fill"><div class="chathead"><button class="btn ghost chatpick" data-act="chatpick" title="${esc(title)}">${linked ? I.link : I.chat}<span class="l">${esc(title)}</span>${I.chev}</button>` +
    `<button class="icon sm" data-act="newchat" title="New chat">${I.plus}</button></div>` +
    `<div class="chatlog" id="chatlog">${linked ? linkbarHTML(linked) : ''}` +
    (conv?.messages.length ? `<div data-conv="${conv.id}">${conv.messages.map((m) => msgHTML(m)).join('')}</div>` : empty) + `</div>` +
    `<div class="chatfoot">${attachHTML()}<div class="composer" id="chatbox"><textarea rows="2" placeholder="${linked ? 'Ask the session…' : 'Ask about the change…'}" aria-label="Question about the change"></textarea>` +
    `<div class="row">${linked?.live ? '<span class="hint">the live session picks its own model</span>' : runBtn(conv?.model ? { model: conv.model, effort: conv.effort } : lastRun(), { conv })}<span class="sp"></span>` +
    `<button class="btn sm primary" data-act="chatsend">Send <kbd>⌘↵</kbd></button></div></div></div></div>`;
  const log = $('#chatlog');
  log.scrollTop = log.scrollHeight;
  const ta = $('#chatbox textarea');
  ta.value = S.chatDraft || '';
  grow(ta);
  if (S.focusChat) { ta.focus(); S.focusChat = false; }
}
function linkbarHTML(l) {
  const name = `<b>${esc(l.title || l.sessionId.slice(0, 8))}</b>`;
  if (l.live) return `<div class="linkbar">${I.link}<span>Live: questions go into ${name} as prompts, and it answers with its own tools and permissions. Its answers come back here.</span></div>`;
  return `<div class="linkbar">${I.link}<span>A read-only fork of ${name}${l.branch ? ` on ${esc(l.branch)}` : ''}${l.tokens ? `. It starts with ~${Math.round(l.tokens / 1000)}k tokens of context: the first question pays for all of it, later ones read it from cache` : ''}. The session itself is untouched.</span></div>`;
}
function attachHTML() {
  if (!S.attach.length) return '';
  return `<div class="attach">${S.attach.map((a, i) => `<span class="chip" data-act="goatt" data-p="${esc(a.path)}" data-l="${a.line}" data-side="${a.side}"><span>${esc(a.path.split('/').pop())} ${esc(a.label)}</span><button class="x" data-act="unattach" data-i="${i}" aria-label="Remove">×</button></span>`).join('')}</div>`;
}
export function openChat() { S.focusChat = true; setTab('chat'); }

async function chatSend() {
  const ta = $('#chatbox textarea');
  const text = ta.value.trim();
  if (!text) return;
  let conv = convOf(S.chat);
  const run = conv?.linked?.live ? {} : runOf($('#chatbox'));
  rememberRun(run);
  try {
    if (!conv) {
      const r = await api(wsApi('/chats'), { method: 'POST', body: {} });
      conv = S.review.convs[r.conv.id] = r.conv;
      if (!S.review.chats.includes(conv.id)) S.review.chats.push(conv.id);
      S.chat = conv.id;
    }
    const attachments = S.attach;
    S.attach = []; S.chatDraft = ''; ta.value = '';
    await api(`/api/w/${S.id}/convs/${conv.id}/messages`, { method: 'POST', body: { text, attachments, ...run } });
  } catch (e) { toast(e.message); ta.value = text; }
}

function chatPicker(btn) {
  const items = [
    ...chats().slice().reverse().map((c) => ({ two: [c.title || (c.linked ? c.linked.title : 'New chat'), `${c.linked ? 'linked session · ' : ''}${plural(c.messages.filter((m) => m.role === 'user').length, 'question')} · ${ago(c.messages.at(-1)?.at || c.created)}`], value: { open: c.id }, current: c.id === S.chat, icon: c.linked ? I.link : I.chat })),
    { sep: true },
    { label: 'New chat', value: { new: true }, icon: I.plus },
    { label: 'Link a Claude Code session…', value: { link: true }, icon: I.link },
    ...(S.chat ? [{ sep: true }, { label: 'Delete this chat', value: { del: S.chat }, danger: true }] : []),
  ];
  menu(btn, items, (it) => {
    if (it.value.open) { S.chat = it.value.open; renderPanel(); }
    if (it.value.new) newChat();
    if (it.value.link) linkPicker(btn);
    if (it.value.del) deleteChat(it.value.del);
  }, { width: 360 });
}
async function newChat() {
  const r = await api(wsApi('/chats'), { method: 'POST', body: {} });
  S.review.convs[r.conv.id] = r.conv;
  if (!S.review.chats.includes(r.conv.id)) S.review.chats.push(r.conv.id);
  S.chat = r.conv.id; S.focusChat = true;
  renderPanel();
}
async function deleteChat(id) {
  if (!confirm('Delete this chat? Its saved session stays on disk; only loupe forgets it.')) return;
  await api(`/api/w/${S.id}/convs/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
  delete S.review.convs[id];
  S.review.chats = S.review.chats.filter((x) => x !== id);
  S.chat = null;
  renderPanel();
}
async function linkPicker(btn) {
  let list, live;
  try { ({ sessions: list, live } = await api(wsApi('/sessions'))); } catch (e) { return toast(e.message); }
  if (!list.length && !live.length) return toast('No Claude Code sessions found for this repository.');
  const items = [
    ...(live.length ? [{ header: 'LIVE SESSIONS' }, ...live.map((s) => ({ two: [s.title || s.sessionId.slice(0, 8), `talk to the running session · ${s.cwd}`], value: { ...s, live: true }, icon: I.chat }))] : []),
    { header: 'FORK A SESSION' }, ...list.map((s) => ({
      two: [s.title, `${s.onBranch ? 'this branch · ' : s.branch ? s.branch + ' · ' : ''}${ago(s.at)}${s.tokens ? ` · ~${Math.round(s.tokens / 1000)}k tokens` : ''}`], value: s,
    }))];
  menu(btn, items, async (it) => {
    try {
      const r = await api(wsApi('/chats'), { method: 'POST', body: { link: it.value } });
      S.review.convs[r.conv.id] = r.conv;
      if (!S.review.chats.includes(r.conv.id)) S.review.chats.push(r.conv.id);
      S.chat = r.conv.id; S.focusChat = true;
      setTab('chat');
    } catch (e) { toast(e.message); }
  }, { width: 460 });
}

// ------------------------------------------------------------------ review
function markRow(th) {
  const conv = convOf(th.conv) || { messages: [] };
  const first = conv.messages.find((m) => m.role === 'user')?.text || '';
  const answers = conv.messages.filter((m) => m.role !== 'user');
  const status = conv.messages.some((m) => m.pending) ? 'answering…' : answers.length ? plural(answers.length, 'answer') : 'no answer';
  return `<button class="nrow ${th.kind}${th.resolved || th.posted ? ' resolved' : ''}" data-act="gothread" data-t="${th.id}" title="${esc(oneLine(first, 600))}"><span class="k"></span><span class="w" title="${esc(th.path)}">${esc(th.path.split('/').pop())} · ${esc(th.label)}</span><span class="q">${esc(oneLine(first, 300))}</span><span class="s">${esc(status)} · ${ago(th.created)}</span></button>`;
}
// GitHub's threads follow the same Open / Resolved filter as your questions, so the counts agree with the tab's badge.
const ghIn = (show) => (S.github?.threads || []).filter((x) => (show === 'resolved' ? x.resolved : !x.resolved));
function githubThreadsHTML(show, head) {
  const t = ghIn(show);
  if (!t.length) return '';
  return `<div class="sect"><div class="sh">ON GITHUB<span class="n">${t.length}</span></div>` +
    t.map((x) => `<button class="nrow gh${x.resolved ? ' resolved' : ''}" data-act="ghopen" data-g="${esc(x.id)}" data-p="${esc(x.path)}" data-l="${x.outdated ? 0 : x.line || 0}"><span class="k"></span><span class="w" title="${esc(x.path)}">${esc(x.path.split('/').pop())} · ${x.outdated ? 'outdated' : `line ${x.line}`}</span><span class="q">${esc(x.comments[0]?.author || '')}: ${esc(oneLine(x.comments[0]?.body, 300))}</span><span class="s">${plural(x.comments.length, 'comment')} · ${ago(Date.parse(x.comments.at(-1)?.at || 0))}</span></button>`).join('') + `</div>`;
}
// ------------------------------------------------------------------ one mark, opened: the conversation where it reads well
// The quoted lines on top (so you never need to look back at the code to know what it is about), the conversation,
// and the follow-up box docked at the bottom. The mark's lines stay lit in the code while it is open.
function quoteHTML(path, side, from, to, fallback) {
  const rows = (S.rows.get(path) || S.waves.get(path) || []).filter((r) => !r.hdr && (side === 'old' ? r.t === '-' && r.o >= from && r.o <= to : r.t !== '-' && r.n >= from && r.n <= to));
  const shown = rows.length ? rows.slice(0, 12).map((r) => ({ t: r.t, n: side === 'old' ? r.o : r.n, s: r.s })) : (fallback || []).slice(0, 12).map((r, i) => ({ t: r.t, n: from + i, s: r.s }));
  if (!shown.length) return '';
  return `<div class="quote" data-act="markgo">${shown.map((r) => `<div class="ql ${r.t === '+' ? 'a' : r.t === '-' ? 'd' : ''}"><span class="no">${r.n ?? ''}</span><span class="tx">${esc(r.s)}</span></div>`).join('')}${rows.length > 12 ? `<div class="ql more">${rows.length - 12} more lines</div>` : ''}</div>`;
}
function renderMark(body) {
  const id = S.mark;
  if (id.startsWith('gh:')) return renderGhMark(body, id.slice(3));
  const th = S.review.threads.find((t) => t.id === id);
  if (!th) { S.mark = null; return renderReview(body); }
  const conv = convOf(th.conv) || { messages: [] };
  body.innerHTML = `<div class="pane fill markview"><div class="mhead"><button class="link" data-act="markback">${I.chevL} Marks</button><span class="sp"></span>` +
    `<button class="link" data-act="markresolve">${th.resolved ? 'Reopen' : 'Resolve'}</button><button class="link danger" data-act="markdel">Delete</button></div>` +
    `<div class="chatlog" id="marklog"><div class="mtitle"><span class="kind ask">Question</span><button class="loc" data-act="markgo" title="${esc(th.path)} · ${esc(th.label)}: go to the lines"><bdi dir="ltr">${esc(th.path)} · ${esc(th.label)}</bdi></button>${th.resolved ? '<span class="pill">resolved</span>' : ''}</div>` +
    quoteHTML(th.path, th.side, th.startLine || th.line, th.line, th.preview) +
    `<div data-conv="${th.conv}">${conv.messages.map((m) => msgHTML(m)).join('')}</div></div>` +
    `<div class="chatfoot"><div class="composer" id="markbox" data-t="${th.id}"><textarea rows="2" placeholder="Ask a follow-up" aria-label="Follow-up question">${esc(S.replyDrafts[th.id] || '')}</textarea>` +
    `<div class="row">${runBtn(conv.model ? { model: conv.model, effort: conv.effort } : lastRun(), { conv })}<span class="sp"></span>` +
    `<button class="btn sm primary" data-act="markask">Ask <kbd>⌘↵</kbd></button>` +
    `</div></div></div></div>`;
  const log = $('#marklog'); log.scrollTop = 0;
  const ta = $('#markbox textarea'); grow(ta);
}
function renderGhMark(body, gid) {
  const t = (S.github?.threads || []).find((x) => x.id === gid);
  if (!t) { S.mark = null; return renderReview(body); }
  const first = t.comments[0];
  const mine = (t.comments || []).find((c) => c.pending);
  body.innerHTML = `<div class="pane fill markview"><div class="mhead"><button class="link" data-act="markback">${I.chevL} Marks</button><span class="sp"></span>` +
    `<button class="link" data-act="ghask">Ask about it</button>` + (mine ? `<button class="link danger" data-act="ghdrop" data-n="${esc(mine.nodeId)}">Delete</button>` : t.resolved ? (t.canUnresolve ? `<button class="link" data-act="ghresolve" data-on="0">Reopen</button>` : '') : t.canResolve ? `<button class="link" data-act="ghresolve" data-on="1">Resolve</button>` : '') + `</div>` +
    `<div class="chatlog" id="marklog"><div class="mtitle"><span class="kind gh">${t.pending ? 'Your review · pending' : 'GitHub'}</span><button class="loc" data-act="markgo" title="${esc(t.path)}: go to the lines"><bdi dir="ltr">${esc(t.path)} · ${t.startLine && t.startLine !== t.line ? `lines ${t.startLine}–${t.line}` : `line ${t.line}`}</bdi></button>${t.resolved ? '<span class="pill">resolved</span>' : ''}</div>` +
    quoteHTML(t.path, t.side, t.startLine || t.line, t.line) +
    t.comments.map((c) => `<div class="msg"><div class="mmeta"><span class="who">${esc(c.author)}</span><span class="t">${ago(Date.parse(c.at))}</span><span class="sp"></span><a class="link" href="${esc(c.url)}" target="_blank" rel="noopener" title="On GitHub">${I.ext}</a></div><div class="md">${md(c.body || '')}</div></div>`).join('') + `</div>` +
    (t.pending ? `<p class="hint pendnote">Only you see this until you submit your review (Submit review, top right).</p>` : '') +
    (t.canReply && first && !t.pending ? `<div class="chatfoot"><div class="composer" id="ghbox" data-cid="${first.id}"><textarea rows="2" placeholder="Reply on GitHub" aria-label="Reply on GitHub">${esc(S.replyDrafts['gh:' + gid] || '')}</textarea><div class="row"><span class="hint">posted on GitHub as ${esc(S.github?.pr?.viewer || 'you')}</span><span class="sp"></span><button class="btn sm primary" data-act="ghreply">Reply <kbd>⌘↵</kbd></button></div></div></div>` : '') + `</div>`;
}
export function openMark(id) {
  const prev = S.mark;
  S.mark = id;
  if (S.unreadAns.delete(id)) hooks.renderTree?.();
  hooks.showPanel?.();
  S.tab = 'review'; pref.set('tab', 'review');
  renderPanel();
  for (const x of new Set([markPath(prev), markPath(id)])) if (x && S.rows.has(x)) renderBody(x);
}
export function closeMark() {
  const p = markPath(S.mark);
  S.mark = null;
  renderPanel();
  if (p && S.rows.has(p)) renderBody(p);
}
const markPath = (id) => (!id ? null : id.startsWith('gh:') ? (S.github?.threads || []).find((t) => t.id === id.slice(3))?.path : S.review.threads.find((t) => t.id === id)?.path);
async function markReply(ask) {
  const th = S.review.threads.find((t) => t.id === S.mark);
  const ta = $('#markbox textarea');
  const text = ta?.value.trim();
  if (!th || !text) return ta?.focus();
  const run = runOf($('#markbox')); rememberRun(run);
  ta.value = ''; grow(ta); delete S.replyDrafts[th.id];
  try { await api(`/api/w/${S.id}/convs/${th.conv}/messages`, { method: 'POST', body: { text, ask, ...run, scope: S.scope } }); }
  catch (e) { toast(e.message); ta.value = text; }
}
Object.assign(hooks, { openMark, closeMark, markChanged: () => { if (S.mark && S.tab === 'review') renderPanel(); } });

function renderReview(body) {
  if (S.mark) return renderMark(body);
  const show = pref.get('marksShow', 'open') === 'resolved' ? 'resolved' : 'open';
  const live = (t) => !t.resolved && !t.posted;
  const ths = S.review.threads.filter((t) => (show === 'resolved' ? !live(t) : live(t))).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const gh = ghIn(show);
  // the badge on the tab, the two counts here and the lists below all count your questions and GitHub's threads together
  const ghAll = S.github?.threads || [];
  const counts = { open: S.review.threads.filter(live).length + ghAll.filter((x) => !x.resolved).length, resolved: S.review.threads.filter((t) => !live(t)).length + ghAll.filter((x) => x.resolved).length };
  body.innerHTML = `<div class="pane"><div class="sect"><div class="bar"><span class="seg"><button data-act="nshow" data-v="open" aria-pressed="${show === 'open'}">Open ${counts.open}</button><button data-act="nshow" data-v="resolved" aria-pressed="${show === 'resolved'}">Resolved ${counts.resolved}</button></span><span class="sp"></span>` +
    `<button class="btn sm ghost" data-act="markshide" title="${S.marksHidden ? 'Show the marks in the code' : 'Hide the marks in the code; the gutter ticks stay'} (m)">${S.marksHidden ? 'Show in code' : 'Hide in code'}</button>` +
    `</div>` +
    (ths.length ? `<div>${ths.map(markRow).join('')}</div>` : gh.length ? '' : `<div class="empty"><p>${show === 'resolved' ? 'Nothing resolved yet.' : 'No open marks.'}</p><p>Select lines (drag the <b>+</b> or click line numbers), then <kbd>a</kbd> to ask about them.</p></div>`) + `</div>` +
    githubThreadsHTML(show) + `</div>`;
}

// Write the brief (the guide and the map) again, on the model and effort chosen in the Overview. The old one stays on
// screen until the new one lands.
export function rebrief() {
  if (S.review.brief?.pending) return;
  const run = briefRun();
  const id = S.id;
  const pending = S.review.brief = { ...(S.review.brief || {}), pending: true, error: null, step: null };
  const refresh = () => {
    if (S.tab === 'overview') renderPanel(); else renderTabs();
    hooks.briefPending?.();
    hooks.renderFab?.();
  };
  refresh();
  return api(wsApi('/brief'), { method: 'POST', body: run }).catch((err) => {
    if (S.id !== id || S.review.brief !== pending) return;
    S.review.brief = { ...pending, pending: false, error: err.message };
    refresh();
    toast(err.message);
  });
}
hooks.rebrief = rebrief;
hooks.briefStep = () => { const t = $('#panel .card.tldr .shimmer'), b = S.review.brief; if (t && b?.step) t.textContent = `Reading ${b.step}`; };

// ------------------------------------------------------------------ events
$('#root').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !b.closest('#panel')) return;
  const act = b.dataset.act;
  if (act === 'stop') {
    const id = b.closest('[data-conv]')?.dataset.conv;
    if (id) return api(wsApi(`/convs/${encodeURIComponent(id)}/stop`), { method: 'POST' }).catch((err) => toast(err.message));
    return;
  }
  if (act === 'brief') return rebrief();
  if (act === 'order') return hooks.setOrder?.(b.dataset.order);
  if (act === 'basemenu') return hooks.baseMenu?.(b);
  if (act === 'gofile') return hooks.goLoc?.({ path: b.dataset.p, line: Number(b.dataset.l) || 0 });
  if (act === 'scope') return hooks.setScope?.(b.dataset.scope);
  if (act === 'stackopen') { const i = Number(b.dataset.si); return S.stack?.items?.[i]?.here ? null : hooks.openStackItem?.(i); }
  if (act === 'gomap') { const m = $('#mapcard'); if (m) { m.classList.remove('shut'); pref.set('mapOpen', true); m.scrollIntoView({ block: 'start', behavior: 'smooth' }); } return; }
  if (act === 'chatpick') return chatPicker(b);
  if (act === 'newchat') return newChat();
  if (act === 'linkpick') return linkPicker(b);
  if (act === 'chatsend') return chatSend();
  if (act === 'unattach') { e.stopPropagation(); S.attach.splice(Number(b.dataset.i), 1); return renderPanel(); }
  if (act === 'nshow') { pref.set('marksShow', b.dataset.v); return renderPanel(); }
  if (act === 'gothread') return hooks.goThread?.(b.dataset.t);
  if (act === 'gochecks') return showChecks();
  if (act === 'ghrefresh') { b.disabled = true; S.github = await api(`/api/w/${S.id}/github?fresh=1`).catch((err) => { toast(err.message); return S.github; }); hooks.githubChanged?.(); return; }
  if (act === 'openprws') { const p = gh(); if (!p) return; try { const r = await api('/api/workspaces', { method: 'POST', body: { target: p.url } }); location.href = r.url; } catch (err) { toast(err.message); } return; }
  if (act === 'ghcomment') {
    const ta = $('#commentbox textarea'), text = ta.value.trim();
    if (!text) return ta.focus();
    const done = await hooks.act?.('comment', { body: text });
    if (done) { S.commentDraft = ''; ta.value = ''; }
    return;
  }
  if (act === 'markback') return closeMark();
  if (act === 'markshide') return hooks.toggleMarks?.();
  if (act === 'markgo') {
    const id = S.mark, gh = id?.startsWith('gh:') && (S.github?.threads || []).find((t) => t.id === id.slice(3));
    const th = !gh && S.review.threads.find((t) => t.id === id);
    const t = gh || th;
    return t && hooks.goLoc?.({ path: t.path, line: t.line, side: t.side });
  }
  if (act === 'markresolve') { const th = S.review.threads.find((t) => t.id === S.mark); if (th) { await setResolved(th, !th.resolved); renderPanel(); } return; }
  if (act === 'markdel') {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete it?'; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ''; b.textContent = 'Delete'; } }, 3000); return; }
    const th = S.review.threads.find((t) => t.id === S.mark); if (th) deleteMark(th); return;
  }
  if (act === 'markask') return markReply(true);
  if (act === 'ghopen') { hooks.goLoc?.({ path: b.dataset.p, line: Number(b.dataset.l) || 0 }); return openMark('gh:' + b.dataset.g); }
  const ght = S.mark?.startsWith('gh:') && (S.github?.threads || []).find((t) => t.id === S.mark.slice(3));
  if (ght && act === 'ghdrop') { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete it?'; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ''; b.textContent = 'Delete'; } }, 3000); return; } if (await hooks.act?.('dropcomment', { nodeId: b.dataset.n })) closeMark(); return; }
  if (ght && act === 'ghresolve') return hooks.act?.('resolve', { threadId: ght.id, resolved: b.dataset.on === '1' });
  if (ght && act === 'ghreply') {
    const box = $('#ghbox'), ta = box.querySelector('textarea'), text = ta.value.trim();
    if (!text) return ta.focus();
    if (await hooks.act?.('reply', { commentId: Number(box.dataset.cid), body: text })) { delete S.replyDrafts['gh:' + ght.id]; ta.value = ''; }
    return;
  }
  if (ght && act === 'ghask') {
    // A question about someone's comment: a new question at the same lines, with the comment as its context.
    const quote = ght.comments.map((c) => `${c.author}: ${c.body}`).join('\n\n');
    S.sel = null;
    S.draft = { path: ght.path, side: ght.side, line: ght.line, startLine: ght.startLine, anchorText: '', label: ght.startLine && ght.startLine !== ght.line ? `lines ${ght.startLine}–${ght.line}` : `line ${ght.line}`, snippet: `(a GitHub review thread on these lines)\n${quote.slice(0, 6000)}`, preview: [], kind: 'ask', value: 'What does this comment ask for, and is it right?', focus: true, run: lastRun() };
    await hooks.goLoc?.({ path: ght.path, line: ght.line, side: ght.side });
    return renderBody(ght.path);
  }
});
function focusComment() { setTab('overview'); requestAnimationFrame(() => { const ta = $('#commentbox textarea'); ta?.scrollIntoView({ block: 'center' }); ta?.focus(); }); }
function showChecks() { setTab('overview'); requestAnimationFrame(() => { const d = $('#checks'); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } }); }
// the palette reaches the chat from anywhere: a new one, or linking a session (its menu opens under the chat's picker)
const linkSession = () => { hooks.showPanel?.(); setTab('chat'); requestAnimationFrame(() => { const b = $('#panel [data-act="chatpick"]') || $('#panel [data-act="linkpick"]'); if (b) linkPicker(b); }); };
Object.assign(hooks, { focusComment, showChecks, newChat: () => { hooks.showPanel?.(); setTab('chat'); return newChat(); }, linkSession });
$('#root').addEventListener('toggle', (e) => { const d = e.target.closest?.('details[data-pref]'); if (d) pref.set(d.dataset.pref, d.open); }, true);
document.addEventListener('input', (e) => {
  const mb = e.target.closest?.('#markbox');
  if (mb) { if (e.target.value) S.replyDrafts[mb.dataset.t] = e.target.value; else delete S.replyDrafts[mb.dataset.t]; }
  if (e.target.closest?.('#ghbox') && S.mark) { if (e.target.value) S.replyDrafts[S.mark] = e.target.value; else delete S.replyDrafts[S.mark]; }
  if (e.target.closest?.('#chatbox')) S.chatDraft = e.target.value;
  if (e.target.closest?.('#commentbox')) S.commentDraft = e.target.value;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  if (e.target.closest?.('#chatbox')) { e.preventDefault(); chatSend(); }
  if (e.target.closest?.('#commentbox')) { e.preventDefault(); $('[data-act="ghcomment"]')?.click(); }
  if (e.target.closest?.('#markbox')) { e.preventDefault(); const th = S.review.threads.find((t) => t.id === S.mark); markReply(true); }
  if (e.target.closest?.('#ghbox')) { e.preventDefault(); $('[data-act="ghreply"]')?.click(); }
});

// A message changed: draw it wherever its conversation is on screen (its thread inline, or the chat).
export function paintMessage(convId, msg) {
  for (const box of $$(`[data-conv="${convId}"]`)) {
    const el = box.querySelector(`.msg[data-m="${CSS.escape(msg.id)}"]`);
    const log = box.closest('#chatlog');
    const atBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const was = el?.querySelector('.mmeta canvas.spark:not(.still)');
    if (el) el.outerHTML = msgHTML(msg); else box.insertAdjacentHTML('beforeend', msgHTML(msg));
    if (was && !msg.pending) box.querySelector(`.msg[data-m="${CSS.escape(msg.id)}"] .mmeta canvas.spark`)?.classList.add('landed');
    if (log && atBottom) log.scrollTop = log.scrollHeight;
  }
}
