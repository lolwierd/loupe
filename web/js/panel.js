// The inspector beside the diff, three questions:
//   Overview: what is this change, and what have others said about it? (PR header, checks, reviewers, the brief and
//             guide, the description, the conversation)
//   Chat:     talk to Claude about it (fresh, a fork of a Claude Code session, or the live session)
//   Review:   what have I marked? (your questions, and GitHub's threads). What you do about them, submitting
//             the review or handing the fixes back, is the top bar's next act, not a form here.
import { S, $, $$, esc, h, api, wsApi, I, pref, toast, convOf, lastRun, rememberRun, ago, plural, fileOf, modelName, briefRun } from './core.js';
import { md } from './md.js';
import { msgHTML, runBtn, briefRunBtn, runOf, grow, menu, shimmerSync, modelKind, verdict } from './ui.js';
import { isViewed, lines, setResolved, deleteMark, cardEl, renderBody, oneLine } from './cards.js';
import { hooks } from './hooks.js';
import { impressionHTML } from './stamp.js';
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
// The pull request as a list of facts under its title: each fact once, always in the same place, with the number that
// drove it at the right. GitHub's link, the author's face and the branch chips are gone: the top bar has the link, and
// nothing here is a control except the checks figures, which open the CHECKS list.
const who = (p, state) => (p.reviewers || []).filter((r) => r.state === state).map((r) => r.login);
const names = (a) => esc(a.length <= 2 ? a.join(' and ') : `${a[0]}, ${a[1]} and ${a.length - 2} more`);
function factsHTML(p, loading) {
  const rows = [];
  const row = (k, v, t = '', sub = '') => rows.push(`<span class="k">${k}</span><span class="v">${v}</span><span class="t">${t}</span>${sub ? `<span class="v sub">${sub}</span>` : ''}`);
  const wait = '<span class="q">…</span>';
  const v = loading ? null : verdict(p), c = p.checkSummary || { pass: 0, fail: 0, run: 0, skip: 0 };
  // state: the verdict, then what qualifies it; the date it got there at the right
  let state = wait, when = '';
  if (v) {
    state = `<span class="fv ${v.tone}">${esc(v.w)}</span>` + (p.state === 'MERGED' ? ` <span class="q">into ${esc(p.baseRefName)}</span>` : p.state === 'CLOSED' ? ' <span class="q">not merged</span>' : '') +
      (v.draft ? '<span class="dot">·</span><span class="fv">draft</span>' : '') + (v.why ? ` <span class="q">${esc(v.why)}</span>` : '');
    const at = p.state === 'MERGED' ? ['merged', p.mergedAt] : p.state === 'CLOSED' ? ['closed', p.closedAt] : ['opened', p.createdAt];
    when = at[1] ? `${at[0]} ${esc(ago(Date.parse(at[1])))}` : '';
  }
  row('state', state, when);
  // review: GitHub's decision, then who made it or who is asked
  let review = wait;
  if (v) {
    const ok = who(p, 'approved'), asked = who(p, 'changes requested'), req = who(p, 'requested');
    if (p.reviewDecision === 'CHANGES_REQUESTED' || (!p.reviewDecision && asked.length)) review = `<span class="fv warn">changes asked</span> ${names(asked)}`;
    else if (p.reviewDecision === 'APPROVED' || (!p.reviewDecision && ok.length)) review = `<span class="fv ok">approved</span> ${names(ok)}`;
    else if (p.reviewDecision === 'REVIEW_REQUIRED' && p.state !== 'OPEN') review = '<span class="q">not approved</span>';
    else if (p.reviewDecision === 'REVIEW_REQUIRED') review = req.length ? `needs approval <span class="q">· asked</span> ${names(req)}` : 'needs approval <span class="q">· nobody asked</span>';
    else review = req.length ? `<span class="q">asked</span> ${names(req)}` : '<span class="q">not required</span>';
  }
  row('review', review, '', v ? impressionHTML() : ''); // under GitHub's decision, your own: the impression of your approval
  // checks: every count that is not zero, the total at the right, the failing ones named underneath
  const total = c.pass + c.fail + c.run + c.skip;
  let checks = wait, failing = '';
  if (v && !total) checks = '<span class="q">none</span>';
  else if (v) {
    const figs = [c.fail && `<span class="bad">${c.fail} failing</span>`, c.run && `<span class="fv">${c.run} running</span>`, `<span class="good">${c.pass} passed</span>`, c.skip && `<span class="q">${c.skip} skipped</span>`].filter(Boolean);
    checks = `<button class="figs" data-act="gochecks" title="The ${total} checks">${figs.join('<span class="dot">·</span>')}</button>`;
    const bad = (p.checks || []).filter((k) => k.kind === 'fail').map((k) => k.name);
    if (bad.length) failing = esc(bad.length <= 3 ? bad.join(', ') : `${bad.slice(0, 3).join(', ')} and ${bad.length - 3} more`);
  }
  row('checks', checks, v && total ? String(total) : '', failing);
  row('branch', `<span class="pair mono" title="${esc(p.headRefName)} into ${esc(p.baseRefName)}">${esc(p.headRefName)}<span class="ar">→</span>${esc(p.baseRefName)}</span>`);
  row('author', `${esc(p.author || '')}${p.viewerIsAuthor ? ' <span class="q">· you</span>' : ''}`, `#${p.number}`);
  const assigned = (p.assignees || []).filter((a) => a !== p.author);
  if (assigned.length) row('assigned', `${names(assigned)}${p.viewer && assigned.includes(p.viewer) ? ' <span class="q">· you</span>' : ''}`);
  if (p.labels?.length) row('labels', esc(p.labels.join(' · ')));
  return `<div class="facts">${rows.join('')}</div>`;
}
function headHTML() {
  const m = S.ws, p = gh();
  if (m.kind === 'pr') {
    const t = p || m.pr;
    return `<div class="prhead"><h1>${esc(t.title)}</h1>${factsHTML(t, !p)}</div>`;
  }
  const behind = p && p.headRefOid !== m.headFull ? `<div class="warnline">GitHub has ${p.headRefOid.slice(0, 7)}, this checkout is at ${m.head.slice(0, 7)}</div>` : '';
  const prCard = p ? `<div class="card prcard"><div class="row"><span class="by">${I.pr}<b>#${p.number}</b>${avatar(p.author)}<span>${p.viewerIsAuthor ? 'you' : esc(p.author || '')}</span></span><span class="sp"></span><button class="btn sm" data-act="openprws" title="Open the pull request as GitHub has it">Open the PR</button></div>` +
    `<div class="row">${prState(p)}${checksPill(p)}${decisionPill(p)}</div><div class="ptitle" title="${esc(p.title)}">${esc(p.title)}</div>${behind}${impressionHTML()}</div>` : '';
  return `<div class="prhead"><h1>${esc(m.branch)}</h1><div class="row"><span>into</span><button class="runpick mono" data-act="basemenu" title="Compare with another branch"><span>${esc(m.base)}</span>${I.chev}</button><span>${plural(m.commits.length, 'commit')}</span>${m.dirty ? `<span class="pill warn">${plural(m.dirty, 'uncommitted file')}</span>` : ''}</div><div class="path" title="${esc(m.root)}"><bdi dir="ltr">${esc(m.root)}</bdi></div></div>${prCard}`;
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
  if (b?.pending) return `<div class="card tldr"><div class="working big">${modelKind(briefRun().model) === 'claude' ? spark(32) : ''}<span class="shimmer" style="${shimmerSync()}">${b.step ? `Reading ${esc(b.step)}` : `Reading the change and the code around it${b.tldr ? ' again' : ''}…`}</span></div>${b.tldr ? `<div class="md">${md(tldrText(b.tldr), { images: modelKind(b.model) !== 'codex', citations: b.citations })}</div>` : ''}</div>`;
  if (!b?.tldr) {
    return `<div class="card tldr"><div class="empty"><p class="big">No brief yet.</p><p>The model you pick reads the change and the code around it, then writes what it does and why, how that part of the system works, a map with the change marked on it, and how to review it.</p>${b?.error ? `<p class="err">${esc(b.error)}</p>` : ''}</div>${write('Write the brief')}</div>`;
  }
  const risk = { low: 'ok', typical: '', high: 'warn', 'very high': 'danger' }[b.risk] ?? '';
  return `<div class="card tldr">` +
    (b.stale ? `<div class="banner warn tight"><span>Written for an earlier version of the change.</span><span class="sp"></span><button class="btn sm" data-act="brief">Regenerate</button></div>` : '') +
    `<div class="md">${md(tldrText(b.tldr), { images: modelKind(b.model) !== 'codex', citations: b.citations })}</div><div class="risk"><span class="pill ${risk}">${esc(b.risk)} risk</span><span>${md(b.riskWhy || '', { images: modelKind(b.model) !== 'codex', citations: b.citations }).replace(/^<p>|<\/p>\s*$/g, '')}</span></div>` +
    (b.startHere ? `<div class="risk"><span class="faint">Start with</span><button class="chip" data-act="gofile" data-p="${esc(b.startHere)}"><span>${esc(b.startHere)}</span></button></div>` : '') +
    (b.context?.system || b.diagrams?.length ? `<div class="risk"><button class="link" data-act="gomap">The map of this change, above the code</button></div>` : '') +
    `<div class="mfoot"><span>${esc(modelName(b.model))} · ${esc(b.effort)}${b.ms ? ' · ' + (b.ms / 1000).toFixed(0) + ' s' : ''}${b.cost ? ' · $' + b.cost.toFixed(2) : ''} · ${ago(b.at)}</span></div>` +
    `<div class="row rebrief"><span class="sp"></span>${briefRunBtn()}<button class="link" data-act="brief" title="Write the guide and the map again with this model">Regenerate</button></div>` +
    (b.error ? `<div class="err">${esc(b.error)}</div>` : '') + `</div>`;
}
// The description at the panel's own size, as an outline. The lead (everything before the first heading, bold-only
// paragraph or <details>) shows whole blocks within 8 lines and says what it hides; each part after it is one row with
// what it holds (its items, or how many of its tasks are done) and opens in place. A body without parts is cut at 14
// lines. Which parts are open, and whether the lead is, last for the page's life, per workspace.
const LEAD_LINES = 8, BODY_LINES = 14;
const descOpen = new Map();
const descState = () => { let s = descOpen.get(S.id); if (!s) descOpen.set(S.id, (s = { lead: false, parts: new Set() })); return s; };
function descHTML() {
  const body = (gh() || S.ws.pr)?.body?.trim();
  if (!body) return '';
  return `<div class="sect"><div class="sh">DESCRIPTION</div><div class="md dmd" id="desc">${md(body)}</div></div>`;
}
const labelOf = (el) => (el ? el.textContent.trim() || el.querySelector('img[alt]')?.alt.trim() || '' : '');
const isHeading = (n) => /^H[1-6]$/.test(n.tagName) ||
  (n.tagName === 'P' && n.children.length === 1 && n.firstElementChild.matches('strong, b') && n.textContent.trim() === n.firstElementChild.textContent.trim());
