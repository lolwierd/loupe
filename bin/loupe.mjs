#!/usr/bin/env node
// loupe: the command. `loupe` opens what you're in; `loupe <PR link | owner/repo#123 | #123 | path>` opens that;
// the daemon behind it is one process for every workspace, kept up by a LaunchAgent (`loupe service install`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.LOUPE_HOME || path.join(os.homedir(), '.loupe');
const PORT = Number(process.env.LOUPE_PORT || 4500);
const API = `http://127.0.0.1:${PORT}`;
// A second instance (LOUPE_NAME) is its own service, so installing it never replaces the first one's.
const LABEL = `dev.${process.env.LOUPE_NAME || 'loupe'}.daemon`;
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(STATE_DIR, 'logs', 'daemon.log');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s), bold = (s) => c('1', s), green = (s) => c('32', s), red = (s) => c('31', s), blue = (s) => c('34', s);

const HELP = `${bold('loupe')}: a local review desk for PRs, branches and uncommitted work, with Claude beside the diff.

  ${bold('loupe')}                      open the repository you're in (branch + uncommitted work)
  ${bold('loupe')} <target>             open a PR link, owner/repo#123, #123 (in a clone), or a path
  ${bold('loupe ls')}                   the open workspaces and how much is left to review in each
  ${bold('loupe close')} <target|url>   close a workspace (a PR's worktree is removed)
  ${bold('loupe block')} [<folder|owner/repo>]
                            never open this repository (none: the one you're in); what is open of it closes
  ${bold('loupe unblock')} <entry>      take it off the block list
  ${bold('loupe blocked')}              the block list
  ${bold('loupe status')}               is the daemon up, and where
  ${bold('loupe doctor')}               check the tools, the sign-ins, the daemon, loupe.local and l.local
  ${bold('loupe service')} install|uninstall|restart|status|logs
                            keep the daemon running (a LaunchAgent; starts at login)
  ${bold('loupe serve')} [--dev|--watch] [--no-80] [--no-mdns]
                            run the daemon in this terminal (--no-80: no ports 80 or 443)

Options for opening: --base <ref> (compare a checkout with another branch), --no-open (print the URL only),
--json, --link <session-id> (a chat linked to that Claude Code session).`;

async function api(p, opts = {}) {
  const r = await fetch(API + p, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Loupe': '1', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 120000) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { error: text }; }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function up() { try { return await api('/api/state', { timeout: 1500 }); } catch { return null; } }

async function ensureDaemon() {
  let s = await up();
  if (s) return s;
  if (fs.existsSync(PLIST)) {
    try { execFileSync('launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  } else {
    // No service: start one in the background for now, and say how to keep it.
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const out = fs.openSync(LOG, 'a');
    spawn(process.execPath, [path.join(ROOT, 'bin/loupe.mjs'), 'serve', '--watch'], { detached: true, stdio: ['ignore', out, out], cwd: ROOT }).unref();
    console.error(dim('started the loupe daemon in the background (keep it with: loupe service install)'));
  }
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); s = await up(); if (s) return s; }
  throw new Error(`the daemon did not come up; see ${LOG}`);
}
const display = (s, url) => `${s.display || API}${url}`;

function openBrowser(u) { try { execFileSync('open', [u], { stdio: 'ignore' }); } catch { /* print only */ } }

async function cmdOpen(target) {
  const s = await ensureDaemon();
  const body = { target: target ?? '', cwd: process.cwd() };
  const bi = argv.indexOf('--base');
  if (bi >= 0 && argv[bi + 1]) body.base = argv[bi + 1];
  const li = argv.indexOf('--link');
  if (li >= 0 && argv[li + 1]) body.link = { sessionId: argv[li + 1], cwd: process.cwd(), title: 'Linked from the CLI' };
  const r = await api('/api/workspaces', { method: 'POST', body: JSON.stringify(body) });
  const u = display(s, r.url);
  if (has('--json')) return console.log(JSON.stringify({ ...r, link: u }));
  console.log(u);
  if (tty && !has('--no-open')) openBrowser(u);
}

async function cmdLs() {
  const s = await up();
  if (!s) return console.log(dim('the daemon is not running (loupe service install, or loupe serve)'));
  if (has('--json')) return console.log(JSON.stringify(s.workspaces));
  if (!s.workspaces.length) return console.log(dim('no workspaces yet: run loupe in a repository, or loupe <PR link>'));
  for (const w of s.workspaces) {
    const left = w.left ? `${w.left.lines.toLocaleString()} lines left in ${w.left.files} files` : dim('not read yet');
    const tot = w.totals ? dim(` of +${w.totals.added} −${w.totals.deleted}`) : '';
    console.log(`${blue(display(s, w.url))}\n  ${w.kind === 'pr' ? `#${w.number} ` : ''}${w.title}  ${dim(w.repo)}  ${left}${tot}${w.dirty ? `  ${c('33', w.dirty + ' uncommitted')}` : ''}${w.status !== 'ready' ? '  ' + c('33', w.status) : ''}`);
  }
}

async function cmdClose(target) {
  const s = await up();
  if (!s) throw new Error('the daemon is not running');
  let id = null;
  const t = String(target || '').replace(/^https?:\/\/[^/]+/, '');
  const hit = s.workspaces.find((w) => w.id === target || w.url === t || w.url === '/' + t || w.slug === t);
  if (hit) id = hit.id;
  else { const r = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ target: target ?? '', cwd: process.cwd() }) }); id = r.id; }
  await api(`/api/w/${id}`, { method: 'DELETE' });
  console.log(`closed ${id}`);
}

