import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { connect, until } from './cdp.mjs';
import { largeFixture } from './fixture.mjs';
import { instrument, status, sweep } from './page.mjs';

const { values } = parseArgs({ options: {
  runs: { type: 'string', default: '5' },
  fixture: { type: 'string', default: 'both' },
  'idle-seconds': { type: 'string', default: '60' },
  out: { type: 'string' },
  'app-root': { type: 'string', default: '.' },
  against: { type: 'string' },
  profile: { type: 'boolean' },
} });
const runs = Number(values.runs), idleSeconds = Number(values['idle-seconds']);
const fixtures = values.fixture === 'both' ? ['small', 'large'] : [values.fixture];
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isFinite(idleSeconds) || idleSeconds < 0 ||
    fixtures.some((fixture) => !['small', 'large'].includes(fixture))) throw new Error('Invalid run count, idle interval, or fixture');
const chromePath = process.env.LOUPE_PERF_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const appRoot = resolve(values['app-root']);
const variants = values.against ? [
  { name: 'baseline', root: resolve(values.against) }, { name: 'candidate', root: appRoot },
] : [{ name: '', root: appRoot }];
const demo = process.env.LOUPE_PERF_DEMO || '/tmp/loupe-demo';
const origin = 'http://127.0.0.1:4650';
const out = resolve(values.out || mkdtempSync(join(tmpdir(), 'loupe-perf-results-')));
mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'loupe-perf-'));
const isolatedHome = join(temp, 'user');
mkdirSync(isolatedHome);
const roots = { small: join(demo, 'ratelimit'), large: join(temp, 'large') };
const env = { ...process.env, HOME: isolatedHome, CODEX_HOME: join(isolatedHome, '.codex'),
  LOUPE_HOME: temp, LOUPE_PORT: '4650', LOUPE_NAME: 'loupe-perf', LOUPE_TLS_PORT: '',
  LOUPE_GH: join(demo, 'gh'), LOUPE_SEARCH: `${demo}:${temp}`, LOUPE_MODELS: 'fixed', GIT_OPTIONAL_LOCKS: '0' };
