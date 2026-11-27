// loupe's own updates. The copy this daemon runs from has a source: the checkout promote.sh copied it from (recorded in
// .loupe-source, with what it promoted in .loupe-promoted), or, when the service runs a checkout of its own on its main
// branch, that checkout. Now and then (every ten minutes, and when a page asks after that long, never at boot) it reads
// the source's main and origin's main: the further along of the two, when what runs does not already hold it, is an
// update. The page offers it with its commits and a short account of them; it is never taken unasked.
//
// Taking one runs this copy's own promote.sh, never the source's (a chat may edit that checkout), on exactly the commit
// the page showed. It runs detached, since the daemon restarts under it when src/ changes, and writes how it went to
// <state>/update.json, which the next boot reads. A brief, scene, file notes or an answer being written holds it off,
// as it holds off promote.sh. LOUPE_NO_UPDATE=1 turns all of this off (the tests' and harnesses' daemons).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, STATE_DIR, BIN, HOME } from './config.mjs';
import { git } from './util.mjs';

const OFF = process.env.LOUPE_NO_UPDATE === '1';
const EVERY = 10 * 60 * 1000, FIRST = 3 * 60 * 1000;
const RESULT = path.join(STATE_DIR, 'update.json'), EXIT = path.join(STATE_DIR, 'update.exit'), LOG = path.join(STATE_DIR, 'logs', 'update.log');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const firstLine = (f) => read(f).split('\n')[0].trim();
const real = (p) => { try { return fs.realpathSync(p); } catch { return ''; } };
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

let state = { available: false }, checking = null, checkedAt = 0, emit = () => {}, busyNow = () => [];
let taking = null; // the update being taken: { sha, startedAt }
const summaries = new Map(); // "from..to" -> Promise<{ tldr }>

const out = (cwd, argv, opts) => git(cwd, argv, opts).then((s) => s.trim(), () => '');
const rev = (cwd, r) => out(cwd, ['rev-parse', '--verify', '-q', `${r}^{commit}`]);
const holds = (cwd, a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false); // b descends from a
async function commits(cwd, range, n = 40) {
  const raw = await out(cwd, ['log', '--no-merges', `-n${n}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct', range]);
  return raw.split('\n').filter(Boolean).map((l) => { const [sha, short, subject, author, ct] = l.split('\x1f'); return { sha, short, subject, author, at: Number(ct) * 1000 }; });
}
const count = async (cwd, range) => Number(await out(cwd, ['rev-list', '--count', range])) || 0;

// where this copy comes from, and which commit of it runs; null when there is nothing to follow
async function source() {
  if (OFF) return null;
  const from = firstLine(path.join(ROOT, '.loupe-source'));
  if (from) { // promoted from a checkout: the marker wins over whatever git says about this folder
    const src = real(await out(from, ['rev-parse', '--show-toplevel']));
    if (!src || src === real(ROOT) || !fs.existsSync(path.join(src, 'bin/loupe.mjs'))) return null;
    return { mode: 'promote', src, current: firstLine(path.join(ROOT, '.loupe-promoted')), main: await mainOf(src) };
  }
  // the service runs a checkout itself: only its own top level, and only on main (a dev instance or a worktree on a
  // branch of its own is left alone)
  if (real(await out(ROOT, ['rev-parse', '--show-toplevel'])) !== real(ROOT)) return null;
  const main = await mainOf(ROOT);
  if (await out(ROOT, ['symbolic-ref', '--short', '-q', 'HEAD']) !== main) return null;
  return { mode: 'pull', src: real(ROOT), current: await rev(ROOT, 'HEAD'), main };
}
const mainOf = async (cwd) => (await out(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '') || 'main';

// what it would update to: the source's main or origin's, whichever holds the other (when they part, your own main,
// with how many of origin's commits it lacks). An update when that is not already in what runs: ahead of it, or
// parted from it (what runs then has commits main does not, which the update leaves out and the page lists; a commit
// promoted by hand and later squashed into main reads that way). Commits of your own main not yet on origin are
// counted, so the page can say they are unpushed.
export function check() {
  checking ||= (async () => {
    checkedAt = Date.now(); // a look counts from when it starts, whether or not there is anything to look at
    const s = await source();
    if (!s) { state = { available: false }; return state; }
    const { src, main, mode } = s;
    const fetched = await git(src, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`], { timeout: 30000 }).then(() => '', (e) => e.message);
    const local = mode === 'promote' ? await rev(src, `refs/heads/${main}`) : '';
    const remote = await rev(src, `refs/remotes/origin/${main}`);
    let target = local || remote, via = local ? main : `origin/${main}`, behindOrigin = 0;
    if (local && remote && local !== remote) {
      if (await holds(src, local, remote)) { target = remote; via = `origin/${main}`; }
      else if (!(await holds(src, remote, local))) behindOrigin = await count(src, `${local}..${remote}`);
    }
    const current = s.current && (await rev(src, s.current));
    const available = !!(target && current && target !== current && !(await holds(src, target, current)));
    const parted = available && !(await holds(src, current, target));
    state = {
      available, mode, src, main, via, behindOrigin, fetchError: fetched || undefined,
      current: current || s.current || null, target: available ? target : null,
      comes: available ? await commits(src, `${current}..${target}`) : [],
      count: available ? await count(src, `${current}..${target}`) : 0,
      goes: parted ? await commits(src, `${target}..${current}`, 12) : [], // running now, and not on main
      goesCount: parted ? await count(src, `${target}..${current}`) : 0,
      unpushed: available && remote && via === main ? await count(src, `${remote}..${target}`) : 0,
    };
    return state;
  })().finally(() => { checking = null; emit(view()); });
  return checking;
}