// A folder (a path starting with /, ~ or .) or a GitHub owner/repo, read by the daemon from this directory.
async function cmdBlock(target, on) {
  if (!(await up())) throw new Error('the daemon is not running');
  if (!on && !target) throw new Error('name the entry to take off (loupe blocked lists them)');
  const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ [on ? 'block' : 'unblock']: target ?? '', cwd: process.cwd() }) });
  if (has('--json')) return console.log(JSON.stringify({ entry: r.entry, closed: r.closed || [], blockedRepos: r.blockedRepos }));
  console.log(on ? `blocked ${bold(r.entry)}${r.closed?.length ? dim(` (closed ${r.closed.join(', ')})`) : ''}` : `unblocked ${bold(r.entry)}`);
}
async function cmdBlocked() {
  const s = await up();
  if (!s) throw new Error('the daemon is not running');
  const list = s.settings?.blockedRepos || [];
  if (has('--json')) return console.log(JSON.stringify(list));
  if (!list.length) return console.log(dim('nothing is blocked: loupe block <folder|owner/repo> keeps a repository out'));
  for (const e of list) console.log(e);
}

async function cmdStatus() {
  const s = await up();
  if (!s) { console.log(`${red('●')} the daemon is down ${dim(`(${API})`)}`); process.exitCode = 1; return; }
  console.log(`${green('●')} loupe ${s.version} at ${bold(s.display)} ${dim(`and ${API}`)}`);
  console.log(dim(`  ${s.workspaces.length} workspaces · service ${fs.existsSync(PLIST) ? 'installed' : 'not installed'} · state in ${STATE_DIR}`));
}

