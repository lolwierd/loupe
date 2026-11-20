import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Codex's models come from Codex's own cache: the newest of each line, in Codex's order; hidden ones and odd slugs never
// show, and a model the list has moved past resolves to the newest of its line
test('the picker lists the newest Codex model of each line, and an old pick moves to it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-codexhome-'));
  const m = (slug, display_name, priority, visibility = 'list') => ({ slug, display_name, priority, visibility, supported_in_api: true });
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
    m('gpt-7-sol', 'GPT-7-Sol', 1), m('gpt-6.1-terra', 'GPT-6.1 Terra', 3), m('gpt-reserve', 'GPT-Reserve', 4, 'hide'), m('gpt-6.5-sol', 'GPT-6.5-Sol', 5),
    m('gpt-6-astra', 'GPT-6-Astra', 6), m('gpt-6.2-astra', 'GPT-6.2-Astra', 2), m('gpt-5.6-terra', 'GPT-5.6-Terra', 10), m('codex-auto-review', 'Codex Auto Review', 12, 'hide'),
  ] }));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const c = await import('./src/config.mjs'); console.log(JSON.stringify({ m: c.MODELS.filter(([id]) => c.modelKind(id) === 'codex'), d: c.codexDefault(), up: [c.currentModel('gpt-6-astra'), c.currentModel('gpt-5.6-terra'), c.currentModel('claude-opus-5-1'), c.currentModel('gpt-6-luna')] }))"],
    { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' });
  const { m: models, d, up } = JSON.parse(out);
  assert.deepEqual(models, [['gpt-7-sol', 'GPT-7 Sol'], ['gpt-6.2-astra', 'GPT-6.2 Astra'], ['gpt-6.1-terra', 'GPT-6.1 Terra']]);
  assert.equal(d, 'gpt-7-sol');
  assert.deepEqual(up, ['gpt-6.2-astra', 'gpt-6.1-terra', 'claude-opus-5-5', null]);
});

test('guide normalization keeps crowded diagram nodes in distinct cells', { timeout: 5000 }, () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { normalizeGuide } = await import('./src/claude.mjs');
    const nodes = Array.from({ length: 16 }, (_, i) => ({ id: String(i), label: 'Node ' + i, col: 5, row: 5 }));
    const guide = normalizeGuide({ diagrams: [{ nodes }] }, []);
    console.log(JSON.stringify(guide.diagrams[0].nodes.map(({ col, row }) => [col, row])));
  `], { encoding: 'utf8', timeout: 4000 });
  const cells = JSON.parse(out);
  assert.equal(cells.length, 16);
  assert.equal(new Set(cells.map(String)).size, 16);
});
