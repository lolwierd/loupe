// A scene is looked at before it is kept: loupe renders its document in a headless Chrome the way the card shows it
// (in a sandboxed frame at the card's width, in light and in dark) and collects what went wrong (errors, loads the
// frame refused, content that does not fit, a frame with nothing in it) and stills its writer then looks at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { BIN, STATE_DIR } from './config.mjs';

// drafts the check renders, by an unguessable token, for a few minutes (served at /scene-doc/draft/<token>)
export const drafts = new Map();
const draft = (html) => { const token = crypto.randomBytes(18).toString('hex'); drafts.set(token, { html, until: Date.now() + 5 * 60 * 1000 }); return token; };
export const takeDraft = (token) => { const d = drafts.get(token); if (!d || d.until < Date.now()) { drafts.delete(token); return null; } return d.html; };

// The page a scene's document is served as. Its policy sandboxes it (so it runs at an opaque origin even opened in a
// tab), allows no network at all (WebRTC, which no policy closes, the shim takes away) and lets only loupe frame it.
// The theme comes in the address: loupe's colour and type tokens, each checked to be a plain value (no url, no way out
// of the declaration), set on :root.
export const DOC_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
// resource hints (preconnect, dns-prefetch, prefetch, preload, prerender) taken out of a scene: a browser may act on one
// before or around its content policy, and a scene has no use for any
const unhinted = (html) => String(html).replace(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\b(?:preconnect|dns-prefetch|prefetch|preload|modulepreload|prerender)\b[^>]*>/gi, '');
export function docPage(html, t, { shim = '', kit = '' } = {}) {
  let theme = {};
  try { theme = JSON.parse(t || '{}') || {}; } catch {}
  const ok = ([k, v]) => /^--[\w-]{1,40}$/.test(k) && typeof v === 'string' && /^[\w\s#(),.%'"-]{1,200}$/.test(v) && !/url|expression|[;{}<>\\]/i.test(v);
  const vars = Object.entries(theme.vars && typeof theme.vars === 'object' ? theme.vars : {}).filter(ok).map(([k, v]) => `${k}:${v}`).join(';');
  const dark = theme.dark === true;
  return {
    // Connection-Allowlist: no connections at all, where Chrome enforces it (resource hints can slip past a content policy)
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': DOC_POLICY, 'Connection-Allowlist': '()', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off', 'Cross-Origin-Resource-Policy': 'same-origin' },
    body: `<!doctype html><html lang="en" data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><style>:root{${vars};color-scheme:${dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent}</style><script>${shim}</script><script>${kit}</script></head><body>${unhinted(html)}</body></html>`,
  };
}

// How much of a still is drawn: the share of its pixels that differ from its commonest colour (its paper). A PNG as
// Chrome writes it (8-bit RGB or RGBA, not interlaced), decoded here so a frame that paints nothing is seen as such
// however many elements it holds.
export function inkOf(png) {
  try {
    let at = 8, w = 0, h = 0, type = 0; const idat = [];
    while (at < png.length) {
      const len = png.readUInt32BE(at), kind = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + len);
      if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12] !== 0) return null; }
      else if (kind === 'IDAT') idat.push(data);
      else if (kind === 'IEND') break;
      at += 12 + len;
    }
    const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
    if (!bpp || !w || !h) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[o + x - bpp] : 0, b = y ? px[o - stride + x] : 0, c = x >= bpp && y ? px[o - stride + x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        px[o + x] = (row[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
      }
    }
    const count = new Map(); let top = 0, paper = 0;
    for (let i = 0; i < px.length; i += bpp * 7) { const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2], n = (count.get(k) || 0) + 1; count.set(k, n); if (n > top) { top = n; paper = k; } }
    let ink = 0, all = 0;
    for (let i = 0; i < px.length; i += bpp) { all++; if (Math.abs(px[i] - (paper >> 16)) + Math.abs(px[i + 1] - ((paper >> 8) & 255)) + Math.abs(px[i + 2] - (paper & 255)) > 36) ink++; }
    return ink / all;
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTH = 680; // the map card's scene, as most readers see it

