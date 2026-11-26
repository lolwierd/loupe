// Reading a change out of git: the files a range changes, one file's hunks, and file contents at either side.
// A range's new side is a revision or WORKTREE (the files on disk, uncommitted and untracked ones included).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, Lru, safeRel } from './util.mjs';

export const WORKTREE = 'WORKTREE';
const SEARCH_MAX = 60;

export function citationLine(text, line, excerpt) {
  if (!text || !Number.isSafeInteger(line) || line < 1 || !excerpt?.trim()) return null;
  const lines = text.split('\n');
  const needle = excerpt.trim().replace(/\s+/g, ' ');
  let match = null;
  for (let i = Math.max(0, line - 13); i < Math.min(lines.length, line + 12); i++) {
    if (!lines[i].trim().replace(/\s+/g, ' ').includes(needle)) continue;
    if (match !== null) return null;
    match = i + 1;
  }
  return match;
}

export async function searchRepository(root, rev, query) {
  const result = { revision: rev === WORKTREE ? 'Working tree' : rev, matches: [], more: false };
  if (!query) return result;
  const worktree = rev === WORKTREE;
  // -z keeps colons, tabs and newlines in file names distinct from the line number.
  const args = ['-c', 'grep.column=false', '-c', 'grep.fullName=true', 'grep', '-I', '-n', '-z', '-F', '--no-color', '--no-textconv',
    '--no-recurse-submodules', '--max-count=61', ...(worktree ? ['--untracked', '--exclude-standard'] : []),
    '-e', query, ...(worktree ? [] : [rev]), '--'];
  let out;
  try {
    out = await git(root, args, { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 1 && !e.stderr) return result;
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e.killed) throw new Error('Search exceeded its limit. Use a more specific query.');
    throw e;
  }
  for (let i = 0; i < out.length;) {
    const pathEnd = out.indexOf('\0', i), lineEnd = out.indexOf('\0', pathEnd + 1);
    if (pathEnd < 0 || lineEnd < 0) break;
    const end = out.indexOf('\n', lineEnd + 1);
    const p = out.slice(i + (worktree ? 0 : rev.length + 1), pathEnd);
    const line = Number(out.slice(pathEnd + 1, lineEnd));
    const text = out.slice(lineEnd + 1, end < 0 ? undefined : end);
    i = end < 0 ? out.length : end + 1;
    if (!safeRel(p) || line < 1) continue;
    if (result.matches.length === SEARCH_MAX) { result.more = true; break; }
    const start = Math.max(0, text.indexOf(query) - 50);
    const excerpt = (start ? '…' : '') + text.slice(start, start + 160).trim() + (text.length > start + 160 ? '…' : '');
    result.matches.push({ path: p, line, excerpt });
  }
  return result;
}
const UNTRACKED_MAX = 5000;
const ZERO = /^0+$/;

// Generated, vendored and lock files: folded, and left out of "lines left".
const GENERATED = [
  /(^|\/)testdata\//, /(^|\/)docs\/(docs\.go|swagger\.(json|ya?ml)|openapi[^/]*\.(json|ya?ml))$/, /(^|\/)vendor\//, /(^|\/)dist\//, /(^|\/)node_modules\//,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum|go\.work\.sum|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|flake\.lock)$/,
  /\.pb\.go$|_gen\.go$|\.gen\.(go|ts)$|_generated\.|\.generated\.|\.min\.(js|css)$|\.snap$|\.pb\.(ts|js)$|_pb2\.py$|zz_generated/,
];
export function kindOf(p) {
  if (GENERATED.some((re) => re.test(p))) return 'generated';
  if (/_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|spec)\/|_test\.py$|(^|\/)test_[^/]+\.py$/.test(p)) return 'test';
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(p)) return 'docs';
  return 'code';
}

