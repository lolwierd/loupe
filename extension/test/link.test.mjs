import { test } from 'node:test';
import assert from 'node:assert/strict';
import { context, read, EXT } from './load.mjs';
import fs from 'node:fs';

const L = context().loupeLink;
const pr = (href) => { const p = L.parsePr(href); return p && { ...p }; };

test('every tab of a pull request names the same pull request', () => {
  const base = 'https://github.com/someone/tool/pull/42';
  for (const [suffix, tab] of [['', 'conversation'], ['/', 'conversation'], ['/files', 'files'], ['/changes', 'changes'],
    ['/commits', 'commits'], ['/checks', 'checks'], ['/files/1a2b3c4..9f8e7d6', 'files'], ['?w=1', 'conversation'],
    ['#issuecomment-123', 'conversation'], ['/files#diff-0123abcdR12', 'files'], ['#discussion_r456', 'conversation'],
    ['/files?diff=split&w=1', 'files'], ['?notification_referrer_id=abc', 'conversation']]) {
    const p = pr(base + suffix);
    assert.deepEqual({ owner: p.owner, repo: p.repo, number: p.number, tab: p.tab }, { owner: 'someone', repo: 'tool', number: 42, tab }, suffix);
    assert.equal(p.commit, undefined, suffix);
    assert.equal(L.loupeUrlFor(base + suffix, 'http://loupe.local'), 'http://loupe.local/someone/tool/pull/42', suffix);
  }
});

test('a commit of a pull request opens as that commit, a range as the whole change', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(pr(`https://github.com/o/r/pull/7/commits/${sha}`).commit, sha);
  assert.equal(L.loupeUrlFor(`https://github.com/o/r/pull/7/commits/${sha}`, 'http://loupe.local'), `http://loupe.local/o/r/pull/7?scope=${sha}`);
  assert.equal(L.loupeUrlFor('https://github.com/o/r/pull/7/files/ABCDEF1', 'http://loupe.local'), 'http://loupe.local/o/r/pull/7?scope=abcdef1');
  assert.equal(L.loupeUrlFor('https://github.com/o/r/pull/7/files/abcdef1..1234567', 'http://loupe.local'), 'http://loupe.local/o/r/pull/7');
  assert.equal(L.loupeUrlFor('https://github.com/o/r/pull/7/commits/not-a-sha', 'http://loupe.local'), 'http://loupe.local/o/r/pull/7');
});

test('names keep their case and their dots, dashes and underscores', () => {
  const p = pr('https://github.com/Some-Org/my.repo_v2/pull/3070/files');
  assert.equal(p.owner, 'Some-Org');
  assert.equal(p.repo, 'my.repo_v2');
  assert.equal(L.prKey(p), 'some-org/my.repo_v2#3070');
});

test('pages that are not a pull request open loupe at its root', () => {
  for (const href of ['https://github.com/', 'https://github.com/someone/tool', 'https://github.com/someone/tool/pulls',
    'https://github.com/someone/tool/issues/5', 'https://github.com/someone/tool/pull/', 'https://github.com/someone/tool/pull/abc',
    'https://github.com/someone/tool/pull/0', 'https://github.com/someone/tool/labels', 'https://github.com/notifications',
    'https://github.com/pulls', 'https://github.com/someone/tool/compare/main...topic', 'https://github.com/someone/tool/commit/abcdef1']) {
    assert.equal(L.parsePr(href), null, href);
    assert.equal(L.loupeUrlFor(href, 'http://loupe.local'), 'http://loupe.local/', href);
  }
});

test("enterprise-looking paths and hosts are not taken for a pull request", () => {
  for (const href of ['https://github.com/enterprises/acme/pull/1', 'https://github.com/orgs/acme/pull/1',
    'https://github.com/settings/tool/pull/1', 'https://github.com/organizations/acme/settings/pull/1',
    'https://github.acme-corp.example/someone/tool/pull/1', 'https://git.example.com/someone/tool/pull/1',
    'https://github.com.example.net/someone/tool/pull/1', 'https://api.github.com/repos/someone/tool/pulls/1',
    'https://gist.github.com/someone/tool/pull/1', 'http://github.com/someone/tool/pull/1', 'not a url', '']) {
    assert.equal(L.parsePr(href), null, href);
  }
});

test('the address is read as an origin, and GitHub itself is refused', () => {
  const ok = (input, origin) => assert.deepEqual({ ...L.normalizeBase(input) }, { ok: true, origin }, String(input));
  ok('', 'http://loupe.local');
  ok(undefined, 'http://loupe.local');
  ok('loupe.local', 'http://loupe.local');
  ok('  http://loupe.local/  ', 'http://loupe.local');
  ok('https://loupe.local/home?x=1#y', 'https://loupe.local');
  ok('127.0.0.1:4500', 'http://127.0.0.1:4500');
  ok('http://localhost:4500/', 'http://localhost:4500');
  ok('l.local', 'http://loupe.local');
  ok('http://l.local:4500', 'http://loupe.local:4500');
  ok('HTTP://LOUPE.LOCAL', 'http://loupe.local');
  for (const bad of ['github.com', 'https://github.com/someone', 'https://www.github.com', 'ftp://loupe.local', 'http://me:pw@loupe.local', 'http://not an address']) {
    assert.equal(L.normalizeBase(bad).ok, false, bad);
  }
  assert.equal(L.baseOf('https://github.com'), 'http://loupe.local');
  assert.equal(L.loupeUrlFor('https://github.com/o/r/pull/1', 'http://127.0.0.1:4500/'), 'http://127.0.0.1:4500/o/r/pull/1');
});

