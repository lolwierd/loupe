// The content script itself, with a fake page around it: the real keydown listener, fed events, on a clock we move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { context, run, settle } from './load.mjs';

const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, isContentEditable: false, ...extra });
const BODY = el('BODY');

function page({ href = 'https://github.com/someone/tool/pull/42', historyLength = 1, visibility = 'visible', stored = {}, navigation = true } = {}) {
  let now = 1_000_000;
  const sent = [], keydown = [], docListeners = {}, navListeners = [], storageListeners = [];
  const runtime = { id: 'ext', sendMessage: (msg) => { sent.push(JSON.parse(JSON.stringify(msg))); return Promise.resolve(); } /* as the browser does: a copy */ };
  const hist = { length: historyLength };
  const doc = {
    visibilityState: visibility,
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
  };
  const ctx = context({
    window: { addEventListener: (type, fn, capture) => { assert.equal(type, 'keydown'); assert.equal(capture, true); keydown.push(fn); } },
    document: doc,
    location: { get href() { return href; } },
    history: hist,
    Date: { now: () => now },
    chrome: {
      runtime,
      storage: { sync: { get: async (keys) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])) }, onChanged: { addListener: (fn) => storageListeners.push(fn) } },
    },
  });
  if (navigation) ctx.navigation = { addEventListener: (t, fn) => { assert.equal(t, 'currententrychange'); navListeners.push(fn); } };
  run(ctx, 'content.js');
  assert.equal(keydown.length, 1, 'one keydown listener, registered at once');
  const press = (key, { target = BODY, ...mods } = {}) => {
    const e = { key, isTrusted: true, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, target,
      composedPath: () => [target], prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...mods };
    keydown[0](e);
    return e;
  };
  return {
    sent, runtime, press, hist,
    tick: (ms) => { now += ms; },
    go: (next) => { href = next; for (const fn of navListeners) fn(); },
    show: () => { doc.visibilityState = 'visible'; for (const fn of docListeners.visibilitychange || []) fn(); },
    change: (changes) => { for (const fn of storageListeners) fn(changes, 'sync'); },
  };
}

test('g then l on a pull request swallows the l and asks for this page in loupe', async () => {
  const p = page({ href: 'https://github.com/someone/tool/pull/42/files' });
  const g = p.press('g');
  assert.equal(g.prevented || g.stopped, false, "the g still reaches GitHub, for its own g sequences");
  p.tick(300);
  const l = p.press('l');
  assert.equal(l.prevented, true);
  assert.equal(l.stopped, true);
  assert.deepEqual(p.sent, [{ type: 'open', url: 'https://github.com/someone/tool/pull/42/files' }]);
});

test('the URL is read when the keys are pressed, not when the page loaded', () => {
  const p = page({ href: 'https://github.com/someone/tool' });
  p.go('https://github.com/someone/tool/pull/7/commits');
  p.press('g'); p.press('l');
  assert.equal(p.sent.at(-1).url, 'https://github.com/someone/tool/pull/7/commits');
});

test('keys typed into a field, or with a modifier, or too slowly, are left to GitHub', () => {
  const p = page();
  for (const target of [el('INPUT', { type: 'text' }), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true })]) {
    p.press('g', { target });
    const l = p.press('l', { target });
    assert.equal(l.prevented, false, target.tagName);
  }
  p.press('g', { target: el('TEXTAREA') });
  assert.equal(p.press('l').prevented, false, 'a g typed in a field does not start the sequence');
  p.press('g'); assert.equal(p.press('l', { metaKey: true }).prevented, false, 'meta');
  p.press('g'); assert.equal(p.press('l', { ctrlKey: true }).prevented, false, 'ctrl');
  p.press('g'); p.tick(1600); assert.equal(p.press('l').prevented, false, 'after 1.6 s');
  p.press('g'); assert.equal(p.press('l', { isTrusted: false }).prevented, false, 'an event a page script made');
  assert.deepEqual(p.sent, []);
  p.press('g', { target: el('INPUT', { type: 'checkbox' }) });
  assert.equal(p.press('l', { target: el('INPUT', { type: 'checkbox' }) }).prevented, true, 'a focused check box takes no text');
});

test('the shortcut can be turned off, and back on, without a reload', async () => {
  const p = page({ stored: { shortcut: false } });
  await settle();
  p.press('g'); assert.equal(p.press('l').prevented, false);
  p.change({ shortcut: { newValue: true } });
  p.press('g'); assert.equal(p.press('l').prevented, true);
  p.change({ shortcut: { newValue: false } });
  p.press('g'); assert.equal(p.press('l').prevented, false);
});

test('the shortcut works before storage answers', () => {
  const p = page({ stored: { shortcut: true } });
  p.press('g');
  assert.equal(p.press('l').prevented, true);
});

test('after the extension is reloaded, the page keeps GitHub’s own g l', () => {
  const p = page();
  delete p.runtime.id;
  p.press('g');
  assert.equal(p.press('l').prevented, false);
  assert.deepEqual(p.sent, []);
});

test('landing on a pull request is reported only with auto-open on, once per pull request in the tab', async () => {
  const off = page();
  await settle();
  assert.deepEqual(off.sent, [], 'auto-open is off by default');

  const p = page({ stored: { autoOpen: true } });
  await settle();
  assert.deepEqual(p.sent, [{ type: 'landed', url: 'https://github.com/someone/tool/pull/42', fresh: true }]);
  p.go('https://github.com/someone/tool/pull/42/files');
  p.go('https://github.com/someone/tool/pull/42/files#diff-abc');
  await settle();
  assert.equal(p.sent.length, 1, 'moving between the tabs of one pull request reports nothing more');
  p.go('https://github.com/someone/tool/pulls');
  p.go('https://github.com/someone/tool/pull/43');
  await settle();
  assert.deepEqual(p.sent.at(-1), { type: 'landed', url: 'https://github.com/someone/tool/pull/43', fresh: false }, 'browsing to another one is not fresh');
});

test('a tab with history behind it is not fresh', async () => {
  const p = page({ stored: { autoOpen: true }, historyLength: 3 });
  await settle();
  assert.equal(p.sent[0].fresh, false);
});

test('a tab in the background reports when it is first looked at', async () => {
  const p = page({ stored: { autoOpen: true }, visibility: 'hidden' });
  await settle();
  assert.deepEqual(p.sent, []);
  p.show();
  await settle();
  assert.deepEqual(p.sent, [{ type: 'landed', url: 'https://github.com/someone/tool/pull/42', fresh: true }]);
  p.show();
  assert.equal(p.sent.length, 1);
});

test('a page that joins a tab with history before it is shown is not fresh', async () => {
  const p = page({ stored: { autoOpen: true }, visibility: 'hidden' });
  await settle();
  p.hist.length = 4; // a prerendered page, activated in a tab you were browsing in
  p.show();
  await settle();
  assert.deepEqual(p.sent, [{ type: 'landed', url: 'https://github.com/someone/tool/pull/42', fresh: false }]);
});

test('a page off a pull request reports nothing, and a browser without the Navigation API still reports the landing', async () => {
  const p = page({ stored: { autoOpen: true }, href: 'https://github.com/someone/tool/issues/3' });
  await settle();
  assert.deepEqual(p.sent, []);
  const q = page({ stored: { autoOpen: true }, navigation: false });
  await settle();
  assert.equal(q.sent.length, 1);
});
