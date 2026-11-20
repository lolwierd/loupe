// The top bar's right side: how much is left (a number and a strip, one segment per file, as long as its changed
// lines, green once viewed, amber if it changed since), and the next act (a split button: the likeliest act, then
// everything else you can do now). Each act is a sheet (a write with its live preview) or a plain step. The stack
// this change sits in is drawn as number chips beside the title.
import { S, $, esc, I, plural, convOf, toast } from './core.js';
import { isViewed, isStale, lines, orderedFiles, cardEl } from './cards.js';
import { progressMarks, nextUnviewed } from './tree.js';
import { menu } from './ui.js';
import { icon } from './pixel.js';
import { hooks } from './hooks.js';

export const liveConv = () => S.review.chats.map(convOf).find((c) => c?.linked?.live && !c.linked.offline) || null;

// What you can do next, the likeliest first.
export function nextActs() {
  const m = S.ws, p = S.github?.pr, st = S.ship;
  const pend = S.github?.pending?.comments?.length || 0;
  const acts = [];
  const reviewAct = { label: pend ? `Submit review · ${pend}` : 'Submit review', sheet: ['review', {}] };
  if (m.kind === 'pr') {
    if (p?.state === 'OPEN') {
      acts.push(reviewAct);
      if (!p.viewerIsAuthor) acts.push({ label: 'Approve', sheet: ['review', { event: 'APPROVE' }] }, { label: 'Request changes', sheet: ['review', { event: 'REQUEST_CHANGES' }] });
      acts.push({ label: `Comment on #${p.number}`, run: () => hooks.focusComment?.() });
    }
    if (p?.url) acts.push({ label: 'Open on GitHub', run: () => window.open(p.url, '_blank', 'noopener') });
    return acts;
  }
  // a checkout of an open PR's branch can review it from here too; pending comments put it first
  if (p?.state === 'OPEN' && pend) acts.push(reviewAct);
  if (st && !st.error) {
    if (st.wip?.length) acts.push({ label: `Commit ${plural(st.wip.length, 'file')}`, sheet: ['commit', {}] });
    if (!st.onDefault && st.head && (st.ahead > 0 || !st.remoteSha || st.behind > 0)) acts.push({ label: st.behind > 0 ? 'Overwrite the remote…' : !st.remoteSha ? 'Push the branch' : `Push ${plural(st.ahead, 'commit')}`, tone: st.behind > 0 ? 'danger' : '', sheet: ['push', {}] });
    if (st.pr?.state === 'OPEN') acts.push({ label: `Open #${st.pr.number}`, run: () => hooks.openPrHere?.(st.pr.url) });
    else if (st.repo && !st.onDefault) acts.push({ label: 'Open a pull request', sheet: ['openpr', {}], disabled: st.remoteSha && st.ahead === 0 ? '' : 'Push the branch first' });
    if (p?.state === 'OPEN' && !pend) acts.push(reviewAct);
    if (S.lastPr && S.stack?.stackNumber && !S.stack.items.some((i) => i.pr === S.lastPr && !i.notInStack)) acts.push({ label: `Add #${S.lastPr} to stack #${S.stack.stackNumber}`, sheet: ['stacklink', { stackNumber: S.stack.stackNumber, pr: S.lastPr }] });
  }
  return acts;
}
// A disabled act is never the primary one: the next one that can run is.
const ordered = (acts) => [...acts.filter((a) => !a.disabled), ...acts.filter((a) => a.disabled)];
export function doAct(a) { if (a.sheet) hooks.openSheet?.(...a.sheet); else a.run?.(); }

export function renderProgress() {
  const el = $('#tally');
  if (!el || !S.ws) return;
  const files = S.files.filter((f) => f.kind !== 'generated');
  const total = files.reduce((n, f) => n + lines(f), 0);
  const leftFiles = files.filter((f) => !isViewed(f));
  const left = leftFiles.reduce((n, f) => n + lines(f), 0);
  progressMarks(total, left);
  const segs = orderedFiles().map(({ f }) => f).filter((f) => f.kind !== 'generated');
  const sum = segs.reduce((n, f) => n + Math.max(1, lines(f)), 0) || 1;
  el.classList.toggle('clean', total > 0 && left === 0);
  el.innerHTML = `<span class="n">${total === 0 ? 'No changes' : left === 0 ? `${icon('check', '--ok')} All viewed` : `<b class="odo">${left.toLocaleString()}</b> left`}</span>` +
    `<span class="strip" aria-hidden="true">${segs.map((f) => `<i class="${isViewed(f) ? 'done' : isStale(f) ? 'stale' : ''}${f.path === S.current ? ' cur' : ''}" style="flex:${(Math.max(1, lines(f)) / sum).toFixed(5)};${readMask(f)}"></i>`).join('')}</span>`;
  const gen = S.files.filter((f) => f.kind === 'generated');
  el.title = `${left.toLocaleString()} of ${total.toLocaleString()} changed lines not yet viewed, in ${leftFiles.length} of ${plural(files.length, 'file')}.` +
    (gen.length ? ` ${plural(gen.length, 'generated file')} are not counted.` : '') + (S.app.settings?.autoView ? ' Tests count as viewed until you untick one.' : '') + ' Click for the next file left (]).';
}
// A file you have scrolled through part of shows that share as a dither of ink over its grey: skimmed half reads
// differently from untouched. Viewed snaps it to solid green.
const readMask = (f) => { const r = S.readFrac.get(f.path) || 0; return !isViewed(f) && r > 0.02 ? `--rd:var(--d${Math.max(1, Math.min(15, Math.round(r * 16)))})` : ''; };
export function paintProgress() {
  const segs = orderedFiles().map(({ f }) => f).filter((f) => f.kind !== 'generated');
  const is = [...($('#tally .strip')?.children || [])];
  if (is.length !== segs.length) return renderProgress();
  segs.forEach((f, k) => { const i = is[k]; i.classList.toggle('done', isViewed(f)); i.classList.toggle('stale', !isViewed(f) && isStale(f)); i.classList.toggle('cur', f.path === S.current); const m = readMask(f); if (m) i.style.setProperty('--rd', m.slice(5)); else i.style.removeProperty('--rd'); });
  tickCount();
}

