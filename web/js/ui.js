// Shared parts: the menu, the composer (one shape for a new thread, a reply and the chat box), the model and effort
// picker, and how a message is drawn.
import { S, $, $$, esc, h, I, pref, modelName, lastRun, rememberRun, ago } from './core.js';
import { md } from './md.js';
import { spark } from './pixel.js';

// ------------------------------------------------------------------ menu
// items: { label, sub, key, value, current | on, header, sep, danger, disabled, icon, two: [line1, line2] }
// A menu that has any icons gives every row the icon column, so labels share one x whether or not their row has an
// icon; the same goes for the key and check columns on the right.
let openMenuEl = null;
export function closeMenu() { openMenuEl?.remove(); openMenuEl = null; document.removeEventListener('mousedown', outside, true); }
function outside(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
export function menu(anchor, items, onPick, { align = 'left', width } = {}) {
  closeMenu();
  const el = h(`<div class="menu" role="menu"${width ? ` style="width:${width}px"` : ''}></div>`);
  let k = 0;
  const keys = items.some((it) => it.key), checks = items.some((it) => 'current' in it || 'on' in it), icons = items.some((it) => it.icon);
  const trail = (it) => (keys ? (it.key ? `<kbd class="mk">${esc(it.key)}</kbd>` : '<span class="mk"></span>') : '') + (checks ? `<span class="mc">${it.current || it.on ? I.check : ''}</span>` : '');
  el.innerHTML = items.map((it) => {
    if (it.sep) return '<hr>';
    if (it.header) return `<div class="mh"><span>${esc(it.header)}</span>${it.key ? `<kbd title="switches">${esc(it.key)}</kbd>` : ''}</div>`;
    const i = k++;
    const body = it.two ? `<span class="two"><span>${esc(it.two[0])}</span><span>${esc(it.two[1] || '')}</span></span>` : `<span class="ml">${esc(it.label)}</span>`;
    return `<button class="mi${it.danger ? ' danger' : ''}" role="${'on' in it ? 'menuitemcheckbox' : 'current' in it ? 'menuitemradio' : 'menuitem'}" data-i="${i}"${it.current || it.on ? ' aria-checked="true"' : 'current' in it || 'on' in it ? ' aria-checked="false"' : ''}${it.current ? ' aria-current="true"' : ''}${it.disabled ? ' disabled' : ''}>${it.icon || (icons ? '<span class="mi-ic"></span>' : '')}${body}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}${trail(it)}</button>`;
  }).join('');
  const pickable = items.filter((it) => !it.sep && !it.header);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + hgt > innerHeight - 8) top = Math.max(8, r.top - hgt - 4);
  el.style.left = left + 'px'; el.style.top = top + 'px';
  openMenuEl = el;
  let cur = -1;
  const btns = $$('.mi', el);
  const mark = (i) => { cur = i; btns.forEach((b, j) => b.setAttribute('aria-selected', String(j === i))); btns[i]?.scrollIntoView({ block: 'nearest' }); };
  el.addEventListener('click', (e) => { const b = e.target.closest('.mi'); if (!b || b.disabled) return; const it = pickable[Number(b.dataset.i)]; closeMenu(); onPick(it); });
  el.addEventListener('keydown', (e) => {
    // arrows skip the rows that cannot be picked
    const step = (d) => { let i = cur + d; while (btns[i]?.disabled) i += d; if (btns[i]) mark(i); };
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); btns[cur].click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus?.(); }
  });
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  (btns.find((b) => b.getAttribute('aria-current') === 'true') || btns[0])?.focus();
  return el;
}

