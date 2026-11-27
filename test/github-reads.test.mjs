// How often loupe asks GitHub, against a gh that writes down every call: a change's first reads share one, and home's
// inbox comes back after a restart without asking.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-ghreads-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.LOUPE_HOME = path.join(tmp, 'home');
process.env.LOUPE_GH = path.join(tmp, 'gh');
process.env.LOUPE_NO_UPDATE = '1';
const CALLS = path.join(tmp, 'calls'), SLOW = path.join(tmp, 'slow'), INBOX = path.join(tmp, 'inbox'), LOGIN = path.join(tmp, 'login');
// pull requests #7 (branch a) and #9 (branch b), their threads, a pending review, and the inbox's searches (the PR number
// they find is in ./inbox: "fail" fails them all, "part:N" only the review-requested one); ./slow holds how many
// milliseconds each call takes, ./login who gh is signed in as
fs.writeFileSync(process.env.LOUPE_GH, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), here = (f) => path.join(__dirname, f);
fs.appendFileSync(here('calls'), JSON.stringify(args) + '\\n');
const slow = fs.existsSync(here('slow')) ? Number(fs.readFileSync(here('slow'), 'utf8')) : 0;
if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow);
const field = (n) => args.find((s) => s.startsWith(n + '='))?.slice(n.length + 1) || '';
const none = { nodes: [], pageInfo: { hasNextPage: false } };
let out;
const option = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const branches = { a: 7, b: 9 }, heads = { 7: 'a', 9: 'b' };
const login = fs.existsSync(here('login')) ? fs.readFileSync(here('login'), 'utf8').trim() : 'me';
if (args[0] === 'api' && args[1] === 'user') out = login;
else if (args[0] === 'pr' && args[1] === 'list') out = branches[option('--head')] ? [{ number: branches[option('--head')], state: 'OPEN', headRefOid: 'a'.repeat(40), updatedAt: '2026-01-01T00:00:00Z', headRepositoryOwner: { login: 'o' }, isCrossRepository: false }] : [];
else if (args[0] === 'pr' && args[1] === 'view') out = { number: Number(args[2]), title: 'pr ' + args[2], body: '', author: { login: 'them' }, state: 'OPEN', url: 'https://github.com/o/r/pull/' + args[2],
  baseRefName: 'main', headRefName: heads[args[2]] || 'topic', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), reviews: [], comments: [], latestReviews: [], reviewRequests: [], statusCheckRollup: [], labels: [], assignees: [] };
