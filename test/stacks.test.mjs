// Real repositories for history, reflogs and worktrees. Only GitHub is a fixture.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-stack-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.LOUPE_HOME = path.join(tmp, 'home');
process.env.LOUPE_GH = path.join(tmp, 'gh');
fs.writeFileSync(process.env.LOUPE_GH, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') { process.stdout.write('tester'); process.exit(0); }
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const field = (name) => args.find((s) => s.startsWith(name + '='))?.slice(name.length + 1);
const match = /^repos\\/(owner\\/[^/]+)\\/stacks\\?pull_request=(\\d+)$/.exec(args[1]);
const repo = match?.[1] || option('--repo') || field('name') || field('r') || args[2];
const file = require('node:path').join(__dirname, repo.split('/').at(-1));
const data = JSON.parse(fs.readFileSync(file + '.json'));
fs.appendFileSync(file + '.calls', JSON.stringify(args) + '\\n');
const delay = data.delay || (args[1] === 'graphql' ? data.graphqlDelay : 0) || (args[0] === 'pr' && args[1] === 'view' ? data.viewDelay : 0) || (args[0] === 'pr' && args[1] === 'list' ? data.listDelay : 0);
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
let result;
if (match) result = data.stacks?.[match[2]] || [];
else if (args[0] === 'api' && args[1] === 'graphql' && field('query')?.includes('query StackCommits')) {
  const query = field('query');
  const open = data.prs.filter((p) => p.state === 'OPEN');
  const history = (p) => p && ({
    number: p.number, headRefOid: p.commitListHead || p.headRefOid,
    commits: { nodes: (p.commits || []).slice(-100).map((oid) => ({ commit: { oid } })) },
  });
  const repository = query.includes('newest: pullRequests')
    ? { newest: { nodes: open.slice(0, 100).map(history) }, oldest: { nodes: open.slice(-100).map(history) } }
    : Object.fromEntries([...query.matchAll(/(pr\\d+): pullRequest\\(number: (\\d+)\\)/g)]
        .map(([, alias, number]) => [alias, history(open.find((p) => p.number === Number(number)))]));
  result = data.commitsError ? 'error' : { data: { repository } };
}
else if (args[0] === 'api' && args[1] === 'graphql' && field('r')) {
  const empty = { nodes: [], pageInfo: { hasNextPage: false } };
  result = { data: { repository: { pullRequest: { id: 'pr-' + field('n'), reviewThreads: empty, reviews: empty } } } };
}
else if (args[0] === 'pr' && args[1] === 'list' && option('--json')) {
  const state = option('--state');
  result = data.listError || (state === 'open' && data.openListError) ? 'error' : (data.prs || []).filter((p) => (!option('--head') || option('--head') === p.headRefName) &&
    (!option('--base') || option('--base') === p.baseRefName) &&
    (state === 'all' || state === p.state.toLowerCase()))
    .slice(0, Number(option('--limit')));
} else if (args[0] === 'pr' && args[1] === 'view') result = (!data.viewError && data.prs?.find((p) => p.number === Number(args[2]))) || 'error';
else if (args[0] === 'repo' && args[1] === 'view') result = data.settingsError ? 'error' : { defaultBranchRef: { name: data.trunk || 'main' } };
else throw Error('Unexpected gh arguments: ' + args.join(' '));
if (result === 'error') process.exit(1);
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });

const { expireStackReads, localParent, onStackReadsChanged, pageStack, stackFor, stackSnapshot } = await import('../src/stacks.mjs');
const { Workspace, openTarget, get, registry } = await import('../src/workspaces.mjs');
const { ACTIONS, shipState } = await import('../src/actions.mjs');
const GH = await import('../src/github.mjs');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
} }).trim();
const commit = (cwd, name) => { fs.writeFileSync(path.join(cwd, name), name); sh(cwd, 'add', name); sh(cwd, 'commit', '-qm', name); };
const hash = (root, ref = 'HEAD') => sh(root, 'rev-parse', ref);
const checkout = (root, branch) => sh(root, 'checkout', '-q', branch);
const cut = (root, branch, from, file) => {
  sh(root, 'checkout', '-q', '-b', branch, ...(from ? [from] : []));
  if (file) commit(root, file);
};
function repo(trunk = 'main') {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const up = path.join(dir, 'up'), root = path.join(dir, 'work');
  fs.mkdirSync(up); sh(up, 'init', '-q', '-b', trunk); commit(up, 'a'); commit(up, 'b'); commit(up, 'c');
  sh(dir, 'clone', '-q', up, root);
  return root;
}
function workspace(root, branch, trunk = 'origin/main', github = null) {
  if (branch && branch !== 'HEAD') checkout(root, branch);
  return { id: root + ':' + branch, github, gitDir: root, rec: { kind: 'local', root }, meta: { branch, trunk, base: trunk } };
}
const order = ({ items }) => items.map((i) => i.branch + (i.current ? '*' : '')).join(' / ');
const stack = async (root, branch, trunk) => order(await stackFor(workspace(root, branch, trunk), { fresh: true }));
const local = (root, extra = {}) => new Workspace({ id: path.basename(path.dirname(root)), kind: 'local', root, ...extra });
const pr = (number, headRefName, baseRefName, extra = {}) => ({ number, headRefName, baseRefName, title: 'PR ' + number, state: 'OPEN', ...extra });
function fixture(root, data, current = null) {
  const repo = path.basename(path.dirname(root));
  fs.writeFileSync(path.join(tmp, repo + '.json'), JSON.stringify(data));
  return { owner: 'owner', repo, number: current?.number, pr: current };
}
const prWorkspace = (root, gh) => ({ id: root + '#pr-' + gh.pr.number, gitDir: root, github: gh, rec: { kind: 'pr' }, meta: { branch: gh.pr.headRefName, trunk: 'the trunk' } });
const numbers = (result) => result.items.map((item) => item.pr);
const calls = (gh) => fs.readFileSync(path.join(tmp, gh.repo + '.calls'), 'utf8').trim().split('\n').map(JSON.parse);
const commitQueries = (gh) => calls(gh).filter((args) => args[1] === 'graphql').map((args) => args[3]);
function nextChange(ws, t, reason, open = false) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`missed workspace change: ${reason}`)), 10000);
    const client = { write(line) {
      if (!line.startsWith('event: changed\n')) return;
      const data = JSON.parse(line.split('\n')[1].slice(6));
      if (data.reason !== reason) return;
      clearTimeout(timer);
      ws.clients.delete(client);
      resolve(data);
    } };
    t.after(() => { clearTimeout(timer); ws.clients.delete(client); });
    if (open) ws.addClient(client);
    else ws.clients.add(client);
  });
}

test('trunk tip, old trunk commit and branches with only dirty work have no local stack', async () => {
  const root = repo();
  sh(root, 'branch', 'one', 'origin/main'); sh(root, 'branch', 'two', 'origin/main');
  sh(root, 'branch', 'old', 'origin/main~2');
  cut(root, 'later', 'origin/main', 'later');
  checkout(root, 'one'); fs.writeFileSync(path.join(root, 'dirty'), 'dirty');
  for (const branch of ['one', 'two', 'old', 'main']) assert.equal(await stack(root, branch), '');
});

test('a branch cut from a branch with work is its child, and the parent shows it', async () => {
  const root = repo();
  cut(root, 'feat', 'origin/main', 'f1'); cut(root, 'feat2', 'feat', 'f2');
  assert.equal(await stack(root, 'feat2'), 'feat / feat2*');
  assert.equal(await stack(root, 'feat'), 'feat* / feat2');
});

test('equal tips use explicit or HEAD creation records in both directions, including three generations', async () => {
  const root = repo();
  cut(root, 'first', 'origin/main', 'one');
  cut(root, 'second', 'first');
  cut(root, 'third');
  assert.equal(await stack(root, 'first'), 'first* / second / third');
  assert.equal(await stack(root, 'second'), 'first / second* / third');
  assert.equal(await stack(root, 'third'), 'first / second / third*');
});

test('independent twins and twins with expired reflogs have no known order', async () => {
  const root = repo();
  cut(root, 'one', 'origin/main', 'work');
  const sha = hash(root);
  sh(root, 'branch', 'independent', sha);
  sh(root, 'branch', 'known', 'one');
  assert.equal(await stack(root, 'independent'), '');
  assert.equal(await stack(root, 'known'), 'one / known*');
  sh(root, 'reflog', 'expire', '--expire=all', '--all');
  for (const branch of ['one', 'independent', 'known']) assert.equal(await stack(root, branch), '');
});

test('contradictory creation records cannot make either twin its own ancestor', async () => {
  const root = repo();
  cut(root, 'one', 'origin/main', 'work');
  sh(root, 'branch', 'two', 'one');
  const log = path.join(root, '.git/logs/refs/heads/one');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').split('\n')[0]
    .replace(hash(root, 'origin/main'), hash(root)).replace('Created from origin/main', 'Created from two') + '\n');
  for (const branch of ['one', 'two']) {
    assert.equal(await stack(root, branch), '');
    const ws = local(root);
    await ws.ready();
    assert.equal(ws.range('all').old, hash(root, 'origin/main'));
    assert.deepEqual((await ws.files()).map((f) => f.path), ['work']);
  }
});

test('a recreated branch can start at the tip of a branch cut from its old name', async () => {
  const root = repo();
  cut(root, 'first', 'main');
  cut(root, 'second', 'first', 'work');
  sh(root, 'branch', '-D', 'first');
  cut(root, 'first', 'second');
  const ws = local(root);
  await ws.ready();
  assert.equal(ws.range('all').old, hash(root, 'second'));
  assert.deepEqual(await ws.files(), []);
  assert.equal(order(await stackFor(ws)), 'second / first*');
});

test('default trunk follows origin/HEAD, ignores stale local trunk, and uses local main without origin', async () => {
  const root = repo('master');
  sh(root, 'reset', '-q', '--hard', 'origin/master~2');
  cut(root, 'release/work', 'origin/master', 'work');
  cut(root, 'more', 'release/work', 'more');
  const ws = local(root);
  await ws.sync();
  assert.equal(ws.meta.trunk, 'origin/master');
  assert.equal(order(await stackFor(ws)), 'release/work / more*');
  assert.equal(order(await stackFor(workspace(root, 'master', 'origin/master'))), '');

  const noRemote = repo();
  sh(noRemote, 'remote', 'remove', 'origin');
  cut(noRemote, 'parent', 'main', 'work'); cut(noRemote, 'child', 'parent', 'child');
  const standalone = local(noRemote);
  await standalone.sync();
  assert.equal(standalone.meta.trunk, 'main');
  assert.equal(order(await stackFor(standalone)), 'parent / child*');
  assert.equal(await stack(noRemote, 'child', 'refs/heads/missing'), '');
  sh(noRemote, 'branch', '-D', 'main');
  await standalone.sync();
  assert.equal(standalone.meta.trunk, 'HEAD');
  assert.equal(order(await stackFor(standalone)), '');
});

for (const method of ['merge', 'rebase', 'squash']) {
  test(`a parent landed by ${method} is trunk work, whether its branch is kept or deleted`, async () => {
    const root = repo();
    cut(root, 'parent', 'origin/main', 'p1'); commit(root, 'p2');
    cut(root, 'child', 'parent', 'child');
    checkout(root, 'main'); commit(root, 'trunk-change');
    if (method === 'merge') sh(root, 'merge', '-q', '--no-ff', '-m', 'landed', 'parent');
    if (method === 'rebase') sh(root, 'cherry-pick', 'parent~2..parent');
    if (method === 'squash') { sh(root, 'merge', '-q', '--squash', 'parent'); sh(root, 'commit', '-qm', 'squashed'); }
    sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
    assert.equal(await stack(root, 'child'), '');
    assert.equal(await stack(root, 'parent'), '');
    checkout(root, 'child');
    sh(root, 'branch', '-D', 'parent');
    const ws = local(root);
    await ws.sync();
    assert.equal(order(await stackFor(ws)), '');
    assert.equal(ws.meta.trunkMergeBase, null);
  });
}

test('a rebased parent stays named and the child compares against the old tip it was cut from', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  const old = hash(root);
  cut(root, 'child', 'parent', 'child');
  checkout(root, 'main'); commit(root, 'trunk'); sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  checkout(root, 'parent'); sh(root, 'rebase', '-q', 'origin/main');
  assert.notEqual(hash(root), old);
  assert.equal(await stack(root, 'parent'), 'parent* / child');
  checkout(root, 'child');
  const ws = local(root);
  await ws.sync();
  assert.equal(order(await stackFor(ws)), 'parent / child*');
  assert.equal(ws.meta.base, old);
  assert.equal(ws.range('all').old, old);
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
});

test('the nearest tracking ref wins if its local copy diverged; only matching copies open a checkout', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'p1'); commit(root, 'p2');
  sh(root, 'update-ref', 'refs/remotes/origin/parent', 'parent');
  cut(root, 'child', 'origin/parent', 'child');
  sh(root, 'branch', '-D', 'parent');
  const ws = local(root);
  await ws.sync();
  assert.equal(ws.meta.base, 'refs/remotes/origin/parent');
  assert.equal(order(await stackFor(ws)), 'parent / child*');
  sh(root, 'branch', 'parent', 'origin/parent~');
  const wt = path.join(path.dirname(root), 'old parent');
  sh(root, 'worktree', 'add', '-q', wt, 'parent');
  assert.equal((await stackFor(ws)).items[0].checkout, undefined);
  sh(wt, 'reset', '-q', '--hard', 'origin/parent');
  await ws.sync();
  assert.equal(ws.meta.base, 'refs/heads/parent');
  assert.equal((await stackFor(ws)).items[0].checkout, wt);
  fs.rmSync(wt, { recursive: true });
  assert.equal((await stackFor(ws)).items[0].checkout, undefined);
});

test('a parent ref deleted after the snapshot still compares with the cut commit', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  const cutSha = hash(root);
  cut(root, 'child', 'parent', 'child');
  const snapshot = await stackSnapshot(root);
  sh(root, 'branch', '-D', 'parent');

  const trunk = 'refs/remotes/origin/main';
  assert.equal((await localParent(root, 'child', trunk, snapshot)).base, 'refs/heads/parent');
  const ws = local(root);
  await ws.sync(false, snapshot);
  assert.equal(ws.meta.base, cutSha);
  assert.equal(ws.range('all').old, cutSha);
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
});

