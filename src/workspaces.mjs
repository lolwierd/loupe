// Workspaces: one per URL. A local checkout (it follows whatever is checked out there, uncommitted work included)
// or a GitHub pull request (read from git objects fetched into a private ref namespace of a clone you already have,
// with a detached worktree that loupe owns for Claude and gopls to read). Each keeps its review state on disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, SEARCH_ROOTS, BIN, HOME } from './config.mjs';
import { git, gitOk, run, JsonFile, Lru, slug, isSha, safeRel, single, serial } from './util.mjs';
import { WORKTREE, revParse, commitsBetween, changedFiles, fileHunks, rangePatches, readAt, lineCount, related, kindOf } from './git.mjs';
import { goplsFor } from './lsp.mjs';
import * as GH from './github.mjs';
import { localParent, localTrunk, stackFor, stackSnapshot } from './stacks.mjs';
import { fileNoteKey } from '../web/js/file-notes.js';

export const registry = new JsonFile(path.join(STATE_DIR, 'state.json'), { workspaces: [], last: null, clones: {}, ownSessions: [] });
// Daemon-wide preferences, shown in the page's settings menu.
// hiddenOrgs: owners whose PRs home leaves out (the page filters; the daemon only keeps the list).
export const settings = () => {
  const st = (registry.data.settings ||= { autoView: true, autoBrief: false });
  st.autoNotes ??= true;
  if (!Array.isArray(st.hiddenOrgs)) st.hiddenOrgs = [];
  return st;
};
const live = new Map(); // id -> Workspace

// ------------------------------------------------------------------ targets: what someone pasted or typed
// A GitHub PR link (or loupe's own copy of one), owner/repo#123, #123 or 123 inside a repository, or a path.
export function parseTarget(input, cwd = HOME) {
  const s = String(input || '').trim();
  if (!s) return { kind: 'local', path: cwd };
  let m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com|[\w.-]+\.local(?::\d+)?|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)/i.exec(s);
  if (m) return { kind: 'pr', owner: m[1], repo: m[2].replace(/\.git$/, ''), number: Number(m[3]) };
  m = /^([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(s);
  if (m) return { kind: 'pr', owner: m[1], repo: m[2], number: Number(m[3]) };
  m = /^#?(\d+)$/.exec(s);
  if (m) return { kind: 'pr-here', number: Number(m[1]), cwd };
  m = /^(?:https?:\/\/)?[\w.-]+\.local(?::\d+)?\/local\/([\w.-]+)/i.exec(s);
  if (m) { const w = registry.data.workspaces.find((x) => x.kind === 'local' && x.slug === m[1]); if (w) return { kind: 'local', path: w.root }; }
  const p = s.startsWith('~') ? path.join(HOME, s.slice(1)) : path.resolve(cwd, s);
  return { kind: 'local', path: p };
}

function githubRepoOf(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

// A clone of owner/repo on this machine: a main checkout (not a linked worktree) whose remote points at it.
async function findClone(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  const known = registry.data.clones[key];
  if (known && fs.existsSync(path.join(known.path, '.git'))) return known;
  const candidates = [];
  // each root, its folders, and their folders (~/Projects/team/repo), skipping hidden ones and the insides of clones
  const kids = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => path.join(dir, d.name)); } catch { return []; } };
  const isClone = (dir) => { try { return fs.statSync(path.join(dir, '.git')).isDirectory(); } catch { return false; } };
  for (const root of SEARCH_ROOTS) {
    candidates.push(root);
    for (const d of kids(root)) { candidates.push(d); if (!isClone(d)) candidates.push(...kids(d)); }
  }
  for (const dir of candidates) {
    try { if (!fs.statSync(path.join(dir, '.git')).isDirectory()) continue; } catch { continue; }
    const remotes = await git(dir, ['remote', '-v']).catch(() => '');
    for (const line of remotes.split('\n')) {
      const [name, url] = line.split(/\s+/);
      const r = githubRepoOf(url);
      if (r && `${r.owner}/${r.repo}`.toLowerCase() === key) {
        registry.data.clones[key] = { path: dir, remote: name };
        registry.save();
        return registry.data.clones[key];
      }
    }
  }
  return null;
}

