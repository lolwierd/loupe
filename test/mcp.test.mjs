// A Codex chat's tools: the daemon's small MCP server over HTTP, at a URL that lives for one turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { openMcp, handleMcp } from '../src/mcp.mjs';

function call(token, msg, headers = {}, method = 'POST') {
  const req = Object.assign(Readable.from([Buffer.from(msg === undefined ? '' : JSON.stringify(msg))]), { method, headers });
  return new Promise((resolve) => {
    const res = { writeHead(code, h) { this.code = code; this.h = h; }, end(b) { resolve({ code: this.code, body: b ? JSON.parse(b) : null }); } };
    handleMcp(req, res, token);
  });
}

test('the tools answer for their turn, and to nothing a web page could send', async () => {
  const seen = [];
  const { url, close } = openMcp([{ name: 'read_guide', description: 'Read the guide.', shape: { part: z.enum(['section']).optional() }, run: async (a) => { seen.push(a); return 'The pantry restocks itself.'; } }]);
  const token = url.split('/').pop();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[\w-]{20,}$/);
  const init = await call(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.body.result.serverInfo.name, 'loupe');
  assert.equal((await call(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).code, 202);
  const list = await call(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['read_guide']);
  assert.equal(list.body.result.tools[0].inputSchema.type, 'object');
  const r = await call(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_guide', arguments: { part: 'section' } } });
  assert.equal(r.body.result.content[0].text, 'The pantry restocks itself.');
  assert.deepEqual(seen, [{ part: 'section' }]);
  const bad = await call(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_guide', arguments: { part: 'pantry' } } });
  assert.equal(bad.body.result.isError, true);
  assert.equal((await call(token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'edit_guide' } })).body.error.code, -32602);
  // a page in a browser sends an Origin: refused, token or not
  assert.equal((await call(token, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { origin: 'https://example.com' })).code, 404);
  assert.equal((await call(token, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { origin: '' })).code, 404, 'an empty Origin is still a page');
  assert.equal((await call('x'.repeat(32), { jsonrpc: '2.0', id: 7, method: 'tools/list' })).code, 404);
  close();
  assert.equal((await call(token, { jsonrpc: '2.0', id: 8, method: 'tools/list' })).code, 404, 'gone when the turn ends');
});

test('a call that arrives as its turn ends is refused', async () => {
  let ran = 0;
  const { url, close } = openMcp([{ name: 'read_guide', description: 'Read.', shape: {}, run: async () => { ran++; return 'x'; } }]);
  const token = url.split('/').pop();
  // the body arrives only after the turn is over
  const req = Object.assign(new Readable({ read() {} }), { method: 'POST', headers: {} });
  const out = new Promise((resolve) => handleMcp(req, { writeHead(c) { this.code = c; }, end(b) { resolve(JSON.parse(b)); } }, token));
  close();
  req.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_guide', arguments: {} } }))); req.push(null);
  assert.equal((await out).error.message, 'this turn is over');
  assert.equal(ran, 0);
});

test('a Stop ends a turn\'s tools at once, and stops what they were doing', async () => {
  const stopTurn = new AbortController();
  let signal = null;
  const { url } = openMcp([{ name: 'read_guide', description: 'Read.', shape: {}, run: async (a, ctx) => { signal = ctx.signal; return 'x'; } }], stopTurn.signal);
  const token = url.split('/').pop();
  await call(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_guide', arguments: {} } });
  assert.equal(signal.aborted, false);
  stopTurn.abort();
  assert.equal(signal.aborted, true, 'what the tool started is told to stop');
  assert.equal((await call(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).code, 404);
});
