// Small things for whoever looks. Hold ⌥ over code for a loupe, a 2× lens that follows the cursor: the tool the app is
// named after, which is the only licence an easter egg has. Hold it over Mote and he is under the glass too, and waves
// back. (Mote has two more of his own, in mote.js: thrown, he lands on his back; double-clicked, he flies off.)
import { h } from './core.js';
import { hooks } from './hooks.js';

let lens = null, lastE = null, peered = false, follow = 0;
const drop = () => { lens?.remove(); lens = null; peered = false; clearInterval(follow); follow = 0; };
function drawMote(e, mote) {
  if (!lens) { lens = h('<div class="lens" aria-hidden="true"><div class="in"></div></div>'); document.body.append(lens); }
  const inner = lens.querySelector('.in'), rr = mote.getBoundingClientRect();
  const copy = () => {
    if (!mote.isConnected || !mote.offsetParent || mote.closest('#motedock.flying')) return drop();
    const s = inner?.firstElementChild;
    if (s) s.style.cssText = mote.style.cssText;
  };
  if (!inner.classList.contains('of-mote')) { inner.className = 'in of-mote'; inner.innerHTML = '<span class="mote"></span>'; }
  copy();
  // his frames change while he waves: the glass follows them, at his own 12 fps
  if (!follow) follow = setInterval(copy, 83);
  inner.style.left = `${150 - (e.clientX - rr.left) * 2}px`; inner.style.top = `${75 - (e.clientY - rr.top) * 2}px`;
  lens.style.left = `${e.clientX - 150}px`; lens.style.top = `${e.clientY - 75}px`;
  if (!peered) { peered = true; hooks.mote?.peered(); }
}
function drawLens(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const mote = hit?.closest('#motedock .mote');
  if (mote) return drawMote(e, mote);
  clearInterval(follow); follow = 0; peered = false;
  const row = hit?.closest('.fb .ln');
  if (!row) { drop(); return; }
  if (!lens) { lens = h('<div class="lens" aria-hidden="true"><div class="in"></div></div>'); document.body.append(lens); }
  const rows = [row.previousElementSibling, row, row.nextElementSibling].filter((x) => x?.classList?.contains('ln'));
  const inner = lens.querySelector('.in');
  inner.innerHTML = rows.map((r) => r.outerHTML).join('');
  inner.className = 'in' + (row.closest('.fb').classList.contains('split') ? ' split' : '');
  // Centre the lens on the cursor, magnifying what is under it.
  const rr = row.getBoundingClientRect();
  const x = e.clientX - rr.left, y = rows.indexOf(row) * 20 + (e.clientY - rr.top);
  inner.style.left = `${150 - x * 2}px`; inner.style.top = `${75 - y * 2}px`;
  lens.style.left = `${e.clientX - 150}px`; lens.style.top = `${e.clientY - 75}px`;
}
document.addEventListener('mousemove', (e) => { lastE = e; if (e.altKey) drawLens(e); else if (lens) drop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Alt' && lastE) drawLens(lastE); });
document.addEventListener('keyup', (e) => { if (e.key === 'Alt') drop(); });
addEventListener('blur', drop);