async function cloneRepo(owner, repo, progress) {
  const dir = path.join(STATE_DIR, 'repos', owner, repo);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    progress?.(`Cloning ${owner}/${repo} (no local clone found)…`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // Blobless and with no checkout: loupe reads objects, and a worktree pulls only the blobs it needs.
    await run(BIN.git, ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${owner}/${repo}.git`, dir], { timeout: 15 * 60 * 1000 });
  }
  const key = `${owner}/${repo}`.toLowerCase();
  registry.data.clones[key] = { path: dir, remote: 'origin' };
  registry.save();
  return registry.data.clones[key];
}

// ------------------------------------------------------------------ opening
export async function openTarget(input, cwd, opts = {}) {
  let t = parseTarget(input, cwd);
  if (t.kind === 'pr-here') {
    const top = (await git(t.cwd, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
    if (!top) throw new Error(`#${t.number}: run it inside a clone of the repository, or paste the PR link`);
    const remotes = await git(top, ['remote', '-v']);
    const gh = remotes.split('\n').map((l) => githubRepoOf(l.split(/\s+/)[1])).find(Boolean);
    if (!gh) throw new Error(`${top} has no GitHub remote`);
    t = { kind: 'pr', owner: gh.owner, repo: gh.repo, number: t.number };
  }
  if (t.kind === 'pr') {
    const id = `pr-${slug(t.owner)}-${slug(t.repo)}-${t.number}`;
    let rec = registry.data.workspaces.find((w) => w.id === id);
    if (!rec) {
      rec = { id, kind: 'pr', owner: t.owner, repo: t.repo, number: t.number, slug: `${t.owner}/${t.repo}/pull/${t.number}`, createdAt: Date.now() };
      registry.data.workspaces.push(rec);
    }
    rec.openedAt = Date.now();
    registry.data.last = id;
    registry.save();
    const ws = get(id);
    ws.prepare().catch(() => {}); // fetch in the background; the page shows progress
    return ws;
  }
  if (!fs.existsSync(t.path)) throw new Error(`no such path: ${t.path}`);
  const dir = fs.statSync(t.path).isDirectory() ? t.path : path.dirname(t.path);
  const top = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) throw new Error(`${t.path} is not inside a git repository`);
  const root = fs.realpathSync(top);
  let rec = registry.data.workspaces.find((w) => w.kind === 'local' && w.root === root);
  if (!rec) {
    const base = slug(path.basename(root));
    let name = base, k = 2;
    while (registry.data.workspaces.some((w) => w.slug === `local/${name}`)) name = `${base}-${k++}`;
    rec = { id: `local-${name}`, kind: 'local', root, slug: `local/${name}`, createdAt: Date.now() };
    registry.data.workspaces.push(rec);
  }
  if (typeof opts.base === 'string' && opts.base.trim()) rec.base = opts.base.trim();
  rec.openedAt = Date.now();
  registry.data.last = rec.id;
  registry.save();
  const ws = get(rec.id);
  if (opts.base) { ws.meta = null; ws.cache.clear(); }
  return ws;
}

export function get(id) {
  if (live.has(id)) return live.get(id);
  const rec = registry.data.workspaces.find((w) => w.id === id);
  if (!rec) return null;
  const ws = new Workspace(rec);
  live.set(id, ws);
  return ws;
}
export const bySlug = (s) => { const rec = registry.data.workspaces.find((w) => w.slug.toLowerCase() === String(s).toLowerCase()); return rec ? get(rec.id) : null; };
export const all = () => registry.data.workspaces.map((r) => get(r.id));