// what the page is told: the update, how the last one went, and whether one is being taken
export const view = () => { const l = last(); return { ...state, srcShown: shown(state.src), last: l, taking: !!taking || l?.state === 'running' }; };
const shown = (p) => (p && HOME && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p); // a path as you would type it
// how the last update went: its record, finished by the exit code its wrapper leaves (whichever daemon reads it first)
function last() {
  let r; try { r = JSON.parse(read(RESULT) || 'null'); } catch { r = null; }
  if (r?.state !== 'running') return r;
  const code = read(EXIT).trim();
  if (code === '') return r;
  const tail = read(LOG).trim().split('\n').slice(-3).join('\n');
  r = { ...r, state: code === '0' ? 'done' : 'failed', code: Number(code), at: Date.now(), message: tail.slice(-600) };
  try { fs.writeFileSync(RESULT, JSON.stringify(r)); fs.rmSync(EXIT, { force: true }); } catch { /* read again next time */ }
  return r;
}
// while an update runs (here or under a daemon it restarted), watch for its end, then say so and read the source again;
// one that has said nothing for fifteen minutes is taken as failed (killed, or the machine went down under it)
const STALE_RUN = 15 * 60 * 1000;
let watching = 0;
function watchEnd() {
  if (watching) return;
  watching = setInterval(() => {
    let r = last();
    if (r?.state === 'running' && Date.now() - r.startedAt > STALE_RUN) {
      r = { ...r, state: 'failed', at: Date.now(), message: 'the update never said how it went (see ~/.loupe/logs/update.log)' };
      try { fs.writeFileSync(RESULT, JSON.stringify(r)); } catch { /* next time */ }
    }
    if (r?.state === 'running') return;
    clearInterval(watching); watching = 0; taking = null;
    check().catch(() => emit(view()));
  }, 2000);
  watching.unref?.();
}
// read it when a page asks, if it has not been read for a while
export function stale() { if (!OFF && Date.now() - checkedAt > EVERY && !checking) check().catch(() => {}); }

// a short account of what the update brings, written once for each range
export function summary(target) {
  if (!state.available || state.target !== target) return Promise.reject(fail('loupe has moved on since: look again'));
  const key = `${state.current}..${target}`;
  if (!summaries.has(key)) {
    const p = (async () => {
      const C = await import('./claude.mjs');
      const log = await out(state.src, ['log', '--no-merges', '-n40', '--format=### %s%n%n%b', key]);
      const stat = await out(state.src, ['diff', '--shortstat', state.current, target]);
      return { tldr: await C.summarizeUpdate(state.src, log, stat) };
    })();
    summaries.set(key, p);
    p.catch(() => summaries.delete(key)); // a failure is tried again next time
  }
  return summaries.get(key);
}

// take the update the page showed: exactly that commit, through this copy's own promote.sh, detached
export async function take(sha) {
  if (OFF) throw fail('updates are off here (LOUPE_NO_UPDATE)', 400);
  if (taking || last()?.state === 'running') throw fail('loupe is already updating');
  taking = { sha, startedAt: Date.now() }; // claimed before the look below, so a second click waits for this one
  try {
    await check();
    if (!state.available || state.target !== sha) throw fail('loupe has moved on since: look again');
    const why = busyNow();
    if (why.length) throw fail(`loupe is busy: ${why.join('; ')}. Update once that is done.`);
    if (!fs.existsSync(path.join(ROOT, 'promote.sh'))) throw fail('this copy of loupe has no promote.sh to update with: promote once by hand', 400);
  } catch (e) { taking = null; throw e; }
  const script = path.join(ROOT, 'promote.sh');
  const args = state.mode === 'promote' ? [script, '--from', state.src, '--ref', sha, '--to', ROOT] : [script, '--ref', sha, '--to', ROOT];
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.rmSync(EXIT, { force: true });
  fs.writeFileSync(RESULT, JSON.stringify({ sha, from: state.current, count: state.count, startedAt: taking.startedAt, state: 'running' }));
  // The wrapper outlives this process (the daemon may restart under it): it leaves the exit code where any daemon reads it.
  const wrap = 'printf "\\n== %s: update to %s\\n" "$(date)" "$LOUPE_UPDATE_SHA" >>"$LOUPE_UPDATE_LOG"; /bin/bash "$@" >>"$LOUPE_UPDATE_LOG" 2>&1; echo $? >"$LOUPE_UPDATE_EXIT"';
  const child = spawn('/bin/bash', ['-c', wrap, 'loupe-update', ...args], {
    detached: true, stdio: 'ignore', cwd: ROOT,
    env: { ...process.env, PATH: [path.dirname(process.execPath), path.dirname(BIN.git || '/usr/bin/git'), process.env.PATH].join(':'), LOUPE_UPDATE_SHA: sha, LOUPE_UPDATE_LOG: LOG, LOUPE_UPDATE_EXIT: EXIT },
  });
  child.unref();
  watchEnd();
  emit(view());
  return { started: true, sha };
}

// started with the daemon: no reading at boot, the first a few minutes in, then every ten
export function init({ onChange, busy }) {
  emit = onChange; busyNow = busy;
  checkedAt = Date.now(); // boot is not a reason to look: the first look is a few minutes in
  if (last()?.state === 'running') watchEnd(); // restarted by the update itself, still finishing (or gone stale)
  if (OFF) return;
  setTimeout(() => { check().catch(() => {}); setInterval(() => check().catch(() => {}), EVERY).unref(); }, FIRST).unref();
}
