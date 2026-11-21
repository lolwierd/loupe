// The bin: the changed files as a tree, directories squashed where they hold one child, each file with its status,
// its lines left, a check once viewed (amber when it changed since), and how many marks are on it. The strip in the
// top bar draws the same files as segments.
import { S, $, $$, esc, tick, I, threadsAt, fileOf, plural } from './core.js';
import { isViewed, isStale, lines, statusGlyph, cardEl, orderedFiles, countedOnly } from './cards.js';
import { icon } from './pixel.js';
import { md } from './md.js';
import { checkKey } from './cards.js';

function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/'); let n = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const name = parts[k];
      if (!n.dirs.has(name)) n.dirs.set(name, { name, path: parts.slice(0, k + 1).join('/'), dirs: new Map(), files: [] });
      n = n.dirs.get(name);
    }
    n.files.push(f);
  }
  const squash = (n) => { for (const [k, d] of n.dirs) { let x = d; while (!x.files.length && x.dirs.size === 1) { const [only] = x.dirs.values(); x = { ...only, name: x.name + '/' + only.name }; } n.dirs.set(k, x); squash(x); } };
  squash(root);
  return root;
}
const leftIn = (files) => files.filter((f) => !isViewed(f) && f.kind !== 'generated').reduce((n, f) => n + lines(f), 0);

function fileRow(f, depth, name) {
  const v = isViewed(f), stale = isStale(f);
  const n = threadsAt(f.path).length;
  const counted = v && countedOnly(f);
  const status = v ? icon('check', counted ? '--ink-3' : '--ok') : `${stale ? icon('dot', '--warn') : ''}${f.kind === 'generated' ? 'gen' : lines(f).toLocaleString()}`;
  // an answer you have not opened yet: one pixel of Claude's colour, the spark's satellite, landed on the file
  const unread = threadsAt(f.path).some((t) => S.unreadAns.has(t.id));
  return `<button class="trow${v ? ' viewed' : ''}${stale ? ' stale' : ''}" data-p="${esc(f.path)}" style="--d:${depth}" title="${esc(f.path)}${stale ? ' · changed since you viewed it' : counted ? ` · counted as viewed (a ${f.kind} file)` : ''}">` +
    `${statusGlyph(f)}<span class="nm">${esc(name)}</span><span class="meta">${unread ? '<i class="sat" title="An answer you have not opened"></i>' : ''}${n ? `<span class="cm">${I.cmt}${n}</span>` : ''}<span class="lines">${status}</span></span></button>`;
}