export async function close(id) {
  const ws = get(id);
  if (!ws) return false;
  ws.stopWatching();
  if (ws.rec.kind === 'pr' && ws.rec.worktree && ws.rec.clone) {
    await git(ws.rec.clone, ['worktree', 'remove', '--force', ws.rec.worktree]).catch(() => fs.rmSync(ws.rec.worktree, { recursive: true, force: true }));
    await git(ws.rec.clone, ['worktree', 'prune']).catch(() => {});
    for (const r of ['head', 'base', 'trunk']) await git(ws.rec.clone, ['update-ref', '-d', `refs/loupe/pr/${ws.rec.number}/${r}`]).catch(() => {});
  }
  live.delete(id);
  registry.data.workspaces = registry.data.workspaces.filter((w) => w.id !== id);
  if (registry.data.last === id) registry.data.last = registry.data.workspaces.toSorted((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0]?.id || null;
  registry.save();
  return true;
}

// ------------------------------------------------------------------ one workspace
export class Workspace {
  constructor(rec) {
    this.rec = rec;
    this.review = new JsonFile(path.join(STATE_DIR, 'ws', rec.id, 'review.json'), () => ({ viewed: {}, threads: [], convs: {}, chats: [], brief: null, seenHead: null }));
    // Work that was in flight when the daemon stopped will never finish: say so.
    for (const c of Object.values(this.review.data.convs || {})) for (const m of c.messages || []) {
      if (m.pending) { m.pending = false; m.queued = false; if (!m.text) m.error = 'Interrupted: loupe restarted before the answer came back. Ask again.'; }
    }
    if (this.review.data.brief?.pending) { this.review.data.brief.pending = false; this.review.data.brief.error ||= 'Interrupted: loupe restarted while writing it.'; }
    if (this.review.data.brief?.scene?.pending) { this.review.data.brief.scene = { ...this.review.data.brief.scene, pending: false, step: null, error: 'Interrupted: loupe restarted while drawing it.' }; }
    if (this.review.data.notes?.pending) {
      this.review.data.notes.pending = false;
      this.review.data.notes.error ||= 'Interrupted: loupe restarted while writing file notes.';
      this.review.save(true);
    }
    this.meta = null;
    this.clients = new Set();
    this.cache = new Lru(64);        // scope key -> files
    this.hunkCache = new Lru(800);   // range key + path -> hunks
    this.patchCache = new Lru(2);    // scope key -> pending range-wide patch
    this.version = 0;                // bumps on every change the watcher sees
    // A PR read on an earlier run is "idle" until a page asks for it; one never read is "preparing".
    this.status = rec.kind === 'pr' ? (rec.pr && rec.clone ? 'idle' : 'preparing') : 'ready';
    this.progress = '';
    this.once = single();
    this.serial = serial();
    this.watch = null;
  }
  get id() { return this.rec.id; }
  get url() { return '/' + this.rec.slug; }
  // Where Claude and gopls read files: the checkout, or the PR's worktree (null until it exists).
  get root() { return this.rec.kind === 'local' ? this.rec.root : this.rec.worktreeReady ? this.rec.worktree : null; }
  // Where git objects are read: the checkout, or the clone the PR was fetched into.
  get gitDir() { return this.rec.kind === 'local' ? this.rec.root : this.rec.clone; }

  summary() {
    const m = this.meta;
    return {
      id: this.id, kind: this.rec.kind, url: this.url, slug: this.rec.slug, openedAt: this.rec.openedAt, status: this.status,
      title: this.rec.kind === 'pr' ? this.rec.pr?.title || `${this.rec.owner}/${this.rec.repo}#${this.rec.number}` : m?.branch || path.basename(this.rec.root || ''),
      repo: this.rec.kind === 'pr' ? `${this.rec.owner}/${this.rec.repo}` : path.basename(this.rec.root || ''),
      number: this.rec.number, root: this.rec.root || this.rec.worktree, branch: m?.branch, totals: m?.totals,
      left: this.leftFor(this.cache.get(this.scopeKey('all'))), dirty: m?.dirty || 0,
      prNumber: this.github?.pr?.number || null, prState: this.github?.pr?.state || null, author: this.rec.pr?.author || this.github?.pr?.author || null,
      session: this.lastSession(),
    };
  }
  // The Claude Code session that last registered or linked itself here (the loupe mod does it on a session's first
  // edit in the repository), so home can say who is working on what.
  lastSession() {
    let best = null;
    for (const c of Object.values(this.review.data.convs || {})) {
      if (!c.linked) continue;
      const at = c.linked.at || c.created || 0;
      if (!best || at > best.at) best = { title: c.linked.title || c.title || 'A session', live: !!c.linked.live, at };
    }
    return best;
  }

  emit(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(line);
  }
  setProgress(text) { this.progress = text; this.emit('progress', { status: this.status, text, pr: this.openingPr() }); }
  // what the page can draw of a change still opening (its record is answered only once it is ready): the pull
  // request's size and refs, from the moment GitHub has given them
  openingPr() {
    const p = this.rec.pr;
    return p ? { additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles, baseRefName: p.baseRefName, headRefName: p.headRefName } : null;
  }

  // Make the workspace answerable: read the checkout, or for a PR reuse what an earlier run fetched
  // (a background ls-remote catches new pushes) and fetch only what is missing.
  ready() {
    return this.once('ready', async () => {
      if (this.meta && this.status === 'ready') return this.meta;
      if (this.rec.kind === 'local') {
        if (!fs.existsSync(this.rec.root)) { this.status = 'error'; this.progress = `${this.rec.root} is gone`; throw new Error(this.progress); }
        return this.sync(true);
      }
      if (this.rec.pr && this.rec.clone && await gitOk(this.rec.clone, ['rev-parse', '--verify', '--quiet', `refs/loupe/pr/${this.rec.number}/head`])) {
        this.status = 'ready';
        await this.sync(true);
        const wtHead = this.rec.worktree && fs.existsSync(path.join(this.rec.worktree, '.git')) ? (await git(this.rec.worktree, ['rev-parse', 'HEAD']).catch(() => '')).trim() : '';
        this.rec.worktreeReady = wtHead === this.meta.headFull;
        if (!this.rec.worktreeReady) this.ensureWorktree().catch(() => {});
        if (!this.github) this.fetchGithubComments().catch(() => {});
        return this.meta;
      }
      await this.prepare();
      return this.meta;
    });
  }

  // -------------------------------------------------------------- PRs: metadata, fetch, worktree
  prepare() {
    return this.once('prepare', async () => {
      if (this.rec.kind !== 'pr') return this.sync();
      const { owner, repo, number } = this.rec;
      try {
        this.status = 'preparing';
        this.setProgress(`Reading ${owner}/${repo}#${number} from GitHub…`);
        if (!BIN.gh) throw new Error('gh is not installed; loupe reads pull requests through it');
        const fields = 'number,title,body,author,baseRefName,headRefName,headRefOid,baseRefOid,url,state,isDraft,additions,deletions,changedFiles,createdAt,updatedAt,labels,reviewDecision,mergeable,headRepositoryOwner,isCrossRepository';
        // Three things at once: GitHub's details of the PR, the local clone, and (once the clone is known) a fetch of
        // the PR's head and the default branch, which need nothing from the details. Only a PR based on another
        // branch (a stack) then fetches its base on its own.
        const view = run(BIN.gh, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', fields], { timeout: 60000 });
        const cloneP = findClone(owner, repo).then((c) => c || cloneRepo(owner, repo, (t) => this.setProgress(t)));
        const early = cloneP.then(async (clone) => {
          const def = (await git(clone.path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^[^/]+\//, '') || null;
          const refs = [`+refs/pull/${number}/head:refs/loupe/pr/${number}/head`];
          if (def) refs.push(`+refs/heads/${def}:refs/loupe/pr/${number}/trunk`);
          await git(clone.path, ['fetch', '--no-tags', '--quiet', clone.remote || 'origin', ...refs], { timeout: 10 * 60 * 1000 });
          return { def };
        }).catch(() => null);
        const pr = JSON.parse(await view);
        this.rec.pr = { ...pr, author: pr.author?.login, labels: (pr.labels || []).map((l) => l.name) };
        this.setProgress(this.progress); // the line as it stands, now with the PR's size: the page draws it while the clone and fetch run
        const clone = await cloneP;
        this.rec.clone = clone.path; this.rec.remote = clone.remote;
        registry.save();
        await this.fetchPr(await early);
        this.status = 'ready';
        this.setProgress('');
        await this.sync(true);
        this.ensureWorktree().catch((e) => this.setProgress(`Worktree failed: ${e.message}`));
        this.fetchGithubComments().catch(() => {});
      } catch (e) {
        this.status = 'error';
        this.setProgress(e.message);
        throw e;
      }
    });
  }
  async fetchPr(early = null) {
    const { number } = this.rec, pr = this.rec.pr;
    this.setProgress(`Fetching #${number} into ${path.basename(this.rec.clone)} (refs/loupe/pr/${number}, nothing checked out)…`);
    // The head and the default branch were fetched while GitHub answered: a PR into the default branch only needs its
    // base pointed at that, and a stacked one fetches its base alone.
    if (early) {
      if (early.def && early.def === pr.baseRefName) return git(this.rec.clone, ['update-ref', `refs/loupe/pr/${number}/base`, `refs/loupe/pr/${number}/trunk`]);
      return git(this.rec.clone, ['fetch', '--no-tags', '--quiet', this.rec.remote || 'origin', `+refs/heads/${pr.baseRefName}:refs/loupe/pr/${number}/base`], { timeout: 10 * 60 * 1000 });
    }
    // A PR on another PR (a stack) also gets the trunk, so "the whole stack" can be read.
    const def = (await GH.mergeSettings(this.rec.owner, this.rec.repo))?.defaultBranchRef?.name;
    const refs = [`+refs/pull/${number}/head:refs/loupe/pr/${number}/head`, `+refs/heads/${pr.baseRefName}:refs/loupe/pr/${number}/base`];
    if (def && def !== pr.baseRefName) refs.push(`+refs/heads/${def}:refs/loupe/pr/${number}/trunk`);
    await git(this.rec.clone, ['fetch', '--no-tags', '--quiet', this.rec.remote || 'origin', ...refs], { timeout: 10 * 60 * 1000 });
  }
  async ensureWorktree() {
    if (this.rec.kind !== 'pr') return;
    const head = this.meta?.headFull;
    if (!head) return;
    const wt = this.rec.worktree || path.join(STATE_DIR, 'worktrees', this.id);
    this.rec.worktree = wt;
    if (!fs.existsSync(path.join(wt, '.git'))) {
      this.setProgress('Checking the PR out into loupe\'s own worktree, for Claude and gopls…');
      await git(this.rec.clone, ['worktree', 'prune']).catch(() => {});
      await git(this.rec.clone, ['worktree', 'add', '--detach', '--force', wt, head], { timeout: 10 * 60 * 1000 });
    } else if ((await git(wt, ['rev-parse', 'HEAD']).catch(() => '')).trim() !== head) {
      await git(wt, ['checkout', '--detach', '--force', '--quiet', head], { timeout: 10 * 60 * 1000 });
    }
    this.rec.worktreeReady = true;
    registry.save();
    this.setProgress('');
    this.emit('changed', { reason: 'worktree ready' });
  }
  // Handwritten note threads were removed on 20 Nov 2026. Leave them on disk and hide them from the page.
  visibleReview() {
    const d = this.review.data;
    const notes = new Set(d.threads.filter((t) => t.kind === 'note').map((t) => t.conv));
    return {
      threads: d.threads.filter((t) => t.kind !== 'note'),
      convs: Object.fromEntries(Object.entries(d.convs).filter(([id]) => !notes.has(id))),
      chats: d.chats.filter((id) => !notes.has(id)),
    };
  }
  runAction(fn) {
    const next = (this.actionTail || Promise.resolve()).then(fn);
    this.actionTail = next.catch(() => {});
    return next;
  }
  // GitHub's side of the change: the PR's details, checks, reviews, conversation and review threads. For a local
  // checkout, the PR its branch has, if any. Fresh for a minute. Past that, whoever asks gets what we have at once
  // and the refresh lands as a 'github' event: nothing waits on gh unless it asked for fresh or we have nothing yet.
  fetchGithubComments() { return this.fetchGithub(true); }
  fetchGithub(force = false) {
    if (!force && this.github && Date.now() - this.github.at < 60000) return Promise.resolve(this.github);
    const run = this.fetchGithubNow();
    if (!force && this.github && !this.github.error) { run.catch(() => {}); return Promise.resolve(this.github); }
    return run;
  }
  fetchGithubNow() {
    return this.serial('github', async () => {
      let owner, repo, number;
      if (this.rec.kind === 'pr') ({ owner, repo, number } = this.rec);
      else {
        const remotes = await git(this.rec.root, ['remote', '-v']).catch(() => '');
        const origin = remotes.split('\n').find((l) => l.startsWith('origin\t')) || remotes.split('\n')[0] || '';
        const gr = GH.githubRepoOf(origin.split(/\s+/)[1]);
        if (gr && this.meta?.branch) { owner = gr.owner; repo = gr.repo; number = await GH.prForBranch(owner, repo, this.meta.branch); }
      }
      if (!number) {
        const before = this.github;
        this.github = { at: Date.now(), pr: null, threads: [], owner, repo, repoFull: owner ? `${owner}/${repo}` : null };
        // A freshness timestamp alone does not require the page to fetch and redraw its diff.
        if (!before || before.pr || before.error || before.owner !== owner || before.repo !== repo) this.emit('github', {});
        return this.github;
      }
      const [pr, threads, pending] = await Promise.all([GH.pullRequest(owner, repo, number), GH.reviewThreads(owner, repo, number).catch(() => []), GH.pendingReview(owner, repo, number).catch((e) => ({ error: e.message }))]);
      // Your pending review's comments are threads too: the ones GitHub already lists as threads are marked pending
      // there; any it does not list yet are added, on the new side at their line.
      const listed = new Set(threads.flatMap((t) => t.comments.map((c) => c.id)));
      for (const c of pending?.review?.comments || []) {
        if (listed.has(c.id)) continue;
        threads.push({ id: `pending:${c.nodeId}`, resolved: false, outdated: c.outdated, canResolve: false, canUnresolve: false, canReply: false, path: c.path, line: c.line, startLine: c.startLine, side: 'new', pending: true,
          comments: [{ id: c.id, nodeId: c.nodeId, author: c.author || pr.viewer, body: c.body, at: c.at, pending: true }] });
      }
      this.github = { at: Date.now(), pr, threads, owner, repo, number, repoFull: `${owner}/${repo}`, pending: pending?.review || null, pendingError: pending?.error, prId: pending?.prId || null };
      // A checkout's base follows its PR's base, once GitHub has said what that is.
      if (this.rec.kind === 'local' && this.meta && pr.headRefName === this.meta.branch) this.sync().catch(() => {});
      if (this.rec.kind === 'pr') {
        const retargeted = this.rec.pr?.baseRefName && pr.baseRefName !== this.rec.pr.baseRefName;
        this.rec.pr = { ...(this.rec.pr || {}), title: pr.title, body: pr.body, state: pr.state, isDraft: pr.isDraft, labels: pr.labels };
        registry.save();
        if (retargeted && this.status === 'ready') this.prepareAgain().then(() => this.emit('changed', { reason: `#${number} now targets ${pr.baseRefName}` })).catch(() => {});
        else if (this.status === 'ready') this.sync().catch(() => {});
      }
      this.emit('github', {});
      return this.github;
    }).catch((e) => {
      // A failed refresh keeps what we had (marked as old, so the next ask tries again), rather than blanking the PR.
      if (this.github?.pr) { this.github = { ...this.github, at: Date.now() - 50000, stale: e.message }; return this.github; }
      this.github = { at: Date.now(), pr: null, threads: [], error: e.message }; return this.github;
    });
  }
  async refresh() {
    if (this.rec.kind === 'pr') {
      if (this.status !== 'ready') return this.prepare();
      const before = this.meta?.headFull;
      await this.prepareAgain();
      return { moved: before !== this.meta?.headFull };
    }
    this.version++;
    await this.sync(true);
    return {};
  }
  prepareAgain() { return this.once('again', () => this.prepareAgainOnce()); }
  async prepareAgainOnce() {
    const { owner, repo, number } = this.rec;
    this.rec.worktreeReady = false; // Claude and gopls wait until the checkout matches the new head
    const fields = 'number,title,body,author,baseRefName,headRefName,headRefOid,baseRefOid,url,state,isDraft,additions,deletions,changedFiles,createdAt,updatedAt,labels,reviewDecision,isCrossRepository';
    const pr = JSON.parse(await run(BIN.gh, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', fields]));
    this.rec.pr = { ...pr, author: pr.author?.login, labels: (pr.labels || []).map((l) => l.name) };
    await this.fetchPr();
    await this.sync(true);
    await this.ensureWorktree();
    await this.fetchGithubComments().catch(() => {});
  }

  // -------------------------------------------------------------- the change itself
  async sync(force = false, snapshot) {
    return this.serial('sync', async () => {
      const before = this.meta;
      const beforeStack = this.stackSnapshotKey;
      const g = this.gitDir;
      let head, branch, base, baseSha, mergeBase = null, trunk = null, parent, prBase;
      if (this.rec.kind === 'pr') {
        if (!this.rec.clone) return null;
        const n = this.rec.number;
        head = await revParse(g, `refs/loupe/pr/${n}/head`);
        baseSha = await revParse(g, `refs/loupe/pr/${n}/base`);
        base = this.rec.pr.baseRefName; branch = this.rec.pr.headRefName;
        mergeBase = (await git(g, ['merge-base', baseSha, head]).catch(() => '')).trim() || null;
        trunk = (await gitOk(g, ['rev-parse', '--verify', '--quiet', `refs/loupe/pr/${n}/trunk`])) ? `refs/loupe/pr/${n}/trunk` : null;
      } else {
        head = (await git(g, ['rev-parse', 'HEAD']).catch(() => '')).trim();
        branch = (await git(g, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim().replace(/^refs\/heads\//, '') || 'HEAD';
        // The base: what you chose, else the branch this one was built on (a stack), else the remote's default.
        // In order: what you chose; the base GitHub compares this branch's PR against; the local branch it was built
        // on; the remote's default branch.
        trunk = await localTrunk(g);
        snapshot ||= await stackSnapshot(g);
        if (this.github?.pr?.headRefName === branch && this.github.pr.baseRefName) {
          const ref = `refs/remotes/origin/${this.github.pr.baseRefName}`;
          if (await gitOk(g, ['rev-parse', '--verify', '--quiet', ref])) prBase = ref;
        }
        if (!prBase && head) parent = await localParent(g, branch, trunk, snapshot).catch(() => null);
        base = this.rec.base
          || parent?.base || prBase
          || trunk;
        baseSha = (await git(g, ['rev-parse', '--verify', '--quiet', base]).catch(() => '')).trim();
        if (!baseSha && base !== trunk) {
          base = trunk;
          baseSha = (await git(g, ['rev-parse', '--verify', '--quiet', trunk]).catch(() => '')).trim();
          parent = null;
        }
        if (head && baseSha) mergeBase = (await git(g, ['merge-base', baseSha, head]).catch(() => '')).trim() || null;
        if (!head) { head = null; branch = '(no commits yet)'; }
      }
      const commits = mergeBase ? await commitsBetween(g, mergeBase, head) : [];
      // The whole stack under this change: from where it leaves the trunk.
      const trunkSha = trunk ? (await git(g, ['rev-parse', '--verify', '--quiet', trunk]).catch(() => '')).trim() : '';
      const trunkLabel = trunk?.replace(/^refs\/loupe\/pr\/\d+\/trunk$/, 'the trunk').replace(/^refs\/(heads\/|remotes\/)/, '') || null;
      const trunkFork = trunkSha && head ? (await git(g, ['merge-base', trunkSha, head]).catch(() => '')).trim() : '';
      let trunkMergeBase = null;
      if (trunkFork && trunkFork !== mergeBase && parent) trunkMergeBase = trunkFork;
      // A custom base alone does not give a PR a stack. Its first diff is ready before GitHub's side arrives.
      if (head && (this.rec.kind === 'pr' || prBase) && this.github?.pr && trunkSha !== baseSha) {
        // Commit discovery is for the panel. The existing comparison ranges use the declared stack.
        const stack = await stackFor(this, { snapshot, commits: false, meta: { branch, headFull: head, trunk: trunkLabel, base } });
        if (stack.items.findIndex((item) => item.current) > 0) {
          let fork = trunkFork;
          const { owner, repo } = this.github;
          const defaultBranch = this.rec.kind === 'pr'
            ? (await GH.mergeSettings(owner, repo))?.defaultBranchRef?.name
            : trunkLabel?.replace(/^origin\//, '');
          if (stack.trunk && defaultBranch && stack.trunk !== defaultBranch) {
            // A stack can target a release branch. Use that boundary when its ref is available here.
            const ref = `refs/remotes/${this.rec.remote || 'origin'}/${stack.trunk}`;
            fork = (await git(g, ['merge-base', ref, head]).catch(() => '')).trim();
          }
          if (fork && fork !== mergeBase) trunkMergeBase = fork;
        }
      }
      const sig = `${head}|${baseSha}|${mergeBase}|${branch}`;
      if (!force && before && before.sig === sig && before.trunkMergeBase === trunkMergeBase && this.rec.kind === 'pr') return before;
      if (!this.review.data.seenHead) { this.review.data.seenHead = head; this.review.save(); }
      const meta = {
        id: this.id, kind: this.rec.kind, url: this.url, sig,
        repoName: this.rec.kind === 'pr' ? this.rec.repo : path.basename(this.rec.root),
        repoFull: this.rec.kind === 'pr' ? `${this.rec.owner}/${this.rec.repo}` : null,
        root: this.root, gitDir: g, branch, base, baseSha: baseSha?.slice(0, 9), head: head?.slice(0, 9), headFull: head, mergeBase: mergeBase?.slice(0, 9), mergeBaseFull: mergeBase,
        commits, totals: null, dirty: 0, pr: this.rec.pr || null, seenHead: this.review.data.seenHead,
        trunk: trunkLabel, trunkMergeBase, baseAuto: this.rec.kind === 'local' && !this.rec.base && base !== trunk,
        sinceCount: this.review.data.seenHead && head && this.review.data.seenHead !== head ? (await commitsBetween(g, this.review.data.seenHead, head).catch(() => [])).length : 0,
      };
      this.meta = meta; // range() reads it
      this.cache.clear();
      const allFiles = await this.files('all');
      meta.totals = totalsOf(allFiles);
      const wip = this.rec.kind === 'local' ? await this.files('wip').catch(() => []) : [];
      meta.dirty = wip.length;
      meta.wipPaths = wip.flatMap((f) => f.oldPath ? [f.oldPath, f.path] : [f.path]);
      this.contentSig = `${sig}|${contentKey(allFiles)}|${meta.dirty}`;
      this.stackSnapshotKey = snapshot?.key;
      if (before && (before.branch !== branch || before.headFull !== head)) this.fetchGithub(true).catch(() => {});
      if (before && before.sig !== sig) {
        const reason = before.branch !== branch ? `switched to ${branch}` : before.headFull !== head ? 'new commits' : 'the base moved';
        this.emit('changed', { reason });
      } else if (before && (beforeStack !== this.stackSnapshotKey || before.trunkMergeBase !== trunkMergeBase)) this.emit('changed', { reason: 'stack changed' });
      return this.meta;
    });
  }

  // A scope names a range: what the page compares.
  range(scope) {
    const m = this.meta;
    if (!m) throw new Error('not ready yet');
    const local = this.rec.kind === 'local';
    const tip = local ? WORKTREE : m.headFull;
    if (scope === 'branch') return { key: 'branch', old: m.mergeBaseFull || m.headFull, new: m.headFull };
    if (scope === 'wip' && local) return { key: 'wip', old: m.headFull || EMPTY_TREE, new: WORKTREE };
    if (scope === 'since' && m.seenHead) return { key: 'since', old: m.seenHead, new: tip };
    if (scope === 'stack' && m.trunkMergeBase) return { key: 'stack', old: m.trunkMergeBase, new: tip };
    if (isSha(scope)) {
      const c = m.commits.find((x) => x.sha.startsWith(scope));
      if (c) return { key: c.sha, old: `${c.sha}^`, new: c.sha, commit: c.sha };
    }
    return { key: 'all', old: m.mergeBaseFull || m.headFull || EMPTY_TREE, new: tip };
  }
  scopeKey(scope) { try { const r = this.range(scope); return `${r.key}:${r.old}:${r.new}:${r.new === WORKTREE ? this.version : ''}`; } catch { return ''; } }

  async files(scope = 'all', { fresh = false } = {}) {
    const r = this.range(scope);
    if (fresh) return changedFiles(this.gitDir, r);
    const key = this.scopeKey(scope);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const files = await changedFiles(this.gitDir, r);
    this.cache.set(key, files);
    return files;
  }
  async file(scope, p) {
    return (await this.files(scope)).find((f) => f.path === p) || null;
  }
  async hunks(scope, p) {
    const r = this.range(scope);
    const scopeKey = this.scopeKey(scope);
    const files = await this.files(scope);
    const f = files.find((file) => file.path === p);
    if (!f) return null;
    const key = `${r.old}:${r.new}:${fileNoteKey(f)}`;
    let hunks = f.untracked ? null : this.hunkCache.get(key);
    if (!hunks && files.length >= 32 && !f.untracked && !f.oldPath && !f.binary) {
      let pending = this.patchCache.get(scopeKey);
      if (!pending) {
        pending = rangePatches(this.gitDir, r, files).catch(() => null);
        this.patchCache.set(scopeKey, pending);
      }
      hunks = (await pending)?.get(p);
    }
    hunks ??= await fileHunks(this.gitDir, r, f);
    if (!f.untracked) this.hunkCache.set(key, hunks);
    const text = f.status === 'D' ? null : await this.text(scope, 'new', p);
    return { path: p, oldPath: f.oldPath, status: f.status, hunks, newLen: lineCount(text) };
  }
  // Text of a file at one side of the scope. The new side of a local workspace is the working tree.
  async text(scope, side, p) {
    if (!safeRel(p)) return null;
    const r = this.range(scope);
    const files = await this.files(scope), i = files.findIndex((f) => f.path === p), f = files[i];
    if (side === 'old') {
      const start = i - i % 24;
      const nearby = f?.oldBlob && files.length >= 32 ? files.slice(start, start + 24)
        .filter((file) => !file.binary && file.deleted && file.oldBlob !== f.oldBlob).map((file) => file.oldBlob) : null;
      return readAt(this.gitDir, r.old, f?.oldPath || p, f?.oldBlob, nearby);
    }
    return readAt(this.gitDir, r.new, p, f?.blob);
  }
  // A path the viewer may open: one the scope changes, or any file tracked at the new side.
  async readable(scope, p) {
    if (!safeRel(p)) return false;
    if (await this.file(scope, p)) return true;
    const r = this.range(scope);
    if (r.new === WORKTREE) {
      const paths = await git(this.gitDir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', p]);
      return paths.split('\0').includes(p);
    }
    return gitOk(this.gitDir, ['cat-file', '-e', `${r.new}:${p}`]);
  }
  async relatedOf(scope, p) {
    const r = this.range(scope);
    const d = await this.hunks(scope, p);
    const changed = new Set((await this.files(scope)).map((f) => f.path));
    return related(this.gitDir, r.new, p, d?.hunks || [], changed);
  }

  // The base a local workspace compares against: the remote's default branch unless you pick another.
  async setBase(base) {
    if (this.rec.kind !== 'local') throw new Error('a pull request compares against its own base');
    if (base && !(await gitOk(this.rec.root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]))) throw new Error(`no such ref: ${base}`);
    this.rec.base = base || undefined;
    registry.save();
    this.version++;
    await this.sync(true);
    this.emit('changed', { reason: `comparing with ${this.meta.base}` });
  }
  async refs() {
    const out = await git(this.gitDir, ['for-each-ref', '--sort=-committerdate', '--count=60', '--format=%(refname:short)\x1f%(committerdate:unix)', 'refs/remotes', 'refs/heads']).catch(() => '');
    return out.split('\n').filter(Boolean).map((l) => { const [name, at] = l.split('\x1f'); return { name, at: Number(at) * 1000 }; }).filter((r) => !r.name.endsWith('/HEAD') && r.name !== this.meta?.branch);
  }

  // -------------------------------------------------------------- viewed and lines left
  // Viewed is keyed to the file's content. Tests and generated files count as viewed until you untick one
  // (settings.autoView, on by default); an untick is kept per content too, so an edit asks again.
  autoViewed(f) { return settings().autoView && (f.kind === 'test' || f.kind === 'generated'); }
  isViewed(f) {
    const key = viewKey(f), list = this.review.data.viewed[f.path] || [];
    if (list.includes(key) || list.includes(f.blob || `gone:${f.oldBlob}`)) return true; // the second: marks made before 20 Nov 11:00
    return this.autoViewed(f) && !(this.review.data.unviewed?.[f.path] || []).includes(key);
  }
  viewKey(f) { return viewKey(f); }
  wasViewed(f) { return !!this.review.data.viewed[f.path]?.length && !this.isViewed(f); }
  setViewed(p, blob, on) {
    const d = this.review.data;
    d.unviewed ||= {};
    const put = (map, add) => { const list = (map[p] || []).filter((b) => b !== blob); if (add) list.push(blob); if (list.length) map[p] = list.slice(-6); else delete map[p]; };
    put(d.viewed, on);
    put(d.unviewed, !on);
    if (on && this.meta?.headFull) d.seenHead = this.meta.headFull;
    this.review.save();
    this.emit('review', { viewed: d.viewed, unviewed: d.unviewed });
  }
  leftFor(files) {
    if (!files) return null;
    let lines = 0, n = 0, total = 0;
    for (const f of files) {
      if (f.kind === 'generated') continue;
      total += f.added + f.deleted;
      if (!this.isViewed(f)) { lines += f.added + f.deleted; n++; }
    }
    return { lines, files: n, total };
  }

  // -------------------------------------------------------------- watching (only while a page is open)
  addClient(res) {
    this.clients.add(res);
    this.startWatching();
    // Checks and reviews move on their own: read GitHub again every minute while a page is open.
    if (!this.ghPoll) { this.ghPoll = setInterval(() => { if (this.clients.size) this.fetchGithub(true).catch(() => {}); }, 60000); this.ghPoll.unref?.(); }
  }
  removeClient(res) {
    this.clients.delete(res);
    if (!this.clients.size) setTimeout(() => { if (!this.clients.size) this.stopWatching(); }, 30000).unref?.();
  }
  startWatching() {
    if (this.watch || this.rec.kind !== 'local') {
      if (this.rec.kind === 'pr' && !this.prPoll) {
        // Someone pushed to the PR? A cheap ls-remote every minute while a page is open.
        this.prPoll = setInterval(async () => {
          if (!this.rec.clone || this.status !== 'ready') return;
          const out = await git(this.rec.clone, ['ls-remote', this.rec.remote || 'origin', `refs/pull/${this.rec.number}/head`]).catch(() => '');
          const sha = out.split(/\s+/)[0];
          if (sha && this.meta && sha !== this.meta.headFull) this.prepareAgain().catch(() => {});
        }, 60000);
      }
      return;
    }
    const root = this.rec.root;
    let timer = null;
    const changed = new Set();
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const paths = [...changed]; changed.clear();
        goplsFor(root)?.changed(paths);
        // A write the diff can't see (an ignored file, a build output, a save with no change) redraws nothing.
        const before = this.contentSig;
        this.version++;
        this.cache.clear();
        await this.sync(true).catch(() => {});
        if (this.contentSig !== before) this.emit('changed', { reason: 'files changed', paths: paths.slice(0, 50) });
      }, 350);
    };
    let fsw = null;
    try {
      fsw = fs.watch(root, { recursive: true }, (_, file) => {
        if (!file) return;
        const f = String(file);
        if (/(^|\/)(\.git|node_modules|\.next|dist|build|target|\.cache|\.turbo)(\/|$)/.test(f) || f.endsWith('.swp') || f.endsWith('~')) return;
        changed.add(f);
        kick();
      });
    } catch { /* recursive watch unavailable: the poll below still sees commits */ }
    // Commits, checkouts, rebases and fetches change refs, not files: poll the refs.
    const poll = setInterval(async () => {
      if (!this.meta) return;
      const [head, branch, snapshot] = await Promise.all([git(root, ['rev-parse', 'HEAD']).catch(() => ''),
        git(root, ['symbolic-ref', '--quiet', 'HEAD']).then((ref) => ref.trim().replace(/^refs\/heads\//, '')).catch(() => 'HEAD'), stackSnapshot(root)]);
      const base = await git(root, ['rev-parse', '--verify', '--quiet', this.meta.base]).catch(() => '');
      const stackChanged = snapshot.key !== this.stackSnapshotKey;
      if (head.trim() !== (this.meta.headFull || '') || (head.trim() && branch !== this.meta.branch) || stackChanged || base.trim().slice(0, 9) !== (this.meta.baseSha || '')) {
        this.version++;
        await this.sync(true, snapshot).catch(() => {});
      }
    }, 2000);
    this.watch = { close: () => { fsw?.close(); clearInterval(poll); clearTimeout(timer); } };
  }
  stopWatching() { this.watch?.close(); this.watch = null; clearInterval(this.prPoll); this.prPoll = null; clearInterval(this.ghPoll); this.ghPoll = null; }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// What "viewed" is keyed to: this diff of the file, from its old content to its new. Viewing the uncommitted part
// of a file does not mark the whole branch's change to it viewed, and any edit asks again.
export const viewKey = (f) => `${f.oldBlob || '0'}..${f.blob || 'gone'}`;
export function totalsOf(files) {
  const sum = (pred) => files.filter(pred).reduce((n, f) => n + f.added + f.deleted, 0);
  return {
    files: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0),
    code: sum((f) => f.kind === 'code'), test: sum((f) => f.kind === 'test'), docs: sum((f) => f.kind === 'docs'), generated: sum((f) => f.kind === 'generated'),
  };
}

// A digest of what a scope changes, by content: the brief is keyed to it.
// The change's fingerprint, which saved briefs and the write guards are checked against. It stays this formula so a brief
// written before keeps matching; a file note has its own, finer key (fileNoteKey, which also counts a rename's source).
export function contentKey(files) {
  return crypto.createHash('sha1').update(files.map((f) => `${f.path}:${f.blob}:${f.oldBlob}`).join('\n')).digest('hex').slice(0, 16);
}

export { kindOf };