function holds(nodes) {
  const boxes = nodes.flatMap((n) => (n.nodeType === 1 ? [...n.querySelectorAll('input[type="checkbox"]'), ...(n.matches('input[type="checkbox"]') ? [n] : [])] : []));
  if (boxes.length) return `<b>${boxes.filter((x) => x.checked).length}</b> of ${boxes.length} done`;
  const items = nodes.reduce((k, n) => k + (n.nodeType === 1 && n.matches('ul, ol') ? n.children.length : 0), 0);
  return items ? plural(items, 'item') : '';
}
function outlineDesc() {
  const box = $('#desc');
  if (!box) return;
  const st = descState(), lead = [], parts = [];
  for (const n of [...box.childNodes]) {
    if (n.nodeType !== 1 && !n.textContent.trim()) continue;
    if (n.nodeType === 1 && n.tagName === 'DETAILS') {
      const sum = n.querySelector(':scope > summary');
      parts.push({ name: labelOf(sum) || 'Details', nodes: [...n.childNodes].filter((x) => x !== sum) });
    } else if (n.nodeType === 1 && isHeading(n)) parts.push({ name: labelOf(n) || 'Section', nodes: [] });
    else if (parts.length) parts.at(-1).nodes.push(n);
    else lead.push(n);
  }
  // a heading with nothing under it is not a part
  for (let i = parts.length - 1; i >= 0; i--) if (!parts[i].nodes.some((x) => x.nodeType === 1 || x.textContent.trim())) parts.splice(i, 1);
  box.textContent = '';
  const leadEl = h('<div class="lead"></div>');
  leadEl.append(...lead);
  if (lead.length) box.append(leadEl);
  if (parts.length) {
    const list = h('<div class="parts"></div>');
    for (const [i, part] of parts.entries()) {
      const key = `${i}:${part.name}`, open = st.parts.has(key);
      const row = h(`<button class="fold${open ? '' : ' shut'}" data-act="descpart" aria-expanded="${open}">${I.chev}<span class="nm">${esc(part.name)}</span><span class="c">${holds(part.nodes)}</span></button>`);
      row.dataset.name = key;
      const body = h('<div class="part-body"></div>');
      body.append(...part.nodes);
      body.hidden = !open;
      list.append(row, body);
    }
    box.append(list);
  }
  if (lead.length) cutLead(leadEl, parts.length ? LEAD_LINES : BODY_LINES, st.lead);
}
// lines as drawn: the distinct line boxes of the text in an element
function linesOf(el) {
  const tops = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange();
  while (w.nextNode()) {
    if (!w.currentNode.textContent.trim()) continue;
    r.selectNodeContents(w.currentNode);
    for (const x of r.getClientRects()) if (x.width) tops.push(x.top + x.height / 2);
  }
  tops.sort((a, b) => a - b);
  let n = 0, last = -1e9;
  for (const y of tops) { if (y - last > 10) n++; last = y; }
  return n;
}
// whole blocks (or whole list items) up to max lines, then a link that says what it hides; opened, a link to fold it
function cutLead(el, max, open) {
  const full = linesOf(el);
  if (full <= max + 2) return; // a cut that hides a line or two only costs a click
  if (open) { el.append(h('<div class="cutrow"><button class="cut" data-act="desccut">Show less</button></div>')); return; }
  const units = [];
  for (const b of el.children) { if (b.matches('ol, ul')) units.push(...b.children); else units.push(b); }
  let used = 0, at = -1;
  for (let i = 0; i < units.length; i++) { const n = linesOf(units[i]) || 1; if (used + n > max && i > 0) { at = i; break; } used += n; }
  if (at < 0) {
    // one block is longer than the cut by itself: it is clamped to the cut, and the link says how much is under it
    const one = units[0];
    if (!one || units.length > 1) return;
    one.classList.add('clamp'); one.style.setProperty('--clamp', max);
    el.append(h(`<div class="cutrow"><button class="cut" data-act="desccut">${esc(plural(full - max, 'more line', 'more lines'))}</button></div>`));
    return;
  }
  const hidden = units.slice(at), list = hidden[0].parentElement;
  for (const x of hidden) x.hidden = true;
  const items = hidden.every((x) => x.matches('li') && x.parentElement === list);
  const label = items ? plural(hidden.length, 'more item', 'more items') : plural(full - linesOf(el), 'more line', 'more lines');
  el.append(h(`<div class="cutrow"><button class="cut${items ? ' inlist' : ''}" data-act="desccut">${esc(label)}</button></div>`));
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
  return `<div class="sect"><div class="sh">CONVERSATION<span class="n">${p.timeline.length}</span><span class="sp"></span><button class="icon sm" data-act="ghrefresh" title="Read GitHub again" aria-label="Read GitHub again">${I.refresh}</button></div>${items || '<div class="faint">No comments yet.</div>'}` +
    (canComment ? `<div class="composer" id="commentbox"><textarea rows="2" placeholder="Comment on #${p.number}…" aria-label="Comment on the pull request">${esc(S.commentDraft || '')}</textarea><div class="row"><span class="hint">posted on GitHub as ${esc(p.viewer || 'you')}</span><span class="sp"></span><button class="btn sm primary" data-act="ghcomment">Comment <kbd>⌘↵</kbd></button></div></div>` : '') + `</div>`;
}
// The cut is measured at the width the description was drawn at; when the panel opens or is dragged to another width,
// the Overview is drawn again (once the width settles) so the cut fits what you see.
let descMeasured = 0, descT = 0;
const descRO = new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width);
  clearTimeout(descT);
  if (!w || w === descMeasured || S.tab === 'chat' || S.tab === 'review' || !$('#desc')) return;
  descT = setTimeout(renderPanel, 120);
});
function renderOverview(body) {
  descRO.observe(body);
  body.innerHTML = `<div class="pane">${headHTML()}${stackHTML()}<div class="sect"><div class="sh">TLDR</div>${tldrHTML()}</div>${descHTML()}${checksHTML()}${conversationHTML()}</div>`;
  outlineDesc();
  descMeasured = Math.round(body.getBoundingClientRect().width);
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
// a chat changes files when it is in your own checkout (a local workspace): it edits and runs commands there, sandboxed;
// a pull request's checkout is loupe's copy, so a chat there only answers (src/claude.mjs, editRoot)
const chatEdits = (conv) => S.ws?.kind === 'local' && (conv?.edits ?? !conv?.linked);
function renderChat(body) {
  let conv = convOf(S.chat);
  if (!conv) { conv = chats().at(-1) || null; S.chat = conv?.id || null; }
  const title = conv ? conv.title || (conv.linked ? conv.linked.title : 'New chat') : 'New chat';
  const linked = conv?.linked, edits = chatEdits(conv);
  // the rule book's empty state: what is empty, one quiet line, one action (the long story is the action's title)
  const empty = `<div class="pane"><div class="empty chatempty"><p class="big">${edits ? 'Ask about the change, or have it changed.' : 'Ask about the whole change.'}</p>` +
    `<p>${edits ? 'It edits and runs commands in this checkout, sandboxed: no network, nothing written outside it. ' : ''}Select lines and press <kbd>l</kbd> to quote them here, or <kbd>a</kbd> to ask at the lines.</p>` +
    `<p><button class="link" data-act="linkpick" title="Ask the session that wrote the code: it answers from what it already knows, in a fork, and the session itself is left alone">${I.link}<span>Link the Claude Code session that wrote it</span></button></p></div></div>`;
  body.innerHTML = `<div class="pane fill"><div class="chathead"><button class="btn ghost chatpick" data-act="chatpick" title="${esc(title)}">${linked ? I.link : I.chat}<span class="l">${esc(title)}</span>${I.chev}</button>` +
    `<button class="icon sm" data-act="newchat" title="New chat">${I.plus}</button></div>` +
    `<div class="chatlog" id="chatlog">${linked ? linkbarHTML(linked, edits) : ''}` +
    (conv?.messages.length ? `<div data-conv="${conv.id}">${conv.messages.map((m) => msgHTML(m)).join('')}</div>` : empty) + `</div>` +
    `<div class="chatfoot">${attachHTML()}<div class="composer" id="chatbox"><textarea rows="2" placeholder="${linked ? 'Ask the session…' : edits ? 'Ask, or ask for a change…' : 'Ask about the change…'}" aria-label="${edits ? 'Question or change' : 'Question about the change'}"></textarea>` +
    `<div class="row">${linked?.live ? '<span class="hint">the live session picks its own model</span>' : runBtn(conv?.model ? { model: conv.model, effort: conv.effort } : lastRun(), { conv })}<span class="sp"></span>` +
    `<button class="btn sm primary" data-act="chatsend">Send <kbd>↵</kbd></button></div></div></div></div>`;
  const log = $('#chatlog');
  log.scrollTop = log.scrollHeight;
  const ta = $('#chatbox textarea');
  ta.value = S.chatDraft || '';
  grow(ta);
  if (S.focusChat) { ta.focus(); S.focusChat = false; }
}
function linkbarHTML(l, edits) {
  const name = `<b>${esc(l.title || l.sessionId.slice(0, 8))}</b>`;
  if (l.live) return `<div class="linkbar">${I.link}<span>Live: questions go into ${name} as prompts, and it answers with its own tools and permissions. Its answers come back here.</span></div>`;
  return `<div class="linkbar">${I.link}<span>${edits ? 'A fork' : 'A read-only fork'} of ${name}${l.branch ? ` on ${esc(l.branch)}` : ''}${l.tokens ? `. It starts with ~${Math.round(l.tokens / 1000)}k tokens of context: the first question pays for all of it, later ones read it from cache` : ''}. The session itself is untouched.</span></div>`;
}
function attachHTML() {
  if (!S.attach.length) return '';
  return `<div class="attach">${S.attach.map((a, i) => `<span class="chip" data-act="goatt" data-p="${esc(a.path)}" data-l="${a.line}" data-side="${a.side}"><span>${esc(a.path.split('/').pop())} ${esc(a.label)}</span><button class="x" data-act="unattach" data-i="${i}" aria-label="Remove">×</button></span>`).join('')}</div>`;
}
export function openChat() { S.focusChat = true; setTab('chat'); }

// Following the conversation: sending pins its log to the bottom, so your question and the answer under it stay in view as
// the answer comes in. Scrolling up lets go (data-follow 0), and only coming all the way back to the bottom follows again;
// a log nobody has sent in yet follows while it is within 80px of its bottom, as before.
function follow(log) {
  if (!log) return;
  log.dataset.follow = '1';
  log.scrollTo({ top: log.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
const fromEnd = (log) => log.scrollHeight - log.scrollTop - log.clientHeight;
function following(log) {
  const f = log.dataset.follow;
  if (f === '0' && fromEnd(log) < 2) log.dataset.follow = '1';
  return log.dataset.follow === '1' || (f === undefined && fromEnd(log) < 80);
}
const letGo = (e) => { const log = e.target.closest?.('.chatlog'); if (log) log.dataset.follow = '0'; };
document.addEventListener('wheel', (e) => { if (e.deltaY < 0) letGo(e); }, { passive: true });
document.addEventListener('keydown', (e) => { if (['PageUp', 'Home', 'ArrowUp'].includes(e.key)) letGo(e); });

let chatSending = false;
async function chatSend() {
  const ta = $('#chatbox textarea');
  const text = ta.value.trim();
  if (!text || chatSending) return; // one question per send, even while a new chat is still being made
  chatSending = true;
  follow($('#chatlog'));
  let conv = convOf(S.chat);
  const run = conv?.linked?.live ? {} : runOf($('#chatbox'));
  rememberRun(run);
  let attachments = S.attach;
  try {
    if (!conv) {
      const r = await api(wsApi('/chats'), { method: 'POST', body: {} });
      conv = S.review.convs[r.conv.id] = r.conv;
      if (!S.review.chats.includes(conv.id)) S.review.chats.push(conv.id);
      S.chat = conv.id;
    }
    attachments = S.attach;
    S.attach = []; S.chatDraft = ''; ta.value = '';
    await api(`/api/w/${S.id}/convs/${conv.id}/messages`, { method: 'POST', body: { text, attachments, ...run } });
  } catch (e) { toast(e.message, { fail: true }); S.attach = attachments || []; S.chatDraft = text; renderPanel(); } // nothing is lost: the lines come back too
  finally { chatSending = false; }
}

function chatPicker(btn) {
  const items = [
    ...chats().slice().reverse().map((c) => ({ two: [c.title || (c.linked ? c.linked.title : 'New chat'), `${c.linked ? 'linked session · ' : ''}${plural(c.messages.filter((m) => m.role === 'user').length, 'question')} · ${ago(c.messages.at(-1)?.at || c.created)}`], value: { open: c.id }, current: c.id === S.chat, icon: c.linked ? I.link : I.chat })),
    { sep: true },
    { label: 'New chat', value: { new: true } },
    { label: 'Link a Claude Code session…', value: { link: true } },
    ...(S.chat ? [{ sep: true }, { label: 'Delete this chat', value: { del: S.chat }, danger: true, confirm: 'Delete it? Its session stays on disk' }] : []),
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
// A mark (yours, or a GitHub thread) handed to a chat to act on: a new chat, its lines attached and its first message
// written, but not sent: you read it, add to it, and send. A mark's own conversation stays read-only.
// attach: the lines, then what it is about in full (the question and its answer, or the review comments as written, a
// suggested change included), so the first message itself can stay one line
async function chatFrom({ attach, draft }) {
  hooks.showPanel?.(); setTab('chat');
  try { await newChat(); } catch (e) { return toast(e.message, { fail: true }); } // made first: nothing lands in the chat you were on
  S.attach = attach.map((a) => ({ ...a, text: String(a.text || '').slice(0, 20000) })); // the server keeps 20,000 of each
  S.chatDraft = draft;
  renderPanel();
  const ta = $('#chatbox textarea');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
async function deleteChat(id) {
  await api(`/api/w/${S.id}/convs/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message, { fail: true }));
  delete S.review.convs[id];
  S.review.chats = S.review.chats.filter((x) => x !== id);
  S.chat = null;
  renderPanel();
}
async function linkPicker(btn) {
  let list, live;
  try { ({ sessions: list, live } = await api(wsApi('/sessions'))); } catch (e) { return toast(e.message, { fail: true }); }
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
    } catch (e) { toast(e.message, { fail: true }); }
  }, { width: 460 });
}

// ------------------------------------------------------------------ review
function markRow(th) {
  const conv = convOf(th.conv) || { messages: [] };
  const first = conv.messages.find((m) => m.role === 'user')?.text || '';
  const answers = conv.messages.filter((m) => m.role !== 'user');
  const busy = conv.messages.some((m) => m.pending);
  const status = busy ? 'answering…' : answers.length ? plural(answers.length, 'answer') : 'no answer';
  const glyph = answers.at(-1)?.role === 'codex' || conv.modelKind === 'codex' ? I.codex : spark(16, !busy, 'Claude');
  return `<button class="nrow ${th.kind}${th.resolved || th.posted ? ' resolved' : ''}" data-act="gothread" data-t="${th.id}" title="${esc(oneLine(first, 600))}"><span class="k">${glyph}</span><span class="w" title="${esc(th.path)}">${esc(th.path.split('/').pop())} · ${esc(th.label)}</span><span class="q">${esc(oneLine(first, 300))}</span><span class="s">${esc(status)} · ${ago(th.created)}</span></button>`;
}
// GitHub's threads follow the same Open / Resolved filter as your questions, so the counts agree with the tab's badge.
const ghIn = (show) => (S.github?.threads || []).filter((x) => (show === 'resolved' ? x.resolved : !x.resolved));
function githubThreadsHTML(show, head) {
  const t = ghIn(show);
  if (!t.length) return '';
  return `<div class="sect"><div class="sh">ON GITHUB<span class="n">${t.length}</span></div>` +
    t.map((x) => `<button class="nrow gh${x.resolved ? ' resolved' : ''}" data-act="ghopen" data-g="${esc(x.id)}" data-p="${esc(x.path)}" data-l="${x.outdated ? 0 : x.line || 0}"><span class="k">${I.github}</span><span class="w" title="${esc(x.path)}">${esc(x.path.split('/').pop())} · ${x.outdated ? 'outdated' : `line ${x.line}`}</span><span class="q">${esc(x.comments[0]?.author || '')}: ${esc(oneLine(x.comments[0]?.body, 300))}</span><span class="s">${plural(x.comments.length, 'comment')} · ${ago(Date.parse(x.comments.at(-1)?.at || 0))}</span></button>`).join('') + `</div>`;
}
// ------------------------------------------------------------------ one mark, opened: the conversation where it reads well
// The quoted lines on top (so you never need to look back at the code to know what it is about), the conversation,
// and the follow-up box docked at the bottom. The mark's lines stay lit in the code while it is open.
function quoteHTML(path, side, from, to, fallback) {
  const rows = (S.rows.get(path) || S.waves.get(path) || []).filter((r) => !r.hdr && (side === 'old' ? r.t !== '+' && r.o >= from && r.o <= to : r.t !== '-' && r.n >= from && r.n <= to));
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
    (chatEdits() ? `<button class="link" data-act="markchat" title="A new chat, with these lines and this question in its first message, ready for you to send">Edit in chat</button>` : '') +
    `<button class="link" data-act="markresolve">${th.resolved ? 'Reopen' : 'Resolve'}</button><button class="link danger" data-act="markdel">Delete</button></div>` +
    `<div class="chatlog" id="marklog"><div class="mtitle"><span class="kind ask">Question</span><button class="loc" data-act="markgo" title="${esc(th.path)} · ${esc(th.label)}: go to the lines"><bdi dir="ltr">${esc(th.path)} · ${esc(th.label)}</bdi></button>${th.resolved ? '<span class="pill">resolved</span>' : ''}</div>` +
    quoteHTML(th.path, th.side, th.startLine || th.line, th.line, th.preview) +
    `<div data-conv="${th.conv}">${conv.messages.map((m) => msgHTML(m)).join('')}</div></div>` +
    `<div class="chatfoot"><div class="composer" id="markbox" data-t="${th.id}"><textarea rows="2" placeholder="Ask a follow-up" aria-label="Follow-up question">${esc(S.replyDrafts[th.id] || '')}</textarea>` +
    `<div class="row">${runBtn(conv.model ? { model: conv.model, effort: conv.effort } : lastRun(), { conv })}<span class="sp"></span>` +
    `<button class="btn sm primary" data-act="markask">Ask <kbd>↵</kbd></button>` +
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
    `<button class="link" data-act="ghask">Ask about it</button>` + (chatEdits() ? `<button class="link" data-act="ghchat" title="A new chat, with these lines and the comments in its first message, ready for you to send">Edit in chat</button>` : '') + (mine ? `<button class="link danger" data-act="ghdrop" data-n="${esc(mine.nodeId)}">Delete</button>` : t.resolved ? (t.canUnresolve ? `<button class="link" data-act="ghresolve" data-on="0">Reopen</button>` : '') : t.canResolve ? `<button class="link" data-act="ghresolve" data-on="1">Resolve</button>` : '') + `</div>` +
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
  follow($('#marklog'));
  try { await api(`/api/w/${S.id}/convs/${th.conv}/messages`, { method: 'POST', body: { text, ask, ...run, scope: S.scope } }); }
  catch (e) { toast(e.message, { fail: true }); ta.value = text; }
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
    `<button class="link" data-act="markshide" title="${S.marksHidden ? 'Show the marks in the code' : 'Hide the marks in the code; the gutter ticks stay'} (m)">${S.marksHidden ? 'Show in code' : 'Hide in code'}</button>` +
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
    hooks.syncMote?.();
  };
  refresh();
  return api(wsApi('/brief'), { method: 'POST', body: run }).catch((err) => {
    if (S.id !== id || S.review.brief !== pending) return;
    S.review.brief = { ...pending, pending: false, error: err.message };
    refresh();
    toast(err.message, { fail: true });
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
    if (id) return api(wsApi(`/convs/${encodeURIComponent(id)}/stop`), { method: 'POST' }).catch((err) => toast(err.message, { fail: true }));
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
  if (act === 'markchat') {
    const th = S.review.threads.find((t) => t.id === S.mark);
    if (!th) return;
    const msgs = (convOf(th.conv)?.messages || []).filter((m) => m.text);
    const asked = msgs.find((m) => m.role === 'user')?.text || '';
    const talk = msgs.map((m) => `${m.role === 'user' ? 'Me' : m.role === 'codex' ? 'Codex' : 'Claude'}: ${m.text}`).join('\n\n');
    return chatFrom({
      attach: [{ path: th.path, side: th.side, line: th.line, label: th.label, text: th.snippet }, { path: th.path, side: th.side, line: th.line, label: 'Q&A', text: talk }],
      draft: `Make the change from my question on ${th.path} ${th.label}: “${oneLine(asked, 160)}” ` });
  }
  if (act === 'unattach') { e.stopPropagation(); S.attach.splice(Number(b.dataset.i), 1); return renderPanel(); }
  if (act === 'nshow') { pref.set('marksShow', b.dataset.v); return renderPanel(); }
  if (act === 'gothread') return hooks.goThread?.(b.dataset.t);
  if (act === 'gochecks') return showChecks();
  if (act === 'descpart') {
    const st = descState(), name = b.dataset.name, open = !st.parts.has(name);
    if (open) st.parts.add(name); else st.parts.delete(name);
    b.classList.toggle('shut', !open); b.setAttribute('aria-expanded', String(open));
    if (b.nextElementSibling) b.nextElementSibling.hidden = !open;
    return;
  }
  if (act === 'desccut') { descState().lead = !descState().lead; return renderPanel(); }
  if (act === 'ghrefresh') { b.disabled = true; S.github = await api(`/api/w/${S.id}/github?fresh=1`).catch((err) => { toast(err.message, { fail: true }); return S.github; }); hooks.githubChanged?.(); return; }
  if (act === 'openprws') { const p = gh(); if (!p) return; try { const r = await api('/api/workspaces', { method: 'POST', body: { target: p.url } }); location.href = r.url; } catch (err) { toast(err.message, { fail: true }); } return; }
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
    return t && hooks.goLoc?.({ path: t.path, line: t.startLine || t.line, end: t.line, side: t.side });
  }
  if (act === 'markresolve') { const th = S.review.threads.find((t) => t.id === S.mark); if (th) { await setResolved(th, !th.resolved); renderPanel(); } return; }
  if (act === 'markdel') {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete it?'; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ''; b.textContent = 'Delete'; } }, 3000); return; }
    const th = S.review.threads.find((t) => t.id === S.mark); if (th) deleteMark(th); return;
  }
  if (act === 'markask') return markReply(true);
  if (act === 'ghopen') {
    // opened first, since it draws the file again; then to its lines, flashed
    openMark('gh:' + b.dataset.g);
    const t = (S.github?.threads || []).find((x) => x.id === b.dataset.g);
    const l = Number(b.dataset.l) || 0; // 0: outdated, its lines are history, so only the file
    return hooks.goLoc?.({ path: b.dataset.p, line: l && (t?.startLine || l), end: l, side: t?.side });
  }
  const ght = S.mark?.startsWith('gh:') && (S.github?.threads || []).find((t) => t.id === S.mark.slice(3));
  if (ght && act === 'ghdrop') { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete it?'; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ''; b.textContent = 'Delete'; } }, 3000); return; } if (await hooks.act?.('dropcomment', { nodeId: b.dataset.n })) closeMark(); return; }
  if (ght && act === 'ghresolve') return hooks.act?.('resolve', { threadId: ght.id, resolved: b.dataset.on === '1' });
  if (ght && act === 'ghreply') {
    const box = $('#ghbox'), ta = box.querySelector('textarea'), text = ta.value.trim();
    if (!text) return ta.focus();
    if (await hooks.act?.('reply', { commentId: Number(box.dataset.cid), body: text })) { delete S.replyDrafts['gh:' + ght.id]; ta.value = ''; }
    return;
  }
  if (ght && act === 'ghchat') {
    // the review comment, to act on: its lines as they read in the diff, and the comments in the first message
    const from = ght.startLine || ght.line, label = ght.outdated ? 'an outdated thread' : from !== ght.line ? `lines ${from}–${ght.line}` : `line ${ght.line}`;
    const rows = ght.outdated ? [] : (S.rows.get(ght.path) || []).filter((r) => !r.hdr && (ght.side === 'old' ? r.t !== '+' && r.o >= from && r.o <= ght.line : r.t !== '-' && r.n >= from && r.n <= ght.line));
    const comments = ght.comments.map((c) => `${c.author}:\n${c.body}`).join('\n\n'); // as written: a suggested change stays code
    return chatFrom({
      attach: [...(rows.length ? [{ path: ght.path, side: ght.side, line: ght.line, label, text: rows.map((r) => r.s).join('\n') }] : []), { path: ght.path, side: ght.side, line: ght.outdated ? undefined : ght.line, label: 'review thread', text: comments }], // an outdated thread's lines are history: only its words
      draft: `Address the review comment on ${ght.path} ${label}: “${oneLine(ght.comments[0]?.body, 160)}” ` });
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
// both open the side panel first: from the top bar's act or the palette it may be folded away
function focusComment() { hooks.showPanel?.(); setTab('overview'); requestAnimationFrame(() => { const ta = $('#commentbox textarea'); ta?.scrollIntoView({ block: 'center' }); ta?.focus(); }); }
function showChecks() { hooks.showPanel?.(); setTab('overview'); requestAnimationFrame(() => { const d = $('#checks'); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } }); }
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
// Asking a model is a chat: ↵ sends and ⇧↵ starts a new line (⌘↵ sends too; an input method's ↵ while composing is its own).
// Writing for GitHub is kept as GitHub keeps it, and it posts in public from here: ↵ is a new paragraph, ⌘↵ posts.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat || e.target.tagName !== 'TEXTAREA') return;
  const ask = !e.shiftKey && !e.isComposing && e.keyCode !== 229, post = e.metaKey || e.ctrlKey;
  if (ask && e.target.closest?.('#chatbox')) { e.preventDefault(); chatSend(); }
  if (ask && e.target.closest?.('#markbox')) { e.preventDefault(); markReply(true); }
  if (post && e.target.closest?.('#commentbox')) { e.preventDefault(); $('[data-act="ghcomment"]')?.click(); }
  if (post && e.target.closest?.('#ghbox')) { e.preventDefault(); $('[data-act="ghreply"]')?.click(); }
});

// A message changed: draw it wherever its conversation is on screen (its thread inline, or the chat).
export function paintMessage(convId, msg) {
  for (const box of $$(`[data-conv="${convId}"]`)) {
    const el = box.querySelector(`.msg[data-m="${CSS.escape(msg.id)}"]`);
    const log = box.closest('.chatlog'); // the chat's log, or a question's follow-ups
    const keep = log && following(log);
    const was = el?.querySelector('.mmeta canvas.spark:not(.still)');
    if (el) el.outerHTML = msgHTML(msg); else box.insertAdjacentHTML('beforeend', msgHTML(msg));
    if (was && !msg.pending) box.querySelector(`.msg[data-m="${CSS.escape(msg.id)}"] .mmeta canvas.spark`)?.classList.add('landed');
    // a new message glides into view; a message growing as it streams keeps its bottom in view without a glide
    if (keep) { if (el) log.scrollTop = log.scrollHeight; else follow(log); }
  }
}
