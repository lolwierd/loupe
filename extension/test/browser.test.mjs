// The extension in a real browser, on real github.com pull request pages, with a stand-in for loupe that records what
// reaches it. Chrome for Testing (or Chromium) loads an unpacked extension from the command line; branded Chrome
// does not. Skipped unless LOUPE_EXT_CHROME names that browser's binary. Needs the network (github.com).
//   LOUPE_EXT_CHROME=/path/to/chrome node --test extension/test/browser.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launch, until, sleep } from './cdp.mjs';

const BIN = process.env.LOUPE_EXT_CHROME;
const skip = BIN ? false : 'set LOUPE_EXT_CHROME to a Chrome for Testing binary to run this';
const EXT = fileURLToPath(new URL('../', import.meta.url));
// Pull requests in a large public repository, old and settled.
const REPO = 'https://github.com/nodejs/node';

let b, stub, hits, origin, sw;
const hitsFor = (p) => hits.filter((h) => h.path === p);

before(async () => {
  if (skip) return;
  hits = [];
  stub = http.createServer((req, res) => {
    hits.push({ path: req.url, site: req.headers['sec-fetch-site'] });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>stand-in</title>');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${stub.address().port}`;
  // loupe.local resolves to nothing in this browser, so no open can reach a real loupe even before the address is set.
  b = await launch(BIN, [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--host-resolver-rules=MAP loupe.local ~NOTFOUND, MAP l.local ~NOTFOUND']);
  // The browser has service workers of its own (one is a background.js too): ours is the one with our manifest.
  const others = new Set();
  sw = await until(async () => {
    for (const t of await b.targets()) {
      if (t.type !== 'service_worker' || others.has(t.targetId)) continue;
      const s = await b.attach(t.targetId);
      const name = await b.evaluate(s, `globalThis.chrome?.runtime?.getManifest?.().name || ''`).catch(() => '');
      if (name === 'loupe for GitHub') return s;
      if (name) others.add(t.targetId);
    }
    return null;
  }, 15000, 250);
  assert.ok(sw, 'the extension loaded');
  await b.evaluate(sw, `chrome.storage.sync.set({ loupe: ${JSON.stringify(origin)} })`);
});

test('the link menu is there, for pull request links', { skip }, async () => {
  // update() fails on an id that does not exist
  const menu = await until(() => b.evaluate(sw, `new Promise((r) => chrome.contextMenus.update('open-link-in-loupe', {}, () => r(chrome.runtime.lastError?.message || 'ok')))`).then((m) => m === 'ok' && m), 5000);
  assert.equal(menu, 'ok');
});
after(async () => { await b?.close(); stub?.close(); });

async function github(url) {
  const { targetId } = await b.send('Target.createTarget', { url });
  const s = await b.attach(targetId);
  // A new target starts on about:blank, which is complete at once: wait for GitHub's own document.
  const loaded = await until(async () => (await b.evaluate(s, `location.href.startsWith('https://github.com/') && document.readyState`).catch(() => '')) === 'complete', 30000);
  assert.ok(loaded, `${url} loaded`);
  await b.send('Page.bringToFront', {}, s);
  return { targetId, s, url: async () => (await b.targets()).find((x) => x.targetId === targetId)?.url };
}
const setting = (obj) => b.evaluate(sw, `chrome.storage.sync.set(${JSON.stringify(obj)})`);

// What GitHub's own scripts would see: a listener in the page's world, on window and document, added after load.
const spy = (s) => b.evaluate(s, `window.__seen = []; for (const t of [window, document]) t.addEventListener('keydown', (e) => __seen.push(e.key), true); true`);
const seen = (s) => b.evaluate(s, 'JSON.stringify([...new Set(window.__seen)])').then(JSON.parse);

test('g then l on a pull request opens it in loupe, and GitHub never sees the l', { skip, timeout: 60000 }, async () => {
  const page = await github(`${REPO}/pull/1`);
  await spy(page.s);
  await b.key(page.s, 'g'); await b.key(page.s, 'l');
  const hit = await until(() => hitsFor('/nodejs/node/pull/1')[0]);
  assert.ok(hit, 'loupe was asked for the pull request');
  assert.equal(hit.site, 'none', 'it arrives as a typed address would, so loupe does not ask first');
  assert.deepEqual(await seen(page.s), ['g'], "the page's own listeners got the g, and not the l");
  await sleep(1500);
  assert.equal(await page.url(), `${REPO}/pull/1`, 'the GitHub tab stayed where it was');
});

test('on the files tab it opens the same pull request; in a text field it does nothing', { skip, timeout: 60000 }, async () => {
  const page = await github(`${REPO}/pull/2/files`);
  await b.key(page.s, 'g'); await b.key(page.s, 'l');
  assert.ok(await until(() => hitsFor('/nodejs/node/pull/2').length === 1), 'files tab: the bare pull request');
  await b.evaluate(page.s, `(() => { const i = document.createElement('input'); document.body.prepend(i); i.focus(); return document.activeElement === i; })()`);
  await b.key(page.s, 'g'); await b.key(page.s, 'l');
  await sleep(1500);
  assert.equal(hitsFor('/nodejs/node/pull/2').length, 1, 'typed into a field: nothing opened');
});

test('with the shortcut off, the keys are left to GitHub', { skip, timeout: 60000 }, async () => {
  await setting({ shortcut: false });
  const page = await github(`${REPO}/pull/6`);
  await spy(page.s);
  const before = hits.length;
  await b.key(page.s, 'g'); await b.key(page.s, 'l');
  await sleep(1500);
  assert.equal(hits.length, before, 'nothing opened in loupe');
  assert.deepEqual(await seen(page.s), ['g', 'l'], 'the page got both keys');
  await setting({ shortcut: true });
});

test('auto-open: a tab opened for a pull request becomes loupe, once per session', { skip, timeout: 90000 }, async () => {
  await setting({ autoOpen: true });
  const { targetId } = await b.send('Target.createTarget', { url: `${REPO}/pull/8` });
  assert.ok(await until(() => hitsFor('/nodejs/node/pull/8').length === 1, 30000), 'loupe was asked for it');
  assert.ok(await until(async () => !(await b.targets()).some((x) => x.targetId === targetId)), 'the GitHub tab was replaced');
  const again = await github(`${REPO}/pull/8/files`);
  await sleep(2500);
  assert.equal(hitsFor('/nodejs/node/pull/8').length, 1, 'the same pull request again: nothing');
  assert.ok(await again.url(), 'and the GitHub tab stays');
  // Moving to another pull request without loading a page (GitHub's pushState) opens it beside.
  // (A number no other test opened: one g l already opened counts as opened this session.)
  await b.evaluate(again.s, `history.pushState(null, '', '/nodejs/node/pull/99999/commits')`);
  assert.ok(await until(() => hitsFor('/nodejs/node/pull/99999').length === 1, 10000), 'a pushState to another pull request opens it');
  assert.ok(await again.url(), 'beside: the GitHub tab you were browsing stays');
  await setting({ autoOpen: false });
});