test('a topic merged in by a second parent is neither its base nor its child', async () => {
  const root = repo();
  cut(root, 'imported', 'origin/main', 'imported');
  cut(root, 'base', 'origin/main', 'base');
  cut(root, 'child', 'base', 'child'); sh(root, 'merge', '-q', '--no-ff', '-m', 'import', 'imported');
  assert.equal(await stack(root, 'child'), 'base / child*');
  assert.equal(await stack(root, 'imported'), '');
});

test('detached HEAD has no local stack; slashes and origin-looking local branches keep their identity', async () => {
  const root = repo();
  cut(root, 'origin/topic', 'origin/main', 'local-topic');
  sh(root, 'update-ref', 'refs/remotes/origin/topic', 'origin/main');
  cut(root, 'user/child', 'refs/heads/origin/topic', 'child');
  const ws = local(root);
  await ws.sync();
  assert.equal(ws.meta.base, 'refs/heads/origin/topic');
  assert.equal(order(await stackFor(ws)), 'origin/topic / user/child*');
  sh(root, 'checkout', '-q', '--detach');
  await ws.sync();
  assert.equal(ws.meta.branch, 'HEAD');
  assert.equal(order(await stackFor(ws)), '');
  assert.equal(ws.meta.trunkMergeBase, null);
});

test('the nearest parent survives more than 25 candidates, and all ancestors, siblings and grandchildren are shown', async () => {
  const root = repo();
  cut(root, 'level-0', 'origin/main', 'level-0');
  for (let i = 0; i < 27; i++) sh(root, 'branch', 'alias-' + i, 'level-0');
  for (let i = 1; i < 9; i++) cut(root, 'level-' + i, 'level-' + (i - 1), 'level-' + i);
  for (let i = 0; i < 12; i++) cut(root, 'child-' + i, 'level-8', 'child-' + i);
  cut(root, 'grandchild', 'child-9', 'grandchild');
  const s = await stackFor(workspace(root, 'level-8'));
  assert.deepEqual(s.items.slice(0, 9).map((item) => item.branch), Array.from({ length: 9 }, (_, i) => 'level-' + i));
  assert.equal(s.items.filter((i) => i.sibling).length, 11);
  assert.equal(s.items.at(-1).branch, 'grandchild');
  assert.equal(s.items.length, 22);
});

test('stack and diff agree on the parent and whole-stack fork; an override on a standalone branch creates no stack scope', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  cut(root, 'child', 'parent', 'child');
  fs.writeFileSync(path.join(root, 'wip'), 'wip');
  const ws = local(root);
  await ws.sync();
  assert.equal(order(await stackFor(ws)), 'parent / child*');
  assert.equal(ws.meta.base, 'refs/heads/parent');
  assert.equal(ws.meta.trunkMergeBase, hash(root, 'origin/main'));
  assert.deepEqual(ws.range('stack'), { key: 'stack', old: hash(root, 'origin/main'), new: 'WORKTREE' });
  assert.deepEqual((await ws.files('stack')).map((f) => f.path).sort(), ['child', 'parent', 'wip']);
  cut(root, 'standalone', 'origin/main', 'other');
  const override = local(root, { id: 'override', base: 'parent' });
  await override.sync();
  assert.equal(order(await stackFor(override)), '');
  assert.equal(override.meta.trunkMergeBase, null);
  assert.equal(override.range('stack').key, 'all');
});

test('an open workspace refreshes for refs and worktree changes even inside the two-minute cache', async (t) => {
  const root = repo();
  cut(root, 'one', 'origin/main', 'one');
  const ws = local(root);
  await ws.sync();
  assert.equal(order(await stackFor(ws)), '');
  // The refs poll must work on its own, including where a recursive filesystem watcher is unavailable.
  t.mock.method(fs, 'watch', () => { throw Error('recursive watch unavailable'); });
  ws.startWatching();
  try {
    const original = ws.emit.bind(ws);
    const changed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('watcher missed the new branch')), 6000);
      ws.emit = (event, data) => {
        original(event, data);
        if (event === 'changed' && data.reason === 'stack changed') { clearTimeout(timer); resolve(); }
      };
    });
    sh(root, 'branch', 'two', 'one');
    await changed;
    assert.equal(order(await stackFor(ws)), 'one* / two');
    const wt = path.join(path.dirname(root), 'child checkout');
    sh(root, 'worktree', 'add', '-q', wt, 'two');
    assert.equal((await stackFor(ws)).items[1].checkout, wt);
    commit(root, 'one-more');
    await ws.sync();
    assert.equal(order(await stackFor(ws)), 'one* / two'); // two still sits at one's earlier tip
    sh(wt, 'rebase', '-q', 'one');
    await ws.sync();
    assert.equal(order(await stackFor(ws)), 'one* / two');
    checkout(root, 'main');
    await ws.sync();
    assert.equal(order(await stackFor(ws)), '');
  } finally {
    ws.stopWatching();
  }
});

test('a PR workspace whose metadata is still null has an empty stack', async () => {
  const ws = { rec: { kind: 'pr' }, meta: null };
  assert.deepEqual(await stackFor(ws), { kind: 'none', items: [] });
});

test('opening a local page catches unwatched edits and agrees with the live Commit count', async (t) => {
  const root = repo();
  const ws = await openTarget(root);
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(root, `file-${i}`), 'work');
  assert.equal((await ws.ready()).dirty, 2);
  for (let i = 2; i < 6; i++) fs.writeFileSync(path.join(root, `file-${i}`), 'work');
  t.after(() => ws.stopWatching());
  const changed = nextChange(ws, t, 'files changed', true);
  await changed;
  const meta = await ws.ready();
  assert.equal(meta.dirty, 6);
  assert.equal(meta.dirty, (await shipState(ws)).wip.length);
  assert.equal((await ws.files('wip')).length, 6);
  const version = ws.version;
  assert.equal(await ws.ready(), meta);
  assert.equal(ws.version, version);
  await openTarget(root, undefined, { base: 'main~' });
  assert.equal((await ws.ready()).base, 'main~');
});

test('ready without a page rereads files and invalidates worktree hunk caches', async () => {
  const root = repo();
  const ws = local(root);
  const file = path.join(root, 'a');
  fs.writeFileSync(file, 'before\n');
  await ws.ready();
  const previous = ws.scopeKey('wip');
  const hunk = await ws.hunks('wip', 'a');
  fs.writeFileSync(file, 'after\n');
  fs.writeFileSync(path.join(root, 'dirty'), 'dirty');
  assert.equal((await ws.ready()).dirty, 2);
  assert.notEqual(ws.scopeKey('wip'), previous);
  assert.notDeepEqual(await ws.hunks('wip', 'a'), hunk);
});

test('restoring a file after a sync reads its current patch and text', async () => {
  const root = repo();
  const ws = local(root);
  const file = path.join(root, 'a');
  const added = (diff) => diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.t === '+').map((line) => line.s));
  fs.writeFileSync(file, 'first\n');
  await ws.ready();
  const before = await ws.file('wip', 'a');
  fs.writeFileSync(file, 'second\n');
  assert.deepEqual(added(await ws.hunks('wip', 'a')), ['second']);

  fs.writeFileSync(file, 'first\n');
  await ws.sync();
  assert.equal((await ws.file('wip', 'a')).blob, before.blob);
  assert.deepEqual(added(await ws.hunks('wip', 'a')), ['first']);
  assert.equal(await ws.text('wip', 'new', 'a'), 'first\n');
});

test('a watched force-tracked dependency refreshes, and ignored writes and identical saves emit nothing', async (t) => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'node_modules'));
  const tracked = path.join(root, 'node_modules/tracked');
  fs.writeFileSync(tracked, 'initial');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  sh(root, 'add', '.gitignore');
  sh(root, 'add', '-f', 'node_modules/tracked');
  sh(root, 'commit', '-qm', 'tracked dependency');
  const ws = local(root);
  const events = [];
  ws.addClient({ write(line) { if (line.startsWith('event: changed\n')) events.push(line); } });
  t.after(() => ws.stopWatching());
  await ws.ready();
  assert.ok(ws.watch.fs, 'recursive filesystem watcher must be attached');
  const changed = nextChange(ws, t, 'files changed');
  fs.writeFileSync(tracked, 'edited');
  await changed;
  assert.deepEqual((await ws.files('wip')).map((f) => f.path), ['node_modules/tracked']);
  const version = ws.version;
  fs.writeFileSync(path.join(root, 'node_modules/ignored'), 'ignored');
  await delay(650);
  assert.equal(ws.version, version);
  fs.writeFileSync(tracked, 'edited');
  await delay(650);
  assert.equal(events.length, 1);
});

test('a watched local workspace reports a missing root and recovers when it returns', async (t) => {
  const root = repo();
  const moved = root + '-moved';
  const ws = local(root);
  ws.addClient({ write() {} });
  t.after(() => ws.stopWatching());
  await ws.ready();
  const unavailable = nextChange(ws, t, 'workspace unavailable');
  fs.renameSync(root, moved);
  await assert.rejects(ws.ready(), /is gone/);
  await unavailable;
  assert.equal(ws.status, 'error');
  const available = nextChange(ws, t, 'workspace available');
  fs.renameSync(moved, root);
  await available;
  assert.equal(ws.status, 'ready');
  assert.equal(ws.progress, '');
  assert.ok(ws.watch.fs);
  const goneAgain = nextChange(ws, t, 'workspace unavailable');
  fs.renameSync(root, moved);
  await goneAgain; // connected pages learn about the loss without first calling ready()
  assert.equal(ws.status, 'error');
});

test('index-only staging refreshes a watched diff and its untracked flags', async (t) => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored\n');
  sh(root, 'add', '.gitignore');
  sh(root, 'commit', '-qm', 'ignore a file');
  fs.writeFileSync(path.join(root, 'ignored'), 'content');
  const ws = local(root);
  ws.startWatching();
  t.after(() => ws.stopWatching());
  assert.equal((await ws.ready()).dirty, 0);
  await delay(500); // let filesystem events for setup drain before changing only the index
  const changed = nextChange(ws, t, 'files changed');
  sh(root, 'add', '-f', 'ignored');
  await changed;
  assert.deepEqual((await ws.files('wip')).map((f) => f.path), ['ignored']);
  const added = nextChange(ws, t, 'files changed');
  fs.writeFileSync(path.join(root, 'new'), 'content');
  await added;
  assert.equal((await ws.file('wip', 'new')).untracked, true);
  const staged = nextChange(ws, t, 'files changed');
  sh(root, 'add', 'new');
  await staged;
  assert.equal((await ws.file('wip', 'new')).untracked, undefined);
});

for (const moved of ['head', 'base', 'target']) {
  test(`opening a PR checks its ${moved} against GitHub immediately`, async (t) => {
    const root = repo();
    cut(root, 'feat/a', 'main', 'first');
    const head = hash(root), base = hash(root, 'main');
    const ns = 'refs/loupe/pr/101/';
    sh(root, 'push', '-q', 'origin', 'HEAD:refs/pull/101/head');
    sh(root, 'update-ref', ns + 'head', head);
    sh(root, 'update-ref', ns + 'base', base);
    sh(root, 'update-ref', ns + 'trunk', base);
    const target = moved === 'target' ? 'release' : 'main';
    const before = pr(101, 'feat/a', 'main', { headRefOid: head, baseRefOid: base });
    const gh = fixture(root, { prs: [before] }, before);
    const wt = path.join(path.dirname(root), 'pr-worktree');
    sh(root, 'worktree', 'add', '-q', '--detach', wt, head);
    const ws = new Workspace({ id: gh.repo, kind: 'pr', owner: gh.owner, repo: gh.repo, number: 101, clone: root, worktree: wt, pr: before });
    ws.github = { ...gh, at: Date.now() };
    await ws.ready();
    t.after(() => ws.stopWatching());
    if (moved === 'head') {
      commit(root, 'second');
      sh(root, 'push', '-q', 'origin', 'HEAD:refs/pull/101/head');
    } else if (moved === 'base') {
      sh(path.join(path.dirname(root), 'up'), 'config', 'receive.denyCurrentBranch', 'updateInstead');
      sh(root, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); // the base reaches the unchanged head
    } else {
      sh(root, 'push', '-q', 'origin', 'main:refs/heads/release'); // a different target at exactly the same SHA
    }
    const current = { ...before, baseRefName: target, headRefOid: hash(root), baseRefOid: moved === 'base' ? head : base };
    fixture(root, { prs: [current] }, current);
    // Both OIDs are local. Any attempt to fetch them now would fail.
    sh(root, 'remote', 'set-url', 'origin', path.join(root, 'missing-remote'));
    const changed = nextChange(ws, t, moved === 'head' ? 'worktree ready' : 'the base moved', true);
    await changed;
    assert.equal(ws.meta.headFull, current.headRefOid);
    assert.equal(ws.meta.baseFull, current.baseRefOid);
    assert.equal(ws.meta.base, target);
    assert.equal(hash(wt), current.headRefOid);
    assert.deepEqual((await ws.files()).map((f) => f.path).sort(), moved === 'head' ? ['first', 'second'] : moved === 'base' ? [] : ['first']);
    assert.equal(hash(root, ns + 'trunk'), moved === 'base' ? head : base);
  });
}

