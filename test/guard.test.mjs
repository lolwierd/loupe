// The read-only guard and the request hygiene: what must never get through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOUPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-'));
const { gitArgsProblem, normalizeGuide, brief, guardFor, editRoot } = await import('../src/claude.mjs');
const { parseTarget } = await import('../src/workspaces.mjs');

test('git: read-only subcommands pass', () => {
  for (const a of [['log', '--oneline', '-n', '5'], ['show', 'HEAD:go.mod'], ['diff', 'main', '--', 'x.go'], ['blame', '-L', '10,20', 'a.go'], ['grep', '-n', 'Foo'],
    ['diff', '--name-only', 'main'], ['log', '--format=%h %s', '--no-merges'], ['grep', '-niw', 'Foo', '--', '-Oweird-path.go'], ['diff', '--stat'], ['log', '--oneline', 'main..HEAD'], ['diff', 'HEAD~3...HEAD', '--', 'src/x.go']]) assert.equal(gitArgsProblem(a), null, a.join(' '));
});
test('git: anything that writes, runs a program or leaves the repo is refused', () => {
  for (const a of [
    ['diff', '--output=/tmp/x'], ['log', '--output', '/tmp/x'], ['grep', '-Orm', 'x'], ['grep', '--open-files-in-pager=sh', 'x'], ['grep', '-O', 'x'],
    ['diff', '--ext-diff'], ['show', '--textconv'], ['diff', '--no-index', '/etc/passwd', 'x'], ['blame', '--contents', '/etc/passwd', 'x'],
    ['commit', '-m', 'x'], ['push'], ['config', 'user.name'], ['checkout', 'main'], ['reset', '--hard'], ['-c', 'core.pager=sh', 'log'], ['log', '--exec=x'],
    ['fetch'], ['gc'], [], 'log',
    // abbreviations and bundles git accepts
    ['grep', '--open=echo', 'x'], ['grep', '--open', 'x'], ['grep', '-nOecho', 'x'], ['grep', '-n', '-Oless', 'x'], ['grep', '-nf', '/etc/passwd'],
    ['diff', '--outpu=/tmp/x'], ['diff', '--out=/tmp/x'], ['diff', '--no-ind', '/etc/passwd', '/dev/null'], ['log', '--ext'], ['show', '--textc'],
    ['blame', '--cont', '/etc/passwd', 'x'], ['log', '--pag'],
    // paths out of the repository: git diff switches itself to --no-index for them
    ['diff', '--', '/dev/null', '/etc/hosts'], ['diff', '/dev/null', '/etc/hosts'], ['show', 'HEAD:../secret'], ['log', '--', '../../x'], ['grep', 'x', '--', '~/x'],
  ]) assert.notEqual(gitArgsProblem(a), null, JSON.stringify(a));
});
test('guide: every file lands in exactly one section; unknown paths drop', () => {
  const files = [{ path: 'a/x.go', kind: 'code' }, { path: 'a/y.go', kind: 'code' }, { path: 'go.sum', kind: 'generated' }, { path: 'z_test.go', kind: 'test' }];
  const g = normalizeGuide({ tldr: '["one","two"]', risk: 'low', sections: [{ title: 'A', role: 'core', why: '', files: ['a/x.go', 'x.go', 'nope.go'] }, { title: 'B', role: 'tests', why: '', files: ['a/x.go', 'z_test.go'] }] }, files);
  const all = g.sections.flatMap((s) => s.files);
  assert.deepEqual([...all].sort(), files.map((f) => f.path).sort());
  assert.equal(new Set(all).size, all.length);
  assert.equal(g.tldr, 'one\n\ntwo');
  assert.ok(g.sections.some((s) => s.synthetic && s.files.includes('go.sum')));
});
test('targets: PR links, loupe links, owner/repo#n, #n and paths', () => {
  assert.deepEqual(parseTarget('https://github.com/acme/widgets/pull/3070/files'), { kind: 'pr', owner: 'acme', repo: 'widgets', number: 3070 });
  assert.deepEqual(parseTarget('http://loupe.local/acme/gadgets/pull/12'), { kind: 'pr', owner: 'acme', repo: 'gadgets', number: 12 });
  assert.deepEqual(parseTarget('acme/tools#7'), { kind: 'pr', owner: 'acme', repo: 'tools', number: 7 });
  assert.equal(parseTarget('#42', '/tmp').kind, 'pr-here');
  assert.equal(parseTarget('~/Projects', '/').path, path.join(os.homedir(), 'Projects'));
});