else if (args[1] === 'graphql' && field('query').includes('reviewThreads')) out = { data: { repository: { pullRequest: { reviewThreads: none } } } };
else if (args[1] === 'graphql' && field('query').includes('states:PENDING')) out = { data: { viewer: { login: 'me' }, repository: { pullRequest: { id: 'PR_7', headRefOid: 'a'.repeat(40), baseRefName: 'main', state: 'OPEN', latestOpinionatedReviews: { nodes: [] }, reviews: none } } } };
else if (args[1] === 'graphql' && field('query').includes('search(')) {
  let n = fs.readFileSync(here('inbox'), 'utf8').trim();
  if (n === 'fail' || (n.startsWith('part:') && field('q').includes('review-requested'))) process.exit(1);
  n = n.replace('part:', '');
  out = { data: { viewer: { login }, search: { nodes: field('q').includes('review-requested') ? [{ number: Number(n), title: 'pr ' + n, url: 'https://github.com/o/r/pull/' + n, repository: { nameWithOwner: 'o/r' }, author: { login: 'them' } }] : [] } } };
} else { process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(1); }
process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
`, { mode: 0o755 });

const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const prViews = () => calls().filter((a) => a[0] === 'pr' && a[1] === 'view').length;
const searches = () => calls().filter((a) => a[1] === 'graphql' && a.some((x) => x.includes('search('))).length;
beforeEach(() => { for (const f of [CALLS, SLOW, LOGIN]) fs.rmSync(f, { force: true }); });

const { Workspace } = await import('../src/workspaces.mjs');
const { execFileSync } = await import('node:child_process');
const pr = (n) => new Workspace({ id: `pr-o-r-${n}`, kind: 'pr', owner: 'o', repo: 'r', number: n, slug: `o/r/pull/${n}` });

test('a change GitHub has not been read for yet asks it once, however many ask at once', async () => {
  fs.writeFileSync(SLOW, '150');
  const ws = pr(7);
  // the record's own first read, then the page's record, its stack and its ship, all before GitHub answers
  const first = ws.fetchGithub(true);
  const asks = [ws.fetchGithub(), ws.fetchGithub(), ws.fetchGithub()];
  const got = await Promise.all([first, ...asks]);
  assert.ok(got.every((g) => g.pr?.number === 7));
  assert.equal(prViews(), 1);
  assert.equal(ws.githubReading, null); // nothing left under way
  // with an answer, a read for fresh (after a write) still begins after the one under way, and the rest share it
  const reads = [ws.fetchGithub(true), ws.fetchGithub(true), ws.fetchGithub(true)];
  await Promise.all(reads);
  assert.equal(prViews(), 3);
  // and asking without fresh answers from memory
  await ws.fetchGithub();
  assert.equal(prViews(), 3);
});

test('a read that fails still answers everyone who joined it, and the next ask tries again', async () => {
  const ws = pr(8);
  const gh = process.env.LOUPE_GH;
  const { BIN } = await import('../src/config.mjs');
  BIN.gh = '/usr/bin/false';
  try {
    const got = await Promise.all([ws.fetchGithub(true), ws.fetchGithub(), ws.fetchGithub()]);
    assert.ok(got.every((g) => g.pr === null && g.error));
  } finally { BIN.gh = gh; }
  assert.equal(ws.githubReading, null);
  ws.github.at = 0; // older than a minute: asked again
  assert.equal((await ws.fetchGithub()).pr?.number, 8);
});

test('a checkout switched to another branch during its first read waits for the read about the new branch', async () => {
  const root = path.join(tmp, 'checkout');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'b'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: root });
  fs.writeFileSync(SLOW, '150');
  const ws = new Workspace({ id: 'local-checkout', kind: 'local', root, slug: 'local/checkout' });
  ws.meta = { branch: 'a' };
  const first = ws.fetchGithub(true); // the read about branch a
  await delay(20); // under way
  ws.meta = { branch: 'b' };
  const switched = ws.fetchGithub(true); // the switch's own read, queued behind it
  const page = ws.fetchGithub(); // the page, with nothing yet: about b, so not the read about a
  // a's answer lands after the switch: it is kept nowhere (nothing can be written to a's PR from b)
  assert.equal((await first).pr, null);
  assert.equal(ws.github, undefined);
  assert.equal((await page).pr.number, 9);
  assert.equal((await switched).pr.number, 9);
  assert.equal(ws.github.pr.number, 9);
  // switched again, seen by a read of the checkout: b's PR is dropped at once, before GitHub is asked about the new one
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'first'], { cwd: root, env });
  execFileSync('git', ['checkout', '-q', '-b', 'c'], { cwd: root });
  await ws.sync(true);
  assert.equal(ws.meta.branch, 'c');
  assert.equal(ws.github, null);
  assert.equal((await ws.fetchGithub()).pr, null); // c has no PR
  ws.stopWatching();
});

test('home opens with the last inbox answer after a restart, and hears when a read brings a different one', async () => {
  const kept = path.join(process.env.LOUPE_HOME, 'inbox.json');
  fs.writeFileSync(INBOX, '1');
  const GH = await import('../src/github.mjs');
  assert.equal((await GH.inbox(true)).prs[0].number, 1);
  await delay(400); // written a moment after
  assert.equal(JSON.parse(fs.readFileSync(kept, 'utf8')).value.prs[0].number, 1);

  assert.equal(JSON.parse(fs.readFileSync(kept, 'utf8')).who, 'me');
  // a restart: the module afresh, with what the last run kept, once gh says it is signed in as the same person
  fs.rmSync(CALLS, { force: true });
  const again = await import('../src/github.mjs?restart');
  assert.equal((await again.inbox()).prs[0].number, 1);
  assert.equal(searches(), 0); // from disk, and only a minute old: GitHub's searches are not asked

  let told = 0;
  again.onInboxChanged(() => { told++; again.inbox(); }); // as home does: told, it asks again
  fs.writeFileSync(INBOX, '2');
  assert.equal((await again.inbox(true)).prs[0].number, 2);
  assert.equal(told, 1);
  await again.inbox(true); // the same answer again says nothing
  assert.equal(told, 1);

  // a failed read is what home shows when it next asks, but it is not redrawn for it, and does not open with it after
  // the next restart
  fs.writeFileSync(INBOX, 'fail');
  assert.ok((await again.inbox(true)).error);
  assert.equal(told, 1);
  await delay(400);
  // nor is a read that found only part (a search that failed drops its rows)
  fs.writeFileSync(INBOX, 'part:3');
  assert.equal((await again.inbox(true)).prs.length, 0);
  assert.equal(told, 1);
  await delay(50);
  const third = await import('../src/github.mjs?restart-again');
  const opened = await third.inbox();
  assert.equal(opened.error, null);
  assert.equal(opened.prs[0].number, 2);

  // signed in as someone else since: what was kept is not shown, and GitHub is asked
  fs.writeFileSync(LOGIN, 'someone-else');
  fs.writeFileSync(INBOX, '4');
  fs.rmSync(CALLS, { force: true });
  const fourth = await import('../src/github.mjs?another-login');
  assert.equal((await fourth.inbox()).prs[0].number, 4);
  assert.equal(searches(), 3);
});

test('home joins the inbox read under way instead of starting another', async () => {
  fs.writeFileSync(INBOX, '5');
  fs.writeFileSync(SLOW, '100');
  fs.rmSync(path.join(process.env.LOUPE_HOME, 'inbox.json'), { force: true });
  const GH = await import('../src/github.mjs?cold');
  const boot = GH.inbox(true); // the read at boot
  const page = GH.inbox(); // home, with nothing yet
  assert.equal((await page).prs[0].number, 5);
  await boot;
  assert.equal(searches(), 3);
});

// (not GitHub, but the same question of reading once: a checkout's page, opening, reads the checkout once)
test("a checkout's page reads the checkout once as it opens, and a request with no page open still reads it again", async (t) => {
  const root = path.join(tmp, 'page-checkout');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  const ws = new Workspace({ id: 'local-page-checkout', kind: 'local', root, slug: 'local/page-checkout' });
  t.after(() => ws.stopWatching());
  let reads = 0;
  const sync = ws.sync.bind(ws);
  ws.sync = (...args) => { reads++; return sync(...args); };
  // the record is asked first, and the page's stream arrives while it is read
  ws.openingPage();
  const record = ws.ready();
  const page = { write() {} };
  ws.addClient(page);
  assert.equal((await record).dirty, 0);
  await ws.ready(); // the files, asked once the record answers
  assert.equal(reads, 1);

  // no page open: an edit made just before a request is in its answer, whether or not the watcher has seen it yet
  ws.clients.delete(page);
  ws.stopWatching();
  ws.openingPage();
  await ws.ready();
  fs.writeFileSync(path.join(root, 'new'), 'work');
  assert.equal((await ws.ready()).dirty, 1);
});
