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
    S, renderTabs() {}, pref: { get() {} }, wsApi: (p) => p,
    api: async () => { throw new Error('daemon unavailable'); },
  });
  assert.equal(S.review.brief.pending, false);
  assert.equal(S.review.brief.error, 'daemon unavailable');
});