async function cmdDoctor() {
  // ✓ works, ✗ needs fixing (and makes the exit code 1), ○ optional and missing
  let bad = 0;
  const ok = (b, label, fix) => { if (!b) bad++; console.log(`${b ? green('✓') : red('✗')} ${label}${b || !fix ? '' : dim('  → ' + fix)}`); };
  const opt = (b, label, fix) => console.log(`${b ? green('✓') : dim('○')} ${b ? label : dim(label)}${b || !fix ? '' : dim('  → ' + fix)}`);
  const which = (b) => { try { return execFileSync('/bin/sh', ['-c', `command -v ${b}`]).toString().trim(); } catch { return ''; } };
  const run = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).toString() }; } catch (e) { return { ok: false, out: String(e.stdout || '') }; } };
  const resolves = (host) => run('dscacheutil', ['-q', 'host', '-a', 'name', host]).out.includes('127.0.0.1');

  console.log(bold('tools'));
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 22, `Node ${process.versions.node}`, 'Node 22 or newer');
  ok(!!which('git'), `git ${dim(which('git'))}`, 'brew install git');
  const gh = which('gh');
  ok(!!gh && run('gh', ['auth', 'status']).ok, 'gh, signed in (pull requests are read through it)', gh ? 'gh auth login' : 'brew install gh, then gh auth login');
  opt(!!which('gopls'), 'gopls (hover and ⌘-click on Go)', 'go install golang.org/x/tools/gopls@latest');

  console.log(bold('models'));
  const claude = which('claude');
  let auth = null;
  if (claude) { try { auth = JSON.parse(run('claude', ['auth', 'status', '--json']).out); } catch { /* an older Claude Code */ } }
  // loupe talks to Claude through the Agent SDK, which carries its own Claude Code; the command adds /login and the mod.
  if (claude) ok(auth?.loggedIn !== false, auth?.loggedIn === false ? 'Claude Code, signed in' : `Claude Code${auth?.authMethod ? `, signed in (${auth.authMethod})` : ''}`, 'run claude, then /login');
  else opt(false, 'the claude command (for /login and the loupe mod)', 'install Claude Code: https://claude.com/claude-code');
  const codex = which('codex');
  opt(!!codex && run('codex', ['login', 'status']).ok, 'Codex, signed in (Codex models in the picker)', codex ? 'codex login' : 'npm install -g @openai/codex, then codex login');

  console.log(bold('loupe'));
  let s = await up();
  // installed without the service (./install.sh --no-service): a stopped daemon is expected, and loupe serve starts it
  const noService = has('--no-service');
  if (!s && noService) opt(false, `daemon at ${API} (no service: start it with loupe serve)`);
  else ok(!!s, `daemon at ${API}`, 'loupe service install');
  // A daemon that just started is still asking Claude Code (it asks at start, for its models): wait for the answer.
  for (let i = 0; s && !s.reach?.claude && i < 25; i++) { await new Promise((r) => setTimeout(r, 1000)); s = (await up()) || s; }
  const r = s?.reach?.claude;
  const relogin = 'run claude, then /login; then loupe service restart';
  if (r && !r.skipped && !r.ok) ok(false, `loupe could not reach Claude Code: ${r.error}`, relogin);
  else if (r && !r.skipped) ok(r.signedIn !== false, r.signedIn === false ? 'loupe reached Claude Code, but it is not signed in, so answers will fail' : `loupe reached Claude Code${r.signedIn ? ', signed in' : ''} (${r.models} models)`, relogin);
  else if (s && !r) ok(false, 'loupe has not heard back from Claude Code', 'loupe service logs');
  const name = s?.name || process.env.LOUPE_NAME || 'loupe';
  if (process.platform === 'darwin' && (s || !noService)) {
    ok(resolves(`${name}.local`), `${name}.local resolves to 127.0.0.1 (mDNS)`, 'the daemon registers it while it runs');
    if (name === 'loupe') ok(resolves('l.local'), 'l.local resolves (github.com → l.local in a PR link opens it here)', 'the daemon registers it while it runs');
    // port 80 belongs to the first instance; a second one (LOUPE_NAME) keeps its own port
    if (name === 'loupe') {
      let p80 = false; try { const res = await fetch('http://127.0.0.1:80/api/state', { signal: AbortSignal.timeout(1500) }); p80 = res.ok && (await res.json()).boot === s?.boot; } catch { /* no */ }
      ok(p80, 'port 80 (so http://loupe.local needs no port)', `use http://loupe.local:${PORT}`);
    }
    if (!noService) ok(fs.existsSync(PLIST), `service ${dim(PLIST)}`, 'loupe service install');
  }
  if (claude) opt(/❯ loupe@/.test(run('claude', ['plugin', 'list']).out), 'Claude Code mod and skill (/loupe, and the first edit opens the repository here)', `./install.sh in ${ROOT}`);
  if (bad) process.exitCode = 1;
}

