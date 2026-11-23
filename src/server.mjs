// The daemon: one HTTP server for every workspace, on 127.0.0.1:<port> and (optionally) port 80 so
// http://loupe.local works with no port. macOS lets a normal user bind :80 only on the wildcard address, so that
// listener destroys every connection that is not from this machine before reading a byte. Every request must
// name loupe's own host (no DNS rebinding), and every request that changes something must come from loupe's own
// page or the CLI (no cross-site requests). With a certificate in <state>/tls the same handler also answers on https
// (docs/HTTPS.md), and l.local, a typing shortcut, only redirects to loupe.local.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { keepModelsCurrent, reach } from './models.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { WEB, ROOT, PORT, HOSTNAME, SHORT_HOSTNAME, TLS_DIR, NAME, VERSION, MODELS, EFFORTS, DEFAULTS, BIN, STATE_DIR, modelKind, lineOf } from './config.mjs';
import * as W from './workspaces.mjs';
import * as C from './claude.mjs';
import * as G from './guide.mjs';
import { handleMcp } from './mcp.mjs';
import { takeDraft, docPage } from './scene-render.mjs';
import * as L from './live.mjs';
import * as A from './actions.mjs';
import { stackFor } from './stacks.mjs';
import { highlightJSON, initHighlightCache, primeHighlight } from './highlight-cache.mjs';
import { goplsFor, lspState, stopAll, readableExternal, lineAt } from './lsp.mjs';
import { uid, safeRel } from './util.mjs';
import { WORKTREE, searchRepository, citationLine, readAt } from './git.mjs';
import { git as gitOut } from './util.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const BOOT = Date.now().toString(36);
let DISPLAY = `http://127.0.0.1:${PORT}`; // the address to hand out: set once the listeners are up
let HTTPS_ORIGIN;
const USER = (() => { try { return execFileSync(BIN.git, ['config', '--global', 'user.name']).toString().trim(); } catch { return ''; } })() || process.env.USER || 'you';

// ------------------------------------------------------------------ request hygiene
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOSTS = new Set([HOSTNAME, 'localhost', '127.0.0.1', '[::1]']);
const hostName = (h) => String(h || '').replace(/:\d+$/, '').toLowerCase();
const hostOk = (h) => !!h && HOSTS.has(hostName(h));
// The short host is kept out of HOSTS on purpose: it answers nothing but a redirect, and no page is ever served from
// it, so an Origin naming it is not loupe's.
const SHORT = new Set(SHORT_HOSTNAME ? [SHORT_HOSTNAME] : []);
const originOk = (o) => { try { return hostOk(new URL(o).host); } catch { return false; } };