export async function resolveBase(root, explicit) {
  if (explicit) return explicit;
  try {
    const head = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (head) return head;
  } catch { /* no origin/HEAD */ }
  for (const r of ['origin/main', 'origin/master', 'main', 'master']) {
    try { await git(root, ['rev-parse', '--verify', '--quiet', r]); return r; } catch { /* next */ }
  }
  return 'HEAD';
}

export async function revParse(root, rev) {
  return (await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
}

export async function commitsBetween(root, from, to) {
  if (!from || from === to) return [];
  const out = await git(root, ['log', '--no-color', '--format=%H%x1f%s%x1f%an%x1f%at', `${from}..${to}`]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, subject, author, at] = l.split('\x1f');
    return { sha, short: sha.slice(0, 9), subject, author, at: Number(at) * 1000 };
  });
}

// The lines a reviewer reads in a change: the added and removed lines that hold a letter or a digit. A blank line, or one
// that only closes something (`}`, `});`, `*/`), is not counted. A file's +N -M stay git's, so they match GitHub's.
const READ = /[\p{L}\p{N}]/u;
export const codeLineCount = (text) => (text ? text.split('\n').filter((l) => READ.test(l)).length : 0);
// what the counts are read by: a file's code lines when they are known, else git's count of every line
export const reviewLines = (f) => f.codeLines ?? f.added + f.deleted;
// Each file's code lines, from the range's patch with no context. A file named in a way this does not read (a quoted
// name that is not JSON's quoting) is left out and keeps git's count.
async function codeLines(root, ends) {
  const patch = await git(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '-U0',
    '--src-prefix=a/', '--dst-prefix=b/', ...ends, '--'], { maxBuffer: 64 * 1024 * 1024 });
  // a header's name: git quotes one with a quote, a backslash or a control character in it, and ends one with a space
  // in it with a tab
  const name = (s, prefix) => {
    s = s.replace(/\t$/, '');
    if (s === '/dev/null') return null;
    if (s.startsWith('"')) { try { s = JSON.parse(s); } catch { return undefined; } }
    return s.startsWith(prefix) ? s.slice(prefix.length) : undefined;
  };
  const counts = new Map();
  let from, to, n = 0, inHunk = false;
  const done = () => { const p = to ?? from; if (p) counts.set(p, n); };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { done(); from = to = undefined; n = 0; inHunk = false; }
    else if (!inHunk) {
      if (line.startsWith('--- ')) from = name(line.slice(4), 'a/');
      else if (line.startsWith('+++ ')) to = name(line.slice(4), 'b/');
      else if (line.startsWith('@@')) inHunk = true;
    } else if ((line[0] === '+' || line[0] === '-') && READ.test(line.slice(1))) n++;
  }
  done();
  return counts;
}

