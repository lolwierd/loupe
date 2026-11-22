// A Chrome older than 152 does not keep a scene's connections shut, so the render check never loads a scene in it: a
// stand-in Chrome that says it is 151 is asked its version and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-gate-')), log = path.join(dir, 'asked.txt');
// it speaks Chrome's pipe protocol: commands in on fd 3, answers out on fd 4, each ended by a NUL
fs.writeFileSync(path.join(dir, 'chrome.mjs'), `import fs from 'node:fs';
let buf = '';
fs.createReadStream(null, { fd: 3 }).on('data', (d) => {
  buf += d; let k;
  while ((k = buf.indexOf('\\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
    fs.appendFileSync(${JSON.stringify(log)}, m.method + '\\n');
    fs.writeSync(4, JSON.stringify({ id: m.id, result: m.method === 'Browser.getVersion' ? { product: 'HeadlessChrome/151.0.7000.0' } : {} }) + '\\0');
  }
});
`);
fs.writeFileSync(path.join(dir, 'chrome'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'chrome.mjs'))}\n`, { mode: 0o755 });
Object.assign(process.env, { LOUPE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-')), LOUPE_CHROME: path.join(dir, 'chrome') });
const { renderScene } = await import('../src/scene-render.mjs');

test('a Chrome older than 152 is asked its version and is given no scene', { timeout: 30000 }, async () => {
  const r = await renderScene('<p>a jar</p>', { origin: 'http://127.0.0.1:9' });
  assert.match(r.unavailable || '', /Chrome 151 is too old/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['Browser.getVersion']);
  fs.rmSync(dir, { recursive: true, force: true });
});
