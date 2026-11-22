import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { connect, until } from './cdp.mjs';
import { motionCases, reducedCases, themeCase } from './cases.mjs';
import { score } from './score.mjs';

const fixture = '/tmp/loupe-demo';
const demo = 'http://127.0.0.1:4640';
const root = process.env.LOUPE_ANIM_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const chromePath = process.env.LOUPE_ANIM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [out, mode = 'all', strip] = process.argv.slice(2);
const deviceScaleFactor = Number(process.env.LOUPE_ANIM_DPR || 1);
const temp = await mkdtemp(join(tmpdir(), 'loupe-anim-'));
let daemon, chrome, cdp;

try {
  const occupied = await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 4640 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (e) => resolve(e.code !== 'ECONNREFUSED'));
  });
  if (occupied) throw new Error('Port 4640 is already in use');

  const home = join(temp, 'home');
  await cp(join(fixture, 'home'), home, { recursive: true });
  const stateFile = join(home, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.settings.autoNotes = false;
  await writeFile(stateFile, JSON.stringify(state));
  const env = { ...process.env, LOUPE_NAME: 'animdemo2', LOUPE_PORT: '4640', LOUPE_HOME: home,
    LOUPE_GH: join(fixture, 'gh'), LOUPE_SEARCH: fixture, LOUPE_MODELS: 'fixed', CODEX_HOME: join(fixture, 'codex-home') };
  delete env.LOUPE_TLS_PORT;
  daemon = spawn(process.execPath, ['bin/loupe.mjs', 'serve', '--no-80', '--no-mdns'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(async () => daemon.exitCode === null
    ? fetch(demo + '/web/style.css').then((r) => r.ok, () => false)
    : Promise.reject(new Error('Demo daemon exited')), 'demo daemon', 10000);

  const profile = join(temp, 'chrome');
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const debugging = await until(() => readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null), 'Chrome DevTools', 10000);
  const targets = await (await fetch('http://127.0.0.1:' + debugging.split('\n')[0] + '/json/list')).json();
  cdp = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://github.com/*', demo + '/api/w/*/events'] });
  const resize = (width) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor, mobile: false });
  const media = (dark, reduce = false) => cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
    { name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' },
  ] });
  const open = async () => {
    await cdp.send('Page.navigate', { url: demo + '/local/ratelimit' });
    await until(() => cdp.evaluate(() => !!document.querySelector('#motedock .mote') && !!document.querySelector('#cards .ln'))
      .catch(() => false), 'review and Mote');
    await cdp.evaluate(async () => { await document.fonts.ready; await new Promise((r) => setTimeout(r, 900)); });
  };

  const results = { chrome: (await cdp.send('Browser.getVersion')).product, deviceScaleFactor, motion: {}, theme: {} };
  if (mode !== 'theme') {
    await resize(1440);
    await media(false);
    await open();
    results.motion = Object.fromEntries(Object.entries(await cdp.evaluate(motionCases, !process.env.LOUPE_ANIM_ROOT)).map(([name, trace]) => [name, score(trace)]));
    await media(false, true);
    results.reduced = await cdp.evaluate(reducedCases);
    await media(false);
    if (!process.env.LOUPE_ANIM_ROOT) assert.ok(Object.values(results.reduced).every(Boolean), JSON.stringify(results.reduced));
  }
  if (mode !== 'motion') {
    const checkMask = !process.env.LOUPE_ANIM_ROOT;
    for (const width of [1440, 2000]) {
      await resize(width);
      await media(false);
      await open();
      for (const [dark, label] of [[true, 'light → dark'], [false, 'dark → light']]) {
        process.stderr.write(`Theme ${width}: ${label}\n`);
        const trace = await cdp.evaluate(themeCase, dark, 'menu', checkMask);
        results.theme[width + ' ' + label] = { ...score(trace), wave: trace.wave, theme: trace.theme, duration: trace.duration, frameTimes: trace.frameTimes };
      }
    }
    await open();
    results.theme.palette = await cdp.evaluate(themeCase, true, 'palette', checkMask).then((t) => ({ ...score(t), wave: t.wave, theme: t.theme, origin: t.origin, duration: t.duration, frameTimes: t.frameTimes }));
    await cdp.evaluate(themeCase, false, 'system');
    const system = cdp.evaluate(themeCase, true, 'observe', checkMask);
    await media(true);
    results.theme.system = await system.then((t) => ({ ...score(t), wave: t.wave, theme: t.theme, duration: t.duration, frameTimes: t.frameTimes }));
    await media(true, true);
    results.theme.reduced = await cdp.evaluate(themeCase, false, 'menu').then((t) => ({ wave: t.wave, theme: t.theme }));
    if (checkMask) {
      for (const [key, row] of Object.entries(results.theme)) {
        if (key === 'reduced') assert.deepEqual(row, { wave: 0, theme: 'light' });
        else {
          assert.ok(row.wave >= 2, key + ' produced no wave');
          assert.equal(row.theme, key.endsWith('light') ? 'light' : 'dark', key);
        }
      }
      assert.ok(results.theme.palette.origin, 'The palette wave needs an origin');
      await media(false);
      const fallback = await cdp.evaluate(themeCase, true, 'no-canvas');
      assert.equal(fallback.wave, 0, 'Canvas failure produced a wave');
      assert.equal(fallback.theme, 'dark');
    }
    if (strip) {
      await mkdir(strip, { recursive: true });
      await resize(1440);
      await media(false);
      await cdp.evaluate(() => localStorage.setItem('loupe.theme', '"light"'));
      await open();
      const frames = [];
      const off = cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        frames.push(data);
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await cdp.evaluate(themeCase, true, 'menu');
      await cdp.send('Page.stopScreencast');
      off();
      if (frames.length < 6) throw new Error('Too few presented frames for the theme strip');
      for (const [i, part] of [0, 0.3, 0.48, 0.65, 1].entries()) {
        const frame = frames[Math.round((frames.length - 1) * part)];
        await writeFile(join(strip, `wave-${i}.png`), Buffer.from(frame, 'base64'));
      }
    }
  }
  const json = JSON.stringify(results, null, 2) + '\n';
  if (out) await writeFile(out, json); else process.stdout.write(json);
} finally {
  cdp?.close();
  await Promise.all([chrome, daemon].filter(Boolean).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  await rm(temp, { recursive: true, force: true });
}