// A PR opened by name (a stack row, the open box, the CLI) in its clone, registered as loupe would have left it:
//   fetched  every ref and loupe's worktree, with the remote gone so that any fetch fails;
//   halfway  the head and trunk with no base, and no worktree yet, as when prepare() stopped after its first fetch;
//   new      nothing of it, and GitHub cannot read it.
// The fake client records every line of progress the page would draw.
async function openPR(t, state) {
  // The working clone is the PR's clone, as a clone of yours under ~/Projects would be.
  const clone = repo();
  cut(clone, 'topic', 'main', 'first');
  const current = committedPR(clone, 101, 'topic');
  sh(clone, 'push', '-q', 'origin', 'topic:refs/pull/101/head');
  const gh = fixture(clone, { prs: state === 'new' ? [] : [current] }, current);
  const key = `owner/${gh.repo}`.toLowerCase(), id = `pr-owner-${gh.repo.toLowerCase()}-101`;
  registry.data.clones[key] = { path: clone, remote: 'origin' }; // or findClone would search the real ~/Projects
  if (state !== 'new') {
    const refs = state === 'halfway' ? [['head', 'topic'], ['trunk', 'main']] : [['head', 'topic'], ['base', 'main'], ['trunk', 'main']];
    for (const [name, ref] of refs) sh(clone, 'update-ref', `refs/loupe/pr/101/${name}`, ref);
    const rec = { id, kind: 'pr', owner: 'owner', repo: gh.repo, number: 101, slug: `owner/${gh.repo}/pull/101`, clone, remote: 'origin', pr: { ...current, isCrossRepository: false } };
    if (state === 'fetched') {
      rec.worktree = path.join(path.dirname(clone), 'pr-worktree');
      sh(clone, 'worktree', 'add', '-q', '--detach', rec.worktree, current.headRefOid);
      sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'missing-remote'));
    }
    registry.data.workspaces.push(rec);
  }
  const lines = [];
  const ws = await openTarget(`owner/${gh.repo}#101`);
  const opening = ws.status;
  assert.equal(ws.id, id);
  ws.clients.add({ write: (line) => { if (line.startsWith('event: progress\n')) lines.push(JSON.parse(line.split('\n')[1].slice(6))); } });
  t.after(() => {
    ws.clients.clear(); ws.stopWatching();
    registry.data.workspaces = registry.data.workspaces.filter((w) => w.id !== id);
    delete registry.data.clones[key];
  });
  const asked = () => (fs.existsSync(path.join(tmp, gh.repo + '.calls')) ? calls(gh) : []).filter((args) => args[0] === 'pr' && args[1] === 'view');
  return { ws, gh, current, lines, opening, asked };
}
const until = async (ok, ms = 10000) => { for (const end = performance.now() + ms; !ok() && performance.now() < end;) await delay(50); }; // not Date: tests mock it

test('opening a PR loupe has already fetched reads its refs instead of fetching it again', async (t) => {
  const { ws, current, lines, opening, asked } = await openPR(t, 'fetched');
  assert.notEqual(opening, 'preparing', 'the page would draw "Opening…" over a change it already has');
  await ws.ready();
  await delay(200); // a gh pr view started by opening has spawned by now
  assert.equal(ws.status, 'ready');
  assert.equal(ws.meta.headFull, current.headRefOid);
  assert.deepEqual(asked(), []);
  assert.deepEqual(lines.filter((l) => /Reading|Fetching|Cloning/.test(l.text || '')), []);
});

test('opening a PR whose earlier fetch stopped halfway fetches it again, and the page waits for that', async (t) => {
  const { ws, current } = await openPR(t, 'halfway');
  const meta = await ws.ready(); // the page's own look, while the fetch runs
  assert.equal(meta?.baseFull, current.baseRefOid);
  await until(() => ws.rec.worktreeReady);
  assert.equal(hash(ws.gitDir, 'refs/loupe/pr/101/base'), current.baseRefOid);
  assert.equal(hash(ws.root), current.headRefOid);
});

test('opening a PR whose refs went while loupe held it fetches it again', async (t) => {
  const { ws, gh, current } = await openPR(t, 'fetched');
  await ws.ready();
  const clone = ws.rec.clone, ref = (r) => { try { return hash(clone, r); } catch { return null; } };
  sh(clone, 'remote', 'set-url', 'origin', path.join(path.dirname(clone), 'up'));
  for (const name of ['head', 'base', 'trunk']) sh(clone, 'update-ref', '-d', `refs/loupe/pr/101/${name}`);
  await openTarget(`owner/${gh.repo}#101`);
  await until(() => ref('refs/loupe/pr/101/base') && ws.status === 'ready');
  assert.equal(ref('refs/loupe/pr/101/head'), current.headRefOid);
  assert.equal(ref('refs/loupe/pr/101/base'), current.baseRefOid);
  await ws.ready();
  await until(() => ws.rec.worktreeReady);
});

test('opening a PR that GitHub cannot read asks once and says why', async (t) => {
  const { ws, asked } = await openPR(t, 'new');
  await until(() => ws.status === 'error');
  await delay(500); // a second attempt would have asked by now
  assert.equal(ws.status, 'error');
  assert.equal(asked().length, 1);
});

test('refresh fetches an unseen PR tip and repairs a missing or stale same-head worktree locally', async () => {
  const root = repo();
  cut(root, 'topic', 'main', 'first');
  const before = committedPR(root, 101, 'topic');
  const clone = fetchedPR(root, before);
  sh(clone, 'remote', 'add', 'origin', root);
  sh(root, 'update-ref', 'refs/pull/101/head', before.headRefOid);
  const gh = fixture(root, { prs: [before] }, before);
  const wt = path.join(path.dirname(root), 'pr-worktree');
  sh(clone, 'worktree', 'add', '-q', '--detach', wt, before.headRefOid);
  const ws = new Workspace({ id: gh.repo, kind: 'pr', owner: gh.owner, repo: gh.repo, number: 101, clone, worktree: wt, pr: before });
  ws.github = { ...gh, at: Date.now() };
  await ws.ready();
  commit(root, 'second');
  const current = committedPR(root, 101, 'topic');
  sh(root, 'update-ref', 'refs/pull/101/head', current.headRefOid);
  assert.throws(() => sh(clone, 'cat-file', '-e', current.headRefOid));
  await ws.prepareAgain(current);
  assert.equal(ws.meta.headFull, current.headRefOid);
  assert.equal(hash(wt), current.headRefOid);
  sh(clone, 'remote', 'set-url', 'origin', path.join(root, 'missing-remote'));
  fs.rmSync(wt, { recursive: true });
  assert.equal(ws.rec.worktreeReady, true);
  await ws.prepareAgain(current);
  assert.equal(hash(wt), current.headRefOid);
  sh(wt, 'checkout', '-q', '--detach', before.headRefOid);
  await ws.prepareAgain(current);
  assert.equal(hash(wt), current.headRefOid);
  assert.equal(ws.rec.worktreeReady, true);
});

