import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BIN } from './config.mjs';

// git with no pager, no optional locks (a read never rewrites the index), output as a string.
export function git(cwd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN.git, ['--no-pager', ...argv], {
      cwd, maxBuffer: 512 * 1024 * 1024, encoding: opts.encoding || 'utf8', timeout: opts.timeout || 120000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); err.message = `git ${argv[0]}: ${(String(stderr || '').trim().split('\n').pop()) || err.message}`; return reject(err); }
      resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}
export const gitOk = (cwd, argv) => git(cwd, argv).then(() => true, () => false);

export function run(bin, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, argv, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 60000, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout || ''); err.stderr = String(stderr || ''); err.message = `${path.basename(bin)}: ${String(stderr || '').trim().split('\n').pop() || err.message}`; return reject(err); }
      resolve(String(stdout));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

// A JSON file written atomically (temp file, then rename), with writes coalesced.
export class JsonFile {
  constructor(file, initial) {
    this.file = file;
    this.timer = null;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = typeof initial === 'function' ? initial() : structuredClone(initial); }
  }
  save(now = false) {
    clearTimeout(this.timer);
    if (now) return this.flush();
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

// A small least-recently-used map, so caches of diffs, files and tokens stay bounded.
export class Lru extends Map {
  constructor(max) { super(); this.max = max; }
  get(k) { if (!super.has(k)) return undefined; const v = super.get(k); super.delete(k); super.set(k, v); return v; }
  set(k, v) { super.delete(k); super.set(k, v); while (this.size > this.max) super.delete(this.keys().next().value); return this; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => crypto.randomUUID();
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
export const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s);
export const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0');

// Per key: a call while one runs schedules exactly one more run afterwards (which sees everything changed in
// between) and resolves with it, so no request for fresh work is ever folded into a stale run.
export function serial() {
  const state = new Map(); // key -> { running, again }
  return (key, fn) => {
    let s = state.get(key);
    if (!s) { s = { running: null, again: null }; state.set(key, s); }
    const start = () => { s.running = Promise.resolve().then(fn).finally(() => { s.running = null; }); return s.running; };
    if (!s.running) return start();
    // One more run after this one, shared by every call that arrives meanwhile.
    if (!s.again) s.again = s.running.catch(() => {}).then(() => { s.again = null; return start(); });
    return s.again;
  };
}

// Collapse concurrent calls with the same key into one promise.
export function single() {
  const inflight = new Map();
  return (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
