// Keeps the pickers on the newest model of each line without a release of loupe.
// Claude: the Agent SDK's supportedModels(), whose alias rows (opus, sonnet, haiku, fable) resolve to the newest of each
// line for this account. It answers from the local Claude Code without a model turn; loupe asks at start and every six
// hours. Codex: the CLI's models_cache.json, which the CLI refreshes as it runs; loupe reads it again when it changes.
// A provider that cannot be asked keeps the list it had (at first the fixed one in config.mjs).
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BIN, MODELS, CODEX_CACHE, codexModels, claudeFixed, newestPerLine, setModels } from './config.mjs';

const ORDER = ['opus', 'sonnet', 'haiku', 'fable']; // the page's order; a new line goes after these
let claude = claudeFixed();

async function askClaude() {
  const never = (async function* () { await new Promise(() => {}); })(); // a session that is never sent a prompt
  const q = query({ prompt: never, options: { ...(BIN.claude ? { pathToClaudeCodeExecutable: BIN.claude } : {}), tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } } });
  try {
    const rows = await Promise.race([q.supportedModels(), new Promise((_, no) => setTimeout(() => no(new Error('no answer in 20 s')), 20000))]);
    const line = (id) => /^claude-([a-z]+)-/.exec(id)[1], rank = (id) => (ORDER.includes(line(id)) ? ORDER.indexOf(line(id)) : ORDER.length);
    const list = rows.filter((r) => r.value !== 'default').map((r) => [r.resolvedModel || r.value, r.displayName])
      .filter(([id], i, all) => /^claude-[a-z]+-[\d-]+$/.test(id) && all.findIndex(([x]) => x === id) === i); // explicit ids only, once each
    return newestPerLine(list).sort((a, b) => rank(a[0]) - rank(b[0]));
  } finally { try { q.close?.(); } catch { /* already gone */ } }
}

function apply(why) {
  const before = MODELS.map(([id]) => id).join(' ');
  setModels(claude, codexModels());
  const after = MODELS.map(([id]) => id).join(' ');
  if (after !== before) console.log(`loupe: models (${why}): ${MODELS.map(([, l]) => l).join(', ')}`);
}

export async function refreshClaude() {
  try { const got = await askClaude(); if (got.length) claude = got; } catch (e) { console.log(`loupe: could not list Claude's models (${e.message}); keeping the last list`); }
  apply('Claude');
}

// started once by the daemon; LOUPE_MODELS=fixed (the tests) keeps the starting list
export function keepModelsCurrent() {
  if (process.env.LOUPE_MODELS === 'fixed') return;
  refreshClaude();
  setInterval(refreshClaude, 6 * 60 * 60 * 1000).unref();
  fs.watchFile(CODEX_CACHE, { interval: 60 * 1000 }, () => apply('Codex'));
}