test('access is asked for by scheme and host, which covers every port', () => {
  assert.equal(L.permissionPattern('http://127.0.0.1:4500'), 'http://127.0.0.1/*');
  assert.equal(L.permissionPattern('https://loupe.local'), 'https://loupe.local/*');
  assert.equal(L.permissionPattern('http://[::1]:4500'), 'http://[::1]/*');
});

test('a loupe tab names its pull request only on the configured address', () => {
  assert.equal(L.prKey(L.parseLoupePr('http://loupe.local/o/r/pull/9?scope=abcdef1', 'http://loupe.local')), 'o/r#9');
  assert.equal(L.parseLoupePr('http://loupe.local/home', 'http://loupe.local'), null);
  assert.equal(L.parseLoupePr('http://127.0.0.1:4500/o/r/pull/9', 'http://loupe.local'), null);
  assert.equal(L.parseLoupePr('https://github.com/o/r/pull/9', 'http://loupe.local'), null);
});

test('the allowlist takes owners and owner/repo, and empty lets everyone', () => {
  const p = L.parsePr('https://github.com/Acme/Tool/pull/1');
  assert.equal(L.ownerAllowed(p, ''), true);
  assert.equal(L.ownerAllowed(p, '   '), true);
  assert.equal(L.ownerAllowed(p, 'acme'), true);
  assert.equal(L.ownerAllowed(p, 'other, @acme'), true);
  assert.equal(L.ownerAllowed(p, 'acme/tool'), true);
  assert.equal(L.ownerAllowed(p, 'https://github.com/acme/'), true);
  assert.equal(L.ownerAllowed(p, 'acme/other other'), false);
  assert.equal(L.ownerAllowed(p, 'acm'), false);
  assert.deepEqual([...L.parseOwners('a,b  c/d,,\n@e')], ['a', 'b', 'c/d', 'e']);
});

test('only fields that take text count as typing', () => {
  const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, isContentEditable: false, ...extra });
  assert.equal(L.isTyping(el('INPUT', { type: 'text' })), true);
  assert.equal(L.isTyping(el('INPUT', { type: 'search' })), true);
  assert.equal(L.isTyping(el('INPUT', { type: '' })), true);
  assert.equal(L.isTyping(el('TEXTAREA')), true);
  assert.equal(L.isTyping(el('SELECT')), true);
  assert.equal(L.isTyping(el('DIV', { isContentEditable: true })), true);
  assert.equal(L.isTyping(el('INPUT', { type: 'checkbox' })), false);
  assert.equal(L.isTyping(el('INPUT', { type: 'radio' })), false);
  assert.equal(L.isTyping(el('BUTTON')), false);
  assert.equal(L.isTyping(el('BODY')), false);
  assert.equal(L.isTyping(null), false);
  assert.equal(L.isTyping({ nodeType: 3 }), false);
});

test('g then l completes within 1.5 s, and anything between or held breaks it', () => {
  const k = (key, extra = {}) => ({ key, ...extra });
  const s = L.createSequence(1500);
  assert.equal(s.step(k('g'), 0), 'start');
  assert.equal(s.step(k('l'), 400), 'done');
  assert.equal(s.step(k('l'), 500), null, 'an l alone does nothing');
  s.step(k('g'), 1000); assert.equal(s.step(k('l'), 2500), 'done', 'at exactly 1.5 s');
  s.step(k('g'), 3000); assert.equal(s.step(k('l'), 4501), null, 'past 1.5 s');
  s.step(k('g'), 5000); s.step(k('x'), 5100); assert.equal(s.step(k('l'), 5200), null, 'another key between');
  s.step(k('g'), 6000); s.step(k('g'), 6100); assert.equal(s.step(k('l'), 6200), 'done', 'g g l');
  s.step(k('g'), 7000); s.step(k('Shift'), 7050); assert.equal(s.step(k('l'), 7100), 'done', 'a modifier pressed alone between');
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    s.step(k('g'), 8000); assert.equal(s.step(k('l', { [mod]: true }), 8100), null, mod + ' on the l');
    assert.equal(s.step(k('g', { [mod]: true }), 8200), null, mod + ' on the g');
    assert.equal(s.step(k('l'), 8300), null, 'after ' + mod + ' on the g');
  }
  s.step(k('g'), 9000); assert.equal(s.step(k('l', { repeat: true }), 9100), null, 'a held l');
  s.step(k('g'), 9500); assert.equal(s.step(k('l', { isComposing: true }), 9600), null, 'mid-composition');
  s.step(k('g'), 9700); assert.equal(s.step(k('L'), 9800), null, 'a capital L');
});

test('the manifest asks for storage, the link menu and github.com, and loupe only on request', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions, ['storage', 'contextMenus']);
  assert.deepEqual(m.host_permissions, ['https://github.com/*']);
  for (const p of m.optional_host_permissions) assert.match(p, /^https?:\/\/(\*\.local|localhost|127\.0\.0\.1|\[::1\])\/\*$/);
  assert.deepEqual(m.content_scripts, [{ matches: ['https://github.com/*'], js: ['link.js', 'content.js'], run_at: 'document_start' }]);
  const files = [m.background.service_worker, m.options_ui.page, ...m.content_scripts[0].js, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  for (const f of files) assert.ok(fs.existsSync(new URL(f, EXT)), f);
});
