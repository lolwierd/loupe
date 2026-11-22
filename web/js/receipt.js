// The toast's commit ID turns over like a split-flap board. Each leaf folds to the seam before the new glyph opens.
import { $, reducedMotion } from './core.js';

const HEX = '0123456789abcdef';
export function flipCommitId(parent = '') {
  const span = $('#toast')?.querySelector('span');
  const m = span && /^Committed ([0-9a-f]{7,40})\b/.exec(span.textContent);
  if (!m || reducedMotion()) return;
  const to = m[1], from = parent.slice(0, to.length).padEnd(to.length, '0'), rest = span.textContent.slice('Committed '.length + to.length);
  span.textContent = 'Committed ';
  const said = document.createElement('span'); said.className = 'sr'; said.textContent = to;
  const id = document.createElement('code'); id.className = 'flip'; id.setAttribute('aria-hidden', 'true');
  span.append(said, id, rest);

  [...to].forEach((ch, i) => {
    const flap = document.createElement('span');
    flap.className = 'flap';
    flap.textContent = ch;
    id.append(flap);
    if (from[i] === ch) return;
    const distance = (HEX.indexOf(ch) - HEX.indexOf(from[i]) + 16) % 16;
    flap.style.setProperty('--flip-delay', `${i * 30}ms`);
    flap.style.setProperty('--flip-half', `${Math.max(80, Math.min(160, distance * 40)) / 2}ms`);
    for (const [half, glyph] of [['old-top', from[i]], ['old-bottom', from[i]], ['new-bottom', ch]]) {
      const leaf = document.createElement('span');
      leaf.className = 'leaf ' + half;
      leaf.textContent = glyph;
      flap.append(leaf);
    }
  });
}
