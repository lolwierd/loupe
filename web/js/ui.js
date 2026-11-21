// Shared parts: the menu, the composer (one shape for a new thread, a reply and the chat box), the model and effort
// picker, and how a message is drawn.
import { S, $, $$, esc, h, I, pref, modelName, lastRun, rememberRun, ago, briefRun, freshModel } from './core.js';
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
    if (it.header) return `<div class="sh"><span>${esc(it.header)}</span>${it.key ? `<kbd title="switches">${esc(it.key)}</kbd>` : ''}</div>`;
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
export const briefRunBtn = () => runBtn(briefRun(), { purpose: 'brief' });
export const modelKind = (model) => S.app?.models.find((m) => m.id === model)?.kind || (/^gpt-/.test(model || '') ? 'codex' : 'claude');
const runContent = (r) => `${modelKind(r.model) === 'claude' ? I.spark : ''}<span>${esc(runLabel(r))}</span>${I.chev}`;
const convKind = (conv) => (conv?.linked || conv?.sessionId ? 'claude' : conv?.modelKind || conv?.messages.find((m) => m.role !== 'user')?.role);
function availableModel(model, conv, fallback) {
  const kind = convKind(conv) || modelKind(model);
  const current = freshModel(model);
  if (current && modelKind(current) === kind) return current;
  if (fallback && modelKind(fallback) === kind) return fallback;
  return S.app.models.find((m) => m.kind === kind)?.id || fallback || model;
}
export function runBtn(r, { conv, purpose = '' } = {}) {
  r = { ...r, model: availableModel(r.model, conv, purpose === 'brief' ? S.app.defaults?.briefModel : S.app.defaults?.model) };
  return `<button type="button" class="runpick" data-act="run" data-model="${esc(r.model)}" data-effort="${esc(r.effort)}" data-run-conv="${esc(conv?.id || '')}" data-purpose="${esc(purpose)}" title="Model and effort">${runContent(r)}</button>`;
}
export function refreshRunButtons() {
  for (const btn of $$('[data-act="run"]')) {
    const conv = S.review?.convs?.[btn.dataset.runConv];
    const fallback = btn.dataset.purpose === 'brief' ? S.app.defaults.briefModel : S.app.defaults.model;
    const run = { model: availableModel(btn.dataset.model, conv, fallback), effort: btn.dataset.effort };
    btn.dataset.model = run.model;
    btn.innerHTML = runContent(run);
  }
}
export function pickRun(btn, choice) {
  const cur = choice ? { ...choice.run } : { model: btn.dataset.model, effort: btn.dataset.effort };
  const kind = convKind(S.review?.convs?.[btn.dataset.runConv]);
  const items = [{ header: 'MODEL' }, ...S.app.models.filter((m) => !kind || m.kind === kind).map((m) => ({ label: m.label, value: { model: m.id }, current: m.id === cur.model })),
    { sep: true }, { header: 'EFFORT' }, ...S.app.efforts.map((e) => ({ label: e, value: { effort: e }, current: e === cur.effort, sub: { low: 'fastest', max: 'slowest' }[e] || '' }))];
  menu(btn, items, (it) => {
    Object.assign(cur, it.value);
    if (!choice) {
      btn.dataset.model = cur.model; btn.dataset.effort = cur.effort;
      btn.innerHTML = runContent(cur);
    }
    const purpose = choice?.purpose || btn.dataset.purpose;
    if (purpose) { pref.set(`${purpose}Model`, cur.model); pref.set(`${purpose}Effort`, cur.effort); } else rememberRun(cur);
    btn.dispatchEvent(new CustomEvent('runpicked', { bubbles: true, detail: { ...cur } }));
    // the brief's pickers (in the Overview and on the map) are one choice: every one shows it
    if (purpose === 'brief') for (const b of document.querySelectorAll('[data-act="run"][data-purpose="brief"]')) { b.dataset.model = cur.model; b.dataset.effort = cur.effort; b.innerHTML = runContent(cur); }
  }, { align: 'right', width: 220 });
}
export const runOf = (root) => { const b = root?.querySelector('[data-act="run"]'); return b ? { model: b.dataset.model, effort: b.dataset.effort } : lastRun(); };

// ------------------------------------------------------------------ composer
export function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; }
document.addEventListener('input', (e) => { if (e.target.matches?.('.composer textarea, .mrow.draft textarea')) grow(e.target); });

// ------------------------------------------------------------------ messages
const toolsLine = (tools) => {
  const n = (k) => tools.filter((t) => t.name === k).length;
  const bits = [];
  if (n('Read')) bits.push(`read ${n('Read')} file${n('Read') === 1 ? '' : 's'}`);
  if (n('Grep') + n('Glob')) bits.push(`searched ${n('Grep') + n('Glob')}×`);
  if (n('git')) bits.push(`${n('git')} git command${n('git') === 1 ? '' : 's'}`);
  if (tools.some((t) => /thread/.test(t.name))) bits.push('looked at your other threads');
  const s = bits.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`;
};
// A repeating animation keeps its phase when its element is redrawn (answers redraw as they stream): the delay is
// taken from the clock, so a redraw lands mid-sweep instead of starting over.
export const shimmerSync = (ms = 1800) => `animation-delay:-${Date.now() % ms}ms`;
export function msgHTML(m) {
  const me = m.role === 'user';
  const codex = m.role === 'codex';
  const who = me ? 'You' : codex ? 'Codex' : 'Claude';
  const steps = !me && (m.tools?.length || m.notes?.length)
    ? `<details class="steps"><summary>${esc(toolsLine(m.tools || []))}</summary>${(m.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('')}<ul>${(m.tools || []).map((t) => `<li>${esc(t.name)} ${esc(t.input)}</li>`).join('')}</ul></details>` : '';
  const atts = me && m.attachments?.length ? `<div class="attach">${m.attachments.map((a) => `<button class="chip" data-act="goatt" data-p="${esc(a.path)}" data-l="${a.line || ''}" data-side="${a.side || 'new'}" title="${esc(a.path)}"><span>${esc(a.path.split('/').pop())} ${esc(a.label)}</span></button>`).join('')}</div>` : '';
  const working = m.pending && !m.text ? `<div class="working"><span class="shimmer" style="${shimmerSync()}">${m.queued ? 'Waiting for the answer before it' : m.tools?.length ? `Reading the code · ${esc(m.tools.at(-1).input || '').slice(0, 80)}` : 'Thinking'}</span></div>` : '';
  return `<div class="msg${me ? ' me' : ''}" data-m="${esc(m.id)}">` +
    `<div class="mmeta">${me || codex ? '' : spark(16, !m.pending, 'Claude')}<span class="who ${me ? 'me' : codex ? 'codex' : 'claude'}">${who}</span>${me ? '' : `<span class="model">${esc(modelName(m.model))}${m.effort ? ' · ' + esc(m.effort) : ''}</span>`}<span class="t">${ago(m.at)}</span>` +
    `${!me && m.pending && !m.queued && !m.live ? `<span class="sp"></span><button class="link" data-act="stop">Stop</button>` : ''}</div>` +
    atts + steps + (m.text ? `<div class="md">${md(m.text, { images: !codex })}</div>` : '') + working +
    (m.error ? `<div class="err">${esc(m.error)}</div>` : '') + (m.foot && !m.pending ? `<div class="mfoot">${esc(m.foot)}</div>` : '') + `</div>`;
}

document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-act="run"]'); if (b) { e.preventDefault(); e.stopPropagation(); pickRun(b); } }, true);
