// One small thing for whoever looks: hold ⌥ over code for a loupe, a 2× lens that follows the cursor. It is the
// tool the app is named after, which is the only licence an easter egg has.
import { h } from './core.js';

let lens = null, lastE = null;
function drawLens(e) {
  const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fb .ln');
  if (!row) { lens?.remove(); lens = null; return; }
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
document.addEventListener('mousemove', (e) => { lastE = e; if (e.altKey) drawLens(e); else if (lens) { lens.remove(); lens = null; } });
document.addEventListener('keydown', (e) => { if (e.key === 'Alt' && lastE) drawLens(lastE); });
document.addEventListener('keyup', (e) => { if (e.key === 'Alt') { lens?.remove(); lens = null; } });