test('a checkout can be restored after its Git link is removed', async () => {
  const root = repo();
  cut(root, 'topic', 'main', 'work');
  const current = committedPR(root, 101, 'topic');
  const clone = fetchedPR(root, current);
  const gh = fixture(root, { prs: [current] }, current);
  const wt = path.join(path.dirname(root), 'pr-worktree');
  sh(clone, 'worktree', 'add', '-q', '--detach', wt, current.headRefOid);
  const ws = new Workspace({ ...gh, id: gh.repo, kind: 'pr', clone, worktree: wt });
  ws.github = gh;
  await ws.ready();
  fs.unlinkSync(path.join(wt, '.git'));
  fs.writeFileSync(path.join(wt, 'work'), 'keep me');

  await ws.prepareAgain(current);
  assert.notEqual(ws.root, wt);
  assert.equal(path.dirname(ws.root), path.join(process.env.LOUPE_HOME, 'worktrees'));
  assert.equal(ws.meta.root, ws.root);
  assert.equal(hash(ws.root), current.headRefOid);
  assert.equal(fs.readFileSync(path.join(wt, 'work'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(wt, '.git')), false);
});

test('a new PR head keeps edits made in loupe’s checkout, and a page opening repairs a checkout that went', async (t) => {
  const root = repo();
  cut(root, 'topic', 'main', 'first');
  const before = committedPR(root, 101, 'topic');
  const clone = fetchedPR(root, before);
  sh(clone, 'remote', 'add', 'origin', root);
  sh(root, 'update-ref', 'refs/pull/101/head', before.headRefOid);
  const gh = fixture(root, { prs: [before] }, before);
  const wt = path.join(path.dirname(root), 'pr-worktree');
  sh(clone, 'worktree', 'add', '-q', '--detach', wt, before.headRefOid);
  const ws = new Workspace({ id: gh.repo, kind: 'pr', owner: gh.owner, repo: gh.repo, number: 101, clone, worktree: wt, pr: before });
  ws.github = { ...gh, at: Date.now() };
  await ws.ready();
  fs.writeFileSync(path.join(wt, 'first'), 'edited by hand');
  fs.writeFileSync(path.join(wt, 'second'), 'left untracked'); // the new head tracks this path
  commit(root, 'second');
  const current = committedPR(root, 101, 'topic');
  sh(root, 'update-ref', 'refs/pull/101/head', current.headRefOid);
  await ws.prepareAgain(current);
  assert.notEqual(ws.root, wt);
  assert.equal(hash(ws.root), current.headRefOid);
  assert.equal(ws.meta.root, ws.root);
  assert.equal(fs.readFileSync(path.join(wt, 'first'), 'utf8'), 'edited by hand');
  assert.equal(fs.readFileSync(path.join(wt, 'second'), 'utf8'), 'left untracked');
  assert.equal(hash(wt), before.headRefOid);
  fixture(root, { prs: [current] }, current); // GitHub now agrees, so its check on each page open moves nothing
  // a healthy checkout: the first page's check changes nothing and redraws nothing
  const events = [];
  const page = { write(line) { if (line.startsWith('event: changed\n')) events.push(line); } };
  ws.addClient(page);
  t.after(() => ws.stopWatching());
  await ws.ensureWorktree();
  await ws.fetchGithub(true);
  assert.deepEqual(events, []);
  ws.clients.delete(page);
  // gone while nobody looked, with GitHub saying nothing moved: opening a page brings it back
  fs.rmSync(ws.root, { recursive: true });
  await nextChange(ws, t, 'worktree ready', true);
  await ws.fetchGithub(true);
  assert.equal(hash(ws.root), current.headRefOid);
  assert.equal(ws.meta.root, ws.root);
  ws.clients.clear();
  // its .git pointer left but git's record of it gone: a fresh checkout, the folder left as it was
  const broken = ws.root;
  fs.rmSync(path.join(path.resolve(clone, sh(clone, 'rev-parse', '--git-common-dir')), 'worktrees'), { recursive: true });
  await nextChange(ws, t, 'worktree ready', true);
  assert.notEqual(ws.root, broken);
  assert.equal(hash(ws.root), current.headRefOid);
  assert.ok(fs.existsSync(path.join(broken, '.git')));
});

test('a new PR head never overwrites an ignored file left in loupe’s checkout', async () => {
  const root = repo();
  cut(root, 'topic', 'main', 'first');
  const before = committedPR(root, 101, 'topic');
  const clone = fetchedPR(root, before);
  sh(clone, 'remote', 'add', 'origin', root);
  const gh = fixture(root, { prs: [before] }, before);
  const wt = path.join(path.dirname(root), 'pr-worktree');
  sh(clone, 'worktree', 'add', '-q', '--detach', wt, before.headRefOid);
  const ws = new Workspace({ id: gh.repo, kind: 'pr', owner: gh.owner, repo: gh.repo, number: 101, clone, worktree: wt, pr: before });
  ws.github = { ...gh, at: Date.now() };
  await ws.ready();
  const common = path.resolve(clone, sh(clone, 'rev-parse', '--git-common-dir'));
  fs.mkdirSync(path.join(common, 'info'), { recursive: true });
  fs.appendFileSync(path.join(common, 'info', 'exclude'), 'second\n');
  fs.writeFileSync(path.join(wt, 'second'), 'ignored, kept');
  commit(root, 'second'); // the new head tracks the ignored path
  const current = committedPR(root, 101, 'topic');
  sh(root, 'update-ref', 'refs/pull/101/head', current.headRefOid);
  await ws.prepareAgain(current);
  assert.notEqual(ws.root, wt);
  assert.equal(hash(ws.root), current.headRefOid);
  assert.equal(fs.readFileSync(path.join(wt, 'second'), 'utf8'), 'ignored, kept');
});

test('a background PR refresh updates the stack range when only trunk advances', async () => {
  const root = repo();
  cut(root, 'landed', 'main', 'landed');
  cut(root, 'parent', 'landed', 'parent');
  cut(root, 'child', 'parent', 'child');
  const current = committedPR(root, 2, 'child', 'parent');
  const parent = committedPR(root, 1, 'parent', 'main');
  const clone = fetchedPR(root, current, 'parent');
  sh(clone, 'remote', 'add', 'origin', root);
  const gh = fixture(root, { prs: [parent, current] }, current);
  const wt = path.join(path.dirname(root), 'pr-worktree');
  sh(clone, 'worktree', 'add', '-q', '--detach', wt, current.headRefOid);
  const ws = new Workspace({ ...gh, id: gh.repo, kind: 'pr', clone, worktree: wt });
  ws.github = gh;
  await ws.ready();
  assert.deepEqual((await ws.files('stack')).map((f) => f.path).sort(), ['child', 'landed', 'parent']);

  sh(root, 'branch', '-f', 'main', 'landed');
  fixture(root, { prs: [{ ...parent, baseRefOid: hash(root, 'main') }, current] }, current);
  await ws.fetchGithubNow();
  assert.equal(hash(clone, 'refs/loupe/pr/2/trunk'), hash(root, 'main'));
  assert.equal(ws.meta.headFull, current.headRefOid);
  assert.equal(ws.meta.baseFull, current.baseRefOid);
  assert.equal(ws.range('stack').old, hash(root, 'main'));
  assert.deepEqual((await ws.files('stack')).map((f) => f.path).sort(), ['child', 'parent']);
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
});

test('GitHub stack order takes precedence, even from a bare clone, and preserves review states', async () => {
  const root = repo();
  const bare = path.join(path.dirname(root), 'bare');
  sh(root, 'clone', '--bare', '-q', '.', bare);
  const parent = pr(1, 'one', 'main', { state: 'MERGED' });
  const current = pr(2, 'two', 'one');
  const child = pr(3, 'three', 'two', { isDraft: true });
  const gh = fixture(root, {
    prs: [pr(4, 'competing', 'two'), child, current, parent],
    stacks: { 2: [{ number: 6, pull_requests: [{ number: 99 }] }, {
      number: 7, base: { ref: 'main' }, pull_requests: [parent, current, child].map((p) => ({ number: p.number, head: { ref: p.headRefName } })),
    }] },
  }, current);
  const result = await stackFor(prWorkspace(bare, gh));
  assert.equal(result.kind, 'github');
  assert.equal(result.stackNumber, 7);
  assert.equal(result.trunk, 'main');
  assert.deepEqual(numbers(result), [1, 2, 3]);
  assert.deepEqual(result.items.map((i) => [i.title, !!i.here, i.merged, i.draft, i.checkout]),
    [['PR 1', false, true, false, undefined], ['PR 2', true, false, false, undefined], ['PR 3', false, false, true, undefined]]);
  cut(root, 'two', 'origin/main', 'local');
  assert.equal((await stackFor(workspace(root, 'two', 'origin/main', gh))).kind, 'github');
});

for (const response of [[], 'error']) {
  test(`stack API ${response === 'error' ? 'error' : 'absence'} falls back to PR bases and follows both sides of a forked chain`, async () => {
    const root = repo();
    const parent = pr(1, 'base-branch', 'main');
    const current = pr(2, 'current', 'base-branch');
    const prs = [parent, current, pr(3, 'left', 'current'), pr(4, 'right', 'current'),
      pr(5, 'left-next', 'left'), pr(6, 'right-next', 'right'), pr(7, 'peer', 'base-branch')];
    const gh = fixture(root, { prs, stacks: { 2: response, 1: [{ number: 42, pull_requests: [parent] }] } }, current);
    const result = await stackFor(prWorkspace(root, gh));
    assert.equal(result.kind, 'chain');
    assert.equal(result.trunk, 'main');
    assert.deepEqual(numbers(result), [1, 2, 3, 4, 5, 6]);
    assert.equal(result.items[1].notInStack, true);
    assert.equal(result.items[3].sibling, true);
    assert.equal(result.parentStack, true);
    assert.equal(result.stackNumber, 42);
    cut(root, 'current', 'origin/main', 'local');
    assert.deepEqual(numbers(await stackFor(workspace(root, 'current', 'origin/main', gh))), [1, 2, 3, 4, 5, 6]);
  });
}

test('cross-repo PRs can sit on a repository branch but cannot be bases or open same-name local worktrees', async () => {
  const root = repo();
  cut(root, 'fork/topic', 'origin/main', 'local');
  const parent = pr(1, 'parent', 'main');
  const current = pr(2, 'fork/topic', 'parent', { crossRepo: true });
  const other = pr(3, 'other', 'fork/topic');
  const gh = fixture(root, { prs: [parent, { ...current, isCrossRepository: true }, other] }, current);
  const result = await stackFor(prWorkspace(root, gh));
  assert.deepEqual(numbers(result), [1, 2]);
  assert.equal(result.items[1].checkout, undefined);
  assert.deepEqual(numbers(await stackFor(prWorkspace(root, { ...gh, pr: other }))), []);
  const fromParent = await stackFor(prWorkspace(root, { ...gh, pr: parent }));
  assert.deepEqual(numbers(fromParent), [1, 2]);
});

test('a closed unmerged base is kept when its head is the base oid; merged, missing and reused bases stop the chain', async () => {
  const root = repo();
  const oid = hash(root);
  const current = pr(10, 'current', 'old-base', { baseRefOid: oid });
  const old = pr(1, 'old-base', 'main', { headRefOid: oid, state: 'CLOSED' });
  for (const historical of [old, { ...old, state: 'MERGED' }, { ...old, headRefOid: 'different' }, null]) {
    const gh = fixture(root, { prs: [current, ...(historical ? [historical] : [])] }, current);
    const result = await stackFor(prWorkspace(root, gh), { fresh: true });
    if (historical === old) {
      assert.deepEqual(numbers(result), [1, 10]);
      assert.equal(result.items[0].state, 'closed');
    } else assert.deepEqual(numbers(result), []);
  }
});

test('a failed open PR list keeps local parent evidence without reviving a closed PR', async () => {
  const root = repo();
  cut(root, 'topic', 'main', 'topic');
  cut(root, 'child', 'topic', 'child');
  const current = committedPR(root, 3, 'child', 'topic');
  const closed = committedPR(root, 1, 'topic', 'main', { state: 'CLOSED' });
  const reopened = pr(2, 'topic', 'release', { headRefOid: closed.headRefOid });
  const gh = fixture(root, { prs: [closed, reopened, current], openListError: true }, current);
  const ws = prWorkspace(root, gh);
  ws.meta.headFull = current.headRefOid;

  const result = await stackFor(ws);
  assert.equal(order(result), 'topic / child*');
  assert.deepEqual(numbers(result), [undefined, 3]);
  assert.equal(calls(gh).some((args) => args.includes('closed')), false);
});

test('PR cycles stop without repeating a row, and the reported trunk is the repository default', async () => {
  const root = repo();
  const a = pr(1, 'a-pr', 'b-pr'), b = pr(2, 'b-pr', 'a-pr');
  const gh = fixture(root, { prs: [a, b], trunk: 'release' }, a);
  const result = await stackFor(prWorkspace(root, gh));
  assert.deepEqual(numbers(result), [2, 1]);
  assert.equal(result.trunk, 'release');
});

test('PR base discovery gets past 200 open PRs and beyond the old depth guard', async () => {
  const root = repo();
  const noise = Array.from({ length: 215 }, (_, i) => pr(i + 100, 'noise-' + i, 'main'));
  const chain = Array.from({ length: 24 }, (_, i) => pr(i + 1, 'pr-' + i, i ? 'pr-' + (i - 1) : 'main'));
  const gh = fixture(root, { prs: [...noise, ...chain] }, chain[12]);
  assert.deepEqual(numbers(await stackFor(prWorkspace(root, gh))), chain.map((p) => p.number));
});

test('past 1,000 open PRs the list is a sample: no PR stack is inferred from it, and it is read once', async () => {
  const root = repo();
  const headRefOid = hash(root);
  const current = pr(1, 'current', 'main', { headRefOid });
  const last = pr(1000, 'last', 'current', { baseRefOid: headRefOid });
  const beyond = pr(1001, 'beyond', 'current', { baseRefOid: headRefOid });
  const noise = Array.from({ length: 998 }, (_, i) => pr(i + 2, 'noise-' + i, 'main'));
  const gh = fixture(root, { prs: [current, ...noise, last, beyond] }, current);

  assert.deepEqual(numbers(await stackFor(prWorkspace(root, gh))), []);
  const open = calls(gh).filter((args) => args.includes('--state') && args.includes('open'));
  assert.deepEqual(open.map((args) => args[args.indexOf('--limit') + 1]), ['1000']);
});

test('a capped list gives no parent either: not an open one it may have cut off, not a closed one by name', async () => {
  const root = repo();
  const closed = pr(1, 'old-base', 'main', { headRefOid: hash(root, 'main~2'), state: 'CLOSED' });
  const parent = pr(2, 'parent', 'old-base', { headRefOid: hash(root, 'main~1'), baseRefOid: closed.headRefOid });
  const current = pr(3, 'current', 'parent', { baseRefOid: parent.headRefOid });
  const omitted = pr(1002, 'parent', 'release', { headRefOid: parent.headRefOid });
  const noise = Array.from({ length: 998 }, (_, i) => pr(i + 4, 'noise-' + i, 'main'));
  const gh = fixture(root, { prs: [current, parent, ...noise, omitted, closed] }, current);

  assert.deepEqual(numbers(await stackFor(prWorkspace(root, gh))), []);
  assert.deepEqual(numbers(await stackFor(prWorkspace(root, { ...gh, pr: parent }))), []);
});

test('a local stack preserves its local-only parent above the nearest PR and uses PR history below it', async () => {
  const root = repo();
  cut(root, 'old-local-base', 'origin/main', 'stale');
  cut(root, 'has-pr', 'old-local-base', 'has-pr');
  cut(root, 'local-parent', 'has-pr', 'local-parent');
  cut(root, 'current', 'local-parent', 'current');
  const parent = pr(2, 'has-pr', 'new-base');
  const gh = fixture(root, { prs: [parent, pr(1, 'new-base', 'main')] });
  const ws = local(root);
  ws.github = gh;
  await ws.sync();
  assert.equal(order(await stackFor(ws)), 'new-base / has-pr / local-parent / current*');
  assert.equal(ws.meta.base, 'refs/heads/local-parent');
  assert.deepEqual((await ws.files()).map((f) => f.path), ['current']);
  const direct = await stackFor(workspace(root, 'local-parent', 'origin/main', fixture(root, {
    prs: [parent, pr(1, 'new-base', 'main')], stacks: { 2: [{ number: 7, pull_requests: [parent] }] },
  })));
  assert.equal(direct.parentStack, true);
  assert.equal(direct.stackNumber, 7);
});

test('a PR workspace gets whole-stack scope only when there is a PR under its fetched base', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent'); cut(root, 'child', 'parent', 'child');
  const current = pr(2, 'child', 'parent');
  const gh = fixture(root, { prs: [pr(1, 'parent', 'main'), current] }, current);
  for (const [name, ref] of [['head', 'child'], ['base', 'parent'], ['trunk', 'origin/main']]) sh(root, 'update-ref', 'refs/loupe/pr/2/' + name, ref);
  const ws = new Workspace({ ...gh, kind: 'pr', clone: root, id: 'pr-scope' });
  ws.github = gh;
  await ws.sync();
  assert.equal(ws.meta.trunkMergeBase, hash(root, 'origin/main'));
  assert.deepEqual(ws.range('stack'), { key: 'stack', old: hash(root, 'origin/main'), new: hash(root) });
  fixture(root, { prs: [current] }, current);
  await stackFor(ws, { fresh: true });
  await ws.sync(true);
  assert.equal(ws.meta.trunkMergeBase, null);
});

test('remote-only stack changes can be refreshed explicitly, and switching branches discards stale PR identity', async () => {
  const root = repo();
  cut(root, 'current', 'origin/main', 'work');
  const current = pr(2, 'current', 'main');
  const ws = workspace(root, 'current', 'origin/main', fixture(root, { prs: [current] }, current));
  assert.deepEqual(numbers(await stackFor(ws)), []);
  fixture(root, { prs: [current, pr(3, 'child', 'current')] }, current);
  assert.deepEqual(numbers(await stackFor(ws)), []);
  assert.deepEqual(numbers(await stackFor(ws, { fresh: true })), [2, 3]);
  checkout(root, 'main'); ws.meta.branch = 'main';
  assert.deepEqual(numbers(await stackFor(ws)), []);
});

test('Overview shows a stack only with two items, keeps branch names and states, and makes inert rows safe', async () => {
  const root = repo();
  cut(root, 'parent/with-space-in-title', 'origin/main', 'parent');
  cut(root, 'current', 'parent/with-space-in-title', 'current');
  const current = pr(4, 'current', 'main');
  const gh = fixture(root, { stacks: { 4: [{ number: 4, pull_requests: [
    { number: 1, head: { ref: 'merged' }, state: 'MERGED' },
    { number: 2, head: { ref: 'closed' }, state: 'closed' },
    { number: 3, head: { ref: 'draft' }, draft: true },
    current,
    { number: 5, head: { ref: 'open' }, state: 'open' },
  ] }] } }, current);
  const S = { ws: {}, rangeKey: 'all' };
  const panel = fs.readFileSync(new URL('../web/js/panel.js', import.meta.url), 'utf8');
  const render = vm.runInNewContext(panel.slice(panel.indexOf('function stackHTML()'), panel.indexOf('// ------------------------------------------------------------------ chat')) + '\nstackHTML', { S, esc: String });
  assert.equal(render(), '');
  const localStack = await stackFor(workspace(root, 'current'));
  S.stack = { ...localStack, items: localStack.items.slice(0, 1) };
  assert.equal(render(), '');
  S.stack = localStack;
  assert.match(render(), /parent\/with-space-in-title<\/span><span class="ss">local/);
  assert.match(render(), /data-si="0"[^>]* disabled/);
  assert.match(render(), /this one/);
  assert.doesNotMatch(render(), /whole stack/);
  S.stack = await stackFor(workspace(root, 'current', 'origin/main', gh));
  S.ws.trunkMergeBase = hash(root, 'origin/main');
  for (const state of ['merged', 'closed', 'draft', 'this one', 'open']) assert.match(render(), new RegExp('>' + state + '</span>'));
  assert.match(render(), /Read the whole stack together/);
  S.rangeKey = 'stack';
  assert.match(render(), /Back to this change alone/);
});

test('stack clicks prefer a checkout, then its PR, and an old request cannot overwrite a newer stack', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  cut(root, 'current', 'parent', 'current');
  const wt = path.join(path.dirname(root), 'parent worktree');
  sh(root, 'worktree', 'add', '-q', wt, 'parent');
  const current = pr(2, 'current', 'parent'), parent = pr(1, 'parent', 'main');
  const gh = fixture(root, { prs: [current, parent, pr(3, 'child', 'current')] }, current);
  const result = await stackFor(workspace(root, 'current', 'origin/main', gh));
  const main = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const S = { id: 'old', stack: result };
  const targets = [], toasts = [], replies = [], requests = [];
  const { openStackItem, loadStack } = vm.runInNewContext(main.slice(main.indexOf('let stackRequest'), main.indexOf('// A PR gets its brief')) + '\n({ openStackItem, loadStack })',
    { S, openTarget: (target) => targets.push(target), toast: (s) => toasts.push(s), renderGo() {}, renderStack() {}, typingInPanel: () => false,
      api: (url) => new Promise((resolve) => { requests.push(url); replies.push(resolve); }) });
  await openStackItem(0);
  await openStackItem(1);
  await openStackItem(2);
  result.items.push({ branch: 'nowhere' });
  await openStackItem(3);
  assert.deepEqual(targets, [wt, result.repo + '#3']);
  assert.equal(toasts.length, 1);
  const old = loadStack();
  S.id = 'new';
  const next = loadStack(true);
  assert.deepEqual(requests, ['/api/w/old/stack', '/api/w/new/stack?fresh=1']);
  replies[1](result); await next;
  replies[0](null); await old;
  assert.equal(S.stack, result);
});

