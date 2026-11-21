// The service worker, with a fake chrome around it: what each message, click and loupe tab makes it do, and how
// auto-open keeps to once per pull request per browser session, across the worker going to sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { context, run, read, settle } from './load.mjs';

const area = (data = {}) => ({
  data,
  get: async (keys) => {
    if (keys === null) return { ...data };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
  },
  set: async (obj) => { Object.assign(data, obj); },
});

// One browser: storage outlives any one worker; worker() starts a fresh one, as the browser does after it sleeps.
function browser(sync = {}) {
  const b = { sync: area({ ...sync }), session: area(), created: [], removed: [], menus: [] };
  b.worker = () => {
    const on = {};
    // As Chromium's: these events take no filter, and passing one throws (and stops the worker).
    const ev = (name) => ({ addListener: (fn, filter) => { if (filter !== undefined) throw new TypeError('This event does not support filters'); on[name] = fn; } });
    const ctx = context({
      chrome: {
        runtime: { id: 'ext', onMessage: ev('message'), onInstalled: ev('installed') },
        storage: { sync: b.sync, session: b.session },
        tabs: {
          create: async (props) => { b.created.push(JSON.parse(JSON.stringify(props))); return { id: 1000 + b.created.length, ...props }; },
          remove: async (id) => { b.removed.push(id); },
          onUpdated: ev('updated'),
        },
        action: { onClicked: ev('action') },
        contextMenus: { removeAll: (cb) => { b.menus.length = 0; cb(); }, create: (item) => { b.menus.push(JSON.parse(JSON.stringify(item))); }, onClicked: ev('menu') },
      },
    });
    ctx.importScripts = (name) => vm.runInContext(read(name), ctx, { filename: name });
    run(ctx, 'background.js');
    const w = { on };
    w.message = async (msg, tab, id = 'ext') => { on.message(msg, { id, tab }); await settle(); };
    w.landed = (url, tab, fresh = true) => w.message({ type: 'landed', url, fresh }, tab);
    return w;
  };
  return b;
}
const tab = (extra = {}) => ({ id: 7, index: 3, windowId: 1, active: true, pinned: false, incognito: false, ...extra });
const PR = 'https://github.com/someone/tool/pull/42';

test('g l opens the pull request beside its tab, at the bare path, on the default address', async () => {
  const b = browser(); const w = b.worker();
  await w.message({ type: 'open', url: PR + '/files#diff-abc' }, tab());
  assert.deepEqual(b.created, [{ url: 'http://loupe.local/someone/tool/pull/42', active: true, index: 4, windowId: 1, openerTabId: 7 }]);
  await w.message({ type: 'open', url: 'https://github.com/someone/tool/issues' }, tab());
  assert.equal(b.created[1].url, 'http://loupe.local/', 'off a pull request: loupe at its root');
});

test('the address from the settings is used, and a bad one falls back to the default', async () => {
  const b = browser({ loupe: 'http://127.0.0.1:4500' }); const w = b.worker();
  await w.message({ type: 'open', url: PR }, tab());
  assert.equal(b.created[0].url, 'http://127.0.0.1:4500/someone/tool/pull/42');
  b.sync.data.loupe = 'https://github.com';
  await w.message({ type: 'open', url: PR }, tab());
  assert.equal(b.created[1].url, 'http://loupe.local/someone/tool/pull/42');
});

test('messages from anything but this extension’s own pages are ignored', async () => {
  const b = browser({ autoOpen: true }); const w = b.worker();
  await w.message({ type: 'open', url: PR }, tab(), 'another-extension');
  await w.message({ type: 'open', url: PR }, undefined);
  await w.message({ type: 'open', url: 42 }, tab());
  assert.deepEqual(b.created, []);
});

test('auto-open is off until it is turned on', async () => {
  const b = browser(); const w = b.worker();
  await w.landed(PR, tab());
  assert.deepEqual(b.created, []);
});

test('a tab opened for the pull request becomes loupe, in its place', async () => {
  const b = browser({ autoOpen: true }); const w = b.worker();
  await w.landed(PR, tab());
  assert.deepEqual(b.created, [{ url: 'http://loupe.local/someone/tool/pull/42', index: 3, windowId: 1, active: true }]);
  assert.deepEqual(b.removed, [7]);
});

test('once per pull request per session: its other tabs, other GitHub tabs, and a worker that slept open nothing', async () => {
  const b = browser({ autoOpen: true });
  await b.worker().landed(PR, tab());
  const w = b.worker();
  await w.landed(PR + '/files', tab({ id: 8 }));
  await w.landed('https://github.com/SOMEONE/Tool/pull/42/commits', tab({ id: 9 }), false);
  assert.equal(b.created.length, 1);
  await w.landed('https://github.com/someone/tool/pull/43', tab({ id: 10 }));
  assert.equal(b.created.length, 2, 'another pull request opens');
  for (const k of Object.keys(b.session.data)) delete b.session.data[k]; // the browser quit
  await b.worker().landed(PR, tab({ id: 11 }));
  assert.equal(b.created.length, 3, 'a new browser session opens it again');
});

