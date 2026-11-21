// Keeps the pickers on the newest model of each line without a release of loupe.
// Claude: the Agent SDK's supportedModels(), whose alias rows (opus, sonnet, haiku, fable) resolve to the newest of each
// line for this account. It answers from the local Claude Code without a model turn; loupe asks at start and every six
// hours. Codex: the CLI's models_cache.json, which the CLI refreshes as it runs; loupe reads it again when it changes.
// A provider that cannot be asked keeps the list it had (at first the fixed one in config.mjs).
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BIN, MODELS, CODEX_CACHE, codexModels, claudeFixed, newestPerLine, setModels, modelKind } from './config.mjs';

const ORDER = ['opus', 'sonnet', 'haiku', 'fable']; // the page's order; a new line goes after these
let claude = claudeFixed();
let changed = () => {};
// What the last ask of Claude Code came to, for `loupe doctor`: null until the first answer (and with LOUPE_MODELS=fixed).
export const reach = { claude: null };

// The model list answers without a login, so the account says whether answers will work. Signed out, Claude Code reports
// tokenSource "none" and no email; another provider (Bedrock, Vertex, a gateway) signs in outside it. null: unknown.
function signedIn(a) {
  if (!a) return null;
  if (a.apiProvider && a.apiProvider !== 'firstParty') return true;
  return !!a.email || [a.tokenSource, a.apiKeySource].some((s) => s && s !== 'none');
}

async function askClaude() {
  const never = (async function* () { await new Promise(() => {}); })(); // a session that is never sent a prompt
  const q = query({ prompt: never, options: { ...(BIN.claude ? { pathToClaudeCodeExecutable: BIN.claude } : {}), tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } } });
  let timer;
  try {
    const asked = Promise.all([q.supportedModels(), q.accountInfo().catch(() => null)]);
    const [rows, account] = await Promise.race([asked, new Promise((_, no) => { timer = setTimeout(() => no(new Error('no answer in 20 s')), 20000); })]);
    const line = (id) => /^claude-([a-z]+)-/.exec(id)[1], rank = (id) => (ORDER.includes(line(id)) ? ORDER.indexOf(line(id)) : ORDER.length);
    const list = rows.filter((r) => r.value !== 'default').map((r) => [r.resolvedModel || r.value, r.displayName])
      .filter(([id], i, all) => /^claude-[a-z]+-[\d-]+$/.test(id) && all.findIndex(([x]) => x === id) === i); // explicit ids only, once each
    return { models: newestPerLine(list).sort((a, b) => rank(a[0]) - rank(b[0])), signedIn: signedIn(account) };
  } finally { clearTimeout(timer); try { q.close(); } catch { /* already gone */ } }
}

function apply(why) {
  const before = JSON.stringify(MODELS);
  const codex = codexModels(MODELS.filter(([id]) => modelKind(id) === 'codex'));
  setModels(claude, codex);
  if (JSON.stringify(MODELS) !== before) {
    console.log(`loupe: models (${why}): ${MODELS.map(([, l]) => l).join(', ')}`);
    changed();
  }
}

export async function refreshClaude() {
  try {
    const got = await askClaude();
    if (got.models.length) claude = got.models;
    reach.claude = { ok: true, signedIn: got.signedIn, models: got.models.length, at: Date.now() };
  } catch (e) {
    reach.claude = { ok: false, error: e.message, at: Date.now() };
    console.log(`loupe: could not list Claude's models (${e.message}); keeping the last list`);
  }
  apply('Claude');
}

// started once by the daemon; LOUPE_MODELS=fixed (the tests) keeps the starting list
export function keepModelsCurrent(onChange) {
  if (process.env.LOUPE_MODELS === 'fixed') { reach.claude = { skipped: true }; return; }
  changed = onChange;
  refreshClaude();
  setInterval(refreshClaude, 6 * 60 * 60 * 1000).unref();
  fs.watchFile(CODEX_CACHE, { interval: 60 * 1000, persistent: false }, () => apply('Codex'));
}