// Three open PRs in one GitHub stack, in a bare clone: each PR's workspace reads the stack the others read.
function sharedStack(extra = {}) {
  const root = repo();
  const bare = path.join(path.dirname(root), 'bare');
  sh(root, 'clone', '--bare', '-q', '.', bare);
  const prs = [pr(1, 'one', 'main'), pr(2, 'two', 'one'), pr(3, 'three', 'two')];
  const stack = { number: 7, base: { ref: 'main' }, pull_requests: prs.map((p) => ({ number: p.number, head: { ref: p.headRefName } })) };
  const data = (more = {}) => ({ prs, stacks: { 1: [stack], 2: [stack], 3: [stack] }, ...more });
  const gh = fixture(root, data(extra), prs[1]);
  const at = (n) => prWorkspace(bare, { ...gh, number: n, pr: prs[n - 1] });
  const asked = () => (fs.existsSync(path.join(tmp, gh.repo + '.calls')) ? calls(gh) : []).filter((args) => (args[0] === 'pr' && args[1] === 'list') || (args[0] === 'api' && args[1].includes('/stacks'))).length;
  return { root, bare, prs, gh, at, asked, data, write: (more) => fixture(root, data(more), prs[1]) };
}

test('the next PR of a stack opened reads its stack from what the last one read', async () => {
  const { at, asked } = sharedStack();
  assert.deepEqual(numbers(await stackFor(at(2))), [1, 2, 3]);
  const before = asked();
  assert.deepEqual(numbers(await stackFor(at(3))), [1, 2, 3]);
  assert.deepEqual(numbers(await stackFor(at(1))), [1, 2, 3]);
  assert.equal(asked(), before, 'GitHub was asked again');
});

test('a read that failed is not kept, and a fresh stack reads again and keeps what it got', async () => {
  const { at, asked, write } = sharedStack({ listError: true, stacks: {} });
  const first = await stackFor(at(2));
  assert.deepEqual(numbers(first), [], 'nothing read, nothing inferred');
  write(); // GitHub answers again
  assert.deepEqual(numbers(await stackFor(at(3))), [1, 2, 3], 'the failure was not kept');
  const before = asked();
  write({ prs: [pr(1, 'one', 'main'), pr(2, 'two', 'one')], stacks: {} }); // #3 is gone from the stack
  assert.deepEqual(numbers(await stackFor(at(2), { fresh: true })), [1, 2]);
  assert.ok(asked() > before);
  assert.deepEqual(numbers(await stackFor(at(1))), [1, 2], 'what the fresh read got is kept for the others');
});

test('an old answer is used while a read behind it runs; that read keeps the last answer if it fails, and says when it changed one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { gh, at, asked, write } = sharedStack();
  const told = [], mine = `owner/${gh.repo}`.toLowerCase();
  t.after(onStackReadsChanged((repo) => { if (repo === mine) told.push(repo); })); // other tests' repositories change too
  assert.deepEqual(numbers(await stackFor(at(2))), [1, 2, 3]);
  t.mock.timers.tick(60000); // a minute old: still used, and read again behind it
  write({ listError: true, stacks: { 1: 'error', 2: 'error', 3: 'error' } });
  const before = asked();
  assert.deepEqual(numbers(await stackFor(at(3))), [1, 2, 3]);
  await until(() => asked() > before);
  await delay(300);
  assert.deepEqual(numbers(await stackFor(at(1))), [1, 2, 3], 'a failed read behind it keeps the last answer');
  assert.deepEqual(told, []);
  write({ prs: [pr(1, 'one', 'main'), pr(2, 'two', 'one')], stacks: {} });
  const ws = at(2);
  assert.deepEqual(numbers(await stackFor(ws)), [1, 2, 3]); // the old answer, and a read behind it
  await until(() => told.length);
  await delay(400);
  assert.deepEqual(told, [mine], 'told once for the answers it changed together');
  assert.deepEqual(numbers(await stackFor(ws)), [1, 2], 'the same workspace reads its stack again');
  t.mock.timers.tick(6 * 60000); // past five minutes, a failure is a failure
  write({ listError: true, stacks: { 1: 'error', 2: 'error', 3: 'error' } });
  assert.deepEqual(numbers(await stackFor(at(3))), []);
});

test('a read begun before the answers were expired is not kept, and an overtaken read hands back the newer answer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { gh, at, asked, write } = sharedStack();
  await stackFor(at(2));
  t.mock.timers.tick(60000);
  write({ listDelay: 1500 }); // a slow read behind the old answer, begun before a merge
  const before = asked();
  await stackFor(at(3));
  await until(() => asked() > before);
  await delay(400);
  expireStackReads(`owner/${gh.repo}`); // the merge
  write();
  await delay(1600); // the slow read lands after it
  const openReads = () => calls(gh).filter((args) => args[0] === 'pr' && args[1] === 'list' && args.includes('open')).length;
  const after = openReads();
  await stackFor(at(1));
  assert.ok(openReads() > after, 'the open PRs read before the merge were kept as fresh');
  // cold: a slow read, overtaken by a fresh one, hands its caller the fresh answer
  const other = sharedStack({ listDelay: 1500, stacks: {} }); // a stack the open PRs' bases make
  const slow = stackFor(other.at(2));
  await until(() => other.asked() > 0);
  await delay(400);
  other.write({ prs: [pr(1, 'one', 'main'), pr(2, 'two', 'one')], stacks: {} });
  assert.deepEqual(numbers(await stackFor(other.at(1), { fresh: true })), [1, 2]);
  assert.deepEqual(numbers(await slow), [1, 2]);
});

test('a PR that left a stack asks GitHub for its own the next time', async () => {
  const { prs, at, asked, write } = sharedStack();
  await stackFor(at(2)); // #1 and #3 kept from #2's answer
  const two = [prs[0], prs[1]];
  write({ prs, stacks: { 1: [{ number: 7, base: { ref: 'main' }, pull_requests: two.map((p) => ({ number: p.number, head: { ref: p.headRefName } })) }], 2: [{ number: 7, base: { ref: 'main' }, pull_requests: two.map((p) => ({ number: p.number, head: { ref: p.headRefName } })) }], 3: 'error' } });
  assert.deepEqual(numbers(await stackFor(at(2), { fresh: true })), [1, 2]);
  const before = asked();
  assert.notEqual((await stackFor(at(3))).kind, 'github', 'GitHub failing, #3 fell back to the stack it had left');
  assert.ok(asked() > before, '#3 used the stack it had left');
});

test('a PR replaced in a stack, and one moved to another stack, are told apart by the stack', async () => {
  const { root, bare, prs, at, asked } = sharedStack();
  await stackFor(at(2)); // stack 7: #1 #2 #3, kept for each
  const four = pr(4, 'four', 'two'), all = [...prs, four];
  const ref = (ps) => ps.map((p) => ({ number: p.number, head: { ref: p.headRefName } }));
  const seven = { number: 7, base: { ref: 'main' }, pull_requests: ref([prs[0], prs[1], four]) };
  fixture(root, { prs: all, stacks: { 1: [seven], 2: [seven], 4: [seven], 3: 'error' } }, prs[1]);
  const ws4 = prWorkspace(bare, { ...at(2).github, number: 4, pr: four });
  assert.deepEqual(numbers(await stackFor(ws4, { fresh: true })), [1, 2, 4]); // #3 was replaced by #4
  const before = asked();
  assert.notEqual((await stackFor(at(3))).kind, 'github', '#3 still showed the stack it was replaced in');
  assert.ok(asked() > before);
  // #1 moves to stack 8; a member of 8 is read, then one of 7, which no longer has #1
  const eight = { number: 8, base: { ref: 'main' }, pull_requests: ref([prs[0], { number: 9, headRefName: 'nine' }]) };
  const seven2 = { ...seven, pull_requests: ref([prs[1], four]) };
  fixture(root, { prs: all, stacks: { 9: [eight], 2: [seven2], 4: [seven2], 1: 'error' } }, prs[1]);
  await stackFor(prWorkspace(bare, { ...at(2).github, number: 9, pr: { number: 9, headRefName: 'nine', baseRefName: 'main', state: 'OPEN' } }), { fresh: true });
  await stackFor(at(2), { fresh: true });
  const one = await stackFor(at(1)); // GitHub fails for #1: what was kept for it in stack 8 still stands
  assert.equal(one.stackNumber, 8);
});

test('a stack is kept no longer than the oldest answer it was built from may be used, and Read again keeps the last answer for a failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { gh, at, write } = sharedStack();
  await stackFor(at(2));
  t.mock.timers.tick(10000);
  expireStackReads(`owner/${gh.repo}`); // Read again, with GitHub down: the ten-second-old answer stands
  write({ listError: true, stacks: { 1: 'error', 2: 'error', 3: 'error' } });
  assert.deepEqual(numbers(await stackFor(at(1))), [1, 2, 3]);
  t.mock.timers.tick(4.5 * 60000);
  const ws = at(3);
  assert.deepEqual(numbers(await stackFor(ws)), [1, 2, 3]); // nearly five minutes old: used, and a read behind it fails
  await delay(300);
  t.mock.timers.tick(60000); // past five minutes
  assert.deepEqual(numbers(await stackFor(ws)), [], 'the same workspace kept a stack built from answers past use');
});

test('a failure past five minutes, then the same answer again, reads again the stack that failed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { at, write } = sharedStack();
  await stackFor(at(2));
  t.mock.timers.tick(6 * 60000);
  write({ listError: true, stacks: { 1: 'error', 2: 'error', 3: 'error' } });
  const ws = at(3);
  assert.deepEqual(numbers(await stackFor(ws)), []);
  write(); // GitHub is back, with the same answers as before
  assert.deepEqual(numbers(await stackFor(at(1))), [1, 2, 3]);
  assert.deepEqual(numbers(await stackFor(ws)), [1, 2, 3], 'the stack that failed stayed empty');
});

test('an answer whose read began before an expiry is the last answer for a read that fails', async () => {
  const { gh, at, write } = sharedStack({ listDelay: 1500, stacks: {} });
  const slow = stackFor(at(2));
  await until(() => fs.existsSync(path.join(tmp, gh.repo + '.calls')));
  await delay(400);
  expireStackReads(`owner/${gh.repo}`); // a write made meanwhile
  assert.deepEqual(numbers(await slow), [1, 2, 3]);
  write({ listError: true, stacks: {} });
  assert.deepEqual(numbers(await stackFor(at(3))), [1, 2, 3], 'the answer that came back was thrown away');
});

test('the first answer after a failed read reads again the stacks that failed', async () => {
  const { at, write } = sharedStack({ listError: true, stacks: { 1: 'error', 2: 'error', 3: 'error' } });
  const ws = at(2);
  assert.deepEqual(numbers(await stackFor(ws)), []);
  write();
  assert.deepEqual(numbers(await stackFor(at(3))), [1, 2, 3]);
  assert.deepEqual(numbers(await stackFor(ws)), [1, 2, 3], 'the stack that failed stayed empty');
});

test('a fresh stack is not overtaken by an older read that lands after it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { at, asked, write } = sharedStack();
  assert.deepEqual(numbers(await stackFor(at(2))), [1, 2, 3]);
  t.mock.timers.tick(60000);
  write({ listDelay: 1500 }); // a slow read behind the old answer, of the stack as it was
  const before = asked();
  await stackFor(at(3));
  await until(() => asked() > before);
  await delay(400); // it has read the stack as it was
  write({ prs: [pr(1, 'one', 'main'), pr(2, 'two', 'one')], stacks: {} });
  assert.deepEqual(numbers(await stackFor(at(2), { fresh: true })), [1, 2]);
  await delay(1600); // the slow read lands
  assert.deepEqual(numbers(await stackFor(at(1))), [1, 2]);
});

// The same workspace as another object: its own stack cache, none of the first's.
const at2 = (ws) => Object.assign(Object.create(Object.getPrototypeOf(ws)), ws);

test('Read again reads GitHub’s answers behind a stack again', async (t) => {
  const { ws, gh } = await openPR(t, 'fetched');
  await ws.ready();
  const asked = () => (fs.existsSync(path.join(tmp, gh.repo + '.calls')) ? calls(gh) : []).filter((args) => args[0] === 'pr' && args[1] === 'list').length;
  await stackFor(ws);
  assert.ok(asked() > 0);
  const before = asked();
  await stackFor(at2(ws)); // another look within half a minute: what was read stands
  assert.equal(asked(), before);
  await ws.refresh().catch(() => {});
  await stackFor(ws);
  assert.ok(asked() > before, 'Read again did not read the open PRs again');
});

test('a write made in loupe reads GitHub’s answers behind its stack again', async (t) => {
  const { ws, gh } = await openPR(t, 'fetched');
  await ws.ready();
  const asked = () => calls(gh).filter((args) => args[0] === 'pr' && args[1] === 'list').length;
  await stackFor(ws);
  const before = asked();
  await stackFor(at2(ws));
  assert.equal(asked(), before, 'within half a minute, what was read stands');
  await ws.runAction(async () => ({ message: 'merged' }));
  await stackFor(ws); // the same workspace: its own stack, built from the old answers, is read again too
  assert.ok(asked() > before, 'the write did not read the open PRs again');
});

test('a page open on a repository hears when a read behind its stack changed an answer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { ws, gh, current } = await openPR(t, 'fetched');
  const events = [];
  ws.clients.add({ write: (line) => { if (line.startsWith('event: stack\n')) events.push(line); } });
  await ws.ready();
  await stackFor(ws);
  t.mock.timers.tick(150000); // past the workspace's own two minutes, inside the shared five
  fixture(ws.rec.clone, { prs: [current, pr(102, 'above', current.headRefName)], stacks: {} }, current);
  await stackFor(ws); // the old answer, and a read behind it
  await until(() => events.length);
  await delay(400);
  assert.equal(events.length, 1);
  assert.deepEqual(numbers(await stackFor(ws)), [101, 102]);
});

