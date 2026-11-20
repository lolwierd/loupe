// The change as git describes it, on a scratch repository: committed, uncommitted, untracked, deleted, renamed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.LOUPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-'));
const { changedFiles, fileHunks, WORKTREE } = await import('../src/git.mjs');
const { serial } = await import('../src/util.mjs');
const { viewKey } = await import('../src/workspaces.mjs');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-repo-'));
const g = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
g('init', '-q', '-b', 'main');
w('a.go', 'package a\n\nfunc A() {}\n');
w('gone.txt', 'bye\n');
w('old/name.txt', 'one\ntwo\nthree\nfour\nfive\n');
g('add', '.'); g('commit', '-qm', 'base');
const base = g('rev-parse', 'HEAD').trim();
g('switch', '-qc', 'feature');
w('a.go', 'package a\n\nfunc A() {}\n\nfunc B() {}\n');
g('commit', '-qam', 'add B');
// uncommitted: an edit, a deletion, a rename, an untracked file, and a name with a tab in it
w('a.go', 'package a\n\nfunc A() { println("x") }\n\nfunc B() {}\n');
fs.rmSync(path.join(repo, 'gone.txt'));
fs.mkdirSync(path.join(repo, 'new')); g('mv', 'old/name.txt', 'new/name.txt');
w('fresh.md', '# new\nline\n');
w('odd\tname.txt', 'tab\n');

test('the branch plus uncommitted work: every kind of change, with counts and content keys', async () => {
  const files = await changedFiles(repo, { old: base, new: WORKTREE });
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(by['a.go'].status, 'M'); assert.equal(by['a.go'].added, 3); assert.equal(by['a.go'].deleted, 1);
  assert.equal(by['gone.txt'].status, 'D'); assert.equal(by['gone.txt'].deleted, 1);
  assert.equal(by['new/name.txt'].status, 'R'); assert.equal(by['new/name.txt'].oldPath, 'old/name.txt');
  assert.equal(by['fresh.md'].untracked, true); assert.equal(by['fresh.md'].added, 2);
  assert.equal(by['odd\tname.txt'].added, 1, 'a tab in a file name keeps its counts');
  for (const f of files) if (f.status !== 'D') assert.match(f.blob || '', /^[0-9a-f]{40}$/, `${f.path} has a content key`);
  const h = await fileHunks(repo, { old: base, new: WORKTREE }, by['fresh.md']);
  assert.deepEqual(h[0].lines.map((l) => l.t + l.s), ['+# new', '+line']);
});
test('viewed is keyed to the diff: the uncommitted part and the whole branch differ', async () => {
  const all = (await changedFiles(repo, { old: base, new: WORKTREE })).find((f) => f.path === 'a.go');
  const head = g('rev-parse', 'HEAD').trim();
  const wip = (await changedFiles(repo, { old: head, new: WORKTREE })).find((f) => f.path === 'a.go');
  assert.equal(all.blob, wip.blob);
  assert.notEqual(viewKey(all), viewKey(wip));
});
test('serial: a call during a run gets a fresh run, not the stale one', async () => {
  const once = serial();
  let base = 'main', seen = [];
  const sync = () => once('sync', async () => { const b = base; await new Promise((r) => setTimeout(r, 20)); seen.push(b); return b; });
  const first = sync();
  await new Promise((r) => setTimeout(r, 5)); // the first run has read its base
  base = 'other';
  const second = sync(), third = sync();
  assert.equal(await first, 'main');
  assert.equal(await second, 'other');
  assert.equal(await third, 'other');
  assert.deepEqual(seen, ['main', 'other']);
});

test('an empty untracked file has no added lines or hunks', async () => {
  w('empty.txt', '');
  const range = { old: base, new: WORKTREE };
  const f = (await changedFiles(repo, range)).find((f) => f.path === 'empty.txt');
  assert.equal(f.added, 0);
  assert.deepEqual(await fileHunks(repo, range, f), []);
});
