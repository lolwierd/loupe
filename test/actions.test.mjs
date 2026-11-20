import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-actions-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.LOUPE_HOME = tmp;
process.env.LOUPE_GH = path.join(tmp, 'gh');
const log = path.join(tmp, 'argv');
fs.writeFileSync(process.env.LOUPE_GH, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const values = Object.fromEntries(process.argv.slice(2).filter(a => a.includes('=')).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const page = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: !!endCursor, endCursor } });
const c = (id) => ({ id, body: id, path: 'file', originalLine: 2, outdated: true });
let data;
if (values.query?.includes('reviews(first:')) {
  const reviews = values.after === 'reviews'
    ? page([{ id: 'mine', viewerDidAuthor: true, comments: page([c('first')], 'comments') }])
    : page([{ id: 'other', viewerDidAuthor: false }], 'reviews');
  data = { repository: { pullRequest: { id: 'PR', reviews } } };
} else if (values.query?.includes('node(id:')) {
  data = { node: { comments: page([c('last')]) } };
}
if (values.query?.includes('addPullRequestReviewThread(')) data = { addPullRequestReviewThread: { thread: { id: 'thread' } } };
console.log(JSON.stringify({ data }));
`, { mode: 0o755 });
const { ACTIONS } = await import('../src/actions.mjs');

function workspace() {
  return {
    rec: { kind: 'pr' }, meta: { headFull: 'head' },
    github: { owner: 'owner', repo: 'repo', number: 1, pr: { state: 'OPEN', headRefOid: 'head' }, prId: 'PR' },
    async fetchGithub() { return this.github; },
    async hunks() { return { hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 }] }; },
    emit() {},
  };
}
const approval = { event: 'APPROVE' };
const draft = { id: 'review', comments: [{ id: 1, nodeId: 'comment', body: 'draft', path: 'file', line: 1 }] };

test('submit refuses stale GitHub data, changes to the PR head, and a changed verdict', async () => {
  for (const change of ['stale', 'head', 'verdict']) {
    const ws = workspace();
    const { guard } = await ACTIONS.review.preview(ws, approval);
    if (change === 'stale') ws.fetchGithub = async () => { throw new Error('offline'); };
    if (change === 'head') ws.github.pr.headRefOid = 'new';
    const payload = change === 'verdict' ? { event: 'COMMENT' } : approval;
    await assert.rejects(ACTIONS.review.run(ws, payload, guard), { status: change === 'verdict' ? 400 : 409 });
  }
  assert.equal(fs.existsSync(log), false);
});

test('submit refuses added, removed and newly outdated pending comments', async () => {
  for (const change of ['add', 'remove', 'outdate']) {
    const ws = workspace();
    ws.github.pending = change === 'add' ? { ...draft, comments: [] } : structuredClone(draft);
    const { guard } = await ACTIONS.review.preview(ws, approval);
    ws.fetchGithub = async () => {
      ws.github.pending = structuredClone(draft);
      if (change === 'remove') ws.github.pending.comments = [];
      if (change === 'outdate') ws.github.pending.comments[0].outdated = true;
      return ws.github;
    };
    await assert.rejects(ACTIONS.review.run(ws, approval, guard), { status: 409 });
  }
});

test('comment placement rejects a stale PR workspace and a reversed range', async () => {
  const ws = workspace();
  const payload = { path: 'file', body: 'draft', line: 1, startLine: 2, side: 'new' };
  await assert.rejects(ACTIONS.reviewcomment.preview(ws, payload), { status: 409 });
  ws.meta.headFull = 'old';
  await assert.rejects(ACTIONS.reviewcomment.preview(ws, { ...payload, startLine: 1 }), { status: 409 });
});

test('overlapping writes each run exactly once, even after an earlier failure', async () => {
  const { Workspace } = await import('../src/workspaces.mjs');
  const ws = new Workspace({ id: 'writes', kind: 'local' });
  const called = [];
  const results = await Promise.allSettled([1, 2, 3].map((n) => ws.runAction(async () => {
    called.push(n);
    if (n === 1) throw new Error('failed');
    return n;
  })));
  assert.deepEqual(called, [1, 2, 3]);
  assert.deepEqual(results.map((r) => r.value), [undefined, 2, 3]);
});

test('pending review scans past other authors and reads every page of draft comments', async () => {
  const { pendingReview } = await import('../src/github.mjs');
  const result = await pendingReview('owner', 'repo', 1);
  assert.equal(result.prId, 'PR');
  assert.equal(result.review?.id, 'mine');
  assert.deepEqual(result.review.comments.map((c) => [c.nodeId, c.line, c.outdated]), [
    ['first', 2, true], ['last', 2, true],
  ]);
});

test('adding a comment refuses a response that never created the pending review', async () => {
  const ws = workspace();
  const payload = { path: 'file', line: 2, body: '123', side: 'new' };
  const { guard } = await ACTIONS.reviewcomment.preview(ws, payload);
  const before = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  await assert.rejects(ACTIONS.reviewcomment.run(ws, payload, guard), { status: 502 });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').slice(before).map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('pr=PR'));
});

test('review threads send integers as typed fields and preserve string bodies', async () => {
  const ws = workspace();
  ws.github.pending = draft;
  for (const startLine of [undefined, 1]) {
    const payload = { path: 'file', line: 2, startLine, body: '123', side: 'old' };
    const { guard } = await ACTIONS.reviewcomment.preview(ws, payload);
    await ACTIONS.reviewcomment.run(ws, payload, guard);
    const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
    assert.equal(call[call.indexOf('line=2') - 1], '-F');
    assert.equal(call[call.indexOf('body=123') - 1], '-f');
    assert.ok(call.includes('side=LEFT'));
    if (startLine) {
      assert.equal(call[call.indexOf('startLine=1') - 1], '-F');
      assert.ok(call.includes('startSide=LEFT'));
    } else assert.equal(call.some((a) => a.startsWith('startLine=') || a.startsWith('startSide=')), false);
  }
});

test('local inline previews refuse a dirty file and a checkout behind the PR', async () => {
  const ws = workspace();
  ws.rec.kind = 'local';
  ws.sync = async () => { ws.meta.wipPaths = ['file']; };
  const payload = { path: 'file', line: 1, body: 'draft', side: 'new' };
  await assert.rejects(ACTIONS.reviewcomment.preview(ws, payload), /uncommitted edits/);
  ws.sync = async () => { ws.meta = { headFull: 'old' }; };
  await assert.rejects(ACTIONS.reviewcomment.preview(ws, payload), /checkout is not at/);
});

test('submitting a pending review requires confirmation from GitHub', async () => {
  const ws = workspace();
  ws.github.pending = draft;
  const { guard } = await ACTIONS.review.preview(ws, approval);
  await assert.rejects(ACTIONS.review.run(ws, approval, guard), { status: 502 });
  const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.ok(call.includes('review=review'));
  assert.equal(call.some((a) => a.startsWith('body=')), false);
});