// ------------------------------------------------------------------ the model and effort picker
// A button that says what the box will use ("Opus 5.5 · xhigh"); the choice is remembered in this browser.
export const runLabel = (r) => `${modelName(r.model)} · ${r.effort}`;
export function runBtn(r) { return `<button type="button" class="runbtn" data-act="run" data-model="${esc(r.model)}" data-effort="${esc(r.effort)}" title="Model and effort">${I.spark}<span>${esc(runLabel(r))}</span></button>`; }
export function pickRun(btn) {
  const cur = { model: btn.dataset.model, effort: btn.dataset.effort };
  const items = [{ header: 'MODEL' }, ...S.app.models.map((m) => ({ label: m.label, value: { model: m.id }, current: m.id === cur.model })),
    { sep: true }, { header: 'EFFORT' }, ...S.app.efforts.map((e) => ({ label: e, value: { effort: e }, current: e === cur.effort, sub: { low: 'fastest', max: 'slowest' }[e] || '' }))];
  menu(btn, items, (it) => {
    Object.assign(cur, it.value);
    btn.dataset.model = cur.model; btn.dataset.effort = cur.effort;
    btn.querySelector('span').textContent = runLabel(cur);
    // The brief's picker is remembered apart from questions'.
    if (btn.dataset.brief) { pref.set('briefModel', cur.model); pref.set('briefEffort', cur.effort); } else rememberRun(cur);
  }, { align: 'right', width: 220 });
}
export const runOf = (root) => { const b = root?.querySelector('[data-act="run"]'); return b ? { model: b.dataset.model, effort: b.dataset.effort } : lastRun(); };

// ------------------------------------------------------------------ composer
export function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; }
document.addEventListener('input', (e) => { if (e.target.matches?.('.composer textarea')) grow(e.target); });

// ------------------------------------------------------------------ messages
const toolsLine = (tools) => {
  const n = (k) => tools.filter((t) => t.name === k).length;
  const bits = [];
  if (n('Read')) bits.push(`read ${n('Read')} file${n('Read') === 1 ? '' : 's'}`);
  if (n('Grep') + n('Glob')) bits.push(`searched ${n('Grep') + n('Glob')}×`);
  if (n('git')) bits.push(`${n('git')} git command${n('git') === 1 ? '' : 's'}`);
  if (tools.some((t) => /thread/.test(t.name))) bits.push('looked at your other threads');
  const s = bits.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : `${tools.length} steps`;
};
// A repeating animation keeps its phase when its element is redrawn (answers redraw as they stream): the delay is
// taken from the clock, so a redraw lands mid-sweep instead of starting over.
export const shimmerSync = (ms = 1800) => `animation-delay:-${Date.now() % ms}ms`;
export function msgHTML(m, { compact = false } = {}) {
  const me = m.role === 'user';
  const who = me ? 'You' : 'Claude';
  const steps = !me && (m.tools?.length || m.notes?.length)
    ? `<details class="steps"><summary>${esc(toolsLine(m.tools || []))}</summary>${(m.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('')}<ul>${(m.tools || []).map((t) => `<li>${esc(t.name)} ${esc(t.input)}</li>`).join('')}</ul></details>` : '';
  const atts = me && m.attachments?.length ? `<div class="attach">${m.attachments.map((a) => `<button class="chip" data-act="goatt" data-p="${esc(a.path)}" data-l="${a.line || ''}" data-side="${a.side || 'new'}" title="${esc(a.path)}"><span>${esc(a.path.split('/').pop())} ${esc(a.label)}</span></button>`).join('')}</div>` : '';
  const working = m.pending && !m.text ? `<div class="working"><span class="shimmer" style="${shimmerSync()}">${m.queued ? 'Waiting for the answer before it' : m.tools?.length ? `Reading the code · ${esc(m.tools.at(-1).input || '').slice(0, 80)}` : 'Thinking'}</span></div>` : '';
  return `<div class="msg${me ? ' me' : ''}" data-m="${esc(m.id)}">` +
    `<div class="mh">${me ? '' : spark(16, !m.pending, 'Claude')}<span class="who ${me ? 'me' : 'claude'}">${who}</span>${me ? '' : `<span class="model">${esc(modelName(m.model))}${m.effort ? ' · ' + esc(m.effort) : ''}</span>`}<span class="t">${ago(m.at)}</span>` +
    `${!me && m.pending ? `<span class="sp"></span><button class="link" data-act="stop">Stop</button>` : ''}</div>` +
    atts + steps + (m.text ? `<div class="md${compact ? ' sm' : ''}">${md(m.text)}</div>` : '') + working +
    (m.error ? `<div class="err">${esc(m.error)}</div>` : '') + (m.foot && !m.pending ? `<div class="mfoot">${esc(m.foot)}</div>` : '') + `</div>`;
}

document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-act="run"]'); if (b) { e.preventDefault(); e.stopPropagation(); pickRun(b); } }, true);