const active = new Set();
function startProcess(command, args, log, extra = {}, cwd) {
  const fd = openSync(log, 'w');
  const child = spawn(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...env, ...extra } });
  closeSync(fd);
  const exited = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  }).then((value) => { active.delete(child); return value; });
  active.add(child);
  return { child, exited, async stop() { child.kill(); await exited; } };
}
const stopAll = async () => {
  for (const child of active) child.kill();
  await Promise.all([...active].map((child) => once(child, 'close').catch(() => {})));
};
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => {
  await stopAll();
  rmSync(temp, { recursive: true, force: true });
  process.exit(1);
});
async function api(path, body) {
  const res = await fetch(origin + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
    headers: { 'X-Loupe': '1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function recordNetwork(cdp) {
  const requests = new Map();
  let loader, phase = 'open';
  const current = () => [...requests.values()].filter((r) => r.loader === loader);
  const off = [
    cdp.on('Network.requestWillBeSent', ({ requestId, request, timestamp, loaderId }) => {
      const url = new URL(request.url);
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
      const stream = url.pathname.endsWith('/events');
      requests.set(requestId, { url: url.pathname + url.search, method: request.method, start: timestamp,
        stream, bytes: 0, phase, loader: loaderId, seen: performance.now() });
    }),
    cdp.on('Network.responseReceived', ({ requestId, response, timestamp }) => {
      const r = requests.get(requestId);
      if (!r) return;
      r.headers = timestamp;
      r.status = response.status;
    }),
    cdp.on('Network.dataReceived', ({ requestId, dataLength }) => {
      const r = requests.get(requestId);
      if (r) r.bytes += dataLength;
    }),
    ...['loadingFinished', 'loadingFailed'].map((name) => cdp.on('Network.' + name, ({ requestId, timestamp, encodedDataLength, errorText }) => {
      const r = requests.get(requestId);
      if (!r) return;
      Object.assign(r, { end: timestamp, wireBytes: encodedDataLength, error: errorText, seen: performance.now() });
    })),
  ];
  return {
    document: (id) => { loader = id; },
    quiet: () => current().every((r) => r.stream || r.end && performance.now() - r.seen >= 350),
    phase: (next) => { phase = next; },
    snapshot: (...phases) => current().filter((r) => phases.includes(r.phase)).map((r) => ({
      url: r.url, method: r.method, status: r.status ?? null,
      ttfbMs: r.headers == null ? null : (r.headers - r.start) * 1000,
      ms: (r.stream ? r.headers : r.end) == null ? null : ((r.stream ? r.headers : r.end) - r.start) * 1000,
      bytes: r.bytes, wireBytes: r.wireBytes, stream: r.stream || undefined, error: r.error,
    })),
    stop: () => off.forEach((fn) => fn()),
  };
}

async function click(cdp, selector, label) {
  const point = await cdp.evaluate((selector, label) => {
    const el = [...document.querySelectorAll(selector)].find((el) => !label || el.textContent.trim() === label);
    if (!el) throw new Error('Missing control: ' + selector);
    const { x, y, width, height } = el.getBoundingClientRect();
    const point = { x: x + width / 2, y: y + height / 2 };
    if (!el.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Control is obscured: ' + selector);
    return point;
  }, selector, label ?? null);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 });
  }
}
async function key(cdp, key, options = {}) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...options });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...options, text: undefined });
}
async function interaction(cdp, event, done, dispatch) {
  await cdp.evaluate((event, done) => { loupePerf.arm(event, done); }, event, done);
  await dispatch();
  return cdp.evaluate(() => loupePerf.input);
}
async function interactions(cdp) {
  const result = {};
  const card = await cdp.evaluate(() => {
    const card = document.querySelector('#cards .file.split:not(.shut):has(.fb .ln)');
    if (!card) throw new Error('Fixture needs an open modified text file for interaction timings');
    loupePerf.card = card;
    card.scrollIntoView({ block: 'start' });
    return '#' + card.id;
  });
  result.palette = await interaction(cdp, 'keydown', 'palette', () => key(cdp, 'k', { code: 'KeyK', modifiers: 4 }));
  for (const letter of 'fil') await key(cdp, letter, { text: letter });
  result.query = await interaction(cdp, 'keydown', 'query', () => key(cdp, 'e', { text: 'e' }));
  await key(cdp, 'Escape');
  for (const [name, digit] of [['chat', '2'], ['marks', '3'], ['overview', '1']]) {
    result[name] = await interaction(cdp, 'keydown', name, () => key(cdp, digit, { code: 'Digit' + digit }));
  }
  const menu = () => click(cdp, card + ' [data-act="filemenu"]');
  await menu();
  result.viewer = await interaction(cdp, 'click', 'viewer', () => click(cdp, '[role=menuitem]', 'View the whole file'));
  await click(cdp, '#vclose');
  for (const [name, label] of [['unified', 'Unified'], ['split', 'Split']]) {
    await click(cdp, '.top [data-act="theme"]');
    result[name] = await interaction(cdp, 'click', name, () => click(cdp, '[role=menuitemradio]', label));
  }
  const viewed = () => click(cdp, card + ' [data-act="viewed"]');
  result.viewed = await interaction(cdp, 'click', 'viewed', viewed);
  await viewed(); // restore state before the next navigation
  return result;
}

function daemonCpuMs(pid) {
  const time = execFileSync('ps', ['-p', String(pid), '-o', 'time='], { encoding: 'utf8' }).trim();
  return time.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
}
async function measureIdle(browser, cdp, pid) {
  if (!idleSeconds) return null;
  const snapshot = async () => {
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return { daemon: daemonCpuMs(pid), renderer: processInfo.filter(({ type }) => type === 'renderer')
      .reduce((total, { cpuTime }) => total + cpuTime * 1000, 0),
    pageMain: metrics.find(({ name }) => name === 'TaskDuration').value * 1000 };
  };
  const start = performance.now();
  const first = await snapshot();
  await sleep(idleSeconds * 1000);
  const last = await snapshot();
  return { seconds: (performance.now() - start) / 1000,
    ...Object.fromEntries(Object.keys(first).map((key) => [key + 'CpuMs', last[key] - first[key]])) };
}
async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  return (await cdp.send('Runtime.getHeapUsage')).usedSize;
}

