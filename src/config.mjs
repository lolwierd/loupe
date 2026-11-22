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
  // a Chrome to render a scene in before it is kept (none: scenes are kept without that look)
  chrome: process.env.LOUPE_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || which('google-chrome') || which('chromium') || '',
};

// GOROOT and the module cache: the only places outside a repository the file viewer may open (for gopls jumps).
export const GO_ROOTS = (() => {
  if (!BIN.go) return [];
  try { return execFileSync(BIN.go, ['env', 'GOROOT', 'GOMODCACHE']).toString().split('\n').filter(Boolean); } catch { return []; }
})();

// Go's build cache: a chat's commands may write there (go build, go test), the one place outside the checkout they may.
export const GO_CACHE = (() => {
  if (!BIN.go) return null;
  try { return execFileSync(BIN.go, ['env', 'GOCACHE']).toString().trim() || null; } catch { return null; }
})();

// Where to look for a clone of a GitHub repository when a PR link is opened.
// Where to look for an existing clone of a PR's repository (two levels deep), so a PR is fetched into it instead of
// cloned again. LOUPE_SEARCH replaces the list (colon-separated).
export const SEARCH_ROOTS = (process.env.LOUPE_SEARCH || [path.join(HOME, 'Projects'), path.join(HOME, 'code'), path.join(HOME, 'src'), path.join(HOME, 'dev')].join(':'))
  .split(':').filter((d) => fs.existsSync(d));

// The models a question may name, in the order the page shows them: the newest of each line, Claude's then Codex's.
// models.mjs keeps the list current from each provider's own list (models.mjs says how); these are where it starts, and
// what stands when a provider cannot be asked.
const CLAUDE_FIXED = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-2', 'Fable 5.2']];
export const MODELS = [];
const CODEX_MODELS = new Set();
export const codexDefault = () => [...CODEX_MODELS][0] || 'gpt-6.2-sol';
export const modelKind = (model) => CODEX_MODELS.has(model) || /^gpt-/.test(model || '') ? 'codex' : 'claude';
// a line is what stays the same from one version to the next: opus, sonnet; gpt:astra, gpt:terra
export const lineOf = (id = '') => { const c = /^claude-([a-z]+)-/.exec(id), g = /^gpt-[\d.]+-([a-z]+)$/.exec(id); return c ? c[1] : g ? 'gpt:' + g[1] : null; };
// a model still offered, or the newest of its line when it is not (a choice remembered from before an update)
export const currentModel = (id) => (MODELS.some(([m]) => m === id) ? id : MODELS.find(([m]) => lineOf(id) && lineOf(m) === lineOf(id))?.[0] || null);
// the newest of each line in a list of [id, label], keeping the list's order
export function newestPerLine(list) {
  const ver = (id) => (/^claude-[a-z]+-([\d-]+)/.exec(id)?.[1] || /^gpt-([\d.]+)-/.exec(id)?.[1] || '0').split(/[-.]/).map(Number);
  const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  const best = new Map();
  for (const [id] of list) { const l = lineOf(id) || id; if (!best.has(l) || newer(id, best.get(l))) best.set(l, id); }
  const keep = new Set(best.values());
  return list.filter(([id]) => keep.has(id));
}

// Codex's models are the ones Codex itself lists for this account: its CLI keeps them, refreshed as it runs, in
// models_cache.json under CODEX_HOME (the CLI's own variable) or ~/.codex. The newest of each line (Sol, Astra, Terra,
// Luna), in Codex's own order; a fixed pair when the file cannot be read.
export const CODEX_CACHE = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'models_cache.json');
const CODEX_FIXED = [['gpt-6.2-sol', 'GPT-6.2 Sol'], ['gpt-6.2-astra', 'GPT-6.2 Astra']];
export function codexModels(fallback = CODEX_FIXED) {
  const label = (m) => (m.display_name || m.slug).replace(/^GPT-([\d.]+)[- ]/, 'GPT-$1 ');
  try {
    const listed = JSON.parse(fs.readFileSync(CODEX_CACHE, 'utf8')).models
      .filter((m) => m.visibility === 'list' && m.supported_in_api !== false && /^gpt-[\d.]+-[a-z]+$/.test(m.slug))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const out = newestPerLine(listed.map((m) => [m.slug, label(m)]));
    if (out.length) return out;
  } catch { /* no Codex here, or an unreadable cache */ }
  return fallback;
}
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULTS = {
  model: 'claude-opus-5-5', effort: 'xhigh', // a question, until the page remembers what you last picked
  briefModel: 'claude-sonnet-5-5', briefEffort: 'high', // the map of a change: it reads around the change, so it gets room to think
  notesModel: 'claude-haiku-5-5', notesEffort: 'medium', // medium: at low it retold the diffs; medium links the files (22 Nov)
};
// put a new list in place; the defaults follow their lines (a question on the newest Opus, the map on the newest Sonnet)
export function setModels(claude, codex) {
  MODELS.splice(0, MODELS.length, ...claude, ...codex);
  CODEX_MODELS.clear(); for (const [id] of codex) CODEX_MODELS.add(id);
  DEFAULTS.model = claude.find(([id]) => lineOf(id) === 'opus')?.[0] || claude[0]?.[0] || DEFAULTS.model;
  DEFAULTS.briefModel = claude.find(([id]) => lineOf(id) === 'sonnet')?.[0] || DEFAULTS.model;
  DEFAULTS.notesModel = claude.find(([id]) => lineOf(id) === 'haiku')?.[0] || DEFAULTS.model;
}
export const claudeFixed = () => CLAUDE_FIXED;
setModels(CLAUDE_FIXED, codexModels());
