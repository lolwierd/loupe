import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  let items;
  const markdownOptions = [];
  const code = vm.runInNewContext(picker + messages + '\n({ pickRun, runBtn, msgHTML })', {
    S, I: { spark: '<svg data-spark></svg>' }, esc: String, md: (text, options) => { markdownOptions.push(options); return text; }, ago: () => 'now',
    spark: () => '<canvas class="spark"></canvas>', modelName: (id) => models.find((m) => m.id === id)?.label,
    menu: (_button, options) => { items = options; },
  });
  const shown = (id, model) => {
    code.pickRun({ dataset: { runConv: id, model } });
    return Array.from(items, (item) => item.value?.model).filter(Boolean);
  };
  assert.deepEqual(shown('fresh', 'gpt-6.2-sol'), models.map((m) => m.id));
  assert.deepEqual(shown('codex', 'gpt-6.2-sol'), ['gpt-6.2-sol', 'gpt-6-astra']);
  for (const id of ['legacy', 'linked']) assert.deepEqual(shown(id, 'claude-opus-5-5'), ['claude-opus-5-5']);
  const run = { model: 'gpt-6.2-sol', effort: 'high' };
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