function send(res, code, obj) {
  return sendJSON(res, code, JSON.stringify(obj));
}
function sendJSON(res, code, json) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('the body is not JSON')); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ------------------------------------------------------------------ events for the launcher (workspace list)
const homeClients = new Set();
function homeEmit(event, data) { for (const r of homeClients) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
setInterval(() => {
  for (const r of homeClients) r.write(': keep-alive\n\n');
  for (const ws of W.all()) for (const r of ws.clients) r.write(': keep-alive\n\n');
}, 20000).unref();

// The page reloads itself when its own files change (developing loupe).
let webStamp = 0;
// Every listed model is the newest of its line, so it is named by the line alone (Opus, Sonnet, Sol, Luna); the label
// with its version stays as full, for a title.
const lineName = (id, label) => { const l = lineOf(id); return l ? l.replace(/^gpt:/, '').replace(/^./, (c) => c.toUpperCase()) : label; };
const modelState = () => ({ models: MODELS.map(([id, label]) => ({ id, label: lineName(id, label), full: label, kind: modelKind(id) })), efforts: EFFORTS, defaults: DEFAULTS });
function watchWeb() {
  try {
    fs.watch(WEB, { recursive: true }, (_, file) => { if (String(file || '').startsWith('proto')) return; /* design prototypes are not the app */ webStamp = Date.now(); for (const ws of W.all()) ws.emit('page', {}); homeEmit('page', {}); });
  } catch { /* fine */ }
}

// ------------------------------------------------------------------ routes
async function route(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // static
  if (method === 'GET' && p.startsWith('/web/')) {
    const file = path.join(WEB, path.normalize(p.slice(5)));
    if (!file.startsWith(WEB + path.sep)) return send(res, 404, { error: 'not found' });
    return serveFile(res, file);
  }
  // a scene written as a document: the model's HTML, CSS and JS, served with no network and sandboxed by its own policy
  // (so even opened in a tab it runs at an opaque origin), framed only by loupe; the theme arrives in the address
  const sd = /^\/scene-doc\/([\w.-]+)\/([\w-]{4,40})$/.exec(p);
  if (method === 'GET' && sd) {
    // only ever as a frame (a scene opened as a page of its own could navigate its tab); browsers say what a request is for
    const dest = req.headers['sec-fetch-dest'];
    if (dest && dest !== 'iframe') return send(res, 403, { error: 'a scene is shown only in loupe\'s frame' });
    // a kept scene, or a draft the check renders before it is kept
    const html = sd[1] === 'draft' ? takeDraft(sd[2]) : (W.get(sd[1])?.review?.data?.brief?.scenes || []).find((s) => s.id === sd[2] && typeof s.html === 'string')?.html;
    if (typeof html !== 'string') return send(res, 404, { error: 'no such scene' });
    const { headers, body } = docPage(html, url.searchParams.get('t'), { shim: fs.readFileSync(path.join(WEB, 'js/scene-doc.js'), 'utf8'), kit: fs.readFileSync(path.join(WEB, 'js/scene-kit.js'), 'utf8') });
    res.writeHead(200, headers);
    return res.end(body);
  }
  // the bare page the check frames a draft in: loupe's colours and type, nothing else
  if (method === 'GET' && p === '/scene-host') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; frame-src http://${req.headers.host}/scene-doc/draft/; frame-ancestors 'none'`, 'X-Content-Type-Options': 'nosniff' });
    return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/web/style.css"></head><body style="margin:0;background:var(--bg)"></body></html>');
  }
  if (method === 'GET' && p === '/vendor/marked.js') return serveFile(res, path.join(ROOT, 'node_modules/marked/lib/marked.esm.js'));
  if (method === 'GET' && p.startsWith('/avatar/')) { let login = ''; try { login = decodeURIComponent(p.slice(8)); } catch { /* not a login */ } return serveAvatar(res, login); }
  if (p === '/favicon.ico' || p === '/favicon.svg') return serveFile(res, path.join(WEB, 'icon.svg'));

  if (!p.startsWith('/api/')) {
    if (method !== 'GET') return send(res, 404, { error: 'not found' });
    if (HTTPS_ORIGIN && !req.socket.encrypted && hostName(req.headers.host) === HOSTNAME) {
      res.writeHead(302, { Location: HTTPS_ORIGIN + p + url.search, 'Cache-Control': 'no-store' });
      return res.end();
    }
    // "/" restores the last workspace; "/home" is the launcher; everything else is a workspace URL the page resolves.
    if (p === '/') {
      const last = W.get(W.registry.data.last);
      if (last && !url.searchParams.has('home')) { res.writeHead(302, { Location: last.url }); return res.end(); }
    }
    // The page learns whether it was reached from another site: a link elsewhere may show a workspace that is
    // already open, but opening a new one (a fetch, a clone, a brief) then needs a click here.
    // Chrome sends no Sec-Fetch-Site to a plain-http name that is not localhost (loupe.local is one), so then the Referer is
    // what says where the link was; a typed address, a bookmark and a page that hides its referrer arrive without either.
    const sfs = req.headers['sec-fetch-site'], ref = req.headers.referer;
    const nav = sfs ? (['none', 'same-origin', 'same-site'].includes(sfs) ? 'trusted' : 'cross-site') : ref && !originOk(ref) ? 'cross-site' : 'trusted';
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('<head>', `<head>\n<meta name="loupe-nav" content="${nav}">`);
    // Scripts only from loupe itself: even if other people's markdown (a PR body, a comment) slipped an element past
    // the renderer, nothing in it could run next to the Approve and Push buttons.
    // frames only from the scene route: a scene's frame cannot be sent to any other page of loupe's
    const csp = `frame-src ${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}/scene-doc/; ` + "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://github.com https://*.githubusercontent.com; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    return res.end(html);
  }

  // ---------------------------------------------------------------- the daemon
  if (method === 'GET' && p === '/api/state') {
    return send(res, 200, {
      version: VERSION, boot: BOOT, user: USER, host: HOSTNAME, name: NAME, display: DISPLAY,
      ...modelState(),
      last: W.registry.data.last,
      workspaces: W.all().map((w) => w.summary()).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)),
      tools: { gh: !!BIN.gh, gopls: !!BIN.gopls, claude: BIN.claude || 'bundled' },
      reach,
      settings: W.settings(),
    });
  }
  if (method === 'POST' && p === '/api/settings') {
    const b = await readBody(req);
    const st = W.settings();
    // The list is checked before anything changes, so a bad one leaves every setting as it was.
    const orgs = b.hiddenOrgs === undefined ? undefined : ownerList(b.hiddenOrgs);
    if (orgs === null) return send(res, 400, { error: 'hiddenOrgs must be a list of GitHub owner names' });
    for (const k of ['autoView', 'autoBrief', 'autoNotes']) if (typeof b[k] === 'boolean') st[k] = b[k];
    if (orgs) st.hiddenOrgs = orgs;
    W.registry.save();
    for (const ws of W.all()) ws.emit('settings', st);
    return send(res, 200, st);
  }
  if (method === 'GET' && p === '/api/inbox') return send(res, 200, await (await import('./github.mjs')).inbox(url.searchParams.get('fresh') === '1'));
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT })}\n\n`);
    homeClients.add(res);
    req.on('close', () => homeClients.delete(res));
    return;
  }
  if (method === 'POST' && p === '/api/workspaces') {
    const b = await readBody(req);
    const ws = await W.openTarget(b.target, typeof b.cwd === 'string' && path.isAbsolute(b.cwd) ? b.cwd : undefined, { base: typeof b.base === 'string' ? b.base : undefined });
    if (b.link && typeof b.link === 'object' && /^[0-9a-f-]{36}$/.test(b.link.sessionId || '')) {
      await ws.ready().catch(() => {});
      linkChat(ws, b.link);
    }
    homeEmit('workspaces', {});
    return send(res, 200, { id: ws.id, url: ws.url, status: ws.status });
  }
  if ((method === 'GET' || method === 'POST') && p === '/api/resolve') {
    // The page asks which workspace its URL names.
    const s = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    let ws = W.bySlug(s);
    const pr = /^([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)/.exec(s);
    if (!ws && pr) {
      // A GitHub link with the host swapped. Opening it fetches (and maybe clones), so it waits for the page to say so.
      if (method !== 'POST') return send(res, 404, { unknown: true, target: `${pr[1]}/${pr[2]}#${pr[3]}`, error: `${pr[1]}/${pr[2]}#${pr[3]} is not open yet` });
      ws = await W.openTarget(`${pr[1]}/${pr[2]}#${pr[3]}`);
    }
    else if (ws && pr && s !== ws.rec.slug) ws = W.bySlug(`${pr[1]}/${pr[2]}/pull/${pr[3]}`) || ws;
    if (!ws) return send(res, 404, { error: `no workspace at /${s}` });
    W.registry.data.last = ws.id; ws.rec.openedAt = Date.now(); W.registry.save();
    return send(res, 200, { id: ws.id, url: ws.url });
  }

  // ---------------------------------------------------------------- live sessions (the loupe mod)
  let lm = /^\/api\/live\/([0-9a-f-]{36})(\/next|\/answer)?$/.exec(p);
  if (method === 'POST' && p === '/api/live') {
    const b = await readBody(req);
    if (!/^[0-9a-f-]{36}$/.test(b.sessionId || '') || typeof b.cwd !== 'string') return send(res, 400, { error: 'sessionId and cwd are required' });
    const s = L.register(b);
    markLive(s.sessionId, true);
    const out = [];
    for (const root of s.repos.length ? s.repos : [s.cwd]) {
      try {
        const ws = await W.openTarget(root);
        await ws.ready().catch(() => {});
        const conv = linkChat(ws, { sessionId: s.sessionId, cwd: s.cwd, title: s.title || 'Live session', live: true });
        out.push({ url: ws.url, id: ws.id, chat: conv.id });
      } catch (e) { out.push({ root, error: e.message }); }
    }
    homeEmit('workspaces', {});
    return send(res, 200, { workspaces: out, display: DISPLAY });
  }
  if (lm && method === 'DELETE' && !lm[2]) { L.unregister(lm[1]); markLive(lm[1], false); return send(res, 200, { off: true }); }
  if (lm && method === 'GET' && lm[2] === '/next') {
    if (!L.known(lm[1])) return send(res, 404, { error: 'unknown session', unknown: true });
    const q = L.next(lm[1], url.searchParams.get('hold') === '1');
    return q ? send(res, 200, q) : (res.writeHead(204), res.end());
  }
  if (lm && method === 'POST' && lm[2] === '/answer') { const b = await readBody(req); return send(res, 200, { ok: L.answer(lm[1], b.id, b) }); }

  // ---------------------------------------------------------------- one workspace
  const m = /^\/api\/w\/([\w.-]+)(\/.*)?$/.exec(p);
  if (!m) return send(res, 404, { error: 'not found' });
  const ws = W.get(m[1]);
  if (!ws) return send(res, 404, { error: 'no such workspace' });
  const sub = m[2] || '';
  const scope = url.searchParams.get('scope') || 'all';

  if (method === 'DELETE' && sub === '') { await W.close(ws.id); homeEmit('workspaces', {}); return send(res, 200, { closed: true }); }
  if (method === 'GET' && sub === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT, status: ws.status, progress: ws.progress, pr: ws.openingPr(), ...modelState() })}\n\n`);
    ws.addClient(res);
    req.on('close', () => ws.removeClient(res));
    ws.ready().catch(() => {});
    return;
  }
  if (method === 'GET' && sub === '') {
    try { await ws.ready(); } catch (e) { return send(res, 200, { id: ws.id, kind: ws.rec.kind, url: ws.url, status: ws.status, progress: ws.progress || e.message, rec: publicRec(ws) }); }
    if (ws.status !== 'ready') return send(res, 200, { id: ws.id, kind: ws.rec.kind, url: ws.url, status: ws.status, progress: ws.progress, rec: publicRec(ws) });
    return send(res, 200, { ...ws.meta, status: ws.status, progress: ws.progress, rec: publicRec(ws), lsp: ws.root ? lspState(ws.root) : 'off', worktreeReady: !!ws.root });
  }
  if (ws.rec.kind === 'local' || ws.status !== 'ready' || !ws.meta) {
    try { await ws.ready(); } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (method === 'GET' && sub === '/refs') return send(res, 200, { refs: await ws.refs(), base: ws.meta.base, baseLabel: ws.meta.baseLabel, automatic: !ws.rec.base });
  if (method === 'POST' && sub === '/base') { const b = await readBody(req); await ws.setBase(typeof b.base === 'string' ? b.base.trim() : ''); return send(res, 200, { base: ws.meta.base }); }
  if (method === 'POST' && sub === '/refresh') { const r = await ws.refresh(); return send(res, 200, { ...r, head: ws.meta.head }); }

  if (method === 'GET' && sub === '/files') {
    const r = ws.captureRange(scope);
    const files = await ws.files(r);
    if (files.length >= 24) primeHighlight(files.find((f) => !f.binary && f.kind === 'code')?.path);
    return send(res, 200, {
      scope: r.key, old: r.old, new: r.new === WORKTREE ? 'worktree' : r.new, key: W.contentKey(files),
      files: files.map((f) => ({ ...f, viewed: ws.isViewed(f), changedSinceViewed: ws.wasViewed(f) })),
      left: ws.leftFor(files), totals: W.totalsOf(files), untrackedSkipped: files.untrackedSkipped || 0,
    });
  }
  if (method === 'GET' && sub === '/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length > 160 || /[\r\n\0]/.test(query)) return send(res, 400, { error: 'Enter up to 160 characters on one line.' });
    return send(res, 200, await searchRepository(ws.gitDir, ws.range(scope).new, query));
  }
  if (method === 'GET' && sub === '/citation') {
    const p = url.searchParams.get('path'), excerpt = url.searchParams.get('excerpt');
    const side = url.searchParams.get('side') === 'old' ? 'old' : 'new';
    const line = Number(url.searchParams.get('line'));
    if (!safeRel(p) || !excerpt || excerpt.length > 160 || !Number.isSafeInteger(line) || line < 1) return send(res, 400, { error: 'Invalid citation.' });
    const r = ws.captureRange(scope);
    if (!(await ws.readable(r, p))) return send(res, 200, { line: null });
    const text = side === 'new' && r.new === WORKTREE
      ? await readAt(ws.gitDir, WORKTREE, p)
      : await ws.text(r, side, p);
    return send(res, 200, { line: citationLine(text, line, excerpt) });
  }
  if (method === 'GET' && sub === '/diff') {
    const fp = url.searchParams.get('path');
    const d = await ws.hunks(scope, fp);
    return d ? send(res, 200, d) : send(res, 404, { error: 'not a file this view changes' });
  }
  if (method === 'GET' && (sub === '/file' || sub === '/hl')) {
    const fp = url.searchParams.get('path');
    const side = url.searchParams.get('side') === 'old' ? 'old' : 'new';
    const r = ws.captureRange(scope);
    if (!(await ws.readable(r, fp))) return send(res, 404, { error: 'not a file in this workspace' });
    let text = await ws.text(r, side, fp);
    if (text === null && side === 'new') {
      // An unchanged file: read it at the new side's revision.
      text = await readAt(ws.gitDir, r.new, fp);
    }
    if (text === null) return send(res, 404, { error: `${fp} is not on the ${side} side` });
    if (sub === '/hl') {
      const through = Number(url.searchParams.get('through'));
      // Small changes can reuse the daemon's loaded grammars without spinning up a worker.
      const inline = ws.meta?.totals?.files < 24 && text.length <= 12_000 && !/[^\n]{1024}/.test(text);
      return sendJSON(res, 200, await highlightJSON(text, fp, { through: Number.isSafeInteger(through) ? through : 0, inline }));
    }
    const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop();
    return send(res, 200, { path: fp, side, lines });
  }
  if (method === 'GET' && sub === '/related') {
    const fp = url.searchParams.get('path');
    const r = ws.captureRange(scope);
    if (!(await ws.file(r, fp))) return send(res, 404, { error: 'not a file this view changes' });
    return send(res, 200, await ws.relatedOf(r, fp));
  }
  if (method === 'GET' && sub.startsWith('/lsp/')) {
    const op = sub.slice(5);
    if (op === 'status') return send(res, 200, { state: ws.root ? lspState(ws.root) : 'off' });
    const fp = url.searchParams.get('path');
    const line = Number(url.searchParams.get('line')), col = Number(url.searchParams.get('col'));
    const lsp = ws.root && goplsFor(ws.root);
    if (!lsp) return send(res, 400, { error: 'no gopls for this workspace' });
    if (!safeRel(fp) || !fp.endsWith('.go') || !(line > 0) || !(col >= 0)) return send(res, 400, { error: 'a .go file, line and col are required' });
    if (op === 'hover') {
      const r = await lsp.at('textDocument/hover', fp, line, col);
      const c = r?.contents;
      return send(res, 200, { markdown: !c ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n\n') : c.value || '' });
    }
    if (op === 'def') {
      const r = await lsp.at('textDocument/definition', fp, line, col);
      return send(res, 200, { locations: (Array.isArray(r) ? r : r ? [r] : []).map((l) => lsp.where(l)) });
    }
    if (op === 'refs') {
      const r = (await lsp.at('textDocument/references', fp, line, col, { context: { includeDeclaration: false } })) || [];
      const locs = r.slice(0, 300).map((l) => lsp.where(l)).map((l) => ({ ...l, text: lineAt(l.external ? l.path : path.join(ws.root, l.path), l.line, ws.root) }));
      return send(res, 200, { locations: locs, total: r.length });
    }
    return send(res, 404, { error: 'unknown lsp operation' });
  }
  if (method === 'GET' && sub === '/ext') {
    const abs = url.searchParams.get('file');
    if (!readableExternal(abs)) return send(res, 404, { error: 'only files under GOROOT or the Go module cache open here' });
    const text = fs.readFileSync(fs.realpathSync(abs), 'utf8');
    if (url.searchParams.get('hl')) return sendJSON(res, 200, await highlightJSON(text, abs));
    const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop();
    return send(res, 200, { path: abs, lines, external: true });
  }

  // ---------------------------------------------------------------- review state
  if (method === 'GET' && sub === '/review') return send(res, 200, await reviewOut(ws));
  if (method === 'GET' && sub === '/github') return send(res, 200, await ws.fetchGithub(url.searchParams.get('fresh') === '1'));
  if (method === 'POST' && sub === '/viewed') {
    const b = await readBody(req);
    const list = Array.isArray(b.files) ? b.files : [b];
    for (const x of list) if (safeRel(x.path) && typeof x.blob === 'string') ws.setViewed(x.path, x.blob, !!x.viewed);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && sub === '/threads') {
    const b = await readBody(req);
    if (!safeRel(b.path) || typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: 'path and text are required' });
    const kind = 'ask'; // New marks are questions. Old notes can still exist in saved reviews.
    const conv = C.newConv(ws, 'thread');
    const th = {
      id: uid(), kind, conv: conv.id, path: b.path, side: b.side === 'old' ? 'old' : 'new', line: Number(b.line) || 1, startLine: Number(b.startLine) || undefined,
      anchorText: String(b.anchorText ?? '').slice(0, 2000), label: String(b.label || '').slice(0, 120), snippet: String(b.snippet || '').slice(0, 20000),
      preview: Array.isArray(b.preview) ? b.preview.slice(0, 14) : [], scope: ws.range(scope).key, view: b.view === 'file' ? 'file' : 'diff',
      created: Date.now(), resolved: false,
    };
    ws.review.data.threads.push(th);
    const msg = { id: uid(), role: 'user', text: b.text.trim(), at: Date.now() };
    conv.messages.push(msg);
    ws.review.save();
    ws.emit('thread', { thread: th, conv });
    if (kind === 'ask') C.ask(ws, conv, msg, { model: b.model, effort: b.effort, scope, thread: th });
    return send(res, 200, { thread: th, conv });
  }
  let t = /^\/threads\/([\w-]+)$/.exec(sub);
  if (t) {
    const th = ws.review.data.threads.find((x) => x.id === t[1]);
    if (!th) return send(res, 404, { error: 'no such thread' });
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (typeof b.resolved === 'boolean') th.resolved = b.resolved;
      if (Number(b.line) > 0) { th.line = Number(b.line); if (typeof b.anchorText === 'string') th.anchorText = b.anchorText; }
      if (Number(b.startLine) > 0) th.startLine = Number(b.startLine);
      if (typeof b.label === 'string') th.label = b.label.slice(0, 120);
      ws.review.save();
      ws.emit('thread', { thread: th });
      return send(res, 200, { thread: th });
    }
    if (method === 'DELETE') {
      C.stop(th.conv);
      ws.review.data.threads = ws.review.data.threads.filter((x) => x !== th);
      delete ws.review.data.convs[th.conv];
      ws.review.save();
      ws.emit('thread', { deleted: th.id });
      return send(res, 200, { deleted: true });
    }
  }
  if (method === 'POST' && sub === '/chats') {
    const b = await readBody(req);
    const conv = b.link && /^[0-9a-f-]{36}$/.test(b.link.sessionId || '') ? linkChat(ws, b.link) : C.newConv(ws, 'chat', { title: String(b.title || '').slice(0, 120) || null });
    if (!ws.review.data.chats.includes(conv.id)) ws.review.data.chats.push(conv.id);
    ws.review.save();
    ws.emit('chat', { conv });
    return send(res, 200, { conv });
  }
  t = /^\/convs\/([\w-]+)(\/messages|\/stop)?$/.exec(sub);
  if (t) {
    const conv = ws.review.data.convs[t[1]];
    if (!conv) return send(res, 404, { error: 'no such conversation' });
    if (method === 'POST' && t[2] === '/stop') return send(res, 200, { stopped: C.stop(conv.id) });
    if (method === 'POST' && t[2] === '/messages') {
      const b = await readBody(req);
      if (typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: 'text is required' });
      if (b.ask !== false || conv.linked?.live) {
        const problem = C.modelSwitchError(conv, b.model);
        if (problem) return send(res, 400, { error: problem });
      }
      const atts = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 12).filter((a) => a && safeRel(a.path)).map((a) => ({ path: a.path, label: String(a.label || '').slice(0, 120), text: String(a.text || '').slice(0, 20000), line: Number(a.line) || undefined, side: a.side === 'old' ? 'old' : 'new' }));
      const msg = { id: uid(), role: 'user', text: b.text.trim(), at: Date.now(), attachments: atts.length ? atts : undefined };
      conv.messages.push(msg);
      if (!conv.title && conv.kind === 'chat') conv.title = msg.text.split('\n')[0].slice(0, 80);
      const th = ws.review.data.threads.find((x) => x.conv === conv.id) || null;
      ws.review.save();
      ws.emit('message', { conv: conv.id, msg, busy: C.isBusy(conv.id) });
      // A reply keeps the scope its thread was left in (one commit stays one commit); a chat follows the page.
      const askScope = th && /^[0-9a-f]{40}$/.test(th.scope || '') ? th.scope : typeof b.scope === 'string' ? b.scope : scope;
      if (conv.linked?.live) liveAsk(ws, conv, msg);
      else if (b.ask !== false) C.ask(ws, conv, msg, { model: b.model, effort: b.effort, scope: askScope, thread: th });
      return send(res, 200, { msg });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (typeof b.title === 'string') conv.title = b.title.slice(0, 120);
      ws.review.save(); ws.emit('chat', { conv });
      return send(res, 200, { conv });
    }
    if (method === 'DELETE') {
      C.stop(conv.id);
      delete ws.review.data.convs[conv.id];
      ws.review.data.chats = ws.review.data.chats.filter((x) => x !== conv.id);
      ws.review.save(); ws.emit('chat', { deleted: conv.id });
      return send(res, 200, { deleted: true });
    }
  }
  if (method === 'GET' && sub === '/ship') { await ws.fetchGithub().catch(() => {}); try { return send(res, 200, A.shipOut(await A.shipState(ws))); } catch (e) { return send(res, 409, { error: e.message }); } }
  if (method === 'POST' && sub === '/draft') {
    const b = await readBody(req);
    try { return send(res, 200, await C.draft(ws, b.what, { paths: Array.isArray(b.paths) ? b.paths.filter(safeRel) : [], model: b.model, effort: b.effort })); }
    catch (e) { return send(res, 422, { error: e.message }); }
  }
  if (method === 'GET' && sub === '/commitfiles') {
    // Which files each commit of the change touched: the timeline's commits lane.
    const m = ws.meta;
    if (!m?.mergeBaseFull || !m.headFull) return send(res, 200, { files: {} });
    const out = await gitOut(ws.gitDir, ['log', '--no-color', '--format=%x01%H', '--name-only', '-n', '60', `${m.mergeBaseFull}..${m.headFull}`]).catch(() => '');
    const files = {};
    for (const block of out.split('\x01').filter(Boolean)) { const [sha, ...rest] = block.split('\n'); files[sha.trim()] = rest.map((x) => x.trim()).filter(Boolean); }
    return send(res, 200, { files });
  }
  if (method === 'GET' && sub === '/stack') { await ws.fetchGithub().catch(() => {}); return send(res, 200, await stackFor(ws, { fresh: url.searchParams.get('fresh') === '1' })); }
  if (method === 'POST' && sub === '/checks') {
    // A guide's "what to check" item ticked or not, keyed to the brief it came from.
    const b = await readBody(req);
    if (typeof b.key !== 'string' || b.key.length > 200) return send(res, 400, { error: 'key' });
    const c = ws.review.data.checks ||= {};
    if (b.on) c[b.key] = Date.now(); else delete c[b.key];
    ws.review.save();
    ws.emit('review', { checks: c });
    return send(res, 200, { checks: c });
  }
  if (method === 'GET' && sub === '/sessions') return send(res, 200, { live: L.forRoot(ws.root || ''), sessions: await C.sessionsFor(ws) });
  if (method === 'POST' && sub === '/brief') {
    const b = await readBody(req);
    // the page asked first, saying what a new brief would drop: if that has changed since, it asks again
    const d = G.drops(ws.review.data.brief);
    if (d.n && b.expect !== d.key) return send(res, 409, { error: 'The guide changed since you were asked; look again before regenerating.' });
    C.brief(ws, { model: b.model, effort: b.effort });
    return send(res, 200, { started: true });
  }
  // a chat's edit to the guide, taken back from the page
  if (method === 'POST' && sub === '/guide/undo') {
    const b = await readBody(req);
    const r = G.undoGuide(ws.review.data, String(b.id || ''), await ws.files('all', { fresh: true }));
    if (!r.ok) return send(res, 409, { error: r.message });
    ws.review.save(); await C.emitBrief(ws);
    return send(res, 200, { message: r.message });
  }
  // the brief's scene, written again (another model, or after it failed)
  if (method === 'POST' && sub === '/scene') {
    const b = await readBody(req), plan = ws.review.data.brief?.motion;
    if (!plan?.warranted) return send(res, 409, { error: 'the brief asked for no scene' });
    if (ws.review.data.brief?.pending) return send(res, 409, { error: 'the guide is being written again; its scene comes with it' });
    if (G.chatTouchedScene(ws.review.data.brief)) return send(res, 409, { error: 'A chat changed this guide\u2019s scene; undo that first, or ask the chat for a new one.' });
    C.writeScene(ws, plan, { model: b.model, effort: b.effort });
    return send(res, 200, { started: true });
  }
  if (method === 'POST' && sub === '/notes') {
    const b = await readBody(req);
    const result = await C.notes(ws, { model: b.model, effort: b.effort, again: b.auto !== true && b.again === true,
      expectedKey: b.auto === true ? String(b.key || '') : undefined });
    return send(res, 200, result);
  }
  // Writes: a preview first (what, where, against which state), then the run, which checks that state still holds.
  t = /^\/actions\/([a-z]+)(\/preview)?$/.exec(sub);
  if (t && method === 'POST') {
    const action = A.ACTIONS[t[1]];
    if (!action) return send(res, 404, { error: 'no such action' });
    const b = await readBody(req);
    await ws.fetchGithub().catch(() => {});
    try {
      if (t[2]) return send(res, 200, { ...(await action.preview(ws, b.payload || {})), modal: !!action.modal });
      const out = await ws.runAction(() => action.run(ws, b.payload || {}, b.guard || {}));
      console.log(`loupe: ${t[1]} on ${ws.id}: ${out.message}`);
      return send(res, 200, out);
    } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }
  return send(res, 404, { error: 'not found' });
}

// GitHub owners as written in a URL ("acme"): at most 200, each a plain name; case-insensitive duplicates dropped.
// null when it is not such a list.
function ownerList(v) {
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === 'string' && /^\w[\w.-]{0,99}$/.test(x.trim()))) return null;
  const seen = new Set();
  return v.map((x) => x.trim()).filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}

function publicRec(ws) {
  const r = ws.rec;
  return { kind: r.kind, slug: r.slug, root: r.root, owner: r.owner, repo: r.repo, number: r.number, clone: r.clone, worktree: r.worktree, pr: r.pr || null };
}
async function reviewOut(ws) {
  const d = ws.review.data;
  if (d.brief?.sections?.some((s) => !s.id) || d.brief?.diagrams?.some((x) => !x.id)) { G.ensureIds(d); ws.review.save(); } // ids for a guide written before parts had them
  const v = ws.visibleReview();
  const convs = {};
  for (const [id, c] of Object.entries(v.convs)) convs[id] = { ...c, busy: C.isBusy(id) };
  return { viewed: d.viewed, unviewed: d.unviewed || {}, checks: d.checks || {}, threads: v.threads, convs, chats: v.chats, brief: await briefOut(ws), notes: d.notes || null, verdict: d.verdict || null, seenHead: d.seenHead };
}
// The brief, marked stale when the change it was written for is no longer the change.
export async function briefOut(ws) {
  const files = ws.review.data.brief?.key ? await ws.files('all').catch(() => []) : null;
  const b = ws.review.data.brief; // read after the wait, with what can be undone on it
  if (!b) return b;
  return { ...b, ...(b.key ? { stale: W.contentKey(files) !== b.key } : {}), edits: G.guideEdits(ws.review.data), drops: G.drops(b) };
}
// ------------------------------------------------------------------ avatars
// A GitHub avatar, fetched once and kept in the state folder. github.com/<login>.png is a redirect to GitHub's image host:
// two trips to GitHub on every page held each portrait back until they came. From here it is a local read the browser
// keeps for a day. A picture is fetched again after a week; a login with none (404) is asked again after an hour, and a
// GitHub that cannot be reached serves what is kept, or nothing (the page then leaves the portrait out), and is not asked
// again for five minutes. Logins are kept in lower case, as GitHub matches them.
const AVATARS = path.join(STATE_DIR, 'avatars'), avatarRuns = new Map(), HOUR = 3600 * 1000, MAX_AVATAR = 512 * 1024;
const fresh = (f, ms) => { try { return Date.now() - fs.statSync(f).mtimeMs < ms; } catch { return false; } };
const mark = (f) => { fs.mkdirSync(AVATARS, { recursive: true }); fs.writeFileSync(f, ''); };
async function picture(url) { // one GET, no redirects followed by fetch itself
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
  if (Number(r.headers.get('content-length')) > MAX_AVATAR) throw new Error('too big');
  return r;
}
function avatarFile(name) {
  const login = name.toLowerCase(), file = path.join(AVATARS, login), none = file + '.none', fail = file + '.fail';
  if (fresh(file, 7 * 24 * HOUR)) return Promise.resolve(file);
  if (fresh(none, HOUR)) return Promise.resolve(null);
  if (fresh(fail, HOUR / 12)) return Promise.resolve(fs.existsSync(file) ? file : null);
  if (!avatarRuns.has(login)) avatarRuns.set(login, (async () => {
    try {
      let r = await picture(`https://github.com/${encodeURIComponent(login)}.png?size=40`);
      if (r.status === 404) { mark(none); fs.rmSync(file, { force: true }); return null; }
      // github.com sends the picture from its image host: that redirect, and only to there, is followed
      const to = r.status >= 300 && r.status < 400 ? new URL(r.headers.get('location') || '', 'https://github.com') : null;
      if (to) {
        if (to.protocol !== 'https:' || !/(^|\.)githubusercontent\.com$/.test(to.hostname)) throw new Error('not GitHub');
        r = await picture(to.href);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok || !/^image\/(png|jpeg|gif|webp)/.test(r.headers.get('content-type') || '') || buf.length > MAX_AVATAR) throw new Error('not a picture');
      fs.mkdirSync(AVATARS, { recursive: true });
      fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
      fs.rmSync(fail, { force: true });
      return file;
    } catch { mark(fail); return fs.existsSync(file) ? file : null; } finally { avatarRuns.delete(login); }
  })());
  return avatarRuns.get(login);
}
const IMAGE = [[[0x89, 0x50], 'image/png'], [[0xff, 0xd8], 'image/jpeg'], [[0x47, 0x49], 'image/gif'], [[0x52, 0x49], 'image/webp']];
async function serveAvatar(res, login) {
  // a GitHub login (letters, digits, single hyphens, at most 39), or an app's "name[bot]"
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/.test(login)) return send(res, 404, { error: 'not found' });
  const file = await avatarFile(login);
  if (!file) { res.writeHead(404, { 'Cache-Control': 'private, max-age=3600' }); return res.end(); }
  const buf = fs.readFileSync(file);
  const type = IMAGE.find(([m]) => buf[0] === m[0] && buf[1] === m[1])?.[1] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}

