// Updating loupe itself, from inside it (the daemon's side is src/update.mjs). When the copy loupe runs from is behind
// its source's main (yours, or origin's), the page asks once per new commit, with a toast; home's footer and ⌘K keep
// the offer after that. The dialog says what will happen as itself: a short account of the commits, written by a
// model when there is one (their subjects stand in until it lands, or if it never does), then the commits. Update
// runs only that commit, and only on your click; loupe restarts, and the page comes back by itself.
import { S, $, esc, h, api, I, toast, plural, pref } from './core.js';
import { hooks } from './hooks.js';
import { shimmerSync } from './ui.js';

const U = () => S.app?.update || null;
const short = (sha = '') => sha.slice(0, 7);

// what the page learns: on load (/api/state), from either event stream, and after an update ends
hooks.updateChanged = (v) => {
  if (!S.app || !v) return;
  S.app.update = v;
  hooks.homeUpdate?.();
  hooks.paintUpdate?.();
  paintDialog();
  const l = v.last;
  // how the last update went, said once
  if (l && l.state !== 'running' && l.at && pref.get('updateNoted', 0) < l.at) {
    pref.set('updateNoted', l.at);
    if (l.state === 'done') toast(`loupe updated to ${short(l.sha)}${l.count ? ` (${plural(l.count, 'commit')})` : ''}.`);
    else toast(`loupe did not update: ${(l.message || 'see ~/.loupe/logs/update.log').split('\n').pop()}`, { fail: true });
  }
  // a new update, asked about once
  if (v.available && v.target && !v.taking && pref.get('updateAsked', '') !== v.target) {
    pref.set('updateAsked', v.target);
    toast(`loupe can update: ${plural(v.count, 'new commit')} on ${v.via}.`, { action: 'See what changes', run: openUpdate });
  }
};
// the page's first look, and a look when it comes back to a daemon that restarted
export async function readUpdate() { try { hooks.updateChanged(await api('/api/update')); } catch { /* an older daemon */ } }

// the icon in the top bar (and beside home's name): there while an update waits or runs, the dialog under it
hooks.paintUpdate = () => {
  const b = $('#updbtn'), u = U();
  if (!b) return;
  const on = !!(u?.available || u?.taking);
  b.hidden = !on;
  if (!on) return;
  const t = u.taking ? 'loupe is updating…' : `loupe can update: ${plural(u.count, 'new commit')} on ${u.via}. See what changes`;
  b.title = t; b.setAttribute('aria-label', t);
};

// the line home keeps in its footer while there is an update
export const homeUpdateLine = () => {
  const u = U();
  if (u?.taking) return '<p>loupe is updating…</p>';
  if (!u?.available) return '';
  return `<p>loupe can update: ${esc(plural(u.count, 'new commit'))} on ${esc(u.via)}. <button class="link" data-act="loupeupdate">See what changes</button></p>`;
};

