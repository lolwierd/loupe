// Dialogs: every write that sends something somewhere (a review, a commit, a push, a pull request) opens as one dialog in the middle of the window. One column, sized to what you write: the title says
// what will happen once the daemon has read it, the body is what you write, and the footer says where it goes,
// beside the button that sends it. The button runs exactly that preview's guard; change anything and the preview is
// read again first.
import { S, $, $$, esc, h, api, wsApi, I, toast, plural, pref } from './core.js';
import { statusGlyph } from './cards.js';
import { icon, spark } from './pixel.js';
import { md } from './md.js';
import { preview, run } from './actions.js';
import { hooks } from './hooks.js';

// ------------------------------------------------------------------ the branch, read from git (checkouts only)
let loading = null;
export async function loadShip(force = false) {
  if (S.ws?.kind !== 'local') { S.ship = null; return null; }
  if (loading && !force) return loading;
  loading = api(wsApi('/ship')).then((st) => {
    S.ship = st;
    S.shipSel ||= new Set();
    const known = S.shipKnown ||= new Set();
    for (const f of st.wip) if (!known.has(f.path)) { known.add(f.path); S.shipSel.add(f.path); } // new files start picked
    for (const p of [...S.shipSel]) if (!st.wip.some((f) => f.path === p)) S.shipSel.delete(p);
    return st;
  }).catch((e) => { S.ship = { error: e.message }; return S.ship; }).finally(() => { loading = null; hooks.shipChanged?.(); });
  return loading;
}
const picked = () => (S.ship?.wip || []).filter((f) => S.shipSel.has(f.path)).map((f) => f.path);

// ------------------------------------------------------------------ parts
// A commit message is one string (subject, blank line, body); the dialog edits the two halves apart.
const splitMsg = (m = '') => { const i = m.indexOf('\n'); return i < 0 ? [m, ''] : [m.slice(0, i), m.slice(i + 1).replace(/^\n/, '')]; };
const joinMsg = (subj, body) => (body.trim() ? `${subj}\n\n${body}` : subj);
// the subject against git's 72 columns: the first line is what every log and PR list shows
const countText = (subj) => `${subj.length}/72`;
const pxbox = (attrs, on) => `<input type="checkbox" class="pxcb" ${attrs}${on ? ' checked' : ''}><span class="pxbox" aria-hidden="true">${icon('check', '--on-fill')}</span>`;
const pxcheck = (id, on, label) => `<label class="pxl">${pxbox(`id="${id}"`, on)}<span>${esc(label)}</span></label>`;
const writeBtn = (what) => `<button class="btn ghost wbtn" data-sh="draft" data-what="${what}" title="Claude drafts it from the change, in this repository's style">${spark(16, true)}<span>Write it</span></button>`;
// the isolate keeps a leading dot or slash where it is when the list cuts a long path at its left (a .github path would otherwise
// show its dot at the end), and unlike an invisible mark in the text it leaves a copied path clean
const splitPath = (p) => { const k = p.lastIndexOf('/'); return `<bdi dir="ltr"><span class="d">${esc(p.slice(0, k + 1))}</span>${esc(p.slice(k + 1))}</bdi>`; };
function filesHTML() {
  const st = S.ship;
  return `<section class="part"><div class="ph"><span class="lbl">Files</span><span class="n" id="shn">${picked().length} of ${st.wip.length}</span><span class="sp"></span><button class="link" data-sh="all">All</button><button class="link" data-sh="none">None</button></div>` +
    `<div class="flist">${st.wip.map((f) => `<label class="frow">${pxbox(`data-sp="${esc(f.path)}"`, S.shipSel.has(f.path))}${statusGlyph(f)}<span class="p" title="${esc(f.path)}">${splitPath(f.path)}</span><span class="num"><span class="add">+${f.added}</span><span class="del">−${f.deleted}</span></span></label>`).join('')}</div></section>`;
}
function commitsHTML() {
  const cs = S.ws?.commits || [];
  if (!cs.length) return '';
  return `<section class="part"><div class="ph"><span class="lbl">Commits</span><span class="n">${cs.length}</span></div>` +
    `<div class="clist">${cs.slice(0, 12).map((c) => `<div class="crow"><span class="sha">${esc(c.short.slice(0, 7))}</span><span class="s" title="${esc(c.subject)}">${esc(c.subject)}</span></div>`).join('')}${cs.length > 12 ? `<div class="crow more"><span></span><span>and ${cs.length - 12} more</span></div>` : ''}</div></section>`;
}