function linkChat(ws, link) {
  const live = !!link.live;
  const existing = Object.values(ws.review.data.convs).find((c) => c.linked?.sessionId === link.sessionId && !!c.linked.live === live);
  // a session registering again says it is still working here
  // (and says where it runs now: whether the fork may edit follows that folder)
  if (existing) { existing.linked.at = Date.now(); if (typeof link.cwd === 'string') existing.linked.cwd = link.cwd; existing.edits = !!C.editRoot(ws, existing); ws.review.save(); ws.emit('chat', { conv: existing }); return existing; }
  const conv = C.newConv(ws, 'chat', {
    modelKind: 'claude',
    title: String(link.title || (live ? 'Live session' : 'Linked session')).slice(0, 120),
    linked: { sessionId: link.sessionId, cwd: typeof link.cwd === 'string' ? link.cwd : null, title: String(link.title || '').slice(0, 200), branch: link.branch || null, tokens: link.tokens || null, live, at: Date.now() },
  }); // newConv judges edits from the linked folder
  if (!ws.review.data.chats.includes(conv.id)) ws.review.data.chats.push(conv.id);
  ws.review.save();
  ws.emit('chat', { conv });
  return conv;
}

// Live chats follow their session: offline when it leaves live mode, back when it returns.
function markLive(sessionId, on) {
  for (const ws of W.all()) {
    let changed = false;
    for (const c of Object.values(ws.review.data.convs)) if (c.linked?.live && c.linked.sessionId === sessionId && !!c.linked.offline === on) { c.linked.offline = !on; changed = true; ws.emit('chat', { conv: c }); }
    if (changed) ws.review.save();
  }
}

