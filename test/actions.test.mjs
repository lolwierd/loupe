import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-actions-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.LOUPE_HOME = tmp;
process.env.LOUPE_GH = path.join(tmp, 'gh');
const log = path.join(tmp, 'argv');
// What GitHub holds now, for the one read a write makes first (actions.mjs freshReviewTarget): the PR's head and state
// and your pending review. Without it, the read is answered as GitHub pages reviews (the scan test below).
const holds = path.join(tmp, 'gh-pr.json'), offline = path.join(tmp, 'gh-offline');
const ghHolds = ({ head = 'head', state = 'OPEN', review = null, base = null, verdict = null } = {}) => fs.writeFileSync(holds, JSON.stringify({ head, state, review, base, verdict }));
const unconfirmed = path.join(tmp, 'gh-unconfirmed'); // a resolve GitHub answers without saying where the thread stands
afterEach(() => { for (const f of [holds, offline, unconfirmed]) fs.rmSync(f, { force: true }); });
fs.writeFileSync(process.env.LOUPE_GH, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (fs.existsSync(${JSON.stringify(offline)})) { console.error('offline'); process.exit(1); }
if (process.argv.slice(2).some((a) => a.startsWith('repos/') && a.endsWith('/reviews'))) { console.log(JSON.stringify({ id: 9, commit_id: 'returned', html_url: 'https://example.test/r' })); process.exit(0); }
const values = Object.fromEntries(process.argv.slice(2).filter(a => a.includes('=')).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const page = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: !!endCursor, endCursor } });
const c = (id) => ({ id, body: id, path: 'file', originalLine: 2, outdated: true });
let data;
if (values.query?.includes('reviews(first:') && fs.existsSync(${JSON.stringify(holds)})) {
  const h = JSON.parse(fs.readFileSync(${JSON.stringify(holds)}, 'utf8'));
  const mine = h.review && { id: h.review.id, viewerDidAuthor: true, body: '', comments: page((h.review.comments || []).map((x) => ({ id: x.nodeId, databaseId: x.id, body: x.body, path: x.path, line: x.line, outdated: !!x.outdated }))) };
  // your latest approval, then (newer) a comment-only review: the approval is still the verdict
  const opinions = h.verdict ? [{ author: { login: 'me' }, state: 'APPROVED', submittedAt: '2026-11-27T00:00:00Z', commit: { oid: h.verdict } }, { author: { login: 'someone' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-27T01:00:00Z', commit: { oid: h.verdict } }] : [];
  data = { viewer: { login: 'me' }, repository: { pullRequest: { id: 'PR', headRefOid: h.head, baseRefName: h.base, state: h.state, latestOpinionatedReviews: { nodes: opinions }, reviews: page(mine ? [mine] : []) } } };
} else if (values.query?.includes('reviews(first:')) {
  const reviews = values.after === 'reviews'
    ? page([{ id: 'mine', viewerDidAuthor: true, comments: page([c('first')], 'comments') }])
    : page([{ id: 'other', viewerDidAuthor: false }], 'reviews');
  data = { repository: { pullRequest: { id: 'PR', reviews } } };
} else if (values.query?.includes('node(id:')) {
  data = { node: { comments: page([c('last')]) } };
}
if (values.query?.includes('addPullRequestReviewThread(')) data = { addPullRequestReviewThread: { thread: { id: 'thread' } } };
if (!fs.existsSync(${JSON.stringify(unconfirmed)})) {
  if (values.query?.includes('unresolveReviewThread(')) data = { unresolveReviewThread: { thread: { isResolved: false } } };
  else if (values.query?.includes('resolveReviewThread(')) data = { resolveReviewThread: { thread: { isResolved: true } } };
}
if (values.query?.includes('submitPullRequestReview(') && values.review === 'unsaid') data = { submitPullRequestReview: { pullRequestReview: { id: 'sent', url: 'https://example.test/review', commit: null } } };
if (values.query?.includes('submitPullRequestReview(') && values.review === 'begun-earlier') data = { submitPullRequestReview: { pullRequestReview: { id: 'sent', url: 'https://example.test/review', commit: { oid: 'older' } } } };
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

test('a fresh read prevents resubmitting either verdict on the same head', async () => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const ws = workspace();
    const payload = { event, body: 'review summary' };
    const { guard } = await ACTIONS.review.preview(ws, payload);
    ws.github.pr.viewerReview = { event, head: 'head' };
    ghHolds();
    await assert.rejects(ACTIONS.review.run(ws, payload, guard), /already/);
    await ACTIONS.review.preview(ws, { ...payload, event: 'COMMENT' });
    await ACTIONS.review.preview(ws, { ...payload, event: event === 'APPROVE' ? 'REQUEST_CHANGES' : 'APPROVE' });
    ws.github.pr.headRefOid = ws.meta.headFull = 'new head'; // the PR moved on, and its diff with it
    await ACTIONS.review.preview(ws, payload);
  }
});

test('the viewer verdict follows GitHub reviews across comments, dismissal and a new verdict', async () => {
  const { viewerReview } = await import('../src/github.mjs');
  const row = (state, day, login = 'me') => ({ state, author: { login }, submittedAt: `2026-11-0${day}T00:00:00Z`, commit: { oid: `head-${day}` } });
  const approved = row('APPROVED', 1);
  const commented = row('COMMENTED', 2);
  const unrelated = row('CHANGES_REQUESTED', 3, 'other');
  assert.equal(viewerReview([unrelated, commented, approved], 'Me').head, 'head-1');
  assert.equal(viewerReview([approved, commented, row('DISMISSED', 4)], 'me'), null);
  assert.equal(viewerReview([approved, row('CHANGES_REQUESTED', 5)], 'me').event, 'REQUEST_CHANGES');
});

test('resolve and reopen refuse a thread already there, and otherwise send one write and show it at once', async () => {
  for (const resolved of [true, false]) {
    const ws = workspace();
    const thread = { id: 'thread', path: 'file', resolved, canResolve: true, canUnresolve: true };
    ws.github.threads = [thread];
    await assert.rejects(ACTIONS.resolve.preview(ws, { threadId: thread.id, resolved }), /already/);
    thread.resolved = !resolved;
    const payload = { threadId: thread.id, resolved };
    const { guard } = await ACTIONS.resolve.preview(ws, payload);
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
    let read = 0;
    ws.fetchGithub = () => { read++; return new Promise(() => {}); }; // the full read never lands: the answer must not wait for it
    await ACTIONS.resolve.run(ws, payload, guard);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').slice(before).map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].some((a) => a.includes(resolved ? 'resolveReviewThread' : 'unresolveReviewThread')));
    assert.equal(ws.github.threads[0].resolved, resolved);
    assert.equal(read, 1); // asked for, behind the answer
  }
});

test('submit refuses GitHub out of reach, changes to the PR head, and a changed verdict, sending nothing', async () => {
  for (const change of ['offline', 'head', 'verdict']) {
    const ws = workspace();
    const { guard } = await ACTIONS.review.preview(ws, approval);
    ghHolds({ head: change === 'head' ? 'new' : 'head' });
    if (change === 'offline') fs.writeFileSync(offline, ''); else fs.rmSync(offline, { force: true });
    const payload = change === 'verdict' ? { event: 'COMMENT' } : approval;
    await assert.rejects(ACTIONS.review.run(ws, payload, guard), { status: change === 'verdict' ? 400 : 409 });
  }
  const sent = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
    .filter((a) => a.includes('POST') || a.some((x) => x.includes('submitPullRequestReview')));
  assert.deepEqual(sent, []);
});

test('submit refuses added, removed and newly outdated pending comments', async () => {
  for (const change of ['add', 'remove', 'outdate']) {
    const ws = workspace();
    ws.github.pending = change === 'add' ? { ...draft, comments: [] } : structuredClone(draft);
    const { guard } = await ACTIONS.review.preview(ws, approval);
    const now = structuredClone(draft); // what GitHub holds when the write reads it
    if (change === 'remove') now.comments = [];
    if (change === 'outdate') now.comments[0].outdated = true;
    ghHolds({ review: now });
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
  ghHolds(); // no pending review on GitHub yet: the write starts one
  const before = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  await assert.rejects(ACTIONS.reviewcomment.run(ws, payload, guard), { status: 502 });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').slice(before).map(JSON.parse);
  assert.equal(calls.length, 2); // the one read of the pending review and the head, then the write that failed
  assert.ok(calls[1].includes('pr=PR'));
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
  ghHolds({ review: draft });
  const { guard } = await ACTIONS.review.preview(ws, approval);
  await assert.rejects(ACTIONS.review.run(ws, approval, guard), { status: 502 });
  const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.ok(call.includes('review=review'));
  assert.equal(call.some((a) => a.startsWith('body=')), false);
});

test('an approval keeps its verdict with the head it was given on, and a comment keeps none', async () => {
  const ws = workspace();
  let saved = 0;
  ws.review = { data: {}, save() { saved++; } };
  ghHolds();
  const { guard } = await ACTIONS.review.preview(ws, approval);
  const r = await ACTIONS.review.run(ws, approval, guard);
  assert.equal(r.head, 'returned'); // the commit GitHub's answer names
  assert.deepEqual({ ...ws.review.data.verdict, at: 0 }, { event: 'APPROVE', head: 'returned', repo: 'owner/repo', number: 1, at: 0 });
  assert.equal(saved, 1);
  const c = workspace();
  c.review = { data: {}, save() { saved++; } };
  const comment = { event: 'COMMENT', body: 'looks fine' };
  const pv = await ACTIONS.review.preview(c, comment);
  await ACTIONS.review.run(c, comment, pv.guard);
  assert.equal(c.review.data.verdict, undefined);
  assert.equal(saved, 1);
});

test('a pending review submitted as an approval keeps the commit GitHub gave it, not the head at the time', async () => {
  const ws = workspace();
  ws.github.pending = { id: 'begun-earlier', comments: [] }; // begun on an older commit
  ghHolds({ review: ws.github.pending });
  ws.review = { data: {}, save() {} };
  const { guard } = await ACTIONS.review.preview(ws, approval);
  const r = await ACTIONS.review.run(ws, approval, guard);
  assert.equal(r.head, 'older');
  assert.equal(ws.review.data.verdict.head, 'older');
});

test('a pending review whose commit GitHub does not name is sent, and clears the verdict it replaces', async () => {
  const ws = workspace();
  ws.github.pending = { id: 'unsaid', comments: [] };
  ghHolds({ review: ws.github.pending });
  ws.review = { data: { verdict: { event: 'APPROVE', head: 'before', number: 1, at: 1 } }, save() {} }; // an earlier approval
  const { guard } = await ACTIONS.review.preview(ws, approval);
  const r = await ACTIONS.review.run(ws, approval, guard);
  assert.equal(r.head, null);
  assert.equal(ws.review.data.verdict, undefined);
});

test('an approval answers without waiting for GitHub to be read again, and shows at once', async () => {
  const ws = workspace();
  ws.github.pending = { id: 'begun-earlier', comments: [] };
  ws.github.threads = [{ id: 't', pending: true, comments: [{ id: 1, pending: true }] }];
  ghHolds({ review: ws.github.pending });
  ws.review = { data: {}, save() {} };
  const events = [];
  ws.emit = (e) => events.push(e);
  const { guard } = await ACTIONS.review.preview(ws, approval);
  let read = 0;
  ws.fetchGithub = () => { read++; return new Promise(() => {}); }; // a full read that never lands
  const r = await ACTIONS.review.run(ws, approval, guard);
  assert.equal(r.head, 'older');
  assert.equal(read, 1); // asked for, behind the answer
  assert.equal(ws.github.pending, null);
  assert.equal(ws.github.threads[0].pending, false);
  assert.deepEqual({ ...ws.github.pr.viewerReview, at: 0 }, { event: 'APPROVE', head: 'older', at: 0 });
  assert.ok(events.includes('github'));
});

test('a resolve GitHub does not confirm is not shown as done', async () => {
  const ws = workspace();
  ws.github.threads = [{ id: 'thread', path: 'file', resolved: false, canResolve: true, canUnresolve: true }];
  const { guard } = await ACTIONS.resolve.preview(ws, { threadId: 'thread', resolved: true });
  fs.writeFileSync(unconfirmed, '');
  await assert.rejects(ACTIONS.resolve.run(ws, { threadId: 'thread', resolved: true }, guard), { status: 502 });
  assert.equal(ws.github.threads[0].resolved, false);
});

test('a review write refuses, and copies nothing, when GitHub holds something the dialog did not show', async () => {
  const cases = {
    head: () => ghHolds({ head: 'new' }),
    pending: () => ghHolds({ review: draft }), // a comment added on GitHub since the preview
    base: () => ghHolds({ base: 'release' }),
    verdict: () => ghHolds({ verdict: 'head' }), // approved on GitHub, on this head, since the preview
  };
  for (const [name, holdsNow] of Object.entries(cases)) {
    const ws = workspace();
    ws.github.pr.baseRefName = 'main';
    const { guard } = await ACTIONS.review.preview(ws, approval);
    holdsNow();
    const before = structuredClone(ws.github);
    let read = 0;
    ws.fetchGithub = () => { read++; return Promise.resolve(ws.github); };
    await assert.rejects(ACTIONS.review.run(ws, approval, guard), { status: 409 }, name);
    assert.deepEqual(ws.github, before, `${name}: GitHub's answer was copied into loupe's copy`);
    assert.equal(read, 1, `${name}: the full read that brings the page what changed`);
  }
});

test('a review write refuses when the page moved to another PR while GitHub was read', async () => {
  const ws = workspace();
  ghHolds();
  const { guard } = await ACTIONS.review.preview(ws, approval);
  const sending = ACTIONS.review.run(ws, approval, guard);
  ws.github = { ...ws.github, number: 2, pr: { ...ws.github.pr } }; // a branch switch landed meanwhile
  await assert.rejects(sending, /now go to|another PR/);
});

test('a PR page does not approve a head its diff has not reached', async () => {
  const ws = workspace();
  ws.meta.headFull = 'older';
  await assert.rejects(ACTIONS.review.preview(ws, approval), /wait for its diff/);
});

test('a checkout that moved to another branch does not send to the PR loupe still has', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(tmp, 'checkout-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'topic'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
  const ws = workspace();
  Object.assign(ws.rec, { kind: 'local', root });
  ws.github.pr.headRefName = 'topic';
  ghHolds();
  const { guard } = await ACTIONS.review.preview(ws, approval);
  git('checkout', '-q', '-b', 'elsewhere');
  await assert.rejects(ACTIONS.review.run(ws, approval, guard), /another branch/);
});
