import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attemptFileNotes, eligibleForNotes, fileNoteKey, filesNeedingNotes, resetNotesAttempt, currentNotes } from '../web/js/file-notes.js';
import vm from 'node:vm';

test('a preview finishing after navigation never sends its write to the next workspace', async () => {
  const source = fs.readFileSync(new URL('../web/js/actions.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
  let resolvePreview;
  const requests = [];
  let id = 'old';
  const hooks = {};
  vm.runInNewContext(source, {
    hooks, S: { get id() { return id; } }, wsApi: (suffix) => '/api/w/' + id + suffix, toast() {},
    api(url) {
      requests.push(url);
      if (url.endsWith('/preview')) return new Promise((resolve) => { resolvePreview = resolve; });
      return Promise.resolve({ message: 'sent' });
    },
  });
  const act = hooks.act('comment', { body: 'review' });
  id = 'new';
  resolvePreview({ guard: {} });
  await act;
  assert.deepEqual(requests, ['/api/w/old/actions/comment/preview']);
});

test('a selection of deleted lines keeps both endpoints on the old side', () => {
  const source = fs.readFileSync(new URL('../web/js/cards.js', import.meta.url), 'utf8');
  const selection = source.slice(source.indexOf('export function selection()'), source.indexOf('export function openDraft(')).replace('export ', '');
  const rows = [{ t: '-', o: 4, s: 'first' }, { t: '-', o: 5, s: 'last' }];
  const result = vm.runInNewContext(selection + '\nselection()', {
    S: { sel: { path: 'file' }, rows: new Map([['file', rows]]) },
    selIdx: () => [0, 1], rangeLabel: () => '', selText: () => '',
  });
  assert.equal(result.side, 'old');
  assert.equal(result.startLine, 4);
  assert.equal(result.line, 5);
});

test('guide layout keeps its empty state while the brief is missing', () => {
  const source = fs.readFileSync(new URL('../web/js/tree.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('export function renderTree()'), source.indexOf('const collect =')).replace('export ', '');
  const list = {};
  vm.runInNewContext(render + '\nrenderTree()', {
    S: { mode: 'guide', filter: '', files: [], review: {} },
    $: (sel) => sel === '#tlist' ? list : null,
    markCurrent() {},
  });
  assert.match(list.innerHTML, /No guide yet/);
});

test('a failed automatic brief request clears the pending state and shows the error', async () => {
  const source = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const brief = source.slice(source.indexOf('function maybeAutoBrief()'), source.indexOf('// ------------------------------------------------------------------ the top bar'));
  const S = { id: 'pr', ws: { kind: 'pr' }, review: {}, files: [{}], app: { settings: { autoBrief: true }, defaults: {} } };
  await vm.runInNewContext(brief + '\nmaybeAutoBrief()', {
    S, renderTabs() {}, pref: { get() {} }, wsApi: (p) => p, briefRun: () => ({}),
    api: async () => { throw new Error('daemon unavailable'); },
  });
  assert.equal(S.review.brief.pending, false);
  assert.equal(S.review.brief.error, 'daemon unavailable');
});

test('the run picker offers all models for a new chat and only the matching kind for replies', () => {
  const source = fs.readFileSync(new URL('../web/js/ui.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const models = [
    { id: 'claude-opus-5-5', label: 'Opus', kind: 'claude' },
    { id: 'gpt-6.2-sol', label: 'Sol', kind: 'codex' },
    { id: 'gpt-6-astra', label: 'Astra', kind: 'codex' },
  ];
  // Use the real picker with a stub menu so the choices and rendered answer can be inspected independently of layout.
  const picker = source.slice(source.indexOf('const runLabel'), source.indexOf('const runOf'));
  const messages = source.slice(source.indexOf('const toolsLine'), source.lastIndexOf("document.addEventListener('click'"));
  const S = { app: { models, efforts: ['low', 'high'] }, review: { convs: {
    fresh: { messages: [] },
    codex: { modelKind: 'codex', messages: [] },
    legacy: { sessionId: 'claude-session', messages: [] },
    linked: { linked: {}, messages: [] },
  } } };
  let items, pick;
  const preferences = new Map();
  const markdownOptions = [];
  const code = vm.runInNewContext(picker + messages + '\n({ pickRun, runBtn, msgHTML })', {
    S, I: { spark: '<svg data-spark></svg>' }, esc: String, md: (text, options) => { markdownOptions.push(options); return text; }, ago: () => 'now',
    freshModel: (id) => models.some((m) => m.id === id) ? id : undefined,
    spark: () => '<canvas class="spark"></canvas>', modelName: (id) => models.find((m) => m.id === id)?.label,
    menu: (_button, options, onPick) => { items = options; pick = onPick; },
    pref: { set: (key, value) => preferences.set(key, value) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  const shown = (id, model) => {
    code.pickRun({ dataset: { runConv: id, model } });
    return Array.from(items, (item) => item.value?.model).filter(Boolean);
  };
  assert.deepEqual(shown('fresh', 'gpt-6.2-sol'), models.map((m) => m.id));
  assert.deepEqual(shown('codex', 'gpt-6.2-sol'), ['gpt-6.2-sol', 'gpt-6-astra']);
  for (const id of ['legacy', 'linked']) assert.deepEqual(shown(id, 'claude-opus-5-5'), ['claude-opus-5-5']);
  const run = { model: 'gpt-6.2-sol', effort: 'high' };
  const picked = [];
  const anchor = { dataset: {}, innerHTML: 'Change title', dispatchEvent: (e) => picked.push(e) };
  code.pickRun(anchor, { purpose: 'notes', run });
  assert.ok(items.find((item) => item.value?.model === run.model && item.current));
  pick(items.find((item) => item.value?.effort === 'low'));
  assert.deepEqual(Object.fromEntries(preferences), { notesModel: run.model, notesEffort: 'low' });
  // a pick says what was picked, so a draft at the lines can turn its mark to the new model
  assert.equal(picked[0]?.type, 'runpicked');
  assert.deepEqual({ ...picked[0].detail }, { model: run.model, effort: 'low' });
  assert.equal(anchor.innerHTML, 'Change title');
  assert.doesNotMatch(code.runBtn(run), /data-spark/);
  const msg = code.msgHTML({ ...run, role: 'codex', id: 'a', text: 'Answer' });
  assert.match(msg, /who codex">Codex/);
  assert.match(msg, /Sol · high/);
  assert.doesNotMatch(msg, /spark|claude/);
  assert.match(code.msgHTML({ ...run, model: 'claude-opus-5-5', role: 'claude', id: 'b', text: 'Answer' }), /canvas class="spark"/);
  assert.equal(markdownOptions[0]?.images, false);
  assert.notEqual(markdownOptions[1]?.images, false);
  const pending = { ...run, role: 'codex', id: 'pending', pending: true };
  assert.match(code.msgHTML(pending), /data-act="stop"/);
  assert.doesNotMatch(code.msgHTML({ ...pending, queued: true }), /data-act="stop"/);
  assert.doesNotMatch(code.msgHTML({ ...pending, role: 'claude', live: true }), /data-act="stop"/);
});

test('Codex Markdown removes image sources and keeps image alt text', () => {
  const source = fs.readFileSync(new URL('../web/js/md.js', import.meta.url), 'utf8');
  const sanitizer = source.slice(source.indexOf('const KEEP'), source.indexOf('// ------------------------------------------------------------------ :emoji:'));
  let sourceRemoved = false;
  let alt;
  const img = { tagName: 'IMG', getAttribute: (name) => name === 'alt' ? 'diagram' : null, replaceWith: (text) => { alt = text; } };
  const picture = { tagName: 'PICTURE', attributes: [], children: [img, { tagName: 'SOURCE', remove: () => { sourceRemoved = true; } }] };
  vm.runInNewContext(sanitizer + '\nclean(input, false)', {
    input: '<picture><img alt="diagram"><source srcset="https://github.com/image"></picture>',
    document: { createElement: () => ({ content: { children: [picture], querySelectorAll: () => [] } }), createTextNode: (text) => text },
  });
  assert.equal(alt, 'diagram');
  assert.equal(sourceRemoved, true);
});

test('the Stop button sends a stop request for its containing conversation', async () => {
  const source = fs.readFileSync(new URL('../web/js/panel.js', import.meta.url), 'utf8');
  const listener = source.slice(source.indexOf("$('#root').addEventListener('click'"), source.indexOf("  if (act === 'brief')"));
  let click;
  const calls = [];
  vm.runInNewContext(listener + '\n});', {
    $: () => ({ addEventListener: (_event, fn) => { click = fn; } }),
    api: (...args) => { calls.push(args); return Promise.resolve(); }, wsApi: (route) => '/api/w/workspace' + route,
  });
  const button = { dataset: { act: 'stop' }, closest: (selector) => selector === '#panel' ? {} : { dataset: { conv: 'chat-id' } } };
  await click({ target: { closest: () => button } });
  assert.equal(calls[0]?.[0], '/api/w/workspace/convs/chat-id/stop');
  assert.equal(calls[0]?.[1].method, 'POST');
});

test('a rejected manual brief can be retried without reloading', async () => {
  const source = fs.readFileSync(new URL('../web/js/panel.js', import.meta.url), 'utf8');
  const brief = source.slice(source.indexOf('export function rebrief()'), source.indexOf('hooks.rebrief =')).replace('export ', '');
  const S = { id: 'pr', tab: 'chat', review: { brief: { tldr: 'Old brief' } } };
  let refreshed = 0;
  await vm.runInNewContext(brief + '\nrebrief()', {
    S, hooks: {}, renderTabs() { refreshed++; }, toast() {}, wsApi: (p) => p, briefRun: () => ({}),
    api: async () => { throw new Error('daemon unavailable'); },
  });
  assert.equal(S.review.brief.pending, false);
  assert.equal(S.review.brief.error, 'daemon unavailable');
  assert.equal(S.review.brief.tldr, 'Old brief');
  assert.equal(refreshed, 2);
});

test('a saved Codex brief keeps images disabled after its model leaves the picker', () => {
  const ui = fs.readFileSync(new URL('../web/js/ui.js', import.meta.url), 'utf8').match(/^export const modelKind = .*$/m)[0].replace('export ', '');
  const panel = fs.readFileSync(new URL('../web/js/panel.js', import.meta.url), 'utf8');
  const brief = panel.slice(panel.indexOf('const tldrText'), panel.indexOf('function descHTML'));
  const calls = [];
  vm.runInNewContext(ui + '\n' + brief + '\ntldrHTML()', {
    S: { app: { models: [] }, review: { brief: { model: 'gpt-6-sol', tldr: 'Summary', riskWhy: 'Reason' } } },
    esc: String, modelName: String, ago: () => '', briefRunBtn: () => '',
    md(text, options) { calls.push([text, options?.images]); return text; },
  });
  assert.deepEqual(calls, [['Summary', false], ['Reason', false]]);
});

test('Mote cancels detached and hidden animation timers', () => {
  const source = fs.readFileSync(new URL('../web/js/mote.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const timers = new Map(), listeners = {};
  let next = 0;
  const hooks = {}, document = { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const classList = { add() {}, remove() {}, toggle() {} };
  const dock = { style: {}, classList, querySelector: () => ({ style: {} }), getBoundingClientRect: () => ({ left: 970, right: 1018 }) }; // the floating dock: placed, then filled
  vm.runInNewContext(source, {
    hooks, document, S: { review: { brief: { pending: true } } }, $: () => dock, reducedMotion: () => false,
    watch: () => () => {}, // the lens's light is drawn on theme and size changes; nothing to draw here
    ResizeObserver: class { observe() {} disconnect() {} }, // the inspector's width aims its bubble
    pref: { get: () => null, set() {} }, addEventListener() {}, innerWidth: 1440, innerHeight: 900,
    setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout: (id) => timers.delete(id),
  });
  hooks.moteMount(false);
  assert.equal(timers.size, 2);
  hooks.moteMount(false);
  assert.equal(timers.size, 2);
  document.hidden = true;
  listeners.visibilitychange();
  assert.equal(timers.size, 0);
  document.hidden = false;
  listeners.visibilitychange();
  assert.equal(timers.size, 1);
});

test('a removed Codex model line falls back to another Codex model', () => {
  const source = fs.readFileSync(new URL('../web/js/core.js', import.meta.url), 'utf8');
  const model = source.slice(source.indexOf('const lineOf'), source.indexOf('export const lastRun')).replace('export ', '');
  const S = { app: { models: [{ id: 'claude-sonnet-5-5', kind: 'claude' }, { id: 'gpt-7-sol', kind: 'codex' }] } };
  const fresh = vm.runInNewContext(model + '\nfreshModel', { S });
  assert.equal(fresh('gpt-6-sol', 'claude-sonnet-5-5'), 'gpt-7-sol');
  assert.equal(fresh('gpt-6-astra', 'claude-sonnet-5-5'), 'gpt-7-sol');
});

test('the map routes a full grid with 24 edges and reuses a drawing at the same width', () => {
  const source = fs.readFileSync(new URL('../web/js/map.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const cards = { clientWidth: 390 };
  const d = {
    kind: 'map', title: 'Dense', groups: [],
    nodes: Array.from({ length: 16 }, (_, i) => ({ id: String(i), label: 'Service ' + i + ' routes requests', ref: 'longSourceFilename' + i + '.mjs', col: i % 4, row: i >> 2, change: 'changed' })),
    edges: Array.from({ length: 24 }, (_, i) => ({ from: String(i % 16), to: String((i * 3 + 5) % 16), label: 'read the shared request', change: 'none' })),
  };
  let measured = 0;
  const context = vm.createContext({
    d, $: () => cards, hooks: {}, esc: String,
    document: { addEventListener() {}, createElement: () => ({ getContext: () => ({ measureText: (t) => { measured++; return { width: t.length * 7 }; } }) }) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  vm.runInContext(source, context);
  const svg = vm.runInContext('diagramSVG(d, "tb")', context);
  const first = measured;
  assert.equal((svg.match(/class="ed /g) || []).length, 24);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.equal(vm.runInContext('diagramSVG(d, "tb")', context), svg);
  assert.equal(measured, first);
});

test('a file refresh keeps a brief event newer than its review snapshot', async () => {
  const source = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const load = source.slice(source.indexOf('let fileRequest'), source.indexOf('  S.github ||='));
  const S = { id: 'pr', review: { brief: { pending: true } } };
  const result = { pending: false, tldr: 'New guide' };
  let finishFiles;
  const pending = vm.runInNewContext(load + '\n}\nloadFiles()', {
    S, wsApi: (p) => p,
    api(url) {
      if (url === '/files') return new Promise((resolve) => { finishFiles = resolve; });
      return Promise.resolve({ brief: { pending: true } });
    },
  });
  S.review.brief = result;
  finishFiles({ files: [] });
  await pending;
  assert.equal(S.review.brief, result);
});

test('inline edits preserve the common middle and cross syntax token boundaries', async () => {
  const source = fs.readFileSync(new URL('../web/js/diff.js', import.meta.url), 'utf8');
  const { wordRanges, tokHTML } = vm.runInNewContext(
    source.replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\n({ wordRanges, tokHTML })',
    { S: { tok: new Map([['file', [[['foo(a', 'code'], [', stable, b)', 'punct']]]]]) }, esc: (s) => s },
  );
  const ranges = wordRanges([{ t: '-', s: 'foo(a, stable, b)' }, { t: '+', s: 'foo(x, stable, y)' }]);
  assert.equal(JSON.stringify(ranges.get(0)), '[[4,5],[15,16]]');
  assert.equal(JSON.stringify(ranges.get(1)), '[[4,5],[15,16]]');
  assert.match(tokHTML('file', 1, 'foo(a, stable, b)', ranges.get(0)), /class="code wd" data-c="4">a<.*class="punct" data-c="5">, stable, <.*class="punct wd" data-c="15">b</);
  assert.equal(wordRanges([{ t: '-', s: 'a'.repeat(3000) }, { t: '+', s: 'b'.repeat(3000) }]).size, 0);
  assert.equal(wordRanges([{ t: '-', s: 'unrelated' }, { t: '+', s: 'different' }]).size, 0);
});

test('jump history restores two origins and is cleared with the comparison', async () => {
  const source = fs.readFileSync(new URL('../web/js/nav.js', import.meta.url), 'utf8');
  const center = { scrollTop: 90, scrollLeft: 0 };
  const back = {};
  const S = { id: 'one', scope: 'all', view: null };
  const nav = vm.runInNewContext(source.slice(source.indexOf('const returns'), source.indexOf('export async function goThread')).replace(/^export /gm, '') + '\n({ goLoc, goBack, clearReturns })', {
    S, $: (id) => ({ '#center': center, '#review-back': back })[id],
    hideTip() {}, closeViewer() { S.view = null; },
    openViewer(v) { S.view = v; center.scrollTop = 0; },
    resolvePath: (p) => p, fileOf: () => null,
  });
  const focus = [];
  const origin = (n) => ({ isConnected: true, focus: () => focus.push(n) });
  await nav.goLoc({ path: 'one' }, origin(1));
  center.scrollTop = 25;
  await nav.goLoc({ path: 'two' }, origin(2));
  await nav.goBack();
  assert.equal(S.view.path, 'one');
  assert.equal(center.scrollTop, 25);
  await nav.goBack();
  assert.equal(S.view, null);
  assert.equal(center.scrollTop, 90);
  assert.deepEqual(focus, [2, 1]);
  await nav.goLoc({ path: 'one' }, origin(1));
  nav.clearReturns();
  assert.equal(back.hidden, true);
  await nav.goBack();
  assert.equal(S.view, null);
});

test('two readers share an in-flight diff and a stale response cannot paint a new scope', async () => {
  const source = fs.readFileSync(new URL('../web/js/cards.js', import.meta.url), 'utf8');
  const S = { loaded: new Map(), rows: new Map() };
  let file = { status: 'D' }, requests = 0, draws = 0, resolve;
  const loadFile = vm.runInNewContext(source.slice(source.indexOf('export async function loadFile'), source.indexOf('// One fetch per file')).replace('export ', '') + '\nloadFile', {
    S, fileOf: () => file, cardEl: () => null, buildRows: (diff) => diff.hunks,
    diffOf() { requests++; return new Promise((r) => { resolve = r; }); },
    threadsAt: () => [], githubAt: () => [], renderBody() { draws++; },
  });
  const first = loadFile('a');
  let secondDone = false;
  const second = loadFile('a').then(() => { secondDone = true; });
  await Promise.resolve();
  assert.equal(secondDone, false);
  assert.equal(requests, 1);
  file = { status: 'D' };
  S.loaded.clear();
  resolve({ hunks: [] });
  await Promise.all([first, second]);
  assert.equal(draws, 0);
  const current = loadFile('a');
  resolve({ hunks: [] });
  await current;
  assert.equal(draws, 1);
});

test('file notes wait for a local change to settle and respect the automatic setting', async () => {
  const source = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const auto = source.slice(source.indexOf('let notesChange, notesTimer'), source.indexOf('// ------------------------------------------------------------------ the top bar'));
  const S = { id: 'test', app: { settings: { autoNotes: false } }, review: {} };
  const requests = [];
  let scheduled;
  const check = vm.runInNewContext(auto + '\n(change) => { notesChange = change; maybeAutoNotes(); }', {
    S, attemptFileNotes, filesNeedingNotes, currentNotes, changedT: null, Date: { now: () => 1000 },
    setTimeout(fn, ms) { scheduled = { fn, ms }; }, clearTimeout() { scheduled = null; },
    notesRun: () => ({ model: 'claude-haiku-5-5', effort: 'low' }),
    api: async (path, request) => { requests.push({ path, ...request }); return { started: true }; },
  });
  const change = { id: 'test', key: 'current', quietAt: 21000, files: [{ path: 'client.js', added: 1 }] };
  check(change);
  assert.equal(scheduled, null);
  S.app.settings.autoNotes = true;
  check(change);
  assert.equal(scheduled.ms, 20000);
  S.app.settings.autoNotes = false;
  scheduled.fn();
  assert.equal(requests.length, 0);
  S.app.settings.autoNotes = true;
  check(change);
  await scheduled.fn();
  assert.equal(requests[0].path, '/api/w/test/notes');
  assert.equal(requests[0].body.model, 'claude-haiku-5-5');
  assert.equal(requests[0].body.effort, 'low');
  assert.equal(requests[0].body.key, 'current');
  check(change);
  assert.equal(scheduled, null);
});

test('a failed notes event and a daemon restart rearm automatic notes on the current change', () => {
  const source = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const live = source.slice(source.indexOf('let wsEs = null;'), source.indexOf('let changedT = null;'));
  const S = { id: 'test', boot: 'before', review: {} };
  const events = new Map();
  let reloads = 0, scheduled = 0;
  const page = vm.runInNewContext(`let notesChange;\n${live}
    listenWs();
    ({ set: (change) => { notesChange = change; }, get: () => notesChange })
  `, {
    S, resetNotesAttempt, console,
    EventSource: class { addEventListener(name, fn) { events.set(name, fn); } },
    loadWorkspace: () => reloads++, updateFileNotes() {}, maybeAutoNotes: () => scheduled++,
  });
  const emit = (name, data) => events.get(name)({ data: JSON.stringify(data) });
  const change = { key: 'current', attempted: true };
  page.set(change);
  emit('notes', { pending: false, error: 'Transient failure', files: {} });
  assert.equal(change.attempted, false);
  assert.equal(scheduled, 1);
  change.attempted = true;
  emit('hello', { boot: 'after' });
  assert.equal(page.get(), undefined);
  assert.equal(reloads, 1);
});

test('file cards draw current notes above the diff and mark older notes when idle or failed', () => {
  const source = fs.readFileSync(new URL('../web/js/cards.js', import.meta.url), 'utf8');
  const cards = source.slice(source.indexOf('const STATUS'), source.indexOf('// A chapter head'))
    .replace(/^export /gm, '');
  const core = fs.readFileSync(new URL('../web/js/core.js', import.meta.url), 'utf8')
    .split('\n').filter((line) => /^export const (esc|tick) =/.test(line)).join('\n')
    .replace(/^export /gm, '');
  const S = { app: { settings: { autoNotes: false } }, review: {}, shut: new Set() };
  const draw = vm.runInNewContext(core + cards + '\ncardHTML', {
    S, I: {}, threadsAt: () => [], isViewed: () => false, isStale: () => false,
    isGo: () => false, countedOnly: () => false, icon: () => '', eligibleForNotes, fileNoteKey,
  });
  const file = { path: 'src/client.js', status: 'M', added: 2, deleted: 1, blob: 'new', oldBlob: 'old' };
  S.review.notes = { pending: true, files: {} };
  assert.match(draw(file), /<p class="file-note"><\/p>/);
  S.review.notes.files[file.path] = { key: fileNoteKey(file), note: 'Routes `retry()` through the client. Accepts <429>.' };
  assert.match(draw(file), /<\/button><\/div><p class="file-note">Routes <code>retry\(\)<\/code> through the client\. Accepts &lt;429&gt;\.<\/p>.*class="fb"/);
  const moved = { ...file, blob: 'newer' };
  assert.match(draw(moved), /<p class="file-note"><\/p>/);
  S.review.notes.pending = false;
  assert.match(draw(moved), /Written for an earlier version\./);
  S.app.settings.autoNotes = true;
  S.review.notes.error = 'model failed';
  assert.match(draw(moved), /Written for an earlier version\./);
  assert.doesNotMatch(draw(file), /Written for an earlier version\./);
});

test('GitHub emoji shortcodes become emoji, beside links and from the full list', async () => {
  const source = fs.readFileSync(new URL('../web/js/md.js', import.meta.url), 'utf8');
  const part = source.slice(source.indexOf('// GitHub\'s full list'), source.indexOf('export function md('));
  const { EMOJI } = await import('../web/js/emoji.js');
  const github = vm.runInNewContext(part + '\ngithub', { GITHUB_EMOJI: EMOJI, S: { github: null, ws: null } });
  // a shortcode right before a link (the text run ends where the link starts) and one GitHub lists but loupe used not to
  const out = github('<p>:umbrella: <a href="https://x">View report</a>.</p><p>:loudspeaker: Feedback? <a href="https://y">Share</a>.</p>');
  assert.match(out, /☔/);
  assert.match(out, /📢/);
  assert.match(out, /<a href="https:\/\/x">View report<\/a>/);
  // inside code it stays as typed; an unknown name stays as typed
  assert.match(github('<p><code>:rocket:</code> :not_an_emoji:</p>'), /<code>:rocket:<\/code> :not_an_emoji:/);
  assert.equal(EMOJI.hash, '#\ufe0f\u20e3');
  // a > inside a quoted attribute is not the end of the tag: the alt keeps its text
  assert.match(github('<p><img alt="before > :umbrella:"></p><pre><code>x</code></pre>'), /alt="before > :umbrella:"/);
  // joined emoji keep their joiners
  assert.equal(EMOJI.technologist, '\u{1f9d1}\u200d\u{1f4bb}');
  assert.equal(EMOJI.rainbow_flag, '\u{1f3f3}\ufe0f\u200d\u{1f308}');
});