// ------------------------------------------------------------------ the LaunchAgent
function plist() {
  const env = {
    PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'go/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: os.homedir(),
    LANG: 'en_US.UTF-8',
    // the service keeps the settings it was installed with
    ...Object.fromEntries(['LOUPE_NAME', 'LOUPE_PORT', 'LOUPE_HOME', 'LOUPE_SEARCH', 'CODEX_HOME'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
  };
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${x(process.execPath)}</string><string>${x(path.join(ROOT, 'bin/loupe.mjs'))}</string><string>serve</string><string>--watch</string></array>
  <key>WorkingDirectory</key><string>${x(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${x(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${x(LOG)}</string>
  <key>StandardErrorPath</key><string>${x(LOG)}</string>
</dict>
</plist>
`;
}
async function cmdService(op) {
  const dom = `gui/${process.getuid()}`;
  const lc = (...a) => { try { execFileSync('launchctl', a, { stdio: 'pipe' }); return true; } catch { return false; } };
  if (op === 'install') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    lc('bootout', `${dom}/${LABEL}`);
    // A daemon started by hand holds the ports: stop it so the service can take them.
    try { const pids = execFileSync('lsof', ['-tiTCP:' + PORT, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean); for (const pid of pids) process.kill(Number(pid)); } catch { /* none */ }
    fs.writeFileSync(PLIST, plist());
    if (!lc('bootstrap', dom, PLIST)) throw new Error(`launchctl bootstrap failed; try: launchctl bootstrap ${dom} ${PLIST}`);
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); const s = await up(); if (s) return console.log(`${green('●')} loupe is running at ${bold(s.display)}, and starts at login ${dim(`(${PLIST})`)}`); }
    throw new Error(`installed, but the daemon did not answer; see ${LOG}`);
  }
  if (op === 'uninstall') { lc('bootout', `${dom}/${LABEL}`); fs.rmSync(PLIST, { force: true }); return console.log('removed the LaunchAgent; the daemon is stopped'); }
  if (op === 'restart') { if (!lc('kickstart', '-k', `${dom}/${LABEL}`)) throw new Error('the service is not installed (loupe service install)'); return console.log('restarted'); }
  if (op === 'logs') { const t = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').slice(-80).join('\n') : '(no log yet)'; return console.log(t); }
  if (op === 'status' || !op) { await cmdStatus(); try { console.log(dim(execFileSync('launchctl', ['print', `${dom}/${LABEL}`]).toString().split('\n').filter((l) => /state =|pid =|last exit/.test(l)).map((l) => '  ' + l.trim()).join('\n'))); } catch { console.log(dim('  the LaunchAgent is not loaded')); } return; }
  throw new Error(`loupe service ${op}: use install, uninstall, restart, status or logs`);
}

// ------------------------------------------------------------------ serve: the daemon, optionally restarting itself when its code changes
async function cmdServe() {
  if ((!has('--watch') && !has('--dev')) || process.env.LOUPE_CHILD) {
    const { start } = await import('../src/server.mjs');
    try { await start(); } catch (e) {
      console.error(`loupe: ${e.code === 'EADDRINUSE' ? `port ${PORT} is taken (is loupe already running? loupe status)` : e.message}`);
      process.exit(1);
    }
    return;
  }
  let child = null, restarting = false, startedAt = 0, backoff = 1000, retry = null;
  const run = () => {
    clearTimeout(retry);
    startedAt = Date.now();
    child = spawn(process.execPath, [path.join(ROOT, 'bin/loupe.mjs'), ...argv.filter((a) => a !== '--watch')], { stdio: 'inherit', env: { ...process.env, LOUPE_CHILD: '1' } });
    child.on('exit', (code, signal) => {
      child = null;
      if (restarting) { restarting = false; backoff = 1000; return run(); }
      if (stopping) return process.exit(0);
      // Crashed (a typo in a save, a port still held): try again, backing off to 30 s, so the daemon is never
      // left down while this supervisor looks alive to launchd.
      if (Date.now() - startedAt > 60000) backoff = 1000;
      console.error(`loupe: the server exited (${signal || code}); starting it again in ${Math.round(backoff / 1000)} s`);
      retry = setTimeout(run, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
  };
  let stopping = false;
  run();
  // A restart cuts off any answer or brief being written, so it happens only when a file's contents changed. macOS
  // reports a file under src/ when a copy only sets the folder's times (an rsync that changed nothing restarted the
  // daemon), and a touched file has nothing new to load either.
  const SRC = path.join(ROOT, 'src');
  const WEB_JS = path.join(ROOT, 'web/js');
  const NOTES_MODULE = 'file-notes.js';
  const prints = () => {
    const out = new Map();
    const fingerprint = (p) => {
      try { out.set(path.relative(ROOT, p), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } catch { /* gone while we looked */ }
    };
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.mjs')) fingerprint(p);
      }
    };
    walk(SRC);
    fingerprint(path.join(WEB_JS, NOTES_MODULE));
    return out;
  };
  let seen = prints(), timer = null;
  const scheduleRestart = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = prints();
      const changed = [...new Set([...seen.keys(), ...now.keys()])].filter((k) => seen.get(k) !== now.get(k));
      seen = now;
      if (!changed.length) return;
      console.log(`loupe: ${changed.join(', ')} changed, restarting`);
      if (child) { restarting = true; child.kill('SIGTERM'); } else { backoff = 1000; run(); }
    }, 250);
  };
  fs.watch(SRC, { recursive: true }, (_, f) => { if (String(f).endsWith('.mjs')) scheduleRestart(); });
  fs.watch(WEB_JS, (_, f) => { if (!f || f === NOTES_MODULE) scheduleRestart(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; restarting = false; clearTimeout(retry); if (child) child.kill(sig); else process.exit(0); });
}

const [cmd, ...rest] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--link' && argv[i - 1] !== '--base');
const main = {
  serve: cmdServe, ls: cmdLs, list: cmdLs, close: () => cmdClose(rest[0]), status: cmdStatus, doctor: cmdDoctor,
  block: () => cmdBlock(rest[0], true), unblock: () => cmdBlock(rest[0], false), blocked: cmdBlocked,
  service: () => cmdService(rest[0]), help: () => console.log(HELP), open: () => cmdOpen(rest[0]),
}[cmd] || (() => (has('--help') || has('-h') ? console.log(HELP) : cmdOpen(cmd)));
Promise.resolve().then(main).catch((e) => { console.error(red('loupe: ') + e.message); process.exit(1); });
