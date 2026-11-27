import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { attemptFileNotes, eligibleForNotes, fileNoteKey, filesNeedingNotes, resetNotesAttempt, NOTES_VERSION } from '../web/js/file-notes.js';

const home = process.env.LOUPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-notes-'));
const { normalizeNotes, notes } = await import('../src/claude.mjs');
const { Workspace, contentKey } = await import('../src/workspaces.mjs');
const { DEFAULTS } = await import('../src/config.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const file = (path, rest) => ({ path, kind: 'code', added: 1, deleted: 0, blob: 'new', oldBlob: 'old', ...rest });

test('file notes accept code with a text diff and exclude generated, binary, lock, vendor and snapshot files', () => {
  assert.equal(eligibleForNotes(file('src/client.js')), true);
  for (const f of [
    file('src/client.js', { kind: 'generated' }), file('logo.png', { binary: true }),
    file('client.js', { added: 0 }), file('nested/package-lock.json'), file('bun.lockb'), file('go.work.sum'),
    file('nested/vendor/client.js'), file('third_party/client.js'), file('nested/node_modules/client.js'),
    file('nested/__snapshots__/client.js'), file('client.snap'), file('client.js', { oldPath: 'vendor/client.js' }),
  ]) assert.equal(eligibleForNotes(f), false, f.path);
  assert.equal(eligibleForNotes(file('deleted.js', { added: 0, deleted: 1 })), true);
});

test('only changed and missing keys need notes again, including changes on the old side', () => {
  const files = ['same', 'new-side', 'old-side', 'missing', 'omitted'].map((p) => file(p));
  const saved = {
    same: { key: fileNoteKey(files[0]), note: 'Keep.' },
    'new-side': { key: fileNoteKey({ ...files[1], blob: 'previous' }), note: 'Stale.' },
    'old-side': { key: fileNoteKey({ ...files[2], oldBlob: 'previous' }), note: 'Stale.' },
    omitted: { key: fileNoteKey(files[4]), note: null },
  };
  assert.deepEqual(filesNeedingNotes(files, saved).map((f) => f.path), ['new-side', 'old-side', 'missing']);
  assert.deepEqual(filesNeedingNotes(files, saved, true), files);
});

test('file note normalization keeps the first valid note and records omissions for the current key', () => {
  const files = ['one', 'two', 'three', 'four', '__proto__'].map((p) => file(p));
  const notes = normalizeNotes({ notes: [
    { path: 'a/one', note: 'Unknown.' },
    { path: 'unknown', note: 'Unknown.' },
    { path: 'one', note: '  This file\n routes   requests.  ' },
    { path: 'one', note: 'Duplicate.' },
    { path: 'two', note: 'This file…' },
    { path: 'three', note: '    ' },
    { path: 'four', note: 'x'.repeat(320) },
    { path: '__proto__', note: 'The file is the retry loop.' },
  ] }, files);
  assert.deepEqual(Object.keys(notes), files.map((f) => f.path));
  assert.equal(notes.one.note, 'Routes requests.');
  assert.equal(notes.two.note, null);
  assert.equal(notes.three.note, null);
  assert.equal(notes.four.note, 'x'.repeat(300));
  assert.equal(notes.__proto__.note, 'The retry loop.');
  assert.equal(notes.one.key, 'one::new:old');
});

test('eligibility shares generated path and diff text exclusions', () => {
  for (const path of [
    'runtimeClasspath.lockfile', 'src/third-party/vendor.ts', 'src/third_party/vendor.ts',
    'src/generated/client.ts', 'gen/client.ts', 'src/__generated__/client.ts',
    'bundle.min.js', 'bundle.min.css', 'client.pb.go', 'client_pb2.py', 'client.g.dart', 'Client.designer.cs',
  ]) assert.equal(eligibleForNotes(file(path)), false, path);
  assert.equal(eligibleForNotes(file('src/client.ts'), [{ context: '', lines: [{ s: 'bad \uFFFD byte' }] }]), false);
  assert.equal(eligibleForNotes(file('src/client.ts'), [{ context: 'bad \uFFFD header', lines: [] }]), false);
  assert.equal(eligibleForNotes(file('src/generator/client.ts')), true);
});

test('a different rename source invalidates notes even when the blobs match', () => {
  const current = file('client.ts', { oldPath: 'compat/client.ts' });
  const old = { key: fileNoteKey({ ...current, oldPath: 'legacy/client.ts' }), note: 'Moved from legacy.' };
  assert.deepEqual(filesNeedingNotes([current], { 'client.ts': old }), [current]);
});

test('automatic notes only latch an accepted request and ignore acknowledgements after a reset', async () => {
  const change = {};
  await attemptFileNotes(change, async () => undefined);
  assert.equal(change.attempted, false);
  assert.equal(await attemptFileNotes(change, async () => ({ started: false, retryAt: 123 })), 123);
  assert.equal(change.attempted, false);
  const response = Promise.withResolvers();
  const attempt = attemptFileNotes(change, () => response.promise);
  resetNotesAttempt(change);
  response.resolve({ started: true });
  await attempt;
  assert.equal(change.attempted, false);
  await attemptFileNotes(change, async () => ({ started: true }));
  assert.equal(change.attempted, true);
  resetNotesAttempt(change);
  assert.equal(change.attempted, false);
});

function checkout(id) {
  const root = fs.mkdtempSync(path.join(home, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: root }).toString().trim();
  const write = (file, bytes) => fs.writeFileSync(path.join(root, file), bytes);
  const open = (base) => {
    const ws = new Workspace({ id, kind: 'local', root });
    ws.meta = { branch: 'main', base: 'HEAD', headFull: base, mergeBaseFull: base };
    return ws;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('commit', '-qm', 'base', '--allow-empty');
  return { root, git, write, open, base: git('rev-parse', 'HEAD') };
}

function watchNotes(ws, check) {
  const done = Promise.withResolvers();
  ws.emit = (name, state) => {
    if (name === 'notes' && check(state)) setImmediate(() => done.resolve(state));
  };
  return done.promise;
}

const answered = (notes = []) => ({ out: { notes }, cost: 0, ms: 0 });
const pathsIn = (schema) => schema.properties.notes.items.properties.path.enum;

test('a model answer saves only files that still have the prompted key', { timeout: 10000 }, async () => {
  const repo = checkout('changed-during-answer');
  repo.write('changed.ts', 'before answer\n');
  repo.write('stable.ts', 'stable input\n');
  const ws = repo.open(repo.base);
  await ws.files(); // Seed the UI cache. The model will edit without bumping the watcher version.
  const done = watchNotes(ws, (state) => !state.pending);
  let prompt;
  assert.deepEqual(await notes(ws, {}, async (_, __, ___, text) => {
    prompt = text;
    repo.write('changed.ts', 'after answer\n');
    return answered([{ path: 'changed.ts', note: 'Stale.' }, { path: 'stable.ts', note: 'Stable.' }]);
  }), { started: true });
  const state = await done;
  assert.match(prompt, /\+before answer/);
  assert.equal(state.error, null);
  assert.deepEqual(Object.keys(state.files), ['stable.ts']);
  assert.equal(state.files['stable.ts'].note, 'Stable.');
});

test('empty and invalid UTF-8 patches never reach the model or become omissions', { timeout: 10000 }, async () => {
  const repo = checkout('empty-patches');
  repo.git('config', 'diff.submodule', 'log');
  repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.base},submodule`);
  repo.write('invalid.dat', Buffer.from([0xff, 0x0a]));
  repo.write('untracked.dat', Buffer.from([0xff, 0x0a]));
  repo.write('asked.ts', 'valid text\n');
  const local = await repo.open(repo.base).files();
  assert.equal(eligibleForNotes(local.find((f) => f.path === 'untracked.dat')), false);
  repo.git('add', 'asked.ts', 'invalid.dat');
  repo.git('commit', '-qm', 'changes with an empty patch');
  const ws = new Workspace({ id: 'empty-patches-pr', kind: 'pr', clone: repo.root });
  ws.meta = { headFull: repo.git('rev-parse', 'HEAD'), mergeBaseFull: repo.base };
  const files = await ws.files();
  assert.equal(eligibleForNotes(files.find((f) => f.path === 'submodule')), true);
  assert.equal(eligibleForNotes(files.find((f) => f.path === 'invalid.dat')), true);
  const seen = [];
  const done = watchNotes(ws, (state) => !state.pending);
  await notes(ws, {}, async (_, __, ___, ____, schema) => {
    seen.push(...pathsIn(schema));
    return answered();
  });
  const state = await done;
  assert.equal(state.error, null);
  assert.deepEqual(seen, ['asked.ts']);
  assert.deepEqual(Object.keys(state.files), ['asked.ts']);
  assert.equal(state.files['asked.ts'].note, null);
});

test('automatic requests report whether they started and retry failures after ten minutes', { timeout: 10000 }, async (t) => {
  const repo = checkout('failure-gate');
  repo.write('a.ts', 'test\n');
  const ws = repo.open(repo.base);
  const expectedKey = contentKey(await ws.files());
  assert.deepEqual(await notes(ws, { expectedKey: 'obsolete' }), { started: false });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const failed = watchNotes(ws, (state) => !state.pending);
  assert.deepEqual(await notes(ws, { expectedKey }, async () => { throw new Error('Transient failure'); }), { started: true });
  assert.equal((await failed).error, 'Transient failure');
  const retryAt = now + 600000;
  now = retryAt - 1;
  assert.deepEqual(await notes(ws, { expectedKey }), { started: false, retryAt });
  now = retryAt;
  const recovered = watchNotes(ws, (state) => !state.pending);
  assert.deepEqual(await notes(ws, { expectedKey }, async () => answered()), { started: true });
  assert.equal((await recovered).error, null);
  assert.deepEqual(await notes(ws, { expectedKey }), { started: false });
});

test('a batch that keeps failing is asked again after ten minutes, then an hour, then not by itself, a restart included', { timeout: 10000 }, async (t) => {
  const repo = checkout('failure-backoff');
  repo.write('a.ts', 'test\n');
  let ws = repo.open(repo.base);
  const expectedKey = contentKey(await ws.files());
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const fail = async () => { throw new Error('error max turns'); };
  const failOnce = async () => { const done = watchNotes(ws, (state) => !state.pending); assert.deepEqual(await notes(ws, { expectedKey }, fail), { started: true }); await done; };
  await failOnce();
  assert.deepEqual(await notes(ws, { expectedKey }), { started: false, retryAt: now + 600000 });
  now += 600000;
  await failOnce();
  assert.deepEqual(await notes(ws, { expectedKey }), { started: false, retryAt: now + 3600000 });
  now += 3600000;
  await failOnce();
  assert.deepEqual(await notes(ws, { expectedKey }), { started: false }, 'a third failure is not asked again by itself');
  ws.review.flush();
  ws = repo.open(repo.base); // loupe restarted
  now += 24 * 3600000;
  assert.deepEqual(await notes(ws, { expectedKey }), { started: false });
  const asked = watchNotes(ws, (state) => !state.pending);
  assert.deepEqual(await notes(ws, {}, async () => answered()), { started: true }, 'Write notes still asks');
  assert.equal((await asked).error, null);
});

test('each change keeps its own count of failed batches, and one from an older notes version does not count', { timeout: 10000 }, async (t) => {
  const repo = checkout('failure-per-key');
  repo.write('a.ts', 'one\n');
  const ws = repo.open(repo.base);
  const keyA = contentKey(await ws.files('all', { fresh: true }));
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const fail = async () => { throw new Error('error max turns'); };
  const failOnce = async (key) => { const done = watchNotes(ws, (state) => !state.pending); assert.deepEqual(await notes(ws, { expectedKey: key }, fail), { started: true }); await done; };
  for (let i = 0; i < 3; i++) { await failOnce(keyA); now += 2 * 3600000; }
  assert.deepEqual(await notes(ws, { expectedKey: keyA }), { started: false });
  repo.write('a.ts', 'two\n'); // another branch, say
  const keyB = contentKey(await ws.files('all', { fresh: true }));
  await failOnce(keyB);
  repo.write('a.ts', 'one\n'); // and back
  assert.deepEqual(await notes(ws, { expectedKey: keyA }), { started: false }, 'the other change’s failure reset this one’s');
  ws.review.data.notesFailures[keyA].v = NOTES_VERSION - 1; // the notes' version moved on since
  const asked = watchNotes(ws, (state) => !state.pending);
  assert.deepEqual(await notes(ws, { expectedKey: keyA }, async () => answered()), { started: true });
  assert.equal((await asked).error, null);
});

test('an active notes run queues model changes and Write again, keeping only the latest', { timeout: 10000 }, async () => {
  const repo = checkout('notes-queue');
  repo.write('a.ts', 'test\n');
  const ws = repo.open(repo.base);
  const first = Promise.withResolvers();
  const seen = [];
  const request = async (_, run) => {
    seen.push(run.model);
    if (seen.length === 1) await first.promise;
    return answered();
  };
  const done = watchNotes(ws, (state) => !state.pending && state.model === 'gpt-6.2-sol');
  assert.deepEqual(await notes(ws, {}, request), { started: true });
  assert.deepEqual(await notes(ws, {}, request), { started: false });
  assert.deepEqual(await notes(ws, { again: true }, request), { started: true, queued: true });
  assert.deepEqual(await notes(ws, { model: 'gpt-6.2-sol' }, request), { started: true, queued: true });
  first.resolve();
  assert.equal((await done).error, null);
  assert.deepEqual(seen, [DEFAULTS.notesModel, 'gpt-6.2-sol']);
});

test('restarting after a saved batch asks only for missing files and preserves omissions', { timeout: 10000 }, async () => {
  const repo = checkout('notes-restart');
  for (let i = 0; i < 41; i++) repo.write(`file-${String(i).padStart(2, '0')}.ts`, 'test\n');
  const ws = repo.open(repo.base);
  const expectedKey = contentKey(await ws.files());
  const held = Promise.withResolvers();
  const checkpoint = Promise.withResolvers();
  const ended = Promise.withResolvers();
  ws.emit = (event, state) => {
    if (event !== 'notes') return;
    if (state.pending && Object.keys(state.files).length === 40) checkpoint.resolve(fs.readFileSync(ws.review.file));
    if (!state.pending) setImmediate(ended.resolve);
  };
  await notes(ws, { expectedKey }, async (_, __, ___, ____, schema) => {
    const files = pathsIn(schema);
    if (files.length === 40) return answered([{ path: files[0], note: 'Saved.' }]);
    await held.promise;
    throw new Error('Interrupted');
  });
  const saved = await checkpoint.promise;
  held.resolve();
  await ended.promise;
  // Restore the last on-disk state before interruption, as a new daemon would see it.
  fs.writeFileSync(ws.review.file, saved);
  const restarted = repo.open(repo.base);
  assert.equal(restarted.review.data.notes.pending, false);
  assert.match(restarted.review.data.notes.error, /restarted/);
  const seen = [];
  const done = watchNotes(restarted, (state) => !state.pending);
  assert.deepEqual(await notes(restarted, { expectedKey }, async (_, __, ___, ____, schema) => {
    seen.push(...pathsIn(schema));
    return answered();
  }), { started: true });
  const state = await done;
  assert.deepEqual(seen, ['file-40.ts']);
  assert.equal(Object.keys(state.files).length, 41);
  assert.equal(state.files['file-00.ts'].note, 'Saved.');
  assert.equal(state.files['file-01.ts'].note, null);
});

test('the change fingerprint keeps its formula, so briefs written before still match', async () => {
  const { contentKey } = await import('../src/workspaces.mjs');
  const crypto = await import('node:crypto');
  const files = [{ path: 'a.go', oldPath: 'old/a.go', blob: 'b1', oldBlob: 'o1' }, { path: 'b.go', blob: 'b2', oldBlob: null }];
  const want = crypto.createHash('sha1').update('a.go:b1:o1\nb.go:b2:null').digest('hex').slice(0, 16);
  assert.equal(contentKey(files), want);
});

test('notes from an older prompt count as unwritten, so they are written again', async () => {
  const { currentNotes } = await import('../web/js/file-notes.js');
  const old = { key: 'a.go::b:o', note: 'old words' }, fresh = { key: 'b.go::b:o', note: 'new words', v: NOTES_VERSION };
  // per note: a run cut short leaves the notes it did not reach marked old
  assert.deepEqual(currentNotes({ files: { 'a.go': old, 'b.go': fresh } }), { 'b.go': fresh });
  assert.deepEqual(currentNotes({ files: { 'a.go': { ...old, v: NOTES_VERSION - 1 } } }), {});
  assert.deepEqual(filesNeedingNotes([file('a.go')], currentNotes({ files: { 'a.go': old } })).map((f) => f.path), ['a.go']);
  assert.equal(normalizeNotes({ notes: [] }, [file('c.go')])['c.go'].v, NOTES_VERSION);
});