test('a stack asked for beside the files is never drawn over a newer one', async () => {
  const main = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const S = { id: 'ws' }, drawn = [], replies = [];
  const { askStack, loadStack } = vm.runInNewContext(main.slice(main.indexOf('let stackRequest'), main.indexOf('async function openStackItem')) + '\n({ askStack, loadStack })',
    { S, renderGo() {}, renderStack: () => drawn.push(S.stack), typingInPanel: () => false, api: () => new Promise((resolve) => replies.push(resolve)) });
  const early = askStack(); // sent with the files, drawn once they are
  const newer = loadStack(); // a read of GitHub landed meanwhile, and asked again
  replies[1]({ kind: 'chain', items: [{ pr: 2 }, { pr: 3 }] }); await newer;
  replies[0]({ kind: 'chain', items: [{ pr: 1 }, { pr: 3 }] }); await early();
  assert.deepEqual(S.stack.items.map((i) => i.pr), [2, 3]);
  assert.equal(drawn.length, 1);
});

test('a PR’s stack is read from its own record while GitHub’s read of it is slow', async (t) => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'child', 'parent', 'child');
  const parent = committedPR(root, 1, 'parent'), child = committedPR(root, 2, 'child', 'parent');
  const clone = fetchedPR(root, child, 'parent');
  const gh = fixture(root, { prs: [parent, child], viewDelay: 3000 }, child);
  const ws = new Workspace({ id: gh.repo + '-slow', kind: 'pr', owner: gh.owner, repo: gh.repo, number: 2, clone, pr: { ...child, isCrossRepository: false } });
  await ws.ready(); // GitHub's read starts here, and takes three seconds
  t.after(() => ws.stopWatching());
  const start = Date.now(), stack = await pageStack(ws);
  assert.ok(Date.now() - start < 2000, `waited ${Date.now() - start} ms for GitHub`);
  assert.deepEqual(numbers(stack), [1, 2]);
  assert.ok(!ws.github?.pr, 'GitHub had not answered yet');
  // a record from before isCrossRepository was kept cannot tell a fork's branch from the repository's own: it waits
  const old = new Workspace({ id: gh.repo + '-old', kind: 'pr', owner: gh.owner, repo: gh.repo, number: 2, clone, pr: child });
  await old.ready();
  t.after(() => old.stopWatching());
  const waited = Date.now();
  await pageStack(old);
  assert.ok(Date.now() - waited >= 2000, 'it did not wait for GitHub');
});

test('a PR whose record cannot tell a fork, with GitHub failing, takes what the open PRs say of it', async (t) => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'child', 'parent', 'child');
  cut(root, 'grandchild', 'parent', 'grandchild'); // based on child by name
  const parent = committedPR(root, 1, 'parent'), child = committedPR(root, 2, 'child', 'parent');
  const grandchild = committedPR(root, 3, 'grandchild', 'child');
  const clone = fetchedPR(root, child, 'parent');
  for (const ref of ['refs/loupe/pr/2/trunk', 'refs/remotes/origin/main']) sh(clone, 'update-ref', '-d', ref); // only its head and base
  const gh = fixture(root, { prs: [parent, { ...child, isCrossRepository: false }, grandchild], viewError: true }, child);
  const ws = new Workspace({ id: gh.repo + '-listed', kind: 'pr', owner: gh.owner, repo: gh.repo, number: 2, clone, pr: child });
  await ws.ready();
  t.after(() => ws.stopWatching());
  assert.deepEqual(numbers(await pageStack(ws)), [1, 2, 3], 'the open PRs said it is this repository’s own');
});

test('a fork PR whose record cannot tell it is one, with GitHub failing, links no branch of this clone to it', async (t) => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'child', 'parent', 'child'); // the fork's branch, fetched here as the PR's head
  cut(root, 'grandchild', 'parent', 'grandchild'); // based on this repository's own branch named child
  const parent = committedPR(root, 1, 'parent'), child = committedPR(root, 2, 'child', 'parent');
  const grandchild = committedPR(root, 3, 'grandchild', 'child');
  const clone = fetchedPR(root, child, 'parent');
  const gh = fixture(root, { prs: [parent, { ...child, isCrossRepository: true }, grandchild], viewError: true }, child);
  const ws = new Workspace({ id: gh.repo + '-legacy', kind: 'pr', owner: gh.owner, repo: gh.repo, number: 2, clone, pr: child });
  await ws.ready();
  t.after(() => ws.stopWatching());
  const stack = await pageStack(ws);
  assert.equal(stack.items.find((i) => i.current)?.crossRepo, true);
  assert.deepEqual(numbers(stack), [1, 2], 'a PR based on a branch named like the fork’s was taken for its child');
});

test('a failed read of a repository’s merge settings is asked again a minute later, not kept until loupe restarts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const root = repo();
  const gh = fixture(root, { settingsError: true });
  const asked = () => calls(gh).filter((args) => args[0] === 'repo').length;
  assert.equal(await GH.mergeSettings('owner', gh.repo), null);
  fixture(root, { trunk: 'release' });
  assert.equal(await GH.mergeSettings('owner', gh.repo), null, 'within the minute, the failure stands');
  assert.equal(asked(), 1);
  t.mock.timers.tick(60000);
  assert.equal((await GH.mergeSettings('owner', gh.repo))?.defaultBranchRef?.name, 'release');
  assert.equal(asked(), 2);
  t.mock.timers.tick(60 * 60000);
  await GH.mergeSettings('owner', gh.repo); // and once read, it is kept
  assert.equal(asked(), 2);
});

test('the minute’s stack read draws the Overview again only when the stack moved, and not under a comment being written', async () => {
  const main = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const S = { id: 'ws' }, drawn = [];
  let typing = false, answer;
  const { loadStack } = vm.runInNewContext(main.slice(main.indexOf('let stackRequest'), main.indexOf('async function openStackItem')) + '\n({ loadStack })',
    { S, renderGo() {}, renderStack: () => drawn.push(S.stack), typingInPanel: () => typing, api: async () => answer() });
  const stack = (title) => ({ kind: 'chain', trunk: 'main', items: [{ pr: 1, branch: 'a', title, current: true }, { pr: 2, branch: 'b', title: 'B' }] });
  answer = () => stack('A');
  await loadStack();
  assert.equal(drawn.length, 1);
  await loadStack(); // the same stack, read again
  assert.equal(drawn.length, 1);
  typing = true; answer = () => ({ ...stack('A'), items: [stack('A').items[1], stack('A').items[0]] }); // reordered
  await loadStack();
  assert.equal(drawn.length, 1, 'drawn over a comment being written');
  assert.equal(S.stack.items[0].pr, 1, 'the rows on screen still open what they show');
  typing = false;
  await loadStack(); // the next read, once the comment is done
  assert.equal(drawn.length, 2);
  assert.equal(S.stack.items[0].pr, 2);
  S.stack = null; typing = true; // the head moved and the page dropped the old list: nothing to keep on screen
  await loadStack();
  assert.equal(drawn.length, 3);
});

test('an anonymous cut above two independently named copies of one commit does not pick a parent alphabetically', async () => {
  const root = repo();
  cut(root, 'one', 'origin/main', 'work');
  const same = hash(root);
  sh(root, 'update-ref', 'refs/heads/two', same); // an independent ref, without a branch creation record
  cut(root, 'child', same, 'child');
  assert.equal(await stack(root, 'child'), '');
  const ws = local(root);
  await ws.sync();
  assert.equal(ws.meta.base, same);
  assert.equal(ws.range('all').old, same);
  assert.equal(ws.meta.baseLabel, same.slice(0, 9));
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
  assert.equal(await stack(root, 'one'), '');
  assert.equal(await stack(root, 'two'), '');
});

test('a detached worktree cut keeps its dirty and committed diffs at the cut and prefers the matching open PR in the stack', async (t) => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  cut(root, 'feat/a', 'parent', 'feat-a');
  sh(root, 'push', '-q', 'origin', 'parent', 'feat/a');
  const tip = hash(root);
  sh(root, 'branch', 'feat/a-copy', tip);
  checkout(root, 'main');
  sh(root, 'branch', '-D', 'feat/a', 'parent');
  const wt = path.join(path.dirname(root), 'detached');
  sh(root, 'worktree', 'add', '-q', '--detach', wt, 'origin/feat/a');
  sh(wt, 'switch', '-q', '-c', 'child');
  fs.writeFileSync(path.join(wt, 'dirty'), 'dirty');
  const parent = pr(101, 'feat/a', 'parent', { headRefOid: tip });
  const gh = fixture(root, { prs: [parent] });

  for (const committed of [false, true]) {
    if (committed) commit(wt, 'child');
    const ws = local(wt);
    ws.github = gh;
    await ws.ready();
    const cut = await localParent(wt, 'child', 'origin/main');
    assert.equal(cut.ref, null);
    assert.deepEqual(cut.candidates.toSorted(), ['feat/a', 'feat/a-copy']);
    assert.equal(ws.meta.base, tip);
    assert.equal(ws.meta.baseAuto, true);
    assert.equal(ws.meta.trunkMergeBase, hash(wt, 'origin/main'));
    assert.deepEqual((await ws.files()).map((f) => f.path).sort(), committed ? ['child', 'dirty'] : ['dirty']);
    assert.equal(order(await stackFor(ws)), 'parent / feat/a / child*');
    const rows = (await stackFor(ws)).items;
    assert.equal(rows[1].pr, 101);
    assert.equal(rows[1].ref, 'refs/remotes/origin/feat/a');
    assert.equal(rows[2].pr, undefined);
  }
  const ws = local(wt);
  ws.startWatching();
  t.after(() => ws.stopWatching());
  await ws.ready();
  const moved = nextChange(ws, t, 'stack changed');
  cut(root, 'feat/a', 'origin/feat/a', 'more');
  sh(root, 'push', '-q', 'origin', 'feat/a');
  sh(root, 'branch', '-D', 'feat/a-copy');
  await moved;
  assert.equal(ws.meta.base, tip);
  assert.deepEqual((await ws.files()).map((f) => f.path).sort(), ['child', 'dirty']);
});

test('a commit comparison base is not prefilled as a GitHub PR base branch', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  const tip = hash(root);
  cut(root, 'child', tip, 'child');
  sh(root, 'branch', '-D', 'parent');
  sh(root, 'push', '-q', '-u', 'origin', 'child');
  const ws = local(root);
  ws.github = { repoFull: 'owner/repo' };
  await ws.ready();
  assert.equal(ws.meta.base, tip);
  assert.equal((await shipState(ws)).base, '');
  await assert.rejects(ACTIONS.openpr.preview(ws, { title: 'Child' }), /name the base branch/);
  assert.equal((await ACTIONS.openpr.preview(ws, { title: 'Child', base: 'main' })).guard.base, 'main');
  sh(root, 'tag', 'point', tip);
  checkout(root, 'main');
  checkout(root, 'child');
  for (const base of ['main~', 'main~0', '@', '@{-1}', 'point', tip.slice(0, 9)]) {
    await ws.setBase(base);
    assert.equal((await shipState(ws)).base, '', base);
  }
  for (const base of ['main', 'refs/heads/main', 'origin/main', 'refs/remotes/origin/main']) {
    await ws.setBase(base);
    assert.equal((await shipState(ws)).base, 'main', base);
  }
});

test('a detached cut is a floor after rebasing onto a newer tracking tip', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  cut(root, 'topic', 'parent', 'topic');
  sh(root, 'push', '-q', 'origin', 'parent', 'topic');
  const cutSha = hash(root);
  const wt = path.join(path.dirname(root), 'detached');
  sh(root, 'worktree', 'add', '-q', '--detach', wt, 'origin/topic');
  cut(wt, 'child', undefined, 'child');
  commit(root, 'more');
  sh(root, 'push', '-q', 'origin', 'topic');
  sh(root, 'fetch', '-q', 'origin');
  sh(wt, 'rebase', '-q', 'origin/topic');
  sh(wt, 'merge-base', '--is-ancestor', cutSha, 'HEAD');
  const ws = local(wt);
  await ws.ready();
  assert.equal(ws.range('all').old, hash(root, 'origin/topic'));
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
  assert.equal(order(await stackFor(ws)), 'parent / topic / child*');

  sh(root, 'update-ref', 'refs/heads/another', 'topic');
  const nearer = hash(root, 'topic');
  const result = await localParent(wt, 'child', 'origin/main');
  assert.equal(result.ref, null);
  assert.equal(result.sha, nearer);
  assert.deepEqual(result.candidates.toSorted(), ['another', 'topic']);
  await ws.ready();
  assert.equal(ws.range('all').old, nearer);
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
  assert.equal(order(await stackFor(ws)), '');
  sh(root, 'update-ref', 'refs/heads/uncut', hash(wt));
  assert.equal(await localParent(root, 'uncut', 'origin/main'), null);
  sh(root, 'update-ref', '-d', 'refs/heads/uncut');
  ws.github = fixture(root, { prs: [pr(101, 'topic', 'parent', { headRefOid: nearer })] });
  const named = await stackFor(ws, { fresh: true });
  assert.equal(order(named), 'parent / topic / child*');
  assert.equal(named.items[1].pr, 101);
  checkout(root, 'main');
  sh(root, 'branch', '-D', 'topic', 'another');
  sh(root, 'update-ref', '-d', 'refs/remotes/origin/topic');
  await ws.ready();
  assert.equal(ws.range('all').old, cutSha); // the remaining parent branch is below the cut
  assert.deepEqual((await ws.files()).map((f) => f.path).sort(), ['child', 'more']);
});

test('a branch cut from a commit can use its only branch name', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'work');
  const tip = hash(root);
  cut(root, 'child', tip, 'child');
  assert.equal((await localParent(root, 'child', 'origin/main')).base, 'refs/heads/parent');
  assert.equal(await stack(root, 'child'), 'parent / child*');
});

test('a tag or expression gives a cut commit, even when its only branch advances', async () => {
  for (const start of ['tag', 'expression']) {
    const root = repo();
    cut(root, 'parent', 'origin/main', 'parent');
    const tip = hash(root);
    sh(root, 'tag', 'point', tip);
    cut(root, 'child', start === 'tag' ? 'point' : 'parent~0', 'child');
    const ws = local(root);
    await ws.ready();
    assert.equal(ws.meta.base, 'refs/heads/parent');
    checkout(root, 'parent');
    commit(root, 'more');
    checkout(root, 'child');
    await ws.ready();
    assert.equal(ws.meta.base, tip);
    assert.equal(order(await stackFor(ws)), '');
    assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
  }
});

