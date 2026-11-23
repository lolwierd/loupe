// The daemon's front door, against a real process: which hosts it answers, what l.local does, and the settings list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child, port, gitGate;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// node's fetch cannot set Host, so the requests are made by hand
const req = (method, p, { host = 'loupe.local', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { Host: host, ...headers } }, (res) => {
    let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
  });
  r.on('error', reject); r.end(body);
});

before(async () => {
  port = await freePort();
  const env = { ...process.env, LOUPE_MODELS: 'fixed', LOUPE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-')), LOUPE_PORT: String(port), LOUPE_GH: '/usr/bin/false' };
  gitGate = env.LOUPE_HOME;
  env.LOUPE_GIT_GATE = gitGate;
  env.LOUPE_GIT = path.join(gitGate, 'git-shim');
  fs.writeFileSync(env.LOUPE_GIT, `#!/bin/sh
if [ -f "$LOUPE_GIT_GATE/pause" ]; then
  read -r old new < "$LOUPE_GIT_GATE/pause"
  case " $* " in
    *" diff -z --raw "*" $old $new ")
      mv "$LOUPE_GIT_GATE/pause" "$LOUPE_GIT_GATE/paused"
      while [ -f "$LOUPE_GIT_GATE/paused" ]; do sleep 0.02; done
      ;;
  esac
fi
exec git "$@"
`, { mode: 0o755 });
  child = spawn(process.execPath, [path.join(ROOT, 'bin/loupe.mjs'), 'serve', '--no-80', '--no-mdns'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/api/state', { host: `127.0.0.1:${port}` })).status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('the daemon did not come up');
});
after(() => child?.kill());

test('serve --dev restarts its child when the shared file-notes module changes', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-dev-'));
  for (const dir of ['bin', 'src', 'web/js']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'bin/loupe.mjs'), path.join(root, 'bin/loupe.mjs'));
  const shared = path.join(root, 'web/js/file-notes.js');
  fs.writeFileSync(shared, 'export const version = 1;\n');
  fs.writeFileSync(path.join(root, 'src/server.mjs'), `
    import { version } from '../web/js/file-notes.js';
    export function start() { console.log('child version ' + version); setInterval(() => {}, 1000); }
  `);
  const dev = spawn(process.execPath, [path.join(root, 'bin/loupe.mjs'), 'serve', '--dev'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(dev, 'exit');
  let output = '';
  for (const stream of [dev.stdout, dev.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const waitFor = async (line) => {
    for (let i = 0; i < 80 && !output.includes(line) && dev.exitCode === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(output.includes(line), output);
  };
  try {
    await waitFor('child version 1');
    fs.writeFileSync(shared, 'export const version = 2;\n');
    await waitFor('child version 2');
    assert.match(output, /web\/js\/file-notes\.js changed, restarting/);
  } finally {
    dev.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('l.local redirects to the same path on loupe.local, and only that', async () => {
  const r = await req('GET', '/acme/widgets/pull/123?x=1', { host: 'l.local' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `http://loupe.local:${port}/acme/widgets/pull/123?x=1`);
  assert.equal((await req('HEAD', '/', { host: `l.local:${port}` })).status, 302);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await req(m, '/api/settings', { host: 'l.local', headers: { 'X-Loupe': '1' }, body: '{}' })).status, 405, m);
  // nothing from the request line or the Host header reaches the target's authority
  assert.equal((await req('GET', '//evil.com/x', { host: 'l.local' })).headers.location, `http://loupe.local:${port}/x`);
});
test('l.local is not one of loupe\'s own hosts', async () => {
  assert.equal((await req('GET', '/api/state', { host: 'l.local.evil.com' })).status, 421);
  assert.equal((await req('GET', '/api/state', { host: 'evil.com' })).status, 421);
  assert.equal((await req('GET', '/api/state', { headers: { Origin: 'http://l.local' } })).status, 403);
  assert.equal((await req('GET', '/api/state', { headers: { Origin: `http://loupe.local:${port}` } })).status, 200);
});
test('a page reached from a link on another site says so, even when the browser sends no Sec-Fetch-Site', async () => {
  const nav = async (headers) => /name="loupe-nav" content="(\w[\w-]*)"/.exec((await req('GET', '/acme/widgets/pull/1', { headers })).body)?.[1];
  assert.equal(await nav({}), 'trusted');
  assert.equal(await nav({ Referer: `http://loupe.local:${port}/home` }), 'trusted');
  assert.equal(await nav({ Referer: 'https://github.com/' }), 'cross-site');
  assert.equal(await nav({ 'Sec-Fetch-Site': 'cross-site' }), 'cross-site');
  assert.equal(await nav({ 'Sec-Fetch-Site': 'none', Referer: 'https://github.com/' }), 'trusted');
});
test('settings: hiddenOrgs is a validated list, and a bad one changes nothing', async () => {
  const post = (b) => req('POST', '/api/settings', { headers: { 'X-Loupe': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.deepEqual(JSON.parse((await req('GET', '/api/state')).body).settings.hiddenOrgs, []);
  const ok = await post({ hiddenOrgs: ['acme', ' Foo-bar ', 'ACME'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).hiddenOrgs, ['acme', 'Foo-bar']);
  for (const bad of ['x', [1], ['a b'], ['../x'], [''], Array.from({ length: 201 }, (_, i) => `o${i}`)]) assert.equal((await post({ autoBrief: true, hiddenOrgs: bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  const st = JSON.parse((await req('GET', '/api/state')).body).settings;
  assert.deepEqual(st.hiddenOrgs, ['acme', 'Foo-bar']);
  assert.equal(st.autoBrief, false);
  assert.deepEqual(JSON.parse((await post({ hiddenOrgs: [] })).body).hiddenOrgs, []);
});

test('direct local diff API requests refresh even without a page or a metadata request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  fs.writeFileSync(path.join(root, 'first'), 'first');
  const opened = await req('POST', '/api/workspaces', {
    headers: { 'X-Loupe': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ target: root }),
  });
  assert.equal(opened.status, 200);
  const url = '/api/w/' + JSON.parse(opened.body).id;
  assert.equal(JSON.parse((await req('GET', url)).body).dirty, 1);
  fs.writeFileSync(path.join(root, 'second'), 'second');
  const list = await req('GET', url + '/files?scope=wip');
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body).files.map((f) => f.path), ['first', 'second']);
});

test('diff reads keep their comparison when a sync lands mid-request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-range-'));
  const pause = path.join(gitGate, 'pause'), paused = path.join(gitGate, 'paused');
  t.after(() => { for (const p of [root, pause, paused]) fs.rmSync(p, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'shared'), 'original\n');
  git('add', 'shared'); git('commit', '-qm', 'initial');
  git('switch', '-qc', 'other');
  git('rm', '-q', 'shared'); git('commit', '-qm', 'remove shared');
  git('switch', '-qc', 'topic', 'main');
  fs.writeFileSync(path.join(root, 'shared'), 'current\n');
  git('commit', '-qam', 'change shared');
  const old = git('rev-parse', 'main'), head = git('rev-parse', 'topic');
  const post = (url, body) => req('POST', url, {
    headers: { 'X-Loupe': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const opened = await post('/api/workspaces', { target: root });
  assert.equal(opened.status, 200);
  const url = '/api/w/' + JSON.parse(opened.body).id;

  for (const [route, check] of [
    ['/files', (body) => {
      assert.equal(body.old, old);
      assert.equal(body.new, head);
      assert.deepEqual(body.files.map((f) => f.path), ['shared']);
    }],
    ['/diff', (body) => {
      assert.equal(body.newLen, 1);
      assert.deepEqual(body.hunks.flatMap((h) => h.lines.map((l) => l.s)), ['original', 'current']);
    }],
    ['/file', (body) => assert.deepEqual(body.lines, ['original'])],
  ]) {
    git('switch', '-q', 'topic');
    assert.equal((await post(url + '/base', { base: 'main' })).status, 200);
    fs.writeFileSync(pause, `${old} ${head}\n`);
    const response = req('GET', url + route + '?scope=branch&side=old&path=shared');
    try {
      for (let i = 0; i < 250 && !fs.existsSync(paused); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(fs.existsSync(paused), `paused ${route}`);
      git('switch', '-q', 'other');
      assert.equal((await post(url + '/base', { base: 'other' })).status, 200);
    } finally {
      fs.rmSync(paused, { force: true });
    }
    const { status, body } = await response;
    assert.equal(status, 200, body);
    check(JSON.parse(body));
    assert.deepEqual(JSON.parse((await req('GET', url + '/files?scope=branch')).body).files, []);
  }
});

test('a scene document that is not there, or a draft that is not, is not found; the check\'s host page runs no script', async () => {
  const h = `127.0.0.1:${port}`;
  assert.equal((await req('GET', '/scene-doc/draft/no-such-token-here', { host: h })).status, 404);
  assert.equal((await req('GET', '/scene-doc/no-ws/no-scene', { host: h })).status, 404);
  const host = await req('GET', '/scene-host', { host: h });
  assert.equal(host.status, 200); assert.match(host.headers['content-security-policy'], /script-src 'none'/); assert.match(host.headers['content-security-policy'], /frame-ancestors 'none'/);
});