// The guide layout's left column is the guide's table of contents: every section on one line with what is left of
// it, and the section you are reading opened to its files and how many of its checks you ticked. The why and the
// checks themselves stand in the middle, above the section's files, where you read them.
let openSec = -1;
export const sectionOf = (p) => (S.review.brief?.sections || []).findIndex((s) => s.files.includes(p));
function guideSideHTML(match) {
  const secs = S.review.brief.sections;
  const inGuide = new Set(secs.flatMap((s) => s.files));
  const rest = S.files.filter((f) => !inGuide.has(f.path) && match(f));
  openSec = sectionOf(S.current);
  if (openSec < 0 && rest.some((f) => f.path === S.current)) openSec = secs.length;
  const row = (k, title, fs, checks) => {
    const left = leftIn(fs), open = k === openSec;
    const ticked = checks.filter((_, j) => S.review.checks?.[checkKey(k, j)]).length;
    return `<section class="gside${left ? '' : ' done'}${open ? ' open' : ''}" id="gs-${k}"><button class="gsh" data-act="gosec" data-k="${k}" aria-expanded="${open}"><span class="gi">${k < secs.length ? k + 1 : ''}</span><span class="gt tick">${tick(title)}</span><span class="num">${left ? left.toLocaleString() : icon('check', '--ok')}</span></button>` +
      (open ? `<div class="gfiles">${fs.map((f) => fileRow(f, 0, f.path.split('/').pop())).join('')}</div>${checks.length ? `<div class="gsum">${ticked} of ${plural(checks.length, 'check')} ticked</div>` : ''}` : '') + '</section>';
  };
  return `<nav class="gtoc" aria-label="The guide">${secs.map((sec, k) => row(k, sec.title, sec.files.map(fileOf).filter((f) => f && match(f)), sec.check || [])).join('')}` +
    (rest.length ? row(secs.length, 'Not in the guide', rest, []) : '') +
    `<div class="gfoot">${S.review.brief.pending ? `<span class="shimmer">Regenerating</span>` : `<button class="link" data-act="writebrief">Regenerate the guide</button>`}</div></nav>`;
}
export function renderTree() {
  const q = S.filter.toLowerCase();
  const match = (f) => !q || f.path.toLowerCase().includes(q);
  const files = S.files.filter(match);
  let html = '';
  if (S.mode === 'guide' && !S.review.brief?.sections?.length) {
    html = `<div class="tempty">No guide yet. <button class="link" data-act="writebrief">Write the brief</button> and this column becomes Claude's guide to the change.</div>`;
  } else if (S.mode === 'guide') {
    html = guideSideHTML(match);
  } else if (S.order === 'guide' && S.review.brief?.sections?.length) {
    // Guide order: one group per section, files in reading order.
    S.review.brief.sections.forEach((sec, k) => {
      const fs = sec.files.map(fileOf).filter((f) => f && match(f));
      if (!fs.length) return;
      const left = leftIn(fs);
      html += `<div class="tsection"><span class="gi">${k + 1}</span><span class="gt tick">${tick(sec.title)}</span><span class="n">${left ? left.toLocaleString() : ''}</span></div>` + fs.map((f) => fileRow(f, 0, f.path.split('/').pop())).join('');
    });
  } else {
    const node = (n, depth) => [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => {
      const all = collect(d), left = leftIn(all), done = all.every((f) => isViewed(f) || f.kind === 'generated');
      const slash = d.name.lastIndexOf('/') + 1;
      return `<button class="trow dir${S.dirShut.has(d.path) ? ' shut' : ''}${done ? ' viewed' : ''}" data-d="${esc(d.path)}" style="--d:${depth}" title="${esc(d.path)}" aria-label="${esc(d.path)}">${I.chev}<span class="nm dirname">${slash ? `<span class="parent">${esc(d.name.slice(0, slash))}</span>` : ''}<span class="leaf">${esc(d.name.slice(slash))}</span></span><span class="meta"><span class="lines">${done ? icon('check', '--ok') : left ? left.toLocaleString() : ''}</span></span></button>` +
        (S.dirShut.has(d.path) ? '' : node(d, depth + 1));
    }).join('') + n.files.map((f) => fileRow(f, depth, f.path.split('/').pop())).join('');
    html = files.length ? node(buildTree(files), 0) : '';
  }
  $('#tlist').innerHTML = q && !files.length
    ? '<div class="tempty">No matching files. <button class="link" data-act="clearfilter">Clear</button></div>'
    : html || '<div class="tempty">No changes.</div>';
  markCurrent();
  for (const f of S.files) { const c = cardEl(f.path); if (c) c.hidden = !match(f); }
}
const collect = (d) => [...d.files, ...[...d.dirs.values()].flatMap(collect)];

export function markCurrent() {
  const p = S.current;
  // reading into another section opens it in the guide's contents
  if (S.mode === 'guide' && S.review.brief?.sections?.length && p && sectionOf(p) >= 0 && sectionOf(p) !== openSec) return renderTree();
  for (const n of $$('.trow[aria-current="true"]')) n.removeAttribute('aria-current');
  if (p) $(`.trow[data-p="${CSS.escape(p)}"]`)?.setAttribute('aria-current', 'true');
}

// The tab says what is left (title and favicon ring), and the moment the last file is viewed a toast says so (the meter
// in the top bar sends its glint across the board, acts.js).
let lastLeft = null;
export function progressMarks(total, left) {
  const done = total ? (total - left) / total : 1;
  const m = S.ws;
  const name = m?.pr ? `#${m.pr.number} ${m.pr.title}` : m?.branch || 'loupe';
  document.title = `${total && left ? `${left.toLocaleString()} left · ` : total ? '✓ ' : ''}${name} · loupe`;
  const r = 6, c = 2 * Math.PI * r;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${r}" fill="none" stroke="#8c8c96" stroke-opacity=".35" stroke-width="3"/><circle cx="8" cy="8" r="${r}" fill="none" stroke="${done >= 1 ? '#1d8348' : '#2f67dd'}" stroke-width="3" stroke-dasharray="${(c * done).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)" stroke-linecap="${done > 0 && done < 1 ? 'round' : 'butt'}"/></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.type = 'image/svg+xml'; link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  if (lastLeft > 0 && left === 0 && total > 0 && lastLeft !== null) {
    import('./core.js').then(({ toast }) => toast('Every file viewed.'));
  }
  lastLeft = left;
}
export function nextUnviewed() {
  const order = orderedFiles().map(({ f }) => f).filter((f) => !isViewed(f) && f.kind !== 'generated' && !cardEl(f.path)?.hidden);
  if (!order.length) return null;
  const i = order.findIndex((f) => f.path === S.current);
  return (order.find((f, k) => k > i && f.path !== S.current) || order[0]).path;
}