test('an anonymous cut at a fork PR tip does not infer the fork as a same-tip parent', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  const tip = hash(root);
  checkout(root, 'main');
  sh(root, 'branch', '-D', 'parent');
  cut(root, 'child', tip);
  const fork = pr(101, 'parent', 'main', { headRefOid: tip, isCrossRepository: true });
  const ws = local(root);
  ws.github = fixture(root, { prs: [fork] });
  await ws.ready();
  assert.equal(ws.meta.base, tip);
  assert.deepEqual(numbers(await stackFor(ws)), []);
});

test('a closed PR on a reused local branch does not override its new cut', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  const tip = hash(root);
  cut(root, 'child', tip, 'child');
  const ws = local(root);
  const old = pr(101, 'child', 'main', { state: 'CLOSED', headRefOid: hash(root, 'main') });
  ws.github = fixture(root, { prs: [old], stacks: { 101: [{ number: 1, pull_requests: [pr(102, 'unrelated', 'main'), old] }] } }, old);
  await ws.ready();
  assert.equal(ws.range('all').old, tip);
  assert.deepEqual((await ws.files()).map((f) => f.path), ['child']);
  assert.equal(order(await stackFor(ws)), 'parent / child*');
});

test('multiple open PRs from one head cannot uniquely establish the base PR', async () => {
  const root = repo();
  const current = pr(3, 'child', 'parent');
  const gh = fixture(root, { prs: [pr(1, 'parent', 'main'), pr(2, 'parent', 'release'), current] }, current);
  assert.deepEqual(numbers(await stackFor(prWorkspace(root, gh))), []);
});

test('a same-tip child created from HEAD in a linked worktree is also found from the main checkout', async () => {
  const root = repo();
  cut(root, 'parent', 'origin/main', 'parent');
  const wt = path.join(path.dirname(root), 'linked checkout');
  sh(root, 'worktree', 'add', '-q', '--detach', wt, 'parent');
  checkout(root, 'main');
  checkout(wt, 'parent');
  cut(wt, 'child');
  const s = await stackFor(workspace(root, 'parent'));
  assert.equal(order(s), 'parent* / child');
  assert.equal(s.items[1].checkout, wt);
});

test('authoritative stack entries outside the recent PR list keep their titles, states and fork identity', async () => {
  const root = repo();
  cut(root, 'same-name', 'origin/main', 'same-name');
  const current = pr(2, 'current', 'main');
  const older = pr(1, 'same-name', 'main', { state: 'CLOSED', isCrossRepository: true });
  const noise = Array.from({ length: 201 }, (_, i) => pr(i + 100, 'noise-' + i, 'main'));
  const gh = fixture(root, { prs: [...noise, current, older], stacks: { 2: [{ number: 5, pull_requests: [{ number: 1 }, { number: 2 }] }] } }, current);
  const s = await stackFor(prWorkspace(root, gh));
  assert.equal(s.items[0].title, 'PR 1');
  assert.equal(s.items[0].state, 'closed');
  assert.equal(s.items[0].checkout, undefined);
});

test('a PR stack based on a release branch starts its whole-stack diff at the release fork', async () => {
  const root = repo();
  cut(root, 'release', 'origin/main', 'release');
  cut(root, 'parent', 'release', 'parent');
  cut(root, 'child', 'parent', 'child');
  sh(root, 'update-ref', 'refs/remotes/origin/release', 'release');
  const current = pr(2, 'child', 'parent');
  const gh = fixture(root, { prs: [pr(1, 'parent', 'release'), current] }, current);
  for (const [name, ref] of [['head', 'child'], ['base', 'parent'], ['trunk', 'origin/main']]) sh(root, 'update-ref', 'refs/loupe/pr/2/' + name, ref);
  const ws = new Workspace({ ...gh, kind: 'pr', clone: root, id: 'release-scope' });
  await ws.sync();
  assert.equal(ws.meta.trunkMergeBase, null);
  ws.github = gh;
  await ws.sync();
  assert.equal((await stackFor(ws)).trunk, 'release');
  assert.equal(ws.meta.trunkMergeBase, hash(root, 'release'));
  assert.deepEqual((await ws.files('stack')).map((f) => f.path).sort(), ['child', 'parent']);
});

// Keep the other PRs' objects in their author repository so GraphQL has to supply their history.
function fetchedPR(root, current, base = 'main') {
  const bare = path.join(path.dirname(root), 'review.git');
  sh(root, 'init', '-q', '--bare', bare);
  const refs = `refs/loupe/pr/${current.number}`;
  sh(root, 'push', '-q', bare, `main:refs/remotes/origin/main`,
    `${current.headRefName}:${refs}/head`, `${base}:${refs}/base`, `main:${refs}/trunk`);
  return bare;
}

function committedPR(root, number, branch, base = 'main', extra = {}) {
  return pr(number, branch, base, {
    headRefOid: hash(root, branch), baseRefOid: hash(root, base),
    commits: sh(root, 'rev-list', '--reverse', `${base}..${branch}`).split('\n').filter(Boolean), ...extra,
  });
}

test('a fetched PR into main finds the nearest open PR without its branch ref or a fetch and keeps the GitHub diff', async () => {
  const root = repo();
  cut(root, 'first', 'main', 'first');
  cut(root, 'parent', 'first', 'parent');
  cut(root, 'current', 'parent', 'current');
  const first = committedPR(root, 1, 'first');
  const parent = committedPR(root, 2, 'parent');
  const current = committedPR(root, 3, 'current');
  const bare = fetchedPR(root, current);
  const gh = fixture(bare, { prs: [current, first, parent] }, current);
  const ws = new Workspace({ ...gh, kind: 'pr', clone: bare, id: 'commit-parent' });
  ws.github = gh;
  await ws.sync();
  assert.equal(ws.meta.trunkMergeBase, null);
  assert.deepEqual((await ws.files()).map((f) => f.path).sort(), ['current', 'first', 'parent']);
  assert.equal(sh(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/parent'), '');
  const s = await stackFor(ws);
  assert.deepEqual(numbers(s), [1, 2, 3]);
  assert.deepEqual(s.items.map((i) => !!i.byCommits), [true, true, false]);
  assert.deepEqual(commitQueries(gh).filter((query) => query.includes('pullRequest(number:')), []);
  const count = calls(gh).length;
  assert.equal(await stackFor(ws), s);
  assert.equal(calls(gh).length, count);
  assert.deepEqual(ws.range('all'), { key: 'all', old: hash(root, 'main'), new: current.headRefOid });
});

test('implicit children include a fork, siblings and a grandchild whose objects were never fetched', async () => {
  const root = repo();
  cut(root, 'current', 'main', 'current');
  cut(root, 'left', 'current', 'left');
  cut(root, 'right', 'current', 'right');
  cut(root, 'grandchild', 'left', 'grandchild');
  const current = committedPR(root, 1, 'current');
  const left = committedPR(root, 2, 'left', 'main', { isCrossRepository: true });
  const right = committedPR(root, 3, 'right');
  const grandchild = committedPR(root, 4, 'grandchild');
  const bare = fetchedPR(root, current);
  const gh = fixture(bare, { prs: [current, left, right, grandchild] }, current);
  const result = await stackFor(prWorkspace(bare, gh));
  assert.deepEqual(numbers(result), [1, 2, 3, 4]);
  assert.deepEqual(result.items.map((i) => !!i.byCommits), [false, true, true, true]);
  assert.deepEqual(result.items.map((i) => !!i.sibling), [false, false, true, false]);
  assert.equal(result.items[1].crossRepo, true);
  assert.equal(result.items[1].checkout, undefined);
  assert.equal(calls(gh).filter((args) => args[1] === 'graphql').length, 1);
  assert.throws(() => sh(bare, 'cat-file', '-e', grandchild.headRefOid));

  const leftBare = path.join(path.dirname(root), 'fork-review.git');
  sh(root, 'init', '-q', '--bare', leftBare);
  sh(root, 'push', '-q', leftBare, 'main:refs/remotes/origin/main', 'left:refs/loupe/pr/2/head');
  assert.deepEqual(numbers(await stackFor(prWorkspace(leftBare, { ...gh, pr: left }))), [1, 2, 4]);
});

for (const authority of ['base chain', 'GitHub stack']) {
  test(`a ${authority} keeps its declared rows and gains an implicit child`, async () => {
    const root = repo();
    cut(root, 'parent', 'main', 'parent');
    cut(root, 'current', 'parent', 'current');
    cut(root, 'child', 'current', 'child');
    const parent = committedPR(root, 1, 'parent');
    const current = committedPR(root, 2, 'current', 'parent');
    const child = committedPR(root, 3, 'child');
    const bare = fetchedPR(root, current, 'parent');
    const stacks = authority === 'GitHub stack' ? { 2: [{ number: 5, base: { ref: 'main' }, pull_requests: [parent, current] }] } : {};
    const gh = fixture(bare, { prs: [parent, current, child], stacks }, current);
    const ws = new Workspace({ ...gh, kind: 'pr', clone: bare, id: 'declared-' + authority.replaceAll(' ', '-') });
    ws.github = gh;
    await ws.sync();
    assert.deepEqual(ws.range('all'), { key: 'all', old: parent.headRefOid, new: current.headRefOid });
    assert.deepEqual(ws.range('stack'), { key: 'stack', old: hash(root, 'main'), new: current.headRefOid });
    assert.equal(calls(gh).some((args) => args[1] === 'graphql' || args.includes('merged')), false);
    const result = await stackFor(ws);
    assert.equal(result.kind, authority === 'GitHub stack' ? 'github' : 'chain');
    assert.deepEqual(numbers(result), [1, 2, 3]);
    assert.deepEqual(result.items.map((i) => !!i.byCommits), [false, false, true]);
    if (authority === 'GitHub stack') assert.equal(result.items[2].notInStack, true);
  });
}

for (const method of ['squash', 'rebase', 'merge']) {
  test(`a ${method}-merged PR is shown only if its original head remains off trunk`, async () => {
    const root = repo();
    cut(root, 'parent', 'main', 'parent');
    commit(root, 'more-parent');
    cut(root, 'current', 'parent', 'current');
    const parent = committedPR(root, 1, 'parent', 'main', { state: 'MERGED' });
    const current = committedPR(root, 2, 'current');
    checkout(root, 'main'); commit(root, 'on-trunk');
    if (method === 'merge') sh(root, 'merge', '-q', '--no-ff', '-m', 'landed', 'parent');
    if (method === 'rebase') sh(root, 'cherry-pick', 'parent~2..parent');
    if (method === 'squash') { sh(root, 'merge', '-q', '--squash', 'parent'); sh(root, 'commit', '-qm', 'landed'); }
    parent.mergeCommit = { oid: hash(root) };
    sh(root, 'branch', '-D', 'parent');
    const bare = fetchedPR(root, current);
    const gh = fixture(bare, { prs: [current, parent] }, current);
    const s = await stackFor(prWorkspace(bare, gh));
    if (method === 'merge') assert.deepEqual(numbers(s), []);
    else {
      assert.deepEqual(numbers(s), [1, 2]);
      assert.equal(s.items[0].merged, true);
      assert.equal(s.items[0].byCommits, true);
      const panel = fs.readFileSync(new URL('../web/js/panel.js', import.meta.url), 'utf8');
      const render = vm.runInNewContext(panel.slice(panel.indexOf('function stackHTML()'), panel.indexOf('// ------------------------------------------------------------------ chat')) + '\nstackHTML', { S: { stack: s, ws: {} }, esc: String });
      assert.match(render(), /merged · by commits<\/span>/);
    }
  });
}

test('twins require a recorded cut, and a trunk head or a closed PR contributes no implicit edge', async () => {
  const root = repo();
  cut(root, 'current', 'main', 'current');
  const same = hash(root);
  sh(root, 'branch', 'twin', same);
  sh(root, 'branch', 'known', 'current');
  sh(root, 'branch', 'old-trunk', 'main~');
  cut(root, 'closed', 'current', 'later');
  const prs = [committedPR(root, 1, 'current'), committedPR(root, 2, 'twin'), committedPR(root, 3, 'known'),
    committedPR(root, 4, 'closed', 'main', { state: 'CLOSED' }), committedPR(root, 5, 'old-trunk')];
  const gh = fixture(root, { prs }, prs[0]);
  // An unmerged closed PR's branch is still an independent source if the ref exists. Remove it here.
  checkout(root, 'main'); sh(root, 'branch', '-D', 'closed');
  assert.deepEqual(numbers(await stackFor(prWorkspace(root, gh))), [1, 3]);
  assert.deepEqual(numbers(await stackFor(prWorkspace(root, { ...gh, pr: prs[2] }))), [1, 3]);
  for (const p of [prs[1], prs[4]]) assert.deepEqual(numbers(await stackFor(prWorkspace(root, { ...gh, pr: p }))), []);
});

test('a fork is only the parent of a same-repo branch when its precise head is in that branch', async () => {
  const root = repo();
  cut(root, 'fork', 'main', 'fork');
  cut(root, 'local-child', 'fork', 'child');
  cut(root, 'unrelated', 'main', 'unrelated');
  const fork = committedPR(root, 1, 'fork', 'main', { isCrossRepository: true });
  sh(root, 'branch', '-D', 'fork');
  sh(root, 'update-ref', 'refs/heads/fork', hash(root, 'unrelated'));
  const gh = fixture(root, { prs: [fork] });
  const s = await stackFor(workspace(root, 'local-child', 'origin/main', gh));
  assert.deepEqual(numbers(s), [1, undefined]);
  assert.equal(s.items[0].checkout, undefined);
  assert.deepEqual(numbers(await stackFor(workspace(root, 'unrelated', 'origin/main', gh))), []);
});

test('GraphQL failure or a changed head leaves the known stack and adds no speculative child', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'current', 'parent', 'current');
  cut(root, 'child', 'current', 'child');
  const parent = committedPR(root, 1, 'parent');
  const current = committedPR(root, 2, 'current');
  const child = committedPR(root, 3, 'child');
  const bare = fetchedPR(root, current);
  for (const data of [{ prs: [parent, current, child], commitsError: true },
    { prs: [parent, current, { ...child, commitListHead: parent.headRefOid }] }]) {
    const gh = fixture(bare, { ...data, stacks: { 2: 'error' } }, current);
    const before = data.commitsError ? 0 : commitQueries(gh).length;
    assert.deepEqual(numbers(await stackFor(prWorkspace(bare, gh))), [1, 2]);
    assert.equal(commitQueries(gh).length - before, 1);
  }
  sh(bare, 'update-ref', 'refs/remotes/origin/parent', parent.headRefOid);
  const gh = fixture(bare, { prs: [parent, current, child], listError: true, settingsError: true, stacks: { 2: 'error' } }, current);
  t.mock.timers.tick(6 * 60000); // GitHub cannot be read, and nothing read of it before is recent enough to use
  const result = await stackFor(prWorkspace(bare, gh));
  assert.equal(order(result), 'parent / current*');
  assert.equal(result.items[0].pr, undefined);
});

