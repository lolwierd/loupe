// The check a scene passes before it is kept, against a real Chrome and a real daemon (skipped where there is no
// Chrome): what renders gets stills, an empty frame and a throwing script are said, and content too tall is cut.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await freePort();
Object.assign(process.env, { LOUPE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-')), LOUPE_PORT: String(port), LOUPE_NO_80: '1', LOUPE_NO_MDNS: '1', LOUPE_MODELS: 'fixed', LOUPE_GH: '/usr/bin/false' });
const { BIN } = await import('../src/config.mjs');
// the render check runs only in a Chrome that keeps a scene's connections shut (152 on); the gate has its own test
const major = (() => { try { return Number(/(\d+)\./.exec(execFileSync(BIN.chrome, ['--version'], { encoding: 'utf8', timeout: 10000 }))?.[1]) || 0; } catch { return 0; } })();
const skip = (!BIN.chrome && 'no Chrome here') || (major < 152 && `Chrome ${major || '(version unknown)'} is older than 152`);
let renderScene;
before(async () => { if (skip) return; ({ renderScene } = await import('../src/scene-render.mjs')); const { start } = await import('../src/server.mjs'); await start(); });
after(() => setTimeout(() => process.exit(process.exitCode), 50)); // the daemon would keep the test running; a failure keeps its status
const quick = { light: [400], dark: [300] }, look = (html, height = 200) => renderScene(html, { origin: `http://127.0.0.1:${port}`, height, times: quick });
const clean = (r) => r.dir && fs.rmSync(r.dir, { recursive: true, force: true });

test('a scene that renders gets its stills, light and dark, and nothing to fix', { skip, timeout: 60000 }, async () => {
  // one still a theme, taken late (not at the quick times): a slow machine paints a frame's first picture late, and a still taken before it is blank
  const r = await renderScene('<p style="font:13px var(--f-ui);color:var(--ink)">a jar on a shelf</p>', { origin: `http://127.0.0.1:${port}`, height: 200, times: { light: [4000], dark: [4000] } });
  assert.equal(r.failed, undefined); assert.equal(r.problem, null); assert.deepEqual(r.errors, []); assert.deepEqual(r.cut, []);
  assert.deepEqual(r.shots.map((s) => s.theme), ['light', 'dark']); assert.ok(r.shots.every((s) => fs.statSync(s.file).size > 100));
  clean(r);
});

test('an empty frame, a script that throws, and content taller than its frame are each said', { skip, timeout: 90000 }, async () => {
  const empty = await look('<div></div>');
  assert.match(empty.problem, /renders nothing/); clean(empty);
  const hollow = await look('<style>.box { width: 100px }</style><div class="box"></div><div></div><script>throw new Error("before it drew")</script>');
  assert.match(hollow.problem, /renders nothing/, 'elements that paint nothing are still nothing'); clean(hollow);
  const boom = await look('<p>x</p><script>throw new Error("the jar fell")</script>');
  assert.ok(boom.errors.some((e) => /the jar fell/.test(e)), boom.errors.join(' | ')); clean(boom);
  const tall = await look('<div style="height:900px">tall</div>', 200);
  assert.ok(tall.cut.some((c) => /taller than its frame/.test(c)), tall.cut.join(' | ')); clean(tall);
});
