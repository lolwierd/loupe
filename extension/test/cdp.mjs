// Just enough of the Chrome DevTools Protocol to drive a browser from a test, with Node's own WebSocket: launch with
// a fresh profile, attach to targets (flattened sessions), evaluate, send trusted keys.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launch(bin, args = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-ext-profile-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-sync', '--window-size=1280,900', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !fs.existsSync(file); i++) await sleep(100);
  if (!fs.existsSync(file)) { proc.kill('SIGKILL'); throw new Error('the browser did not start: ' + stderr); }
  const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let n = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method}: no answer`)); }, 20000);
  });
  const targets = async () => (await send('Target.getTargets')).targetInfos;
  const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const evaluate = async (sessionId, expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  // A key as the keyboard sends it: trusted, with its text.
  const key = async (sessionId, ch) => {
    const code = 'Key' + ch.toUpperCase();
    const vk = ch.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId);
  };
  // The profile goes once the browser has exited, not while it is still writing to it.
  const exited = new Promise((r) => proc.once('exit', r));
  const close = async () => {
    try { ws.close(); } catch { /* gone */ }
    proc.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, targets, attach, evaluate, key, close };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, timeout = 15000, every = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(every);
  }
}
