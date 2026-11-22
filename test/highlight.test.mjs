import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHighlighter } from 'shiki';
import { highlightKey } from '../src/highlight.mjs';

test('the highlight key changes with the tokenizer theme and options', () => {
  const source = 'const n = 1;';
  const key = highlightKey('js', source);
  const options = { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false };
  assert.equal(key, highlightKey('js', source, options));
  assert.notEqual(key, highlightKey('js', source, { ...options, themes: { ...options.themes, dark: 'dracula' } }));
  assert.notEqual(key, highlightKey('js', source, { ...options, themes: { ...options.themes, light: 'min-light' } }));
  assert.notEqual(key, highlightKey('js', source, { ...options, defaultColor: 'light' }));
  assert.notEqual(key, highlightKey('ts', source));
  assert.notEqual(key, highlightKey('js', source + '\n'));
});

test('worker and content cache preserve the full Shiki token payload', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'loupe-tokens-'));
  process.env.LOUPE_HOME = state;
  try {
    const { highlightJSON } = await import('../src/highlight-cache.mjs');
    const themes = { light: 'github-light', dark: 'github-dark' };
    const h = await createHighlighter({ themes: Object.values(themes), langs: ['js', 'typescript', 'markdown', 'go'] });
    const cases = [
      ['.js', 'const s = `two\nlines ${name}\`;\n/* x\r\ny */\n'],
      ['.ts', 'type T = { target: string };\nconst a: T = { target: "é" };\n'],
      ['.md', '# title\n\n```js\nlet x = 1;\n```\n'],
      ['.go', 'package main\nvar a = `two\nlines\`\n'],
    ];
    for (const [extension, source] of cases) {
      const lang = { '.js': 'js', '.ts': 'ts', '.md': 'markdown', '.go': 'go' }[extension];
      const { tokens } = h.codeToTokens(source, { lang, themes, defaultColor: false });
      const palette = [];
      const lines = tokens.map((line) => line.map(({ content, htmlStyle, fontStyle }) => {
        const style = [htmlStyle?.['--shiki-light'] || '', htmlStyle?.['--shiki-dark'] || '', fontStyle || 0];
        let slot = palette.findIndex((entry) => entry.every((value, i) => value === style[i]));
        if (slot < 0) slot = palette.push(style) - 1;
        return [content, slot];
      }));
      const [fresh, sameBlob] = await Promise.all([
        highlightJSON(source, 'old' + extension), highlightJSON(source, 'renamed' + extension),
      ]);
      assert.deepEqual(JSON.parse(fresh), { lang, palette, lines });
      assert.equal(sameBlob, fresh);
      assert.equal(await highlightJSON(source, 'another' + extension), fresh);
      assert.notEqual(await highlightJSON(source + ' 0', 'old' + extension), fresh);
      if (extension === '.js') {
        const prefix = JSON.parse(await highlightJSON(source, 'first.js', { through: 2 }));
        assert.equal(prefix.through, 2);
        assert.deepEqual(prefix.lines, lines.slice(0, 2));
        assert.deepEqual(prefix.palette, palette.slice(0, prefix.palette.length));
        assert.equal(await highlightJSON(source, 'inline.js', { inline: true }), fresh);
      }
    }
    const directory = path.join(state, 'highlight-v1');
    for (let attempt = 0; attempt < 100; attempt++) {
      const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}$/.test(name));
      if (names.length === 9) {
        for (const name of names) assert.ok(JSON.parse(await readFile(path.join(directory, name), 'utf8')).lines.length);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Highlight entries did not reach the disk cache');
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
