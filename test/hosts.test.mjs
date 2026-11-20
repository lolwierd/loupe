// The daemon's front door, against a real process: which hosts it answers, what l.local does, and the settings list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child, port;
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
  child = spawn(process.execPath, [path.join(ROOT, 'bin/loupe.mjs'), 'serve', '--no-80', '--no-mdns'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/api/state', { host: `127.0.0.1:${port}` })).status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('the daemon did not come up');
});
after(() => child?.kill());

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
