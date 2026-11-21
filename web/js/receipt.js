// A commit's receipt: in its toast the new commit's id flips in from its parent's, one character after another, the way
// a split-flap board turns to the next departure, so you see the history move on and the id you might copy. Each cell
// is one mono character wide (the id never changes width), turns through at most four characters, 40 ms a turn,
// starting 30 ms after the cell to its left, and shows its fold while it turns. With reduced motion it is the new id.
import { $, reducedMotion } from './core.js';

const HEX = '0123456789abcdef';
export function flipCommitId(parent = '') {
  const t = $('#toast'), span = t?.querySelector('span');
  const m = span && /^Committed ([0-9a-f]{7,40})\b/.exec(span.textContent);
  if (!m || reducedMotion()) return;
  const to = m[1], from = parent.slice(0, to.length).padEnd(to.length, '0'), rest = span.textContent.slice('Committed '.length + to.length);
  span.textContent = 'Committed ';
  const said = document.createElement('span'); said.className = 'sr'; said.textContent = to; // what a screen reader hears: the new id, once
  const id = document.createElement('code'); id.className = 'flip'; id.setAttribute('aria-hidden', 'true');
  span.append(said, id, rest);
  [...to].forEach((ch, i) => {
    const c = document.createElement('span'); c.className = 'flap'; c.textContent = from[i]; id.append(c);
    const a = HEX.indexOf(from[i]), b = HEX.indexOf(ch), span16 = (b - a + 16) % 16, n = Math.min(4, span16);
    if (!n) return; // the same character: it stays
    for (let k = 1; k <= n; k++) {
      const next = k === n ? ch : HEX[(a + Math.round((span16 * k) / n)) % 16];
      setTimeout(() => { c.textContent = next; c.classList.toggle('turn', k < n); }, i * 30 + k * 40);
    }
  });
}
