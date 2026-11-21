import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-codex-'));
const root = path.join(fs.realpathSync(temp), 'repo');
const callsFile = path.join(temp, 'calls.jsonl');
const threadId = '00000000-0000-4000-8000-000000000001';
let daemon, url, workspace, daemonLog = '';

const fake = `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const schemaAt = argv.indexOf('--output-schema');
const schema = schemaAt < 0 ? null : JSON.parse(fs.readFileSync(argv[schemaAt + 1], 'utf8'));
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({ argv, stdin, schema }) + '\\n');
const emit = (type, fields = {}) => console.log(JSON.stringify({ type, ...fields }));
const msg = (type, text) => emit(type, { item: { id: 'answer', type: 'agent_message', text } });
const done = () => emit('turn.completed', { usage: { input_tokens: 23, cached_input_tokens: 3, output_tokens: 7 } });
emit('thread.started', { thread_id: '${threadId}' });
emit('turn.started');
if (stdin.trimEnd().endsWith('simulate turn failure')) {
  emit('turn.failed', { error: { message: 'fake model failure' } });
} else if (stdin.trimEnd().endsWith('simulate truncated stream')) {
  msg('item.updated', 'Unfinished');
} else if (schema) {
  // a value for every field of a strict schema, so the brief parses however its schema grows
  const fill = (s) => s.type === 'object' ? Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, fill(v)])) : s.type === 'array' ? [fill(s.items)] : s.enum ? s.enum[0] : s.type === 'integer' || s.type === 'number' ? (s.minimum ?? 0) : s.type === 'boolean' ? false : '';
  const out = schema.properties.tldr
    ? { ...fill(schema), tldr: 'Adds a check.', risk: 'low', riskWhy: 'Local only.', citations: [{ ref: 'file.txt:1', excerpt: 'new' }], plan: { ...fill(schema.properties.plan), start: 'file.txt' }, sections: [
        { ...fill(schema.properties.sections.items), title: 'Check', role: 'core', why: 'Read it.', check: ['Check it.'], files: ['file.txt', 'made-up.txt'] },
      ] }
    : stdin.includes('Write the pull request')
      ? { title: 'Add a check', body: 'Checks the value.' }
      : { subject: 'Add a check', body: '' };
  if (fs.existsSync(process.env.FAKE_CODEX_CALLS + '.invalid')) delete out.subject;
  msg('item.completed', JSON.stringify(out));
  if (!fs.existsSync(process.env.FAKE_CODEX_CALLS + '.truncated')) done();
} else {
  const item = { id: 'cmd', type: 'command_execution', command: 'git diff', aggregated_output: '', status: 'in_progress' };
  emit('item.started', { item });
  emit('item.completed', { item: { ...item, status: 'completed' } });
  msg('item.updated', 'Partial');
  setTimeout(() => {
    msg('item.completed', argv.includes('resume') ? 'Follow-up answer' : 'Partial answer');
    done();
  }, stdin.trimEnd().endsWith('simulate slow turn') ? 10000 : 180);
}
`;

async function until(read, timeout = 6000) {
  const end = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(30);
  } while (Date.now() < end);
  assert.fail('Timed out waiting for the daemon. ' + daemonLog);
}

