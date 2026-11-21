// The top bar's right side: how much is left (a number and the meter, one block of lamps per file, as long as its
// changed lines, green once viewed, amber if it changed since; meter.js), and the next act (a split button: the likeliest act, then
// everything else you can do now). Each act is a sheet (a write with its live preview) or a plain step. The stack
// this change sits in is drawn as number chips beside the title.
import { S, $, esc, I, plural, convOf, toast } from './core.js';
import { isViewed, isStale, lines, orderedFiles, cardEl } from './cards.js';
import { progressMarks, nextUnviewed } from './tree.js';
import { menu, canMerge } from './ui.js';
import { icon } from './pixel.js';
import { hooks } from './hooks.js';
import { meter } from './meter.js';

export const liveConv = () => S.review.chats.map(convOf).find((c) => c?.linked?.live && !c.linked.offline) || null;

// What you can do next, the likeliest first.
export function nextActs() {
  const m = S.ws, p = S.github?.pr, st = S.ship;
  const pend = S.github?.pending?.comments?.length || 0;
  const acts = [];
  const reviewAct = { label: pend ? `Submit review · ${pend}` : 'Submit review', sheet: ['review', {}] };
  // a pull request you wrote, or one assigned to you, is yours to answer, not to review: its review acts appear only to
  // submit comments you have pending
  const own = !!(p?.viewerIsAuthor || p?.viewerIsAssignee);
  if (m.kind === 'pr') {
    // loupe does not merge: a pull request GitHub calls ready is merged there, so that is the first act
    if (canMerge(p)) acts.push({ label: 'Merge on GitHub', run: () => window.open(p.url, '_blank', 'noopener') });
    if (p?.state === 'OPEN') {
      if (!own || pend) acts.push(reviewAct);
      if (!own) acts.push({ label: 'Approve', sheet: ['review', { event: 'APPROVE' }] }, { label: 'Request changes', sheet: ['review', { event: 'REQUEST_CHANGES' }] });
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
    if (p?.state === 'OPEN' && !pend && !own) acts.push(reviewAct);
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
  el.classList.toggle('clean', total > 0 && left === 0);
  const n = `<span class="n">${total === 0 ? 'No changes' : left === 0 ? `${icon('check', '--ok')} All viewed` : `<b class="odo">${left.toLocaleString()}</b> left`}</span>`;
  // the meter is built once and kept, so what it is animating survives the count being redrawn
  if (!M || !el.contains(M.host)) {
    M?.destroy();
    el.innerHTML = n + '<span class="meter"></span>';
    // the label hangs below the bar, over the page, so it lives on the body and is placed by the block's position
    const host = el.querySelector('.meter'), label = document.querySelector('body > .mlabel') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'mlabel', hidden: true }));
    M = meter(host, {
      onPick: (s) => hooks.goLoc?.({ path: s.path, line: 0 }),
      onHover: (s) => {
        if (!s) { label.hidden = true; return; }
        const f = s.f, r = S.readFrac.get(f.path) || 0;
        label.innerHTML = `<b>${esc(f.path.split('/').pop())}</b> <span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span> · ${s.state === 'done' ? 'viewed' : s.state === 'stale' ? 'changed since viewed' : r > 0.02 ? `${Math.round(r * 100)}% read` : 'not read yet'}`;
        label.hidden = false;
        const hr = host.getBoundingClientRect(), x = hr.left + s.mid * hr.width, half = label.offsetWidth / 2;
        label.style.left = Math.max(half + 8, Math.min(innerWidth - half - 8, x)) + 'px';
        label.style.top = $('.top')?.getBoundingClientRect().bottom + 6 + 'px';
      },
    });
    M.host = host; M.ws = null;
  } else el.querySelector('.n').outerHTML = n;
  lastLeft = left; // the next change of the count is measured from what is on screen now
  paintMeter();
  const gen = S.files.filter((f) => f.kind === 'generated');
  el.title = `${left.toLocaleString()} of ${total.toLocaleString()} changed lines not yet viewed, in ${leftFiles.length} of ${plural(files.length, 'file')}.` +
    (gen.length ? ` ${plural(gen.length, 'generated file')} are not counted.` : '') + (S.app.settings?.autoView ? ' Tests count as viewed until you untick one.' : '') + ' Click for the next file left (]).';
}
// The meter's blocks, in reading order. A file you have scrolled through part of lights that share of its lamps: skimmed
// half reads differently from untouched. Viewed turns it green; changed since, amber.
let M = null;
function paintMeter() {
  const fs = orderedFiles().map(({ f }) => f).filter((f) => f.kind !== 'generated');
  const sum = fs.reduce((n, f) => n + Math.max(1, lines(f)), 0) || 1;
  let acc = 0;
  const segs = fs.map((f) => {
    const w = Math.max(1, lines(f)), mid = (acc + w / 2) / sum; acc += w;
    return { path: f.path, f, w, mid, cur: f.path === S.current, state: isViewed(f) ? 'done' : isStale(f) ? 'stale' : 'left', read: isViewed(f) ? 0 : S.readFrac.get(f.path) || 0 };
  });
  const opening = M.ws !== S.id; M.ws = S.id;
  M.update(segs, { opening });
}
export function paintProgress() {
  if (!M || !$('#tally')?.contains(M.host)) return renderProgress();
  paintMeter();
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
  if (left === 0 && total) { renderProgress(); M?.glint(); return; }
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
  const tone = a.tone === 'danger' ? 'danger' : ''; // a plain button: the frame is chrome, a filled slab shouts in it
  el.innerHTML = `<button class="btn ${tone}${acts.length > 1 ? ' l' : ''}" data-act="next"${a.disabled ? ` disabled title="${esc(a.disabled)}"` : ''}>${esc(a.label)}</button>` +
    (acts.length > 1 ? `<button class="btn ${tone} r" data-act="nextmenu" aria-label="Everything you can do next" title="Everything you can do next">${I.chev}</button>` : '');
}

export function renderStack() {
  if (S.tab === 'overview') hooks.renderPanel?.(); // the stack is drawn in Overview
}

document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.top [data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'next') { const a = S.acts?.[0]; if (a && !a.disabled) doAct(a); }
  if (act === 'nextmenu') menu(b, [{ header: 'NEXT' }, ...S.acts.map((a, i) => ({ label: a.label, value: i, disabled: !!a.disabled, danger: a.tone === 'danger', sub: a.disabled || '' }))], (it) => doAct(S.acts[it.value]), { align: 'right', width: 300 });
  if (act === 'nextleft') hooks.nextLeft?.();
});