test('a PR workspace finds tracking-only branches in both directions with no follow-up commit query', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'current', 'parent', 'current');
  cut(root, 'child', 'current', 'child');
  const current = committedPR(root, 1, 'current');
  const bare = fetchedPR(root, current);
  sh(root, 'push', '-q', bare, 'parent:refs/remotes/origin/parent', 'child:refs/remotes/origin/child');
  const gh = fixture(bare, { prs: [current], settingsError: true }, current);
  const result = await stackFor(prWorkspace(bare, gh));
  assert.equal(order(result), 'parent / current* / child');
  assert.deepEqual(result.items.map((i) => !!i.byCommits), [true, false, true]);
  assert.deepEqual(commitQueries(gh).filter((query) => query.includes('pullRequest(number:')), []);
});

test('diverged local and tracking copies of a PR child show one row for the local copy', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'remote-copy', 'parent', 'remote-child');
  sh(root, 'update-ref', 'refs/remotes/origin/child', 'remote-copy');
  cut(root, 'child', 'parent', 'local-child');
  sh(root, 'branch', '-D', 'remote-copy');
  const current = committedPR(root, 1, 'parent');
  const gh = fixture(root, { prs: [current] }, current);
  const ws = prWorkspace(root, gh);
  ws.meta.headFull = current.headRefOid;

  const result = await stackFor(ws);
  assert.equal(order(result), 'parent* / child');
  assert.equal(result.items[1].ref, 'refs/heads/child');
  assert.equal(result.items[1].checkout, root);
});

test('a tracking parent survives deduplication against its local copy above the current PR', async () => {
  const root = repo();
  cut(root, 'remote-copy', 'main', 'parent');
  sh(root, 'update-ref', 'refs/remotes/origin/topic', 'remote-copy');
  cut(root, 'current', 'origin/topic', 'current');
  cut(root, 'topic', 'current', 'child');
  sh(root, 'branch', '-D', 'remote-copy');
  const current = committedPR(root, 1, 'current', 'origin/topic', { baseRefName: 'topic' });
  const gh = fixture(root, { prs: [current] }, current);
  const ws = prWorkspace(root, gh);
  ws.meta.headFull = current.headRefOid;

  const result = await stackFor(ws);
  assert.equal(order(result), 'topic / current*');
  assert.equal(result.items[0].ref, 'refs/remotes/origin/topic');
  assert.equal(result.items[0].checkout, undefined);
});

test('an unfetched parent PR can sit closer than the nearest local branch', async () => {
  const root = repo();
  cut(root, 'base', 'main', 'base');
  cut(root, 'parent', 'base', 'parent');
  cut(root, 'child', 'parent', 'child');
  const parent = committedPR(root, 1, 'parent');
  sh(root, 'branch', '-D', 'parent');
  const gh = fixture(root, { prs: [parent] });
  const result = await stackFor(workspace(root, 'child', 'origin/main', gh));
  assert.equal(order(result), 'base / parent / child*');
  assert.deepEqual(numbers(result), [undefined, 1, undefined]);
});

test('the bottom of a declared base chain can have an implicit parent', async () => {
  const root = repo();
  cut(root, 'first', 'main', 'first');
  cut(root, 'parent', 'first', 'parent');
  cut(root, 'current', 'parent', 'current');
  const first = committedPR(root, 1, 'first');
  const parent = committedPR(root, 2, 'parent');
  const current = committedPR(root, 3, 'current', 'parent');
  const bare = fetchedPR(root, current, 'parent');
  const gh = fixture(bare, { prs: [first, parent, current] }, current);
  const result = await stackFor(prWorkspace(bare, gh));
  assert.deepEqual(numbers(result), [1, 2, 3]);
  assert.deepEqual(result.items.map((i) => !!i.byCommits), [true, false, false]);
});

test('a PR may carry this head while declaring a base on a different line', async () => {
  const root = repo();
  cut(root, 'current', 'main', 'current');
  cut(root, 'other-base', 'main', 'other-base');
  cut(root, 'child', 'current', 'child');
  const current = committedPR(root, 1, 'current');
  const other = committedPR(root, 2, 'other-base');
  const child = committedPR(root, 3, 'child', 'other-base');
  const bare = fetchedPR(root, current);
  const gh = fixture(bare, { prs: [current, other, child] }, current);
  assert.deepEqual(numbers(await stackFor(prWorkspace(bare, gh))), [1, 3]);
  const fromChild = await stackFor(prWorkspace(root, { ...gh, pr: child }));
  assert.deepEqual(numbers(fromChild), [2, 3]);
  assert.equal(fromChild.items[0].byCommits, undefined);
});

test('remote child discovery stops at 250 candidates while declared discovery and local head matching still work', async () => {
  const root = repo();
  cut(root, 'parent', 'main', 'parent');
  cut(root, 'current', 'parent', 'current');
  cut(root, 'first-child', 'current', 'first-child');
  cut(root, 'last-child', 'current', 'last-child');
  const parent = committedPR(root, 1, 'parent');
  const current = committedPR(root, 2, 'current');
  const first = committedPR(root, 3, 'first-child');
  const last = committedPR(root, 4, 'last-child');
  const noise = Array.from({ length: 250 }, (_, i) => pr(i + 100, 'noise-' + i, 'main', { headRefOid: (i + 16).toString(16).padStart(40, '0') }));
  const bare = fetchedPR(root, current);
  const gh = fixture(bare, { prs: [current, ...noise.slice(0, 55), first, ...noise.slice(55), parent, last] }, current);
  const result = await stackFor(prWorkspace(bare, gh));
  assert.deepEqual(numbers(result), [1, 2, 3]);
  const graphql = commitQueries(gh);
  assert.equal(graphql.length, 4);
  assert.match(graphql[0], /newest: pullRequests/);
  assert.deepEqual(graphql.slice(1).map((query) => [...query.matchAll(/pullRequest\(number:/g)].length).sort((a, b) => a - b), [4, 25, 25]);
});

function fourStack() {
  const root = repo();
  cut(root, 'feat/store', 'main', 'store');
  cut(root, 'feat/gc', 'feat/store', 'gc');
  cut(root, 'feat/serve', 'feat/gc', 'serve');
  cut(root, 'feat/serve-mac', 'feat/serve', 'mac');
  const prs = [
    committedPR(root, 101, 'feat/store'),
    committedPR(root, 102, 'feat/gc', 'feat/store'),
    committedPR(root, 103, 'feat/serve', 'feat/gc'),
    committedPR(root, 104, 'feat/serve-mac', 'feat/serve'),
  ];
  for (const p of prs) sh(root, 'update-ref', 'refs/remotes/origin/' + p.headRefName, p.headRefOid);
  const stacks = Object.fromEntries(prs.map((p) => [p.number, [{ number: 1, base: { ref: 'main' }, pull_requests: prs }]]));
  return { root, prs, stacks };
}

test('an ahead or rebased local PR branch still has just one row in the published stack', async () => {
  const { root, prs, stacks } = fourStack();
  checkout(root, 'feat/gc'); commit(root, 'unpushed');
  checkout(root, 'feat/serve');
  sh(root, 'reset', '-q', '--hard', 'feat/gc');
  commit(root, 'rewritten');
  assert.notEqual(hash(root, 'feat/gc'), prs[1].headRefOid);
  assert.notEqual(hash(root, 'feat/serve'), prs[2].headRefOid);
  const gh = fixture(root, { prs, stacks }, prs[0]);
  const result = await stackFor(workspace(root, 'feat/store', 'origin/main', gh));
  assert.equal(result.kind, 'github');
  assert.deepEqual(numbers(result), [101, 102, 103, 104]);
});

test('an alternate branch at the PR head is one row, and opening it marks the PR current', async () => {
  const { root, prs, stacks } = fourStack();
  const alternate = 'feat/serve-mac-copy';
  cut(root, alternate, 'feat/serve', 'old-local');
  sh(root, 'reset', '-q', '--hard', 'origin/feat/serve-mac');
  sh(root, 'branch', '-D', 'feat/serve-mac');
  fs.writeFileSync(path.join(root, 'dirty'), 'work in progress');
  assert.equal(hash(root, alternate), prs[3].headRefOid);
  const gh = fixture(root, { prs, stacks }, prs[0]);
  const fromBottom = await stackFor(workspace(root, 'feat/store', 'origin/main', gh));
  assert.deepEqual(numbers(fromBottom), [101, 102, 103, 104]);
  const fromAlias = await stackFor(workspace(root, alternate, 'origin/main', { ...gh, pr: null }));
  assert.equal(fromAlias.kind, 'github');
  assert.deepEqual(numbers(fromAlias), [101, 102, 103, 104]);
  assert.equal(fromAlias.items.find((row) => row.current)?.pr, 104);
});

test('a backup at a rewritten stack branch’s superseded tip is left out', async () => {
  const { root, prs, stacks } = fourStack();
  const branch = 'feat/serve', backup = 'backup/serve-before-rebase';
  checkout(root, branch); commit(root, 'old-serve');
  sh(root, 'branch', backup, hash(root));
  sh(root, 'reset', '-q', '--hard', 'feat/gc');
  commit(root, 'new-serve');
  assert.match(sh(root, 'reflog', 'show', '--format=%H', branch), new RegExp(hash(root, backup)));
  const gh = fixture(root, { prs, stacks }, prs[0]);
  assert.deepEqual(numbers(await stackFor(workspace(root, 'feat/store', 'origin/main', gh))), [101, 102, 103, 104]);
});

test('200 open PRs meet the cold and warm budgets with two-second GitHub calls', async (t) => {
  const root = repo();
  cut(root, 'current', 'main', 'current');
  cut(root, 'child', 'current', 'child');
  cut(root, 'noise', 'main', 'noise');
  const current = committedPR(root, 1, 'current'), child = committedPR(root, 2, 'child');
  const noise = Array.from({ length: 198 }, (_, i) => committedPR(root, i + 3, 'noise', 'main', { headRefName: 'noise-' + i }));
  const bare = fetchedPR(root, current);
  const prs = [current, ...noise, child];
  const gh = fixture(bare, { prs, delay: 2000 }, current);
  const ws = prWorkspace(bare, gh);
  Object.assign(ws.meta, { headFull: current.headRefOid, base: 'main', commits: current.commits });
  const started = performance.now();
  const result = await stackFor(ws);
  const cold = performance.now() - started;
  const coldCalls = calls(gh).length;
  const warmStarted = performance.now();
  assert.equal(await stackFor(ws), result);
  const warm = performance.now() - warmStarted;
  const warmCalls = calls(gh).length - coldCalls;
  t.diagnostic('Cold: ' + cold.toFixed(0) + ' ms, ' + coldCalls + ' fake gh calls. Warm: ' + warm.toFixed(0) + ' ms, ' + warmCalls + ' calls.');
  assert.deepEqual(numbers(result), [1, 2]);
  assert.ok(cold <= 2500, 'cold read took ' + cold.toFixed(0) + ' ms');
  assert.ok(warm <= 500, 'warm read took ' + warm.toFixed(0) + ' ms');
  assert.ok(coldCalls <= 6, 'cold read made ' + coldCalls + ' calls');
  assert.equal(warmCalls, 0);
  assert.equal(commitQueries(gh).length, 1);
  assert.equal(calls(gh).filter((args) => args.includes('merged')).length, 1);
});

test('a refresh requests only unseen PR heads, in parallel batches, and reuses their histories afterward', async (t) => {
  const root = repo();
  cut(root, 'current', 'main', 'current');
  cut(root, 'child', 'current', 'child');
  cut(root, 'noise', 'main', 'noise');
  const current = committedPR(root, 1, 'current'), child = committedPR(root, 2, 'child');
  const noise = Array.from({ length: 26 }, (_, i) => ({ ...child, number: i + 3, headRefName: 'noise-' + i,
    headRefOid: hash(root, 'noise'), commits: [hash(root, 'noise')] }));
  const bare = fetchedPR(root, current);
  const gh = fixture(bare, { prs: [current, child, ...noise] }, current);
  const ws = prWorkspace(bare, gh);
  assert.deepEqual(numbers(await stackFor(ws)), [1, 2]);
  const changed = [current, child, ...noise.map((p) => ({ ...p, headRefOid: child.headRefOid, commits: child.commits }))];
  fixture(bare, { prs: changed, graphqlDelay: 1000 }, current);
  const started = performance.now();
  const result = await stackFor(ws, { fresh: true });
  const elapsed = performance.now() - started;
  t.diagnostic('Changed heads: ' + elapsed.toFixed(0) + ' ms for two 1-second alias calls.');
  assert.ok(elapsed < 1900, 'alias batches took ' + elapsed.toFixed(0) + ' ms');
  assert.deepEqual(numbers(result), changed.map((p) => p.number));
  const batches = commitQueries(gh).slice(1).map((query) => [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1])));
  assert.deepEqual(batches.map((batch) => batch.length).sort((a, b) => a - b), [1, 25]);
  assert.deepEqual(batches.flat().sort((a, b) => a - b), noise.map((p) => p.number));
  assert.deepEqual(numbers(await stackFor(ws, { fresh: true })), numbers(result));
  assert.equal(commitQueries(gh).length, 3);
});