// The count rolls down to its new value (old digits slide up and out, three steps), and the moment it reaches zero
// one glint crosses the strip and the check takes the number's place.
let lastLeft = null;
function tickCount() {
  const files = S.files.filter((f) => f.kind !== 'generated');
  const left = files.filter((f) => !isViewed(f)).reduce((n, f) => n + lines(f), 0);
  const total = files.reduce((n, f) => n + lines(f), 0);
  const el = $('#tally');
  if (!el || lastLeft === left) return;
  const was = lastLeft; lastLeft = left;
  if (was === null) return;
  if (left === 0 && total) { renderProgress(); el.classList.remove('glint'); void el.offsetWidth; el.classList.add('glint'); return; }
  const b = el.querySelector('.odo');
  if (!b) return renderProgress();
  b.innerHTML = `<span class="roll"><span>${was.toLocaleString()}</span><span>${left.toLocaleString()}</span></span>`;
  b.classList.remove('rolling'); void b.offsetWidth; b.classList.add('rolling');
  setTimeout(() => { if (b.isConnected) b.textContent = left.toLocaleString(); }, 220);
}
export function renderGo() {
  const el = $('#go');
  if (!el || !S.ws) return;
  const acts = ordered(nextActs());
  S.acts = acts;
  const a = acts[0];
  if (!a) { el.innerHTML = ''; return; }
  const tone = a.tone === 'danger' ? 'danger' : a.tone === 'claude' ? 'claude' : 'primary';
  el.innerHTML = `<button class="btn sm ${tone}${acts.length > 1 ? ' l' : ''}" data-act="next"${a.disabled ? ` disabled title="${esc(a.disabled)}"` : ''}>${esc(a.label)}</button>` +
    (acts.length > 1 ? `<button class="btn sm ${tone} r" data-act="nextmenu" aria-label="Everything you can do next" title="Everything you can do next">${I.chev}</button>` : '');
}

export function renderStack() {
  const el = $('#stackbar');
  if (S.tab === 'overview') hooks.renderPanel?.(); // the stack is drawn in Overview
  if (!el) return;
  const s = S.stack;
  if (!s?.items?.length) { el.hidden = true; return; }
  const dot = (it) => (it.merged ? 'merged' : it.state === 'closed' ? 'closed' : it.draft ? 'draft' : it.pr ? '' : 'local');
  const short = (b) => String(b || '').split('/').pop();
  el.hidden = false;
  // each chip travels with the mark before it, so a chip that does not fit takes its arrow along
  el.innerHTML = s.items.map((it, i) => `<span class="sq">${i ? `<span class="arrow">${it.sibling ? '·' : '›'}</span>` : ''}<button class="seq ${dot(it)}${it.here ? ' here' : ''}" data-si="${i}" title="${esc([s.kind === 'github' ? `GitHub stack #${s.stackNumber}` : s.kind === 'chain' ? 'PRs based on each other' : 'local branches built on each other', it.pr ? `#${it.pr}` : '', it.branch, it.title, it.here ? 'you are here' : it.checkout ? `checked out at ${it.checkout}` : 'not checked out: opens the PR'].filter(Boolean).join(' · '))}"><i></i><span>${it.pr ? `#${it.pr}` : esc(short(it.branch))}</span></button></span>`).join('') +
    (S.ws.trunkMergeBase ? `<button class="sw${S.rangeKey === 'stack' ? ' on' : ''}" data-act="scope" data-scope="${S.rangeKey === 'stack' ? 'all' : 'stack'}" title="${S.rangeKey === 'stack' ? 'Back to this change alone' : 'Read this change together with everything under it, from the trunk'}">${S.rangeKey === 'stack' ? 'this one' : 'whole stack'}</button>` : '');
}

document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.top [data-act], .top .seq[data-si]');
  if (!b) return;
  if (b.dataset.si !== undefined) return hooks.openStackItem?.(Number(b.dataset.si));
  const act = b.dataset.act;
  if (act === 'next') { const a = S.acts?.[0]; if (a && !a.disabled) doAct(a); }
  if (act === 'nextmenu') menu(b, [{ header: 'NEXT' }, ...S.acts.map((a, i) => ({ label: a.label, value: i, disabled: !!a.disabled, danger: a.tone === 'danger', sub: a.disabled || '' }))], (it) => doAct(S.acts[it.value]), { align: 'right', width: 300 });
  if (act === 'nextleft') hooks.nextLeft?.();
});