// Chrome, driven over a pipe (no debugging port anything else on the machine could reach), in a process group of its
// own so every process it starts goes with it; its profile is removed once it has gone.
function chromeOverPipe(prof) {
  // it reaches nothing but loupe at 127.0.0.1: every other name fails to resolve, and Chrome's own calls home are off
  const child = spawn(BIN.chrome, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${prof}`, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--dns-prefetch-disable', '--no-pings', '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true });
  const wait = new Map(), out = child.stdio[3], inp = child.stdio[4];
  let id = 0, buf = '', dead = null;
  const fail = (why) => { if (dead) return; dead = why; for (const [, w] of wait) w.reject(new Error(why)); wait.clear(); };
  inp.on('data', (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf('\0')) >= 0) {
      const raw = buf.slice(0, k); buf = buf.slice(k + 1);
      let m = null; try { m = JSON.parse(raw); } catch { continue; }
      const w = m.id && wait.get(m.id);
      if (w) { wait.delete(m.id); clearTimeout(w.t); m.error ? w.reject(new Error(m.error.message || 'Chrome refused')) : w.resolve(m.result || {}); }
    }
  });
  let exited = false;
  const gone = new Promise((r) => { child.once('exit', () => { exited = true; r(); }); child.once('error', () => { exited = true; r(); }); });
  child.on('exit', () => fail('Chrome went away')); child.on('error', (e) => fail(`Chrome did not start: ${e.message}`));
  for (const p of [inp, out]) { p.on('error', () => fail('Chrome went away')); p.on('close', () => fail('Chrome went away')); }
  // every call has a deadline: a command Chrome never answers fails instead of waiting forever
  const send = (method, params = {}, sessionId = undefined, ms = 15000) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(dead));
    const n = ++id, t = setTimeout(() => { wait.delete(n); reject(new Error(`Chrome did not answer ${method}`)); }, ms);
    wait.set(n, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); }, t });
    out.write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  // the whole group goes; its profile is removed once it has gone (a Chrome still running is left its folder)
  const kill = async () => { fail('stopped'); if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } } await Promise.race([gone, sleep(5000)]); if (exited || !child.pid) await fs.promises.rm(prof, { recursive: true, force: true }).catch(() => {}); };
  return { send, kill };
}

// renderScene(html, { origin, height, signal }) ->
//   { unavailable } when there is no Chrome to render it in (the scene is kept without being looked at),
//   { failed } when it could not be rendered (it is not kept on that), or
//   { problem, errors, cut, shots: [{ theme, at, file }], dir }; stills land in dir, which its writer may read
export async function renderScene(html, { origin, height = 320, signal = null, times = { light: [1000, 4000], dark: [2500] } } = {}) {
  if (signal?.aborted) return { failed: 'stopped' }; // stopped before it began: no Chrome, no folders, on any machine
  if (!BIN.chrome) return { unavailable: 'no Chrome to render it in' };
  const dir = fs.mkdtempSync(path.join(STATE_DIR, 'tmp-scene-')), prof = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-chrome-'));
  const token = draft(html), errors = [], shots = [], cut = [], reports = [];
  const chrome = chromeOverPipe(prof);
  let done = false, dt = null;
  const deadline = new Promise((_, j) => { dt = setTimeout(() => j(new Error('it took over 90 seconds to render')), 90 * 1000); signal?.addEventListener('abort', () => j(new Error('stopped')), { once: true }); });
  deadline.catch(() => {}); // it loses the race when the render finishes first; that is not an error
  const run = async () => {
    const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p, ms) => chrome.send(m, p, sessionId, ms);
    const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
    for (const theme of ['light', 'dark']) {
      await send('Emulation.setDeviceMetricsOverride', { width: WIDTH + 20, height: height + 20, deviceScaleFactor: 2, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      // the host page, loaded: asked until it says so (a busy machine is slow to swap documents)
      const pass = `?pass=${theme}-${crypto.randomBytes(6).toString('hex')}`; // its own address, so the last pass's page cannot answer for it
      const nav = await send('Page.navigate', { url: `${origin}/scene-host${pass}` });
      if (nav.errorText) throw new Error(`the host page did not load: ${nav.errorText}`);
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) { ready = await ev(`location.search === '${pass}' && document.readyState === 'complete'`).catch(() => false); if (!ready) await sleep(100); }
      if (!ready) throw new Error('the host page did not load');
      // the frame as the card makes it: loupe's colours and type passed in, sandboxed, the card's width; what it says is
      // kept small and few here, before any of it comes back
      const ok = await ev(`(async () => {
        const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
        const keys = ['--bg', '--chrome', '--ink', '--ink-2', '--ink-3', '--rule', '--rule-strong', '--on-act', '--ok', '--warn', '--danger', '--pencil', '--shade', '--shade-3', '--lit', '--f-ui', '--f-mono'];
        const vars = Object.fromEntries(keys.map((k) => [k, v(k)]).filter(([, x]) => x));
        window.__got = []; window.__report = null; window.__asked = false;
        const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts');
        f.style.cssText = 'position:absolute;left:10px;top:10px;width:${WIDTH}px;height:${height}px;border:0';
        f.src = '/scene-doc/draft/${token}?t=' + encodeURIComponent(JSON.stringify({ dark: ${theme === 'dark'}, vars }));
        const s = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
        addEventListener('message', (e) => {
          if (e.source !== f.contentWindow) return;
          const m = e.data && typeof e.data === 'object' ? e.data : {}, n = (x) => (Number.isInteger(x) && x >= 0 ? x : null);
          // the one report asked for has a place of its own, so errors cannot crowd it out
          if (m.type === 'report' && window.__asked && !window.__report) { const r = { nodes: n(m.nodes), text: n(m.text), canvases: n(m.canvases) }; if (r.nodes !== null && r.text !== null && r.canvases !== null) window.__report = { ...r, cut: Array.isArray(m.cut) ? m.cut.slice(0, 6).map((c) => s(c, 200)) : [] }; }
          else if (m.type === 'error' && window.__got.length < 30) window.__got.push({ type: 'error', message: s(m.message, 300) });
        });
        document.body.append(f); window.__f = f;
        await new Promise((r) => { f.addEventListener('load', r); setTimeout(r, 5000); });
        return true;
      })()`);
      if (!ok) throw new Error('the frame did not load');
      const t0 = Date.now();
      for (const at of times[theme]) {
        await sleep(Math.max(0, at - (Date.now() - t0)));
        const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 10, y: 10, width: WIDTH, height, scale: 0.5 } }); // at 1×: enough to judge, a quarter of the image to read
        if (r.data) { const file = path.join(dir, `${theme}-${String(at).padStart(5, '0')}ms.png`), png = Buffer.from(r.data, 'base64'); fs.writeFileSync(file, png); shots.push({ theme, at, file, ink: inkOf(png) }); }
      }
      await ev('window.__asked = true; window.__f.contentWindow.postMessage({ type: "report" }, "*")'); await sleep(300);
      for (const m of (await ev('window.__got')) || []) if (m.message && errors.length < 8 && !errors.includes(m.message)) errors.push(m.message);
      const rep = await ev('window.__report');
      reports.push({ theme, ...(rep || {}), answered: !!rep, shots: shots.filter((x) => x.theme === theme).length });
      for (const c of rep?.cut || []) { const line = theme === 'dark' ? `in dark, ${c}` : c; if (cut.length < 6 && !cut.includes(c) && !cut.includes(line)) cut.push(line); }
    }
  };
  try {
    // only a Chrome that keeps the scene's connections shut (Connection-Allowlist, from 152) runs one here
    const major = Number(/\/(\d+)\./.exec((await chrome.send('Browser.getVersion')).product || '')?.[1]);
    if (!(major >= 152)) return { unavailable: `Chrome ${major || '(version unknown)'} is too old to render a scene in (152 or later)` };
    await Promise.race([run(), deadline]);
    // each theme on its own: a frame of it captured, and the scene answering in it with something drawn
    const lost = reports.find((m) => !m.shots);
    if (!shots.length || lost) return { failed: `no frame could be captured${lost ? ` in ${lost.theme}` : ''}` };
    done = true;
    // blank: every still of a theme with (next to) nothing drawn on it, whatever its document holds
    // a theme is bare when every still of it that could be read is (next to) empty and at least one could be read
    const bare = (theme) => { const read = shots.filter((x) => x.theme === theme && x.ink !== null); return read.length > 0 && read.every((x) => x.ink < 0.0005); };
    // the pixels decide; the element count only where a still could not be read
    const seenAny = (theme) => shots.some((x) => x.theme === theme && x.ink !== null);
    const silent = reports.find((m) => !m.answered), blank = reports.find((m) => (seenAny(m.theme) ? bare(m.theme) : m.answered && m.nodes < 3 && !m.canvases && m.text < 4));
    const where = (m) => (m.theme === 'dark' ? ' in dark' : '');
    const problem = silent ? `it did not answer when loupe looked at it${where(silent)} (its code may not have run)` : blank ? `it renders nothing${where(blank)}: the frame stayed empty` : null;
    return { problem, errors, cut, shots, dir };
  } catch (e) {
    return { failed: String(e.message || e).slice(0, 200) };
  } finally {
    clearTimeout(dt);
    drafts.delete(token);
    await chrome.kill();
    if (!done) fs.rm(dir, { recursive: true, force: true }, () => {}); // stills of a render that did not finish are no one's
  }
}

// what the check found, as the writer is told it
export function renderNotes(r) {
  const lines = [];
  if (r.problem) lines.push(`- ${r.problem}`);
  for (const e of r.errors || []) lines.push(`- error: ${e}`);
  for (const c of r.cut || []) lines.push(`- ${c}`);
  return lines.join('\n');
}
