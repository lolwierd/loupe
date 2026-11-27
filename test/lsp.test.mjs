// gopls's lifetime, with a fake gopls that answers every request and takes a moment to exit once it is killed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-lsp-')));
const log = path.join(tmp, 'spawns');
process.env.LOUPE_GOPLS = path.join(tmp, 'gopls');
process.env.FAKE_GOPLS_LOG = log;
fs.writeFileSync(process.env.LOUPE_GOPLS, `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FAKE_GOPLS_LOG, process.pid + '\\n');
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const he = buf.indexOf('\\r\\n\\r\\n');
    if (he < 0) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, he).toString())[1]);
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.subarray(he + 4, he + 4 + len).toString());
    buf = buf.subarray(he + 4 + len);
    if (msg.id === undefined || !msg.method) continue;
    const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'textDocument/hover' ? { contents: 'hi' } : null });
    process.stdout.write('Content-Length: ' + Buffer.byteLength(out) + '\\r\\n\\r\\n' + out);
  }
});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); // a moment to exit, as a real one takes
`, { mode: 0o755 });

const { goplsFor } = await import('../src/lsp.mjs');
const pids = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map(Number); } catch { return []; } };
const spawns = () => pids().length;
// every fake gopls goes at the end, so one a bug left behind fails the test instead of keeping it running
after(() => {
  for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a gopls started while the stopped one is still exiting is not taken down by that exit', async () => {
  const root = path.join(tmp, 'mod');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'go.mod'), 'module m\n');
  fs.writeFileSync(path.join(root, 'a.go'), 'package m\n');
  const g = goplsFor(root);
  after(() => g.stop());
  assert.ok(await g.at('textDocument/hover', 'a.go', 1, 0));
  g.stop(); // idle for twenty minutes
  assert.ok(await g.at('textDocument/hover', 'a.go', 1, 0)); // a hover before the old gopls has exited starts a new one
  await delay(500); // the old one exits
  assert.ok(await g.at('textDocument/hover', 'a.go', 1, 0));
  assert.equal(spawns(), 2, 'the old exit dropped the new gopls, and a third had to start cold');
});