// ------------------------------------------------------------------ the dialogs
const EVENTS = [['COMMENT', 'Comment'], ['REQUEST_CHANGES', 'Request changes'], ['APPROVE', 'Approve']];
const SHEETS = {
  review: {
    title: 'Submit your review', focus: 'textarea',
    idle: (c) => EVENTS.find(([e]) => e === c.opts.event)?.[1] || 'Submit',
    form(c) {
      const p = S.github?.pr, own = !!p?.viewerIsAuthor;
      if (own || !c.opts.event) c.opts.event = own ? 'COMMENT' : c.opts.event || 'COMMENT';
      return `<div class="seg verdict" id="shev" role="group" aria-label="Verdict">${EVENTS.map(([e, l]) => `<button data-ev="${e}" aria-pressed="${c.opts.event === e}"${own && e !== 'COMMENT' ? ' disabled title="Not on your own pull request"' : ''}>${l}</button>`).join('')}</div>` +
        `<div class="box"><textarea class="body prose" rows="6" data-f="reviewDraft" placeholder="What you think of the change as a whole. GitHub needs it for Comment and Request changes." aria-label="Review summary">${esc(S.reviewDraft || '')}</textarea></div>` +
        `<p class="note">${(() => { const n = S.github?.pending?.comments?.length || 0; return n ? `${plural(n, 'comment')} on lines go${n === 1 ? 'es' : ''} with it: your pending review on GitHub.` : 'No comments on lines yet: select lines and press c to add one.'; })()}</p>`;
    },
    bind(c, el) {
      el.querySelector('#shev').addEventListener('click', (e) => {
        const b = e.target.closest('[data-ev]'); if (!b || b.disabled) return;
        c.opts.event = b.dataset.ev;
        for (const x of $$('#shev button', el)) x.setAttribute('aria-pressed', String(x === b));
        refreshSoon();
      });
    },
    payload: (c) => ({ event: c.opts.event, body: S.reviewDraft || '' }),
    after(r, c, payload) { S.reviewDraft = ''; if (payload.event === 'APPROVE') hooks.stamp?.(); },
  },
  commit: {
    title: 'Commit', focus: '[data-m="subj"]',
    idle: () => (S.shipAmend ? 'Amend' : `Commit ${plural(picked().length, 'file')}`),
    form() {
      const st = S.ship, [subj, body] = splitMsg(S.shipMsg || '');
      return (st.onDefault ? `<label class="field"><span class="lbl">New branch</span><input class="in mono" data-f="shipBranch" placeholder="You are on ${esc(st.branch)}: name a branch to commit on" value="${esc(S.shipBranch || '')}" autocomplete="off" spellcheck="false"></label>` : '') +
        `<div class="box msg"><div class="subjrow"><input class="subj" data-m="subj" placeholder="Subject: what this commit does" value="${esc(subj)}" autocomplete="off" aria-label="Subject"><span class="cnt${subj.length > 72 ? ' over' : ''}" id="shcnt" title="The subject line against git's 72 columns">${countText(subj)}</span></div>` +
        `<textarea class="body" data-m="body" rows="5" placeholder="Why, if the subject does not say it" aria-label="Body">${esc(body)}</textarea></div>` +
        `<div class="tools">${writeBtn('commit')}<span class="sp"></span>${pxcheck('shamend', S.shipAmend, 'Amend the last commit')}</div>` +
        filesHTML();
    },
    bind(c, el) {
      el.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-sp]');
        if (cb) { cb.checked ? S.shipSel.add(cb.dataset.sp) : S.shipSel.delete(cb.dataset.sp); countFiles(); refreshSoon(); }
        if (e.target.id === 'shamend') { S.shipAmend = e.target.checked; refreshSoon(); }
      });
    },
    payload: () => ({ paths: picked(), message: S.shipMsg || '', amend: !!S.shipAmend, branch: S.shipBranch || '' }),
    async after() { S.shipMsg = ''; S.shipAmend = false; S.shipBranch = ''; S.shipKnown = new Set(); await loadShip(true); },
  },
  push: {
    title: 'Push', idle: () => 'Push',
    payload: (c) => ({ force: !!c.opts.force }),
    async after() { await loadShip(true); },
  },
  openpr: {
    title: 'Open a pull request', focus: '[data-f="prTitle"]',
    idle: () => (pref.get('prDraft', true) ? 'Open draft' : 'Open'),
    form() {
      const st = S.ship, base = S.prBase || st.base || '';
      return `<div class="route"><code title="This branch">${esc(st.branch)}</code><span class="arr" aria-hidden="true">→</span><input class="in mono base" data-f="prBase" value="${esc(base)}" style="width:${Math.max(8, base.length + 3)}ch" aria-label="Into (base branch)" spellcheck="false" title="Into: the base branch"></div>` +
        `<input class="in ttl" data-f="prTitle" placeholder="Title" value="${esc(S.prTitle || '')}" autocomplete="off" aria-label="Title">` +
        `<div class="box"><div class="mdtabs" role="tablist" aria-label="Description"><button role="tab" data-mdv="write" aria-selected="true">Write</button><button role="tab" data-mdv="preview" aria-selected="false">Preview</button><span class="sp"></span><span class="hint">GitHub markdown</span></div>` +
        `<textarea class="body prose" rows="10" data-f="prBody" placeholder="Why, what changed, how it was tested" aria-label="Description">${esc(S.prBody ?? st.template ?? '')}</textarea><div class="mdpv md" hidden></div></div>` +
        `<div class="tools">${writeBtn('pr')}<span class="sp"></span>${pxcheck('shdraft', pref.get('prDraft', true), 'Open as a draft')}</div>` +
        commitsHTML();
    },
    bind(c, el) {
      el.addEventListener('change', (e) => { if (e.target.id === 'shdraft') { pref.set('prDraft', e.target.checked); refreshSoon(); } });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mdv]'); if (!b) return;
        const pv = b.dataset.mdv === 'preview', ta = el.querySelector('[data-f="prBody"]'), out = el.querySelector('.mdpv');
        for (const x of el.querySelectorAll('[data-mdv]')) x.setAttribute('aria-selected', String(x === b));
        if (pv) { out.innerHTML = md(ta.value || '*Nothing written yet.*'); out.style.minHeight = ta.offsetHeight + 'px'; }
        ta.hidden = pv; out.hidden = !pv;
        if (!pv) ta.focus();
      });
    },
    payload: () => ({ title: S.prTitle || '', body: S.prBody ?? S.ship?.template ?? '', base: S.prBase || S.ship?.base, draft: pref.get('prDraft', true) }),
    async after(r) { const n = Number(/\/pull\/(\d+)/.exec(r.url || '')?.[1]); if (n) S.lastPr = n; S.prTitle = ''; S.prBody = undefined; await loadShip(true); hooks.loadStack?.(); },
  },
  stacklink: {
    title: 'Add to the stack', idle: () => 'Add to stack',
    payload: (c) => ({ stackNumber: c.opts.stackNumber, pr: c.opts.pr }),
    after() { S.lastPr = null; hooks.loadStack?.(); },
  },
};

