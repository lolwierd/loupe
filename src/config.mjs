// Where loupe keeps things, and the programs it runs. Resolved once at start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');
export const HOME = os.homedir();
export const STATE_DIR = process.env.LOUPE_HOME || path.join(HOME, '.loupe');
export const PORT = Number(process.env.LOUPE_PORT || 4500);
export const NAME = process.env.LOUPE_NAME || 'loupe';
export const HOSTNAME = `${NAME}.local`;
// The typing shortcut: http://l.local/<github path> goes to loupe.local. Only the daemon named "loupe" owns it, so a second
// instance (LOUPE_NAME) never announces a name the first one holds.
export const SHORT_HOSTNAME = NAME === 'loupe' ? 'l.local' : null;
// Where the optional https listener looks for its certificate (see docs/HTTPS.md).
export const TLS_DIR = path.join(STATE_DIR, 'tls');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

for (const d of ['', 'ws', 'worktrees', 'repos', 'logs', 'snapshots']) fs.mkdirSync(path.join(STATE_DIR, d), { recursive: true });

// launchd starts us with a bare PATH: add the usual homes of git, gh, go and claude, so a lookup finds them.
const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'), path.join(HOME, 'go/bin'), path.dirname(process.execPath)];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), ...extra])].join(':');

function which(bin) {
  for (const dir of process.env.PATH.split(':')) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return '';
}
export const BIN = {
  git: process.env.LOUPE_GIT || which('git') || 'git',
  gh: process.env.LOUPE_GH || which('gh'),
  claude: process.env.LOUPE_CLAUDE || which('claude'),
  gopls: process.env.LOUPE_GOPLS || which('gopls'),
  go: which('go'),
};

// GOROOT and the module cache: the only places outside a repository the file viewer may open (for gopls jumps).
export const GO_ROOTS = (() => {
  if (!BIN.go) return [];
  try { return execFileSync(BIN.go, ['env', 'GOROOT', 'GOMODCACHE']).toString().split('\n').filter(Boolean); } catch { return []; }
})();

// Where to look for a clone of a GitHub repository when a PR link is opened.
// Where to look for an existing clone of a PR's repository (two levels deep), so a PR is fetched into it instead of
// cloned again. LOUPE_SEARCH replaces the list (colon-separated).
export const SEARCH_ROOTS = (process.env.LOUPE_SEARCH || [path.join(HOME, 'Projects'), path.join(HOME, 'code'), path.join(HOME, 'src'), path.join(HOME, 'dev')].join(':'))
  .split(':').filter((d) => fs.existsSync(d));

// The models a question may name; the page shows them in this order.
export const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-2', 'Fable 5.2'],
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULTS = {
  model: 'claude-opus-5-5', effort: 'xhigh', // a question, until the page remembers what you last picked
  briefModel: 'claude-sonnet-5-5', briefEffort: 'medium', // the TLDR and the guide: fast, and they read the whole diff
};
