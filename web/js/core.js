// Shared parts of the page: DOM helpers, the API, browser-side preferences, icons, the app's state object.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// a title that may hold `code`: escaped, with the code spans kept as code (guide titles come from the model)
export const tick = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export async function api(url, opts = {}) {
  const init = { ...opts, headers: { 'X-Loupe': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const r = await fetch(url, init);
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text }; }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// Preferences that belong to this browser: the model and effort you last picked, layout, theme, panel widths.
export const pref = {
  get(k, d) { try { const v = localStorage.getItem('loupe.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('loupe.' + k, JSON.stringify(v)); } catch { /* private window */ } },
};

// One state object for the open change; modules read and write it, then call the render functions they need.
export const S = {
  app: null,          // /api/state: models, efforts, defaults, user, display address
  ws: null,           // the change's meta
  id: null,           // the change's id
  scope: 'all', rangeKey: 'all', comparison: null,
  files: [], byPath: new Map(), left: null, totals: null,
  review: { viewed: {}, threads: [], convs: {}, chats: [], brief: null },
  github: { review: [], conversation: [] },
  rows: new Map(), items: new Map(), tok: new Map(), loaded: new Map(), shut: new Set(), dirShut: new Set(), newText: new Map(), diffs: new Map(), waves: new Map(), commitFiles: null,
  sel: null, dragging: false, draft: null, replyDrafts: {},
  layout: pref.get('layout', 'split') === 'unified' ? 'unified' : 'split', // split by default; unified in the View menu
  order: pref.get('order', 'tree'), // tree | guide
  tab: pref.get('tab', 'brief'),
  chat: null,         // the open chat's conversation id
  attach: [],         // line selections waiting in the chat composer
  filter: '',
  mode: pref.get('mode', 'panes') === 'guide' ? 'guide' : 'panes', // the layout: three panes, or the guide on the left
  marksHidden: pref.get('marksHidden', false), // marks drawn at their lines, or only their gutter ticks
  mark: null,         // the mark open in the inspector
  readFrac: new Map(), // how far down each file you have scrolled, 0..1 (the strip dithers by it)
  unreadAns: new Set(), // questions whose answer arrived and you have not opened yet
  view: null,
  opening: null,      // the record of a change that is not ready yet (a pull request's size while it is fetched)
};

export const fileOf = (p) => S.byPath.get(p);
export const convOf = (id) => S.review.convs[id];
// Marks drawn at their lines: your questions. (Notes were removed on 20 Nov 2026; any left on disk are not shown.)
export const threadsAt = (p) => S.review.threads.filter((t) => t.path === p && !t.posted && scopeFits(t));
// A thread left on one commit shows only while that commit is the scope; the others show in every whole-change scope.
export const scopeFits = (t) => (/^[0-9a-f]{40}$/.test(t.scope || '') ? t.scope === S.rangeKey : !/^[0-9a-f]{40}$/.test(S.rangeKey || ''));
export const wsApi = (sub, q = {}) => {
  const params = new URLSearchParams({ scope: S.scope, ...q });
  return `/api/w/${S.id}${sub}?${params}`;
};

// A listed model by its line (Opus, Sol); one the list has moved past, kept on an old answer, with its version
// (Sonnet 5.2, Terra 6.1), so the two read apart.
export const modelName = (id) => {
  const bare = String(id || '').replace(/\[.*\]$/, '');
  const m = S.app?.models.find((x) => x.id === bare);
  if (m) return m.label;
  const c = /^claude-([a-z]+)-([\d-]+)$/.exec(bare), g = /^gpt-([\d.]+)-([a-z]+)$/.exec(bare);
  const up = (s) => s[0].toUpperCase() + s.slice(1);
  return c ? `${up(c[1])} ${c[2].replace(/-/g, '.')}` : g ? `${up(g[2])} ${g[1]}` : bare || 'Claude';
};
// The model and effort a new question starts with: what you picked last, in this browser.
// a remembered model that the list has moved past becomes the newest of its line (opus, gpt:astra), else the default
const lineOf = (id = '') => { const c = /^claude-([a-z]+)-/.exec(id), g = /^gpt-[\d.]+-([a-z]+)$/.exec(id); return c ? c[1] : g ? 'gpt:' + g[1] : null; };
export const freshModel = (id, d) => {
  const ms = S.app?.models || [], line = lineOf(id);
  if (ms.some((m) => m.id === id)) return id;
  return (line && ms.find((m) => lineOf(m.id) === line)?.id) || (/^gpt-/.test(id || '') && ms.find((m) => m.kind === 'codex')?.id) || d;
};
export const lastRun = () => ({ model: freshModel(pref.get('model', S.app?.defaults.model), S.app?.defaults.model), effort: pref.get('effort', S.app?.defaults.effort) });
export const briefRun = () => ({ model: freshModel(pref.get('briefModel', S.app?.defaults.briefModel), S.app?.defaults.briefModel), effort: pref.get('briefEffort', S.app?.defaults.briefEffort) });
export const notesRun = () => ({ model: freshModel(pref.get('notesModel', S.app?.defaults.notesModel), S.app?.defaults.notesModel), effort: pref.get('notesEffort', S.app?.defaults.notesEffort) });
export const rememberRun = (r) => { if (r.model) pref.set('model', r.model); if (r.effort) pref.set('effort', r.effort); };

export const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
export const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

let toastT = null;
// A one-line notice at the bottom; with { action, run } it carries one button (Undo) for as long as it shows.
export function toast(msg, opt = {}) {
  let t = $('#toast');
  if (!t) { t = h('<div class="toast" id="toast" role="status"></div>'); document.body.append(t); }
  t.innerHTML = `<span>${esc(msg)}</span>${opt.action ? `<button class="tb">${esc(opt.action)}</button>` : ''}`;
  if (opt.action) t.querySelector('.tb').onclick = () => { t.hidden = true; opt.run(); };
  t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, opt.action ? 5000 : 3600);
}
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Octicon-weight glyphs, 16px grid, drawn as strokes so they share one line weight.
const P = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const I = {
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="13" cy="13" r="9" fill="none" stroke="currentColor" stroke-width="3"/><path d="M19.5 19.5 28 28" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/><path d="M9 11h8M9 15h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  chev: P('<path d="m4 6 4 4 4-4"/>', 'class="chev"'),
  chevR: P('<path d="m6 4 4 4-4 4"/>'),
  chevL: P('<path d="m10 4-4 4 4 4"/>'),
  up: P('<path d="m4 10 4-4 4 4"/>'),
  down: P('<path d="m4 6 4 4 4-4"/>'),
  updown: P('<path d="m5 6 3-3 3 3M5 10l3 3 3-3"/>'),
  check: P('<path d="m3.5 8.5 3 3 6-7"/>'),
  plus: P('<path d="M8 3v10M3 8h10"/>'),
  search: P('<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.5 3.5"/>'),
  x: P('<path d="m4 4 8 8M12 4l-8 8"/>'),
  dir: P('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
  file: P('<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/>'),
  cmt: P('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
  ask: P('<circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3"/><path d="M8 11.6h0" stroke-width="2"/>'),
  note: P('<path d="M3 13l1-3.5L10.5 3a1.4 1.4 0 0 1 2 2L6 11.5z"/><path d="M9.5 4l2 2"/>'),
  chat: P('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 6.5h5M5.5 8.5h3"/>'),
  // Codex's mark beside Claude's spark: a terminal's prompt, since Codex is the command-line agent
  codex: P('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M4.75 6.25 6.5 8l-1.75 1.75M8.25 10h3"/>'),
  link: P('<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>'),
  sidebarL: P('<rect class="pn" x="2" y="2.5" width="4" height="11" rx="1.5"/><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  sidebarB: P('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 9.5h12"/>'),
  sidebarR: P('<rect class="pn" x="10" y="2.5" width="4" height="11" rx="1.5"/><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>'),
  refresh: P('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v2.5h-2.5"/>'),
  more: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  pr: P('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5M8.8 3 7.3 4.5 8.8 6"/>'),
  branch: P('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5"/>'),
  sun: P('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>'),
  moon: P('<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>'),
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  send: P('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
  spark: P('<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4"/>'),
  ext: P('<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4"/>'),
  guide: P('<path d="M2.5 3.5h4l1.5 1 1.5-1h4v9h-4l-1.5 1-1.5-1h-4z"/><path d="M8 4.5v9"/>'),
  github: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
};