// A question to a live session: it goes in as a prompt there (through the mod) and the answer comes back.
function liveAsk(ws, conv, msg, raw) {
  const answer = { id: uid(), role: 'claude', text: '', tools: [], notes: [], at: Date.now(), pending: true, model: 'live session', live: true };
  conv.messages.push(answer);
  ws.review.save();
  ws.emit('message', { conv: conv.id, msg: answer, busy: true });
  const lines = (msg.attachments || []).map((a) => `${a.label[0].toUpperCase()}${a.label.slice(1)} of ${a.path}:\n\`\`\`\n${a.text}\n\`\`\``).join('\n\n');
  const text = raw ? `[From loupe]\n\n${raw}` : `[From loupe: I'm reviewing ${ws.meta?.pr ? `PR #${ws.meta.pr.number}` : ws.meta?.branch || 'this change'} in the browser, and your reply is copied back there.]\n\n${lines ? lines + '\n\n' : ''}${msg.text}`;
  const t0 = Date.now();
  if (conv.linked.offline) { answer.pending = false; answer.error = 'That session is not live any more: run /loupe live in it again, or start a fork from the chat menu.'; ws.review.save(); ws.emit('message', { conv: conv.id, msg: answer, busy: false }); return; }
  L.send(conv.linked.sessionId, text).then((a) => {
    answer.text = String(a.text || '(no text in the answer)');
    answer.foot = `${((a.durationMs || Date.now() - t0) / 1000).toFixed(1)} s · in the live session`;
  }, (e) => { answer.error = e.message; }).finally(() => {
    answer.pending = false;
    ws.review.save();
    ws.emit('message', { conv: conv.id, msg: answer, busy: false });
  });
}