test('two landings at once open one tab', async () => {
  const b = browser({ autoOpen: true }); const w = b.worker();
  w.on.message({ type: 'landed', url: PR, fresh: true }, { id: 'ext', tab: tab() });
  w.on.message({ type: 'landed', url: PR + '/files', fresh: false }, { id: 'ext', tab: tab({ id: 8 }) });
  await settle();
  assert.equal(b.created.length, 1);
});

test('a page reached by browsing, a pinned tab, and the beside setting keep the GitHub tab', async () => {
  const b = browser({ autoOpen: true }); const w = b.worker();
  await w.landed('https://github.com/o/r/pull/1', tab(), false);
  await w.landed('https://github.com/o/r/pull/2', tab({ pinned: true }));
  b.sync.data.autoOpenMode = 'beside';
  await w.landed('https://github.com/o/r/pull/3', tab());
  assert.deepEqual(b.created.map((c) => [c.url, c.index, c.openerTabId]), [
    ['http://loupe.local/o/r/pull/1', 4, 7], ['http://loupe.local/o/r/pull/2', 4, 7], ['http://loupe.local/o/r/pull/3', 4, 7]]);
  assert.deepEqual(b.removed, []);
});

test('the allowlist limits auto-open to its owners and repositories', async () => {
  const b = browser({ autoOpen: true, autoOpenOwners: 'acme, someone/tool' }); const w = b.worker();
  await w.landed('https://github.com/other/thing/pull/1', tab());
  await w.landed('https://github.com/someone/other/pull/1', tab());
  assert.deepEqual(b.created, []);
  await w.landed('https://github.com/Acme/anything/pull/5', tab());
  await w.landed(PR, tab());
  assert.equal(b.created.length, 2);
});

test('a pull request opened by g l, the button or the menu is not opened again on landing', async () => {
  const b = browser({ autoOpen: true }); const w = b.worker();
  await w.message({ type: 'open', url: PR }, tab());
  await w.landed(PR, tab({ id: 8 }));
  assert.equal(b.created.length, 1);
  await w.message({ type: 'open', url: PR }, tab());
  assert.equal(b.created.length, 2, 'asking again always opens');
});

test('a pull request seen in a loupe tab is not sent back from GitHub', async () => {
  const b = browser({ autoOpen: true, loupe: 'https://loupe.local' }); const w = b.worker();
  await w.on.updated(5, { url: 'https://loupe.local/someone/tool/pull/42?scope=abcdef1' });
  await w.on.updated(5, { url: 'http://127.0.0.1:4500/o/r/pull/1' });
  await w.on.updated(5, { status: 'complete' });
  await w.landed(PR, tab());
  assert.deepEqual(b.created, []);
  await w.landed('https://github.com/o/r/pull/1', tab());
  assert.equal(b.created.length, 1, 'only the configured address counts');
});

test('the toolbar button opens the tab’s pull request, or loupe’s root', async () => {
  const b = browser(); const w = b.worker();
  w.on.action(tab({ url: PR + '/checks' }));
  w.on.action(tab({ url: undefined }));
  await settle();
  assert.deepEqual(b.created.map((c) => c.url).sort(), ['http://loupe.local/', 'http://loupe.local/someone/tool/pull/42']);
});

test('the link menu is made on install for pull request links, and opens only those', async () => {
  const b = browser(); const w = b.worker();
  w.on.installed({ reason: 'install' });
  assert.deepEqual(b.menus, [{ id: 'open-link-in-loupe', title: 'Open link in loupe', contexts: ['link'], targetUrlPatterns: ['https://github.com/*/*/pull/*'] }]);
  w.on.installed({ reason: 'update' });
  assert.equal(b.menus.length, 1);
  w.on.menu({ menuItemId: 'open-link-in-loupe', linkUrl: 'https://github.com/o/r/pull/9#discussion_r1' }, tab());
  w.on.menu({ menuItemId: 'open-link-in-loupe', linkUrl: 'https://github.com/o/r/pull/abc' }, tab());
  w.on.menu({ menuItemId: 'something-else', linkUrl: PR }, tab());
  w.on.menu({ menuItemId: 'open-link-in-loupe', linkUrl: PR }, undefined);
  await settle();
  assert.deepEqual(b.created, [{ url: 'http://loupe.local/o/r/pull/9', active: true, index: 4, windowId: 1, openerTabId: 7 }, { url: 'http://loupe.local/someone/tool/pull/42', active: true }]);
});

test('an incognito tab is never auto-opened', async () => {
  const b = browser({ autoOpen: true }); const w = b.worker();
  await w.landed(PR, tab({ incognito: true }));
  assert.deepEqual(b.created, []);
});