// The files a range changes. raw gives status and blob ids, numstat the line counts; both detect renames. The patch
// gives the code lines among them.
export async function changedFiles(root, range) {
  const ends = range.new === WORKTREE ? [range.old] : [range.old, range.new];
  const [raw, num, code] = await Promise.all([
    git(root, ['diff', '-z', '--raw', '--no-abbrev', '-M', '--no-ext-diff', ...ends]),
    git(root, ['diff', '-z', '--numstat', '-M', '--no-ext-diff', ...ends]),
    codeLines(root, ends).catch(() => new Map()), // too big a patch: every file keeps git's count
  ]);
  const files = [];
  const rp = raw.split('\0');
  for (let i = 0; i < rp.length - 1;) {
    const head = rp[i++];
    if (!head.startsWith(':')) continue;
    const [, , oldBlob, newBlob, st] = head.slice(1).split(' ');
    const status = st[0];
    const a = rp[i++];
    const b = status === 'R' || status === 'C' ? rp[i++] : null;
    files.push({ path: b ?? a, oldPath: b ? a : undefined, status, oldBlob: ZERO.test(oldBlob) ? null : oldBlob, blob: ZERO.test(newBlob) ? null : newBlob, added: 0, deleted: 0, binary: false });
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const np = num.split('\0');
  for (let i = 0; i < np.length - 1;) {
    const rec = np[i++];
    const t1 = rec.indexOf('\t'), t2 = rec.indexOf('\t', t1 + 1);
    const a = rec.slice(0, t1), d = rec.slice(t1 + 1, t2), p = rec.slice(t2 + 1); // a path may itself hold tabs
    let file = p;
    if (p === '') { i++; file = np[i++]; } // a rename: "a\td\t\0old\0new\0"
    const f = byPath.get(file);
    if (!f) continue;
    f.binary = a === '-';
    f.added = f.binary ? 0 : Number(a);
    f.deleted = f.binary ? 0 : Number(d);
    if (!f.binary && code.has(file)) f.codeLines = code.get(file);
  }
  if (range.new === WORKTREE) {
    // Untracked files are part of uncommitted work too: added in full.
    const others = (await git(root, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    if (others.length > UNTRACKED_MAX) files.untrackedSkipped = others.length - UNTRACKED_MAX;
    const format = others.length ? (await git(root, ['rev-parse', '--show-object-format'])).trim() : null;
    for (const p of others.slice(0, UNTRACKED_MAX)) {
      const bytes = readWorktreeBytes(root, p);
      const text = bytes?.toString('utf8');
      const binary = text === undefined || text.includes('\0') || text.includes('\uFFFD');
      const blob = bytes && hashBlob(bytes, format);
      files.push({ path: p, status: 'A', untracked: true, oldBlob: null, blob, added: binary ? 0 : lineCount(text), deleted: 0, codeLines: binary ? 0 : codeLineCount(text), binary });
    }
    // The working tree side has no blob id in git's output: hash what is on disk, so "viewed" can key to content.
    const need = files.filter((f) => !f.untracked && !f.blob && f.status !== 'D');
    if (need.length) {
      // On stdin, so no argument list grows past the system's limit. A file that can't be hashed gets a key of
      // its size and mtime, so it still un-views when it changes.
      // hash-object accepts C-quoted paths, so a newline in a name can't split the list.
      const input = need.map(({ path }) => '"' + path.replace(/["\\\n]/g, (c) => c === '\n' ? '\\n' : '\\' + c) + '"\n').join('');
      const out = await git(root, ['hash-object', '--stdin-paths'], { input }).catch(() => '');
      const hashes = out.split('\n').filter(Boolean);
      need.forEach((f, k) => {
        if (hashes.length === need.length) f.blob = hashes[k].trim();
        else { try { const st = fs.statSync(path.join(root, f.path)); f.blob = `stat:${st.size}:${st.mtimeMs}`; } catch { f.blob = null; } }
      });
    }
  }
  for (const f of files) f.kind = kindOf(f.path);
  files.sort((x, y) => x.path.localeCompare(y.path));
  return files;
}

export const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

export function readWorktree(root, p) {
  return readWorktreeBytes(root, p)?.toString('utf8') ?? null;
}

function hashBlob(bytes, format) {
  return crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function readWorktreeBytes(root, p) {
  if (!safeRel(p)) return null;
  const abs = path.join(root, p);
  try {
    const real = fs.realpathSync(abs);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null; // a symlink out of the repository
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return null;
    return fs.readFileSync(real);
  } catch { return null; }
}

// File contents, by blob id when known (content-addressed, so the cache never goes stale), else by revision.
const blobCache = new Lru(1500);
const blobBatches = new Map();
const activeBlobs = new Map();
function readBlob(root, oid, nearby) {
  return new Promise((resolve) => {
    let active = activeBlobs.get(root);
    if (!active) activeBlobs.set(root, active = new Map());
    if (active.has(oid)) { active.get(oid).push(resolve); return; }
    let batch = blobBatches.get(root);
    if (!batch) {
      batch = new Map();
      blobBatches.set(root, batch);
      setImmediate(() => {
        blobBatches.delete(root);
        for (let entries = [...batch], i = 0; i < entries.length; i += 32) {
          readBlobBatch(root, entries.slice(i, i + 32), active);
        }
      });
    }
    const enqueue = (id, readers) => { active.set(id, readers); batch.set(id, readers); };
    enqueue(oid, [resolve]);
    for (const neighbor of nearby || []) {
      if (neighbor && !blobCache.has(neighbor) && !active.has(neighbor)) enqueue(neighbor, []);
    }
  });
}

async function readBlobBatch(root, entries, active) {
  const data = await git(root, ['cat-file', '--batch'], {
    input: entries.map(([oid]) => oid + '\n').join(''), encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  }).catch(() => null);
  let pos = 0;
  for (const [oid, readers] of entries) {
    let text = null;
    if (data) {
      const end = data.indexOf(10, pos);
      const [, type, size] = data.toString('ascii', pos, end).split(' ');
      pos = end + 1;
      if (size !== undefined) {
        const next = pos + Number(size);
        if (type === 'blob') text = data.toString('utf8', pos, next);
        pos = next + 1;
      }
    } else if (readers.length) {
      text = await git(root, ['cat-file', 'blob', oid]).catch(() => null);
    }
    if (text !== null) blobCache.set(oid, text);
    active.delete(oid);
    for (const resolve of readers) resolve(text);
  }
  if (!active.size) activeBlobs.delete(root);
}

export async function readAt(root, rev, p, blob, nearby) {
  if (rev === WORKTREE) return readWorktree(root, p);
  if (blob) return blobCache.get(blob) ?? readBlob(root, blob, nearby);
  return git(root, ['show', `${rev}:${p}`]).catch(() => null);
}

// A range-wide patch saves a process for every ordinary file. Keep Git's per-path logic for renames,
// copies and quoted paths, where identifying the section or matching rename detection is less direct.
export async function rangePatches(root, range, files) {
  const ends = range.new === WORKTREE ? [range.old] : [range.old, range.new];
  const patch = await git(root, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
    '--full-index', '-M', '-U3', ...ends, '--'], { maxBuffer: 12 * 1024 * 1024 });
  const headers = new Map();
  for (const f of files) {
    if (!f.oldPath && !f.untracked && !f.binary && /^[\x20-\x7e]+$/.test(f.path)) {
      headers.set(`a/${f.path} b/${f.path}`, f);
    }
  }
  const sections = new Map();
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const end = section.indexOf('\n');
    const f = headers.get(section.slice(0, end));
    if (!f) continue;
    const index = /^index ([a-f0-9]+)\.\.([a-f0-9]+)/m.exec(section);
    if (index && (ZERO.test(index[1]) ? null : index[1]) === f.oldBlob &&
        (ZERO.test(index[2]) ? null : index[2]) === f.blob) sections.set(f.path, parseHunks(section));
  }
  return sections;
}

// One file's unified diff, as hunks of typed lines with old and new numbers.
export async function fileHunks(root, range, f, { verifyBlobs = false } = {}) {
  if (f.untracked) {
    const bytes = readWorktreeBytes(root, f.path);
    if (!bytes || !f.blob || hashBlob(bytes, f.blob.length === 64 ? 'sha256' : 'sha1') !== f.blob) return [];
    const text = bytes.toString('utf8');
    if (!text) return [];
    const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop();
    return lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, context: '', lines: lines.map((s, k) => ({ t: '+', n: k + 1, s })) }] : [];
  }
  const ends = range.new === WORKTREE ? [range.old] : [range.old, range.new];
  const paths = f.oldPath ? [f.oldPath, f.path] : [f.path];
  const out = await git(root, ['diff', '--no-color', '--no-ext-diff',
    ...(verifyBlobs ? ['--full-index', '--no-textconv'] : []), '-M', '-U3', ...ends, '--', ...paths]);
  if (verifyBlobs) {
    // The patch's index line identifies the bytes Git diffed, even if a watcher has yet to see an edit.
    const patches = out.split(/^diff --git /m);
    const index = /^index ([a-f0-9]+)\.\.([a-f0-9]+)/m.exec(out);
    if (patches.length !== 2 || !index ||
        (ZERO.test(index[1]) ? null : index[1]) !== f.oldBlob ||
        (ZERO.test(index[2]) ? null : index[2]) !== f.blob) return [];
  }
  return parseHunks(out);
}

export function parseHunks(out) {
  const hunks = [];
  let h = null, o = 0, n = 0;
  for (const line of out.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (m) {
      h = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], context: m[5], lines: [] };
      hunks.push(h); o = h.oldStart; n = h.newStart;
      continue;
    }
    if (!h || line.startsWith('\\')) continue;
    const t = line[0], s = line.slice(1);
    if (t === '+') h.lines.push({ t: '+', n: n++, s });
    else if (t === '-') h.lines.push({ t: '-', o: o++, s });
    else if (t === ' ') h.lines.push({ t: ' ', o: o++, n: n++, s });
  }
  return hunks;
}

// For a Go file: the functions and types the change touches, and the other files that name them.
const COMMON = new Set('Get Set New Init Run Start Stop Close Read Write String Error Name Value Len Less Swap Do Apply Check Load Parse Validate main init'.split(' '));
export async function related(root, rev, p, hunks, changed) {
  const names = new Set();
  if (p.endsWith('.go')) {
    for (const h of hunks) {
      const ctx = /func (?:\([^)]*\) )?([A-Za-z_]\w*)/.exec(h.context || '');
      if (ctx && h.lines.some((l) => l.t !== ' ')) names.add(ctx[1]);
      for (const l of h.lines) {
        if (l.t !== '+') continue;
        const f = /^func (?:\([^)]*\) )?([A-Za-z_]\w*)/.exec(l.s);
        const t = /^type\s+([A-Z]\w*)\s/.exec(l.s);
        if (f) names.add(f[1]); else if (t) names.add(t[1]);
      }
    }
  }
  const idents = [...names].filter((x) => x.length >= 4 && !COMMON.has(x)).slice(0, 16);
  const users = new Map();
  if (idents.length) {
    const argv = ['grep', '-n', '-w', '-I', '--no-color', '--full-name'];
    for (const x of idents) argv.push('-e', x);
    if (rev !== WORKTREE) argv.push(rev);
    argv.push('--');
    const out = await git(root, argv).catch(() => '');
    for (const line of out.split('\n')) {
      const m = (rev !== WORKTREE ? /^[^:]+:([^:]+):(\d+):(.*)$/ : /^([^:]+):(\d+):(.*)$/).exec(line);
      if (!m || !m[1].endsWith('.go') || m[1] === p || /^\s*\/\//.test(m[3])) continue;
      const hit = idents.find((x) => new RegExp(`\\b${x}\\b`).test(m[3]));
      if (!hit || new RegExp(`^func (\\([^)]*\\) )?${hit}\\(`).test(m[3])) continue;
      if (!users.has(m[1])) users.set(m[1], []);
      const list = users.get(m[1]);
      if (list.length < 6) list.push({ line: +m[2], ident: hit, text: m[3].trim().slice(0, 160) });
    }
  }
  const dir = path.posix.dirname(p);
  const ls = await git(root, ['ls-tree', '--name-only', rev === WORKTREE ? 'HEAD' : rev, dir === '.' ? '' : dir + '/']).catch(() => '');
  const siblings = ls.split('\n').filter((x) => x && x !== p).slice(0, 60).map((x) => ({ path: x, changed: changed.has(x) }));
  const usedBy = [...users.entries()].map(([file, hits]) => ({ path: file, changed: changed.has(file), kind: kindOf(file), hits }))
    .sort((a, b) => (a.kind === 'test') - (b.kind === 'test') || b.changed - a.changed || a.path.localeCompare(b.path)).slice(0, 40);
  return { idents, usedBy, siblings };
}