// ------------------------------------------------------------------ open, read, send
let cur = null, rt = null, opener = null;
export function openSheet(kind, opts = {}) {
  const def = SHEETS[kind];
  if (!def || !S.ws) return;
  if ((kind === 'commit' || kind === 'openpr') && !S.ship?.wip) { loadShip().then(() => S.ship?.wip && openSheet(kind, opts)); return; }
  if (kind === 'commit' && cur?.kind !== 'commit') S.shipAmend = false;
  closeSheet();
  opener = document.activeElement;
  const c = cur = { id: S.id, kind, opts: { ...opts }, def, pv: null, key: null, seq: 0 };
  const el = c.el = h(`<div class="sheet k-${esc(kind)}${def.form ? '' : ' small'}" role="dialog" aria-modal="true" aria-labelledby="sht">` +
    `<header class="shh"><h2 class="t" id="sht">${esc(def.title)}</h2><button class="icon" data-sh="close" title="Close (esc)" aria-label="Close">${I.x}</button></header>` +
    `<div class="shb">${def.form ? def.form(c) : ''}<ul class="items" id="shitems"${def.form ? ' hidden' : ''}></ul></div>` +
    `<div class="shwarn" id="shwarn" hidden></div>` +
    `<footer class="shf"><span class="what" id="shpv"></span><button class="btn ghost" data-sh="close">Cancel</button><button class="btn primary go" data-sh="go" disabled><span class="gl">${esc(def.idle?.(c) || 'Go')}</span><kbd>⌘↵</kbd></button></footer></div>`);
  const scrim = c.scrim = h('<div class="sheetscrim"></div>');
  scrim.append(el);
  // a click on the dim around it closes it; what you typed is kept for the next time it opens
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeSheet(); });
  document.body.append(scrim);
  def.bind?.(c, el);
  for (const ta of $$('textarea', el)) fit(ta);
  refresh();
  requestAnimationFrame(() => (def.focus && el.querySelector(def.focus) || el.querySelector('[data-sh="go"]'))?.focus());
}
export function closeSheet() {
  if (!cur) return;
  cur.scrim.remove(); cur = null; clearTimeout(rt);
  if (opener?.isConnected) opener.focus();
  opener = null;
}
export const sheetOpen = () => !!cur;

