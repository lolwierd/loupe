// Every script the page and the daemon load parses: a slip in one page script stops the whole page, and nothing else here loads them all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

test('every page and daemon script parses', () => {
  const files = [...fs.readdirSync('web/js').map((f) => `web/js/${f}`), ...fs.readdirSync('src').filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`)].filter((f) => /\.m?js$/.test(f));
  const bad = [];
  for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad.push(`${f}: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`); } }
  assert.deepEqual(bad, []);
});
