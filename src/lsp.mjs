// gopls over LSP on stdio, one per workspace root that has a go.mod. Started on the first hover or ⌘-click,
// stopped after 20 idle minutes. Files are opened per request with what is on disk, so answers never come
// from a stale copy.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { BIN, GO_ROOTS } from './config.mjs';

const servers = new Map(); // root -> Lsp
const IDLE_MS = 20 * 60 * 1000;

export function goplsFor(root) {
  if (!BIN.gopls || !fs.existsSync(path.join(root, 'go.mod'))) return null;
  if (!servers.has(root)) servers.set(root, new Lsp(root));
  return servers.get(root);
}
export function lspState(root) {
  if (!BIN.gopls || !fs.existsSync(path.join(root, 'go.mod'))) return 'off';
  return servers.get(root)?.state || 'idle';
}
export function stopAll() { for (const s of servers.values()) s.stop(); }

class Lsp {
  constructor(root) { this.root = root; this.proc = null; this.state = 'idle'; this.id = 0; this.pending = new Map(); this.openCount = new Map(); this.version = 0; this.idle = null; }

  start() {
    if (this.proc) return this.ready;
    const p = spawn(BIN.gopls, [], { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p; this.state = 'starting';
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const he = buf.indexOf('\r\n\r\n');
        if (he < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, he).toString())?.[1] || 0);
        if (buf.length < he + 4 + len) return;
        let msg;
        try { msg = JSON.parse(buf.subarray(he + 4, he + 4 + len).toString('utf8')); } catch { msg = {}; }
        buf = buf.subarray(he + 4 + len);
        if (msg.id !== undefined && !msg.method) {
          const w = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (w) msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
        } else if (msg.id !== undefined && msg.method) {
          this.write({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? (msg.params?.items || []).map(() => ({})) : null });
        }
      }
    });
    p.stderr.on('data', () => {});
    p.on('exit', (code) => {
      this.proc = null; this.state = code ? `exited (${code})` : 'idle';
      for (const w of this.pending.values()) w.reject(new Error('gopls exited'));
      this.pending.clear(); this.openCount.clear();
    });
    const root = pathToFileURL(this.root).href;
    this.ready = this.request('initialize', {
      processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: path.basename(this.root) }],
      capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, definition: {}, references: {} }, workspace: { workspaceFolders: true, configuration: true } },
    }).then(() => {
      this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
      this.state = 'loading';
      // A symbol search waits for the workspace to load: its answer means hover and ⌘-click are ready.
      this.request('workspace/symbol', { query: 'loupeWarmupNoSuchSymbol' }).then(() => { if (this.state === 'loading') this.state = 'ready'; }, () => {});
    });
    this.touch();
    return this.ready;
  }
  stop() { this.proc?.kill(); this.proc = null; clearTimeout(this.idle); }
  touch() { clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), IDLE_MS); this.idle.unref?.(); }
  write(o) { if (!this.proc) return; const s = JSON.stringify(o); this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('gopls took too long')); }, 30000).unref?.();
    });
  }
  changed(paths) {
    if (!this.proc) return;
    const changes = [...new Set(paths)].filter((p) => /\.go$|go\.(mod|sum|work)$/.test(p))
      .map((p) => ({ uri: pathToFileURL(path.join(this.root, p)).href, type: fs.existsSync(path.join(this.root, p)) ? 2 : 3 }));
    if (changes.length) this.write({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params: { changes } });
  }
  async at(method, rel, line, col, extra = {}) {
    await this.start();
    this.touch();
    const abs = path.join(this.root, rel);
    let real;
    try { real = fs.realpathSync(abs); } catch { throw new Error('no such file'); }
    if (!real.startsWith(fs.realpathSync(this.root) + path.sep)) throw new Error('that file leads out of the workspace'); // a symlink in the change
    const uri = pathToFileURL(abs).href;
    const n = this.openCount.get(uri) || 0;
    if (!n) this.write({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'go', version: ++this.version, text: fs.readFileSync(real, 'utf8') } } });
    this.openCount.set(uri, n + 1);
    try {
      const r = await this.request(method, { textDocument: { uri }, position: { line: line - 1, character: col }, ...extra });
      this.state = 'ready';
      return r;
    } finally {
      const left = (this.openCount.get(uri) || 1) - 1;
      if (left) this.openCount.set(uri, left);
      else { this.openCount.delete(uri); this.write({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } }); }
    }
  }
  where(loc) {
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetSelectionRange || loc.targetRange;
    const abs = fileURLToPath(uri);
    const line = range.start.line + 1, col = range.start.character;
    if (abs.startsWith(this.root + path.sep)) return { path: path.relative(this.root, abs), line, col, external: false };
    return { path: abs, line, col, external: true, readable: readableExternal(abs) };
  }
}

// A file outside the repository the viewer may open: under GOROOT or the module cache, by its real path.
export function readableExternal(abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.split(path.sep).includes('..')) return false;
  let real; try { real = fs.realpathSync(abs); } catch { return false; }
  return GO_ROOTS.some((r) => { let rr = r; try { rr = fs.realpathSync(r); } catch { /* as written */ } return real.startsWith(rr + path.sep); });
}
// One line of a file for a references list: inside the root it came from, or readable outside it; else nothing.
export function lineAt(abs, line, root) {
  let real; try { real = fs.realpathSync(abs); } catch { return ''; }
  const ok = root ? real.startsWith(fs.realpathSync(root) + path.sep) || readableExternal(real) : readableExternal(real);
  if (!ok) return '';
  try { return fs.readFileSync(real, 'utf8').split('\n')[line - 1]?.trim().slice(0, 200) ?? ''; } catch { return ''; }
}