// ------------------------------------------------------------------ the listeners
function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('bad request\n'); }
  if (SHORT.has(hostName(req.headers.host))) return shortRedirect(req, res, url);
  if (!hostOk(req.headers.host)) { res.writeHead(421, { 'Content-Type': 'text/plain' }); return res.end(`loupe answers only to ${HOSTNAME}, localhost and 127.0.0.1\n`); }
  const origin = req.headers.origin;
  if (origin && !originOk(origin)) return send(res, 403, { error: 'cross-origin request refused' });
  // a Codex chat's tools: their own key (the token in the path), and they refuse any request a page could send
  const mcp = /^\/mcp\/([\w-]{20,64})$/.exec(url.pathname);
  if (mcp) return handleMcp(req, res, mcp[1]).catch((err) => { if (!res.headersSent) send(res, 500, { error: String(err?.message || err) }); });
  // A request that changes something must say it is loupe's: a header a cross-site page cannot send without a
  // CORS preflight, which loupe never answers.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-loupe'] !== '1') return send(res, 403, { error: 'missing X-Loupe header' });
  route(req, res, url).catch((err) => {
    if (!res.headersSent) send(res, 500, { error: String(err?.message || err) });
    else res.end();
  });
}

// l.local serves nothing and opens nothing: a GET or HEAD goes to the same path on loupe.local, so a GitHub pull request
// link with github.com swapped for l.local arrives as the link the page already opens (or asks about, when it came from
// another site; a redirect keeps the browser's own sense of where the click came from). The target is built from our own
// name, the port this connection came in on and the parsed path, never from the Host header or the raw request line.
function shortRedirect(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }); return res.end('l.local only redirects\n'); }
  const tls = !!req.socket.encrypted, port = req.socket.localPort;
  const dflt = tls ? port === 443 : port === 80;
  res.writeHead(302, { Location: `${tls ? 'https' : 'http'}://${HOSTNAME}${dflt ? '' : ':' + port}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
  res.end();
}

// https: a certificate and key in <state>/tls (docs/HTTPS.md) put loupe.local and l.local on 443 too. Without them nothing
// changes. Like port 80, it takes the wildcard address and drops every connection that is not from this machine.
async function startTls(port) {
  let creds;
  try { creds = { cert: fs.readFileSync(path.join(TLS_DIR, 'cert.pem')), key: fs.readFileSync(path.join(TLS_DIR, 'key.pem')) }; } catch { return false; }
  let srv;
  try { srv = https.createServer(creds, handler); } catch (e) { console.log(`loupe: ${TLS_DIR} does not hold a usable certificate (${e.message}); https is off`); return false; }
  srv.keepAliveTimeout = 65000;
  srv.on('connection', (sock) => { if (!LOOPBACK.has(sock.remoteAddress)) sock.destroy(); });
  srv.on('tlsClientError', () => {}); // a browser that does not trust the certificate hangs up mid-handshake
  return new Promise((resolve) => {
    srv.once('error', (e) => { console.log(`loupe: https port ${port} not taken (${e.code})`); resolve(false); });
    srv.listen(port, '::', () => resolve(true));
  });
}

export async function start() {
  await initHighlightCache();
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  console.log(`loupe ${VERSION}: http://127.0.0.1:${PORT}  (state in ${STATE_DIR})`);
  keepModelsCurrent(() => { for (const ws of W.all()) ws.emit('models', modelState()); });
  let on80 = false;
  if (!flag('no-80') && process.env.LOUPE_NO_80 !== '1') {
    const s80 = http.createServer(handler);
    s80.on('connection', (sock) => { if (!LOOPBACK.has(sock.remoteAddress)) sock.destroy(); });
    on80 = await new Promise((resolve) => {
      s80.once('error', (e) => { console.log(`loupe: port 80 not taken (${e.code}); use http://${HOSTNAME}:${PORT}`); resolve(false); });
      s80.listen(80, '::', () => resolve(true)); // '::' is dual-stack: IPv4 and IPv6 loopback both arrive here
    });
  }
  // --no-80 means no privileged ports, so it skips 443 too; LOUPE_TLS_PORT names a port on purpose and overrides that.
  const tlsPort = Number(process.env.LOUPE_TLS_PORT || 443);
  const onTls = (process.env.LOUPE_TLS_PORT || (!flag('no-80') && process.env.LOUPE_NO_80 !== '1')) ? await startTls(tlsPort) : false;
  const mdnsOn = !flag('no-mdns') && process.env.LOUPE_NO_MDNS !== '1';
  if (mdnsOn) startMdns();
  if (onTls) HTTPS_ORIGIN = `https://${HOSTNAME}${tlsPort === 443 ? '' : ':' + tlsPort}`;
  DISPLAY = !mdnsOn ? `http://127.0.0.1:${PORT}` : HTTPS_ORIGIN || `http://${HOSTNAME}${on80 ? '' : ':' + PORT}`;
  console.log(`open ${DISPLAY}`);
  watchWeb();
  const stop = () => { stopAll(); for (const p of mdns) p.kill(); for (const ws of W.all()) ws.review.flush?.(); W.registry.flush(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { on80 };
}

// loupe.local (and l.local) -> 127.0.0.1 through mDNSResponder, with no root: dns-sd -P keeps a record while it runs, one
// process per name, each with its own service instance name so they do not collide.
let mdns = [];
function startMdns() {
  if (!fs.existsSync('/usr/bin/dns-sd')) return;
  for (const [name, host] of [[NAME, HOSTNAME], ...(SHORT_HOSTNAME ? [[SHORT_HOSTNAME.replace(/\.local$/, ''), SHORT_HOSTNAME]] : [])]) {
    const go = () => {
      const p = spawn('/usr/bin/dns-sd', ['-P', name, '_loupe._tcp', 'local', String(PORT), host, '127.0.0.1'], { stdio: 'ignore' });
      mdns.push(p);
      p.on('exit', () => { mdns = mdns.filter((x) => x !== p); setTimeout(go, 5000).unref(); });
    };
    go();
  }
}

// Warm the inbox at start and every two minutes after, so home answers from memory.
setTimeout(() => import('./github.mjs').then((g) => g.inbox(true)).catch(() => {}), 1500);
setInterval(() => import('./github.mjs').then((g) => g.inbox(true)).catch(() => {}), 120000).unref?.();
