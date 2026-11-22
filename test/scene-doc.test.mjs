// A scene's document as loupe serves it: a sandboxing policy with no network, framed only by loupe, and a theme taken
// from the address only as plain values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOUPE_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-'));
const { docPage, DOC_POLICY, renderNotes } = await import('../src/scene-render.mjs');

test('the document is sandboxed by its own policy, with no network and no framing but loupe\'s', () => {
  const { headers, body } = docPage('<p>hi</p>', null);
  const csp = headers['Content-Security-Policy'];
  assert.equal(csp, DOC_POLICY);
  for (const part of ['sandbox allow-scripts', "default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/allow-same-origin|allow-popups|allow-top-navigation|allow-forms/.test(csp));
  assert.equal(headers['X-DNS-Prefetch-Control'], 'off');
  assert.match(body, /<body><p>hi<\/p><\/body>/);
});

test('the theme in the address is taken only as plain values', () => {
  const t = JSON.stringify({ dark: true, vars: { '--ink': '#111', '--f-ui': '-apple-system, "SF Pro Text", sans-serif', '--bad': 'red;} body{background:url(http://x)}', '--worse': 'url(http://x)', '--out': '</style><script>alert(1)</script>', 'no-dashes': '#fff' } });
  const { body } = docPage('', t);
  assert.match(body, /--ink:#111/); assert.match(body, /--f-ui:-apple-system, "SF Pro Text", sans-serif/);
  assert.ok(!body.includes('--bad') && !body.includes('--worse') && !body.includes('--out') && !body.includes('no-dashes'));
  assert.match(body, /data-theme="dark"/);
  assert.match(docPage('', JSON.stringify({ dark: 'yes' })).body, /data-theme="light"/, 'dark only when it is true');
  assert.match(docPage('', '{not json').body, /data-theme="light"/);
});

test('the shim takes WebRTC away before the scene runs, and the check says what it found', () => {
  const shim = fs.readFileSync(new URL('../web/js/scene-doc.js', import.meta.url), 'utf8');
  assert.match(shim, /RTCPeerConnection/); assert.match(shim, /configurable: false/);
  assert.equal(renderNotes({ problem: 'it renders nothing', errors: ['x is not defined'], cut: ['the text "a" is cut off in its box'] }), '- it renders nothing\n- error: x is not defined\n- the text "a" is cut off in its box');
  assert.equal(renderNotes({ errors: [], cut: [] }), '');
});

test('resource hints are taken out of a scene before it is served, and no connection at all is allowed', () => {
  const { headers, body } = docPage('<link rel="preconnect" href="https://x.example"><link rel=dns-prefetch href=//y.example><LINK REL="prefetch" HREF="/z"><link rel="stylesheet" href="data:text/css,"><p>kept</p>', null);
  assert.equal(headers['Connection-Allowlist'], '()');
  assert.ok(!/preconnect|dns-prefetch|prefetch/i.test(body.split('<body>')[1]), body);
  assert.match(body, /<link rel="stylesheet" href="data:text\/css,"><p>kept<\/p>/);
});