// where it goes, said short: a checkout's path keeps its last two folders (the full path is in the title)
// a sentence starts with a capital, except when it starts with the branch's name: that is a name, and names keep their case
const sentence = (t = '') => { const b = S.ship?.branch || S.ws?.branch; return !t || (b && t.startsWith(b)) ? t : t[0].toUpperCase() + t.slice(1); };
const shortWhere = (w = '') => sentence(w.replace(/(\/[^\s,]+)/g, (p) => { const parts = p.split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; }));
// textareas grow with what is in them, up to a cap, so the dialog is never bigger than its text
function fit(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.42) + 'px'; }
function countFiles() { const n = $('#shn', cur?.el); if (n) n.textContent = `${picked().length} of ${S.ship.wip.length}`; }

function goBtn(label, tone, disabled) {
  const b = cur?.el.querySelector('[data-sh="go"]');
  if (!b) return;
  b.querySelector('.gl').textContent = label; b.disabled = !!disabled;
  b.classList.toggle('danger', tone === 'danger'); b.classList.toggle('primary', tone !== 'danger');
}
function refreshSoon() { if (cur?.sending) return; clearTimeout(rt); if (cur) { cur.key = null; cur.seq++; cur.el.querySelector('[data-sh="go"]').disabled = true; } rt = setTimeout(refresh, 260); }
async function refresh() {
  const c = cur;
  if (!c || c.sending || S.id !== c.id) return;
  const payload = c.def.payload(c), key = JSON.stringify(payload), seq = ++c.seq;
  const btn = c.el.querySelector('[data-sh="go"]'); btn.disabled = true;
  try {
    const pv = await preview(c.kind, payload);
    if (cur !== c || seq !== c.seq || S.id !== c.id) return;
    c.pv = pv; c.key = key;
    $('#sht', c.el).textContent = pv.title;
    const what = $('#shpv', c.el); what.textContent = shortWhere(pv.where); what.title = pv.where || ''; what.classList.remove('hint');
    const items = $('#shitems', c.el);
    if (!c.def.form) items.innerHTML = (pv.items || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>Nothing else.</li>';
    const warn = $('#shwarn', c.el); warn.hidden = !pv.warnings?.length; warn.innerHTML = (pv.warnings || []).map((x) => `<p>${esc(x)}</p>`).join('');
    if (pv.needsForce) goBtn('Overwrite…', 'danger');
    else goBtn(pv.confirm || c.def.idle?.(c) || 'Go', pv.tone);
  } catch (e) {
    if (cur !== c || seq !== c.seq || S.id !== c.id) return;
    c.pv = null; c.key = null;
    // not ready yet (no message, no title): said once, quietly, where the destination would be; the button keeps
    // its name, so you know what it will do
    $('#sht', c.el).textContent = c.def.title;
    const what = $('#shpv', c.el); what.textContent = sentence(e.message); what.title = ''; what.classList.add('hint');
    $('#shwarn', c.el).hidden = true;
    goBtn(c.def.idle?.(c) || 'Go', '', true);
  }
}
async function go() {
  const c = cur;
  if (!c?.pv || c.sending || S.id !== c.id) return;
  if (c.pv.needsForce) { c.opts.force = true; return refresh(); }
  const payload = c.def.payload(c);
  if (JSON.stringify(payload) !== c.key) return refresh(); // changed since its preview: read it again, then you decide
  const gb = c.el.querySelector('[data-sh="go"]');
  gb.disabled = true; gb.classList.add('sending');
  gb.querySelector('.gl').innerHTML = `<span class="launch">${icon('arrow', '--on-fill')}</span>Sending…`;
  c.sending = true;
  try {
    const r = await run(c.kind, payload, c.pv.guard);
    toast(r.message);
    if (S.id !== c.id) return;
    if (cur === c) closeSheet();
    if (!cur) await c.def.after?.(r, c, payload);
    if (S.id === c.id) hooks.afterAct?.(c.kind, r);
  } catch (e) {
    toast(e.message); c.sending = false;
    if (cur === c) { gb.classList.remove('sending'); gb.classList.add('failed'); setTimeout(() => gb.classList.remove('failed'), 400); refresh(); }
  }
}

// Claude drafts the commit message or the PR's title and description; what you typed meanwhile is kept.
async function draft(b) {
  const what = b.dataset.what;
  if (what === 'commit' && !picked().length) return toast('Pick the files first.');
  const c = cur, label = b.innerHTML;
  b.disabled = true; b.innerHTML = `${spark(16, false, 'writing')}<span>Writing…</span>`;
  const box = c.el.querySelector(what === 'commit' ? '.box.msg' : '.box');
  box?.classList.add('drafting'); if (what === 'pr') c.el.querySelector('[data-f="prTitle"]')?.classList.add('drafting');
  const before = { msg: S.shipMsg, title: S.prTitle, body: S.prBody, branch: S.ship?.branch, ws: S.id };
  try {
    const d = await api(wsApi('/draft'), { method: 'POST', body: { what, paths: picked() } });
    if (S.id !== before.ws || S.ship?.branch !== before.branch || cur !== c) return;
    const same = (now, then) => (now || '') === (then || '');
    const put = (sel, v) => { const el = c.el.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    if (what === 'commit') {
      if (same(S.shipMsg, before.msg)) { put('[data-m="subj"]', d.subject || ''); put('[data-m="body"]', (d.body || '').trim()); }
      else toast('You edited the message while Claude wrote: kept yours.');
    } else {
      if (same(S.prTitle, before.title)) put('[data-f="prTitle"]', d.title);
      if (same(S.prBody, before.body)) put('[data-f="prBody"]', d.body); else toast('You edited the description while Claude wrote: kept yours.');
    }
    box?.classList.add('drafted'); setTimeout(() => box?.classList.remove('drafted'), 700);
  } catch (err) { toast(err.message); }
  finally {
    box?.classList.remove('drafting'); c.el.querySelector('.in.ttl')?.classList.remove('drafting');
    if (b.isConnected) { b.disabled = false; b.innerHTML = label; }
  }
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.sheet [data-sh]');
  if (!b || !cur) return;
  const a = b.dataset.sh;
  if (a === 'close') closeSheet();
  if (a === 'go') go();
  if (a === 'draft') draft(b);
  if (a === 'all' || a === 'none') {
    for (const f of S.ship.wip) a === 'all' ? S.shipSel.add(f.path) : S.shipSel.delete(f.path);
    for (const cb of $$('[data-sp]', cur.el)) cb.checked = a === 'all';
    countFiles(); refreshSoon();
  }
});
document.addEventListener('input', (e) => {
  if (!cur || !e.target.closest?.('.sheet')) return;
  const t = e.target;
  if (t.tagName === 'TEXTAREA') fit(t);
  if (t.dataset.m) {
    const subj = $('[data-m="subj"]', cur.el).value.replace(/\n/g, ' '), body = $('[data-m="body"]', cur.el).value;
    S.shipMsg = joinMsg(subj, body);
    const n = $('#shcnt', cur.el); n.textContent = countText(subj); n.classList.toggle('over', subj.length > 72);
    return refreshSoon();
  }
  if (t.dataset.f) {
    S[t.dataset.f] = t.value;
    if (t.dataset.f === 'prBase') t.style.width = `${Math.max(8, t.value.length + 3)}ch`;
    refreshSoon();
  }
});
addEventListener('keydown', (e) => {
  if (!cur) return;
  if (e.key === 'Escape' && !document.querySelector('.menu')) { e.preventDefault(); e.stopPropagation(); return closeSheet(); }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); return go(); }
  // Enter in the subject moves to the body, as in a terminal editor's message
  if (e.key === 'Enter' && e.target.dataset?.m === 'subj') { e.preventDefault(); return $('[data-m="body"]', cur.el)?.focus(); }
  // Tab stays inside the dialog
  if (e.key === 'Tab') {
    const f = $$('button:not([disabled]), input:not([disabled]), textarea:not([hidden]), [tabindex]:not([tabindex="-1"])', cur.el).filter((x) => x.offsetParent !== null || x.classList.contains('pxcb'));
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  }
}, true);
Object.assign(hooks, { openSheet, closeSheet });