async function request(route, body) {
  const response = await fetch(url + route, body === undefined ? {} : {
    method: 'POST', headers: { 'X-Loupe': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function api(route, body) {
  const result = await request(route, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const wsApi = (sub, body) => api(workspace + sub, body);
const calls = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
const git = (...argv) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...argv], { cwd: root });

before(async () => {
  fs.mkdirSync(root);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'file.txt'), 'old\n');
  git('add', 'file.txt');
  git('commit', '-qm', 'Initial commit');
  fs.writeFileSync(path.join(root, 'file.txt'), 'new\n');

  const binary = path.join(temp, 'fake-codex.cjs');
  fs.writeFileSync(binary, fake, { mode: 0o755 });
  const listener = net.createServer();
  const port = await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
  url = `http://127.0.0.1:${port}`;
  daemon = spawn(process.execPath, ['bin/loupe.mjs', 'serve', '--no-80', '--no-mdns'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, CODEX_HOME: path.join(temp, 'codex-home'), LOUPE_MODELS: 'fixed', LOUPE_HOME: path.join(temp, 'state'), LOUPE_PORT: String(port), LOUPE_GH: '/usr/bin/false',
      LOUPE_CODEX: binary, LOUPE_CLAUDE: '/usr/bin/false', FAKE_CODEX_CALLS: callsFile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemon.stderr.on('data', (chunk) => { daemonLog += chunk; });
  const state = await until(() => api('/api/state').catch(() => null));
  assert.deepEqual(state.models.filter((m) => m.kind === 'codex').map((m) => m.id), ['gpt-6.2-sol', 'gpt-6.2-astra']);
  workspace = '/api/w/' + (await api('/api/workspaces', { target: root })).id;
});

after(async () => {
  if (daemon?.exitCode === null && daemon.signalCode === null) {
    await new Promise((resolve) => { daemon.once('exit', resolve); daemon.kill(); });
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('Codex streams a line answer, resumes its thread, and refuses cross-kind replies', async () => {
  const previous = (await wsApi('/chats', {})).conv;
  await wsApi(`/convs/${previous.id}/messages`, { text: 'What changed before?', model: 'gpt-6.2-sol', effort: 'high' });
  await until(async () => (await wsApi('/review')).convs[previous.id].messages.find((m) => m.role === 'codex' && !m.pending));

  const controller = new AbortController();
  const response = await fetch(url + workspace + '/events', { signal: controller.signal });
  const events = [];
  const read = (async () => {
    let pending = '';
    try {
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        const records = pending.split('\n\n');
        pending = records.pop();
        for (const record of records) {
          if (record.startsWith('event: message\n')) events.push(JSON.parse(record.split('\ndata: ')[1]));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  try {
    const { conv } = await wsApi('/threads', {
      path: 'file.txt', line: 1, label: 'line 1', snippet: '+new', text: 'Why this change?', model: 'gpt-6.2-sol', effort: 'max',
    });
    const done = await until(() => events.find((e) => e.conv === conv.id && e.msg.role === 'codex' && !e.msg.pending));
    assert.ok(events.some((e) => e.conv === conv.id && e.msg.pending && e.msg.text === 'Partial'));
    assert.equal(done.msg.text, 'Partial answer');
    assert.deepEqual(done.msg.tools, [{ name: 'Command', input: 'git diff' }]);
    assert.deepEqual(done.msg.usage, { input: 23, output: 7 });
    assert.match(done.msg.foot, /\d+\.\d s · 23 input tokens · 7 output tokens/);

    const saved = () => wsApi('/review').then((r) => r.convs[conv.id]);
    assert.equal((await saved()).modelKind, 'codex');
    assert.equal((await saved()).codexThreadId, threadId);
    const route = workspace + `/convs/${conv.id}/messages`;
    const refusal = await request(route, { text: 'wrong kind', model: 'claude-opus-5-5' });
    assert.deepEqual(refusal, { status: 400, body: { error: 'This conversation uses Codex. Start a new chat to switch.' } });
    assert.equal((await saved()).messages.length, 2);

    await api(route, { text: 'What else?', model: 'gpt-6.2-astra', effort: 'xhigh' });
    await until(() => events.find((e) => e.conv === conv.id && !e.msg.pending && e.msg.text === 'Follow-up answer'));
    const [chat, initial, followUp] = calls();
    assertInvocation(chat, 'gpt-6.2-sol', 'high');
    assertInvocation(initial, 'gpt-6.2-sol', 'max');
    assertInvocation(followUp, 'gpt-6.2-astra', 'xhigh');
    assert.match(initial.stdin, /file\.txt line 1[\s\S]*\+new[\s\S]*Why this change\?/);
    assert.match(initial.stdin, /Other open review conversations[\s\S]*"where":"whole-change chat","asked":"What changed before\?","answer":"Partial answer"/);
    assert.doesNotMatch(initial.stdin.split('Other open review conversations')[1].split('Their comment:')[0], /"asked":"Why this change\?"/);
    assert.equal(initial.argv.includes('resume'), false);
    assert.equal(followUp.argv[followUp.argv.indexOf('resume') + 1], threadId);

    const { conv: linked } = await wsApi('/chats', { link: { sessionId: threadId, cwd: root } });
    const linkedRefusal = await request(workspace + `/convs/${linked.id}/messages`, { text: 'wrong kind', model: 'gpt-6.2-astra' });
    assert.deepEqual(linkedRefusal, { status: 400, body: { error: 'This conversation uses Claude. Start a new chat to switch.' } });
    assert.equal(calls().length, 3);

    await api(route, { text: 'simulate turn failure' });
    const failed = await until(() => events.find((e) => e.conv === conv.id && e.msg.error));
    assert.equal(failed.msg.error, 'fake model failure');
    assert.equal(failed.msg.pending, false);
    assertInvocation(calls().at(-1), 'gpt-6.2-astra', 'xhigh');
  } finally {
    controller.abort();
    await read;
  }
});

function assertInvocation(call, model, effort) {
  const value = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(value('--sandbox'), 'read-only');
  assert.equal(value('--cd'), root);
  assert.equal(value('--model'), model);
  for (const flag of ['--ignore-user-config', '--ignore-rules']) assert.ok(call.argv.includes(flag), flag);
  assert.equal(call.argv.includes('--ephemeral'), !!call.schema);
  for (const config of [`model_reasoning_effort="${effort}"`, 'approval_policy="never"', 'sandbox_workspace_write.network_access=false',
    'web_search="disabled"', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.shell_snapshot=false']) {
    assert.equal(call.argv[call.argv.indexOf(config) - 1], '--config', config);
  }
}

test('Codex uses structured schemas for briefs and both kinds of draft', async () => {
  await wsApi('/brief', { model: 'gpt-6.2-astra', effort: 'medium' });
  const brief = await until(async () => {
    const { brief } = await wsApi('/review');
    return brief && !brief.pending && brief;
  });
  assert.equal(brief.error, null);
  assert.equal(brief.model, 'gpt-6.2-astra');
  assert.equal(brief.tldr, 'Adds a check.');
  assert.equal(brief.startHere, 'file.txt');
  assert.deepEqual(brief.sections[0].files, ['file.txt']);
  assert.deepEqual(brief.citations, { 'file.txt:1': 'new' });
  const briefCall = calls().at(-1);
  assertInvocation(briefCall, 'gpt-6.2-astra', 'medium');
  assert.equal(briefCall.schema.additionalProperties, false);
  assert.ok(briefCall.schema.properties.sections.items.required.includes('check'));
  assert.match(briefCall.stdin, /-old\n\+new/);

  const draftRun = { model: 'gpt-6.2-sol', effort: 'low' };
  const commit = { ...draftRun, what: 'commit', paths: ['file.txt'] };
  assert.deepEqual(await wsApi('/draft', commit), { subject: 'Add a check', body: '' });
  assertInvocation(calls().at(-1), 'gpt-6.2-sol', 'low');
  assert.deepEqual(calls().at(-1).schema.required, ['subject', 'body']);
  assert.deepEqual(await wsApi('/draft', { ...draftRun, what: 'pr' }), { title: 'Add a check', body: 'Checks the value.' });
  assert.deepEqual(calls().at(-1).schema.required, ['title', 'body']);

  fs.writeFileSync(callsFile + '.invalid', '');
  const invalid = await request(workspace + '/draft', commit);
  assert.equal(invalid.status, 422);
  assert.match(invalid.body.error, /subject/);
  fs.unlinkSync(callsFile + '.invalid');

  fs.writeFileSync(callsFile + '.truncated', '');
  try {
    const truncated = await request(workspace + '/draft', commit);
    assert.equal(truncated.status, 422);
    assert.match(truncated.body.error, /ended before the turn completed/);
  } finally { fs.unlinkSync(callsFile + '.truncated'); }
});

test('Codex reports a stream that exits without completing the turn', async () => {
  const { conv } = await wsApi('/chats', {});
  await wsApi(`/convs/${conv.id}/messages`, { text: 'simulate truncated stream', model: 'gpt-6.2-sol' });
  const answer = await until(async () => (await wsApi('/review')).convs[conv.id].messages.find((m) => m.role === 'codex' && !m.pending));
  assert.equal(answer.text, 'Unfinished');
  assert.match(answer.error, /ended before the turn completed/);
});

test('Codex structured output can use the Git directory before the worktree is ready', () => {
  const script = `
    import { structured } from './src/codex.mjs';
    const schema = { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } } };
    const result = await structured({ root: null, gitDir: process.argv[1] }, { model: 'gpt-6.2-sol', effort: 'low' }, 'Write a commit message', schema, new AbortController().signal);
    console.log(JSON.stringify(result.out));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, root], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, LOUPE_CODEX: path.join(temp, 'fake-codex.cjs'), FAKE_CODEX_CALLS: callsFile },
  });
  assert.deepEqual(JSON.parse(output), { subject: 'Add a check', body: '' });
  assertInvocation(calls().at(-1), 'gpt-6.2-sol', 'low');
});

test('stopping a Codex turn preserves partial text and clears pending', async () => {
  const { conv } = await wsApi('/chats', {});
  const route = `/convs/${conv.id}`;
  await wsApi(route + '/messages', { text: 'simulate slow turn', model: 'gpt-6.2-sol' });
  const answer = async () => (await wsApi('/review')).convs[conv.id].messages.find((m) => m.role === 'codex');
  await until(async () => (await answer())?.text === 'Partial');
  assert.deepEqual(await wsApi(route + '/stop', {}), { stopped: true });
  const stopped = await until(async () => {
    const msg = await answer();
    return !msg.pending && msg;
  });
  assert.equal(stopped.text, 'Partial');
  assert.equal(stopped.foot, 'stopped');
  assert.equal(stopped.error, undefined);
});
