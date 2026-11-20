#!/usr/bin/env node
// loupe: the command. `loupe` opens what you're in; `loupe <PR link | owner/repo#123 | #123 | path>` opens that;
// the daemon behind it is one process for every workspace, kept up by a LaunchAgent (`loupe service install`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.LOUPE_HOME || path.join(os.homedir(), '.loupe');
const PORT = Number(process.env.LOUPE_PORT || 4500);
const API = `http://127.0.0.1:${PORT}`;
const LABEL = 'dev.loupe.daemon';
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
  ${bold('loupe status')}               is the daemon up, and where
  ${bold('loupe doctor')}               check git, gh, claude, gopls, loupe.local and port 80
  ${bold('loupe service')} install|uninstall|restart|status|logs
                            keep the daemon running (a LaunchAgent; starts at login)
  ${bold('loupe serve')} [--watch] [--no-80] [--no-mdns]
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

async function cmdStatus() {
  const s = await up();
  if (!s) { console.log(`${red('●')} the daemon is down ${dim(`(${API})`)}`); process.exitCode = 1; return; }
  console.log(`${green('●')} loupe ${s.version} at ${bold(s.display)} ${dim(`and ${API}`)}`);
  console.log(dim(`  ${s.workspaces.length} workspaces · service ${fs.existsSync(PLIST) ? 'installed' : 'not installed'} · state in ${STATE_DIR}`));
}

async function cmdDoctor() {
  const ok = (b, label, fix) => console.log(`${b ? green('✓') : red('✗')} ${label}${b || !fix ? '' : dim('  → ' + fix)}`);
  const which = (b) => { try { return execFileSync('/bin/sh', ['-c', `command -v ${b}`]).toString().trim(); } catch { return ''; } };
  ok(!!which('git'), `git ${dim(which('git'))}`, 'brew install git');
  let ghOk = false; try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); ghOk = true; } catch { /* no */ }
  ok(ghOk, 'gh, signed in (pull requests are read through it)', 'gh auth login');
  ok(!!which('claude'), `claude ${dim(which('claude'))}`, 'install Claude Code; answers use its login');
  ok(!!which('gopls'), 'gopls (hover and ⌘-click on Go)', 'go install golang.org/x/tools/gopls@latest');
  const s = await up();
  ok(!!s, `daemon at ${API}`, 'loupe service install');
  let dns = '';
  try { dns = execFileSync('dscacheutil', ['-q', 'host', '-a', 'name', 'loupe.local']).toString(); } catch { /* none */ }
  ok(dns.includes('127.0.0.1'), 'loupe.local resolves to 127.0.0.1 (mDNS)', 'the daemon registers it while it runs');
  let p80 = false; try { const r = await fetch('http://127.0.0.1:80/api/state', { signal: AbortSignal.timeout(1500) }); p80 = r.ok; } catch { /* no */ }
  ok(p80, 'port 80 (so http://loupe.local needs no port)', `use http://loupe.local:${PORT}`);
  ok(fs.existsSync(PLIST), `LaunchAgent ${dim(PLIST)}`, 'loupe service install');
}

// ------------------------------------------------------------------ the LaunchAgent
function plist() {
  const env = {
    PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'go/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: os.homedir(),
    LANG: 'en_US.UTF-8',
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
  if (!has('--watch') || process.env.LOUPE_CHILD) {
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
  let timer = null;
  fs.watch(path.join(ROOT, 'src'), { recursive: true }, (_, f) => {
    if (!String(f).endsWith('.mjs')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`loupe: ${f} changed, restarting`);
      if (child) { restarting = true; child.kill('SIGTERM'); } else { backoff = 1000; run(); }
    }, 250);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; restarting = false; clearTimeout(retry); if (child) child.kill(sig); else process.exit(0); });
}

const [cmd, ...rest] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--link' && argv[i - 1] !== '--base');
const main = {
  serve: cmdServe, ls: cmdLs, list: cmdLs, close: () => cmdClose(rest[0]), status: cmdStatus, doctor: cmdDoctor,
  service: () => cmdService(rest[0]), help: () => console.log(HELP), open: () => cmdOpen(rest[0]),
}[cmd] || (() => (has('--help') || has('-h') ? console.log(HELP) : cmdOpen(cmd)));
Promise.resolve().then(main).catch((e) => { console.error(red('loupe: ') + e.message); process.exit(1); });
