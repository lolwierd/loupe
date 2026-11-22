// Stacks of local branches, judged on real git repositories: what is under a branch and what is built on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

process.env.LOUPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-stack-home-'));
const { stackFor } = await import('../src/stacks.mjs');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const commit = (cwd, name) => { fs.writeFileSync(path.join(cwd, name), name); sh(cwd, 'add', name); sh(cwd, 'commit', '-q', '-m', name); };
// a clone whose origin/main is two commits ahead of the first one
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-stack-')));
  const up = path.join(dir, 'up'), root = path.join(dir, 'work');
  fs.mkdirSync(up); sh(up, 'init', '-q', '-b', 'main'); commit(up, 'a'); commit(up, 'b'); commit(up, 'c');
  sh(dir, 'clone', '-q', up, root);
  return root;
}
const stack = async (root, branch) => {
  sh(root, 'checkout', '-q', branch);
  const ws = { id: root + ':' + branch, github: null, gitDir: root, rec: { kind: 'local', root }, meta: { branch, trunk: 'origin/main', base: 'origin/main' } };
  const s = await stackFor(ws, { fresh: true });
  return s.kind === 'none' ? 'none' : s.items.map((i) => i.branch + (i.current ? '*' : '')).join(' / ');
};

test('branches with nothing of their own off the trunk are no stack, from either side', async () => {
  const root = repo();
  sh(root, 'branch', 'one', 'origin/main'); sh(root, 'branch', 'two', 'origin/main');
  sh(root, 'branch', 'old', 'origin/main~2'); // on an old trunk commit: every later branch contains it
  commit(root, 'x'); // main moves on locally too
  assert.equal(await stack(root, 'one'), 'none');
  assert.equal(await stack(root, 'two'), 'none');
  assert.equal(await stack(root, 'old'), 'none');
});

test('a branch cut from a branch with work is its child, and the parent shows it', async () => {
  const root = repo();
  sh(root, 'checkout', '-q', '-b', 'feat', 'origin/main'); commit(root, 'f1');
  sh(root, 'checkout', '-q', '-b', 'feat2', 'feat'); commit(root, 'f2');
  assert.equal(await stack(root, 'feat2'), 'feat / feat2*');
  assert.equal(await stack(root, 'feat'), 'feat* / feat2');
});