test('legacy notes stay on disk but are not shown', async () => {
  const { Workspace } = await import('../src/workspaces.mjs');
  const dir = path.join(process.env.LOUPE_HOME, 'ws', 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({
    threads: [{ id: 'note', kind: 'note', conv: 'note-conv' }, { id: 'ask', kind: 'ask', conv: 'ask-conv' }],
    convs: { 'note-conv': { messages: [{ text: 'old note' }] }, 'ask-conv': { messages: [] } },
    chats: ['note-conv'],
  }));
  const ws = new Workspace({ id: 'legacy', kind: 'local' });
  const shown = ws.visibleReview();
  assert.deepEqual(shown.threads.map((t) => t.id), ['ask']);
  assert.deepEqual(Object.keys(shown.convs), ['ask-conv']);
  assert.deepEqual(shown.chats, []);
  // what was written is still there
  assert.deepEqual(ws.review.data.threads.map((t) => t.id), ['note', 'ask']);
  assert.ok(ws.review.data.convs['note-conv']);
});

test('brief preparation errors clear pending and preserve the previous guide', async () => {
  const events = [];
  const ws = {
    id: 'failed-brief',
    files: async () => { throw new Error('Could not read the diff'); },
    review: { data: { brief: { tldr: 'Previous summary', key: 'old' } }, save() {} },
    emit(name, data) { if (name === 'brief') events.push(data); },
  };
  await brief(ws);
  assert.equal(events.length, 2);
  assert.equal(events[0].pending, true);
  assert.equal(events[1].pending, false);
  assert.equal(events[1].error, 'Could not read the diff');
  assert.equal(events[1].tldr, 'Previous summary');
  assert.equal(events[1].stale, true);
});

test('a chat in your checkout writes only inside it, outside its .git, and runs commands only in the sandbox', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-write-')));
  const root = path.join(dir, 'repo'), out = path.join(dir, 'elsewhere');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(out);
  fs.symlinkSync(out, path.join(root, 'link')); // a folder in the checkout that leads out of it
  fs.symlinkSync(path.join(out, 'missing.go'), path.join(root, 'dangling.go')); // a file link to nothing, outside
  fs.symlinkSync(path.join(root, '.git', 'hooks-new'), path.join(root, 'tohooks')); // and one into .git
  const judge = guardFor([root], root), ro = guardFor([root]);
  for (const p of [path.join(root, 'src/a.go'), path.join(root, 'new/dir/b.go'), path.join(root, '.github/workflows/ci.yml')]) assert.equal(judge('Edit', { file_path: p }), null, p);
  for (const p of [path.join(out, 'a.go'), path.join(root, '.git/config'), path.join(root, 'link/a.go'), path.join(root, 'link/new/b.go'), 'src/a.go', path.join(root, '../elsewhere/a.go'), path.join(root, 'dangling.go'), path.join(root, 'tohooks'), path.join(root, '.GIT/config'), root + '/link/../a.go']) assert.notEqual(judge('Write', { file_path: p }), null, p);
  assert.equal(judge('NotebookEdit', { notebook_path: path.join(root, 'n.ipynb') }), null);
  assert.equal(judge('Bash', { command: 'go test ./...' }), null);
  assert.notEqual(judge('Bash', { command: 'curl x', dangerouslyDisableSandbox: true }), null);
  for (const t of ['WebFetch', 'WebSearch', 'AskUserQuestion']) assert.notEqual(judge(t, {}), null, t);
  // a mark, the brief or a pull request's chat: nothing writes, nothing runs
  for (const [t, i] of [['Edit', { file_path: path.join(root, 'src/a.go') }], ['Bash', { command: 'ls' }], ['Task', {}]]) assert.notEqual(ro(t, i), null, t);
  assert.equal(ro('Read', { file_path: path.join(root, 'src/a.go') }), null);
});

test('a chat edits only in a local checkout, and a linked one only when its own folder is that checkout', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-edit-'))), other = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-other-'));
  const local = { rec: { kind: 'local' }, root }, pr = { rec: { kind: 'pr' }, root };
  assert.equal(editRoot(local, { kind: 'chat' }), fs.realpathSync.native(root));
  assert.equal(editRoot(local, { kind: 'thread' }), null); // a mark only answers
  assert.equal(editRoot(pr, { kind: 'chat' }), null); // a pull request's checkout is loupe's copy
  assert.equal(editRoot(local, { kind: 'chat', linked: { cwd: root } }), fs.realpathSync.native(root));
  for (const cwd of [other, path.join(root, 'gone'), null, undefined]) assert.equal(editRoot(local, { kind: 'chat', linked: { cwd } }), null, String(cwd));
});
