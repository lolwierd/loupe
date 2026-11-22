// loupe's tools for a Codex chat: a small MCP server over streamable HTTP, at a URL that lives for one turn.
// Claude gets the same tools in-process (claude.mjs); Codex connects to this instead (codex.mjs passes the URL in its
// config), the Codex process itself and not the commands it runs, which keep no network. The token in the URL is the
// key: made fresh for the turn, unguessable, and gone when the turn ends. A request with an Origin (a page in a
// browser) is refused, so no web page can drive it even with the token.
import crypto from 'node:crypto';
import { z } from 'zod';
import { PORT } from './config.mjs';

const open = new Map(); // token -> { tools, until }
const TTL = 60 * 60 * 1000;

// tools: [{ name, description, shape (a zod raw shape), run(args) -> text }]
// end a turn's tools: no call made after this commits, and any still running (a scene's check) is stopped
const shut = (token) => { const s = open.get(token); if (!s) return; clearTimeout(s.timer); s.stop.abort(); open.delete(token); };
export function openMcp(tools, signal = null) {
  const token = crypto.randomBytes(24).toString('base64url');
  const stop = new AbortController();
  const timer = setTimeout(() => shut(token), TTL); timer.unref?.(); // an hour, even if nothing asks again
  open.set(token, { tools, until: Date.now() + TTL, stop, timer });
  const close = () => shut(token);
  if (signal) { if (signal.aborted) close(); else signal.addEventListener('abort', close, { once: true }); } // Stop ends them at once
  return { url: `http://127.0.0.1:${PORT}/mcp/${token}`, close };
}

const reply = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(body === null ? '' : JSON.stringify(body)); };
async function body(req) {
  let n = 0; const parts = [];
  for await (const c of req) { n += c.length; if (n > 2 * 1024 * 1024) throw new Error('too large'); parts.push(c); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || 'null');
}

export async function handleMcp(req, res, token) {
  for (const [k, v] of open) if (v.until < Date.now()) shut(k);
  const s = open.get(token);
  if (!s || 'origin' in req.headers) return reply(res, 404, { error: 'not found' }); // any Origin, even an empty one, is a page
  if (req.method === 'GET') return reply(res, 405, null, { Allow: 'POST' }); // no stream of server messages: none are sent
  if (req.method === 'DELETE') { shut(token); return reply(res, 200, null); }
  if (req.method !== 'POST') return reply(res, 405, null, { Allow: 'POST' });
  let msg;
  try { msg = await body(req); } catch { return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  const one = async (m) => {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    if (m.id === undefined || m.id === null) return null; // a notification: nothing to answer
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'loupe', version: '1.0.0' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: s.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) })) });
      case 'tools/call': {
        const live = () => open.get(token) === s && s.until > Date.now();
        if (!live()) return { jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'this turn is over' } };
        const t = s.tools.find((x) => x.name === m.params?.name);
        if (!t) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `no tool ${m.params?.name}` } };
        const args = z.object(t.shape).safeParse(m.params?.arguments || {});
        if (!args.success) return ok({ content: [{ type: 'text', text: `Arguments refused: ${args.error.message}` }], isError: true });
        try { return ok({ content: [{ type: 'text', text: await t.run(args.data, { live, signal: s.stop.signal }) }] }); } catch (e) { return ok({ content: [{ type: 'text', text: String(e?.message || e) }], isError: true }); }
      }
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } };
    }
  };
  if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(one))).filter(Boolean); return out.length ? reply(res, 200, out) : reply(res, 202, null); }
  const out = await one(msg);
  return out ? reply(res, 200, out) : reply(res, 202, null);
}