async function runPage(browser, cdp, daemon, workspace, temperature, profile) {
  const network = recordNetwork(cdp);
  const waitForQuiet = async (all = false) => {
    try {
      return await until(async () => {
        if (!network.quiet()) return;
        const s = await cdp.evaluate(status);
        if (s.errors.length) throw new Error('Diff errors: ' + s.errors.join(', '));
        return s.first > 0 && s.quiet >= 350 && (!all || !s.pending.length) ? s : null;
      }, all ? 'every diff rendered and quiet' : 'first viewport rendered and quiet', 20000);
    } catch (error) {
      const page = await cdp.evaluate(() => ({
        first: loupePerf.first, scrollTop: document.querySelector('#center')?.scrollTop,
        firstCards: [...document.querySelectorAll('#cards .file')].slice(0, 5).map((card) => ({
          path: card.dataset.p, class: card.className, rows: card.querySelectorAll('.fb .ln').length,
          body: card.querySelector('.fb > .loadd')?.textContent,
        })),
      }));
      const pending = network.snapshot('open', 'idle', 'scroll').filter((r) => r.ms === null);
      throw new Error(`${error.message}\nPage: ${JSON.stringify(page)}\nPending API requests: ${JSON.stringify(pending)}`, { cause: error });
    }
  };
  if (profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  try {
    const url = origin + workspace.url + '?perf=' + temperature;
    const nav = await cdp.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(nav.errorText);
    network.document(nav.loaderId);
    // A warm navigation can briefly expose the previous document to Runtime.evaluate.
    await until(() => cdp.evaluate((url) => location.href === url && !!window.loupePerf && document.readyState === 'complete', url).catch(() => false), 'page load');
    const initial = await waitForQuiet();
    const initialIdleMs = await cdp.evaluate(() => performance.now());
    const apiOpen = network.snapshot('open');
    const heapAfterOpen = await heap(cdp);
    network.phase('idle');
    const idle = await measureIdle(browser, cdp, daemon.child.pid);
    const apiIdle = network.snapshot('idle');
    const excludedMs = await cdp.evaluate(() => performance.now()) - initialIdleMs;
    network.phase('scroll');
    const scroll = await cdp.evaluate(sweep, 12000);
    const skipped = (await cdp.evaluate(status)).pending;
    // A stall can jump past a short placeholder. Visit any misses before claiming completion.
    for (const id of skipped) {
      await cdp.evaluate((id) => { document.getElementById(id).scrollIntoView({ block: 'center' }); }, id);
      await until(async () => !(await cdp.evaluate(status)).pending.includes(id), id);
    }
    const all = await waitForQuiet(true);
    const allIdleMs = await cdp.evaluate(() => performance.now()) - excludedMs;
    const allReadyMs = initial.pending.length === 0 ? initialIdleMs : allIdleMs;
    const apiAll = network.snapshot('open', 'scroll');
    const heapAfterScroll = await heap(cdp);
    const longFrames = await cdp.evaluate((start, end) =>
      loupePerf.longFrames.filter((entry) => entry.start >= start && entry.start <= end), scroll.start, scroll.end);
    network.phase('interaction');
    const inputsMs = await interactions(cdp);
    await until(() => network.snapshot('interaction').filter((r) =>
      r.method === 'POST' && r.url.endsWith('/viewed') && r.status === 200 && r.ms !== null).length === 2,
    'both viewed updates to finish');
    return {
      fileCount: all.count, firstPaintMs: initial.first, initialIdleMs, allReadyMs, allIdleMs, skippedDuringSweep: skipped.length,
      heapAfterOpen, heapAfterScroll, idle, inputsMs, apiOpen, apiIdle, apiAll,
      scroll: { frames: scroll.frames.length, overBudgetPct: scroll.frames.filter((ms) => Math.round(ms * 1000) > 16700).length * 100 / scroll.frames.length,
        over20MsPct: scroll.frames.filter((ms) => ms > 20).length * 100 / scroll.frames.length,
        longestMs: Math.max(...scroll.frames), durationMs: scroll.end - scroll.start, longFrames },
    };
  } finally {
    network.stop();
    if (profile) {
      const { profile: data } = await cdp.send('Profiler.stop');
      writeFileSync(profile, JSON.stringify(data));
    }
  }
}

const median = (values) => {
  const numbers = values.toSorted((a, b) => a - b), middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
};
const numericMedians = (rows) => Object.fromEntries(Object.entries(rows[0]).flatMap(([key, value]) =>
  typeof value === 'number' ? [[key, median(rows.map((row) => row[key]))]]
    : value && !Array.isArray(value) && typeof value === 'object' ? [[key, numericMedians(rows.map((row) => row[key]))]] : []));
const apiTotals = (requests) => ({ count: requests.length, bytes: requests.reduce((n, { bytes }) => n + bytes, 0) });
const results = [];
try {
  if (!existsSync(chromePath) || !existsSync(join(demo, 'gh')) || !existsSync(roots.small)) throw new Error('Chrome or demo fixture is missing');
  if (fixtures.includes('large')) largeFixture(roots.large);
  console.error(`Results: ${out}`);
  for (const fixture of fixtures) {
    for (let i = 0; i < runs; i++) {
      const order = i % 2 ? variants.toReversed() : variants;
      for (const variant of order) {
        const label = [variant.name, fixture, i + 1].filter(Boolean).join('-');
        const dir = join(temp, label), home = join(dir, 'state');
        mkdirSync(home, { recursive: true });
        const prof = values.profile && i === 0;
        const log = join(out, label + '-daemon.log');
        const daemon = startProcess(process.execPath, [
          ...(prof ? ['--cpu-prof', '--cpu-prof-dir=' + out, '--cpu-prof-name=' + label + '.cpuprofile'] : []),
          'bin/loupe.mjs', 'serve', '--no-80', '--no-mdns',
        ], log, { LOUPE_HOME: home, ...(prof ? { GIT_TRACE2_PERF: join(out, label + '-git.trace') } : {}) }, variant.root);
        let chrome, browser, cdp;
        try {
          await until(async () => {
            if (daemon.child.exitCode != null) throw new Error(readFileSync(log, 'utf8'));
            return readFileSync(log, 'utf8').includes('open ' + origin) && await api('/api/state').catch(() => null);
          }, 'isolated daemon');
          await api('/api/settings', { autoNotes: false });
          const workspace = await api('/api/workspaces', { target: roots[fixture] });
          const profile = join(dir, 'chrome');
          chrome = startProcess(chromePath, [
            '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
            '--enable-automation', '--disable-extensions', '--no-proxy-server', '--use-mock-keychain',
            '--disable-back-forward-cache',
            '--disk-cache-dir=' + join(dir, 'chrome-cache'),
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--window-size=1440,1000', '--user-data-dir=' + profile, 'about:blank',
          ], join(out, label + '-chrome.log'));
          const portFile = join(profile, 'DevToolsActivePort');
          const [port, ws] = (await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8'), 'Chrome CDP')).trim().split('\n');
          browser = await connect(`ws://127.0.0.1:${port}${ws}`);
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          cdp = await connect(targets.find(({ type }) => type === 'page').webSocketDebuggerUrl);
          cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
            console.error(exceptionDetails.exception?.description || exceptionDetails.text);
          });
          for (const domain of ['Page', 'Network', 'Performance', 'Runtime']) await cdp.send(domain + '.enable');
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${instrument})()` });
          for (const temperature of ['cold', 'warm']) {
            const sample = await runPage(browser, cdp, daemon, workspace, temperature,
              prof && join(out, `${label}-${temperature}-page.cpuprofile`));
            results.push({ variant: variant.name, fixture, temperature, run: i + 1, ...sample });
            writeFileSync(join(out, 'samples.json'), JSON.stringify(results, null, 2) + '\n');
            console.error(`${label} ${temperature}: first ${Math.round(sample.firstPaintMs)} ms, all ${Math.round(sample.allIdleMs)} ms, longest scroll frame ${sample.scroll.longestMs.toFixed(1)} ms`);
          }
        } finally {
          cdp?.close();
          browser?.close();
          await chrome?.stop();
          await daemon.stop();
        }
      }
    }
  }
  const medians = {};
  for (const variant of variants) for (const fixture of fixtures) for (const temperature of ['cold', 'warm']) {
    const rows = results.filter((r) => r.variant === variant.name && r.fixture === fixture && r.temperature === temperature)
      .map(({ run, ...r }) => ({ ...r, apiOpen: apiTotals(r.apiOpen), apiAll: apiTotals(r.apiAll) }));
    medians[[variant.name, fixture, temperature].filter(Boolean).join('-')] = numericMedians(rows);
  }
  writeFileSync(join(out, 'medians.json'), JSON.stringify(medians, null, 2) + '\n');
  console.log(JSON.stringify(medians, null, 2));
} finally {
  await stopAll();
  rmSync(temp, { recursive: true, force: true });
}
