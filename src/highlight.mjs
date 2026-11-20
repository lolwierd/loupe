// Syntax highlighting with Shiki: VS Code's TextMate grammars and GitHub's light and dark themes, whole files at a
// time so multi-line strings and comments come out right. The page gets tokens as [text, paletteIndex] per line.
import path from 'node:path';
import { createHighlighter, bundledLanguages } from 'shiki';
import { Lru } from './util.mjs';

let hlP = null;
export const highlighter = () => (hlP ||= createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] }));

const LANG = {
  go: 'go', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', mdx: 'mdx', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', rb: 'ruby', rs: 'rust', hcl: 'hcl', tf: 'hcl', tfvars: 'hcl',
  toml: 'toml', service: 'ini', ini: 'ini', conf: 'ini', html: 'html', css: 'css', scss: 'scss', proto: 'proto', mod: 'go', sum: 'text', swift: 'swift',
  kt: 'kotlin', java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', lua: 'lua', nix: 'nix', vue: 'vue', svelte: 'svelte', xml: 'xml', plist: 'xml',
  graphql: 'graphql', gql: 'graphql', ps1: 'powershell', dockerfile: 'docker', cue: 'cue', zig: 'zig', ex: 'elixir', exs: 'elixir',
};
export function langFor(p) {
  const base = path.basename(p).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return 'docker';
  if (base === 'makefile' || base.endsWith('.mk')) return 'make';
  if (base === 'justfile') return 'just';
  const parts = base.split('.');
  const ext = parts.length > 1 ? parts.at(-1) : '';
  // name.hcl.linux.tmpl, app.service.j2: the inner extension says what the template renders.
  const lang = ext === 'tmpl' || ext === 'j2' || ext === 'tpl' ? LANG[parts.slice(1, -1).find((x) => LANG[x])] : LANG[ext];
  return lang && (lang === 'text' || bundledLanguages[lang]) ? lang : 'text';
}

const cache = new Lru(400);
export async function tokens(key, text, p) {
  if (cache.has(key)) return cache.get(key);
  const lang = langFor(p);
  // Very large files are drawn plain: highlighting them would stall the server for seconds.
  if (lang === 'text' || text.length > 1_500_000) {
    const out = { lang: 'text', palette: [['', '', 0]], lines: text.split('\n').map((s) => [[s, 0]]) };
    cache.set(key, out);
    return out;
  }
  const h = await highlighter();
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  const r = h.codeToTokens(text, { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false });
  const palette = [], seen = new Map();
  const lines = r.tokens.map((line) => line.map((t) => {
    const s = t.htmlStyle || {};
    const k = `${s['--shiki-light'] || ''}|${s['--shiki-dark'] || ''}|${t.fontStyle || 0}`;
    if (!seen.has(k)) { seen.set(k, palette.length); palette.push([s['--shiki-light'] || '', s['--shiki-dark'] || '', t.fontStyle || 0]); }
    return [t.content, seen.get(k)];
  }));
  const out = { lang, palette, lines };
  cache.set(key, out);
  return out;
}