// ------------------------------------------------------------------ the dialog
let open = null; // { scrim, sha }
export function openUpdate() {
  const u = U();
  if (!u?.available) return toast(u?.taking ? 'loupe is updating.' : 'loupe is up to date.');
  closeUpdate();
  const opener = document.activeElement;
  const scrim = h('<div class="sheetscrim" data-weight="local"></div>');
  scrim.innerHTML = `<div class="sheet k-update small" role="dialog" aria-modal="true" aria-labelledby="upt">` +
    `<header class="shh"><h2 class="t" id="upt"></h2><button class="icon" data-up="close" title="Close (esc)" aria-label="Close">${I.x}</button></header>` +
    `<div class="shb"><p class="uptldr" id="uptldr"></p><section class="part"><div class="sh"><span>Commits</span><span class="n" id="upn"></span></div><div class="clist" id="uplist"></div></section><section class="part" id="upgoes" hidden><div class="sh"><span>Leaves out</span><span class="n" id="upgn"></span></div><div class="clist" id="upglist"></div></section><p class="note" id="upnote"></p></div>` +
    `<div class="shwarn" id="upwarn" hidden></div>` +
    `<footer class="shf"><span class="what" id="upwhat"></span><button class="btn ghost lg" data-up="close">Cancel</button><button class="btn primary lg go" data-up="go"><span class="gl">Update</span><kbd>⌘↵</kbd></button></footer></div>`;
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeUpdate(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); go(); }
  };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeUpdate(); });
  scrim.addEventListener('click', (e) => { if (e.target.closest('[data-up="close"]')) closeUpdate(); if (e.target.closest('[data-up="go"]')) go(); });
  document.addEventListener('keydown', key, true);
  document.body.append(scrim);
  open = { scrim, key, opener, sha: u.target, tldr: null, asked: null };
  paintDialog();
  ask(u.target);
  requestAnimationFrame(() => scrim.querySelector('[data-up="go"]')?.focus());
}
export function closeUpdate() {
  if (!open) return;
  open.scrim.remove(); document.removeEventListener('keydown', open.key, true);
  if (open.opener?.isConnected) open.opener.focus();
  open = null;
}
// the account of the commits, asked for once per update; their subjects stand in meanwhile
async function ask(sha) {
  if (!open || open.asked === sha) return;
  open.asked = sha; open.tldr = null; open.tldrFailed = false;
  paintDialog();
  try { const r = await api('/api/update/summary', { method: 'POST', body: { sha } }); if (open?.sha === sha) open.tldr = r.tldr; }
  catch { if (open?.sha === sha) open.tldrFailed = true; }
  paintDialog();
}
function paintDialog() {
  if (!open) return;
  const u = U(), el = open.scrim;
  const title = el.querySelector('#upt'), go = el.querySelector('[data-up="go"]'), warn = el.querySelector('#upwarn');
  if (u?.available && u.target !== open.sha) { // main moved while it was open: it shows the newer commit, and says so
    open.sha = u.target; open.moved = true; ask(u.target);
  }
  const sha = open.sha;
  title.textContent = u?.taking ? `Updating loupe to ${short(sha)}` : `Update loupe to ${short(sha)}`;
  const list = u?.comes || [], total = u?.count || list.length;
  const tl = el.querySelector('#uptldr');
  if (open.tldr) { tl.className = 'uptldr'; tl.textContent = open.tldr; }
  else if (open.tldrFailed || !list.length) { tl.className = 'uptldr'; tl.textContent = list[0]?.subject ? `${list[0].subject}${total > 1 ? `, and ${plural(total - 1, 'more commit')}.` : '.'}` : ''; }
  else { tl.className = 'uptldr mstate shimmer'; tl.setAttribute('style', shimmerSync()); tl.textContent = 'Reading the commits…'; }
  el.querySelector('#upn').textContent = String(total);
  const rows = (cs, n) => cs.slice(0, 12).map((c) => `<div class="crow"><span class="sha">${esc(c.short)}</span><span class="s" title="${esc(c.subject)}">${esc(c.subject)}</span></div>`).join('') +
    (n > 12 ? `<div class="crow more"><span></span><span>${esc(plural(n - 12, 'more commit'))}</span></div>` : '');
  el.querySelector('#uplist').innerHTML = rows(list, total);
  // what runs now and is not on main (a commit promoted by hand, perhaps squashed into main since): left out, not lost
  const goes = u?.goes || [], gn = u?.goesCount || goes.length;
  el.querySelector('#upgoes').hidden = !gn;
  el.querySelector('#upgn').textContent = String(gn);
  el.querySelector('#upglist').innerHTML = rows(goes, gn);
  const from = u?.mode === 'promote' ? `${u.main}${u.via.startsWith('origin/') ? ` on origin` : ''}, in ${u.srcShown || u.src}` : `${u?.via || 'origin/main'}`;
  const where = u?.srcShown || u?.src;
  el.querySelector('#upnote').textContent = [
    u?.unpushed ? `${u.unpushed === total ? (total === 1 ? 'It is' : 'They are') : `${u.unpushed} of them ${u.unpushed === 1 ? 'is' : 'are'}`} on your ${u.main} and not on origin yet.` : '',
    gn ? `What runs now has ${plural(gn, 'commit')} ${u?.main} does not; they stay in ${where}.` : '',
    u?.behindOrigin ? `origin/${u.main} also has ${plural(u.behindOrigin, 'commit')} your ${u.main} does not: pull them in ${where} to have them too.` : '',
    u?.fetchError ? `origin could not be reached (${u.fetchError.replace(/^git fetch: /, '')}): this is what ${where} already had.` : '',
    `From ${from}. loupe restarts and the page comes back by itself; your reviews, marks and chats stay.`,
  ].filter(Boolean).join(' ');
  el.querySelector('#upwhat').textContent = u?.mode === 'pull' ? `Fast-forwards ${u?.srcShown || u?.src}` : 'Copies the commit into the copy loupe runs';
  go.disabled = !!u?.taking || !u?.available;
  go.querySelector('.gl').textContent = u?.taking ? 'Updating…' : 'Update';
  if (!u?.available && !u?.taking) { warn.hidden = false; warn.textContent = 'loupe is up to date now.'; }
  else if (open.moved && !open.sending) { warn.hidden = false; warn.textContent = `${u?.via || 'main'} moved while this was open: it now shows ${short(sha)}.`; }
}
async function go() {
  if (!open || open.sending || U()?.taking) return;
  const sha = open.sha, warn = open.scrim.querySelector('#upwarn'), btn = open.scrim.querySelector('[data-up="go"]');
  open.sending = true; btn.disabled = true; warn.hidden = true; // one click is one update
  try {
    await api('/api/update', { method: 'POST', body: { sha } });
    S.app.update = { ...U(), taking: true };
    hooks.paintUpdate?.();
  } catch (e) { warn.hidden = false; warn.textContent = e.message; }
  if (open) { open.sending = false; paintDialog(); }
}

// home's footer link, and the page's own ⌘K entry (main.js lists it)
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-act="loupeupdate"]')) openUpdate(); });
export async function checkUpdate() {
  try { const v = await api('/api/update/check', { method: 'POST' }); hooks.updateChanged(v); if (v.available) openUpdate(); else toast(v.taking ? 'loupe is updating.' : v.mode ? 'loupe is up to date.' : 'loupe has no source to update from here.'); }
  catch (e) { toast(e.message, { fail: true }); }
}
