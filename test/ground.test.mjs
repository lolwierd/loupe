// The plain ground, kept by a test: nothing in loupe blurs. Every shadow is whole pixels (no blur radius), there is
// no backdrop-filter, no blur() or drop-shadow() filter, no radial gradient, and a linear gradient is only one of the
// few that draw a hairline, a flat fill or type. Dither lives in plates (web/js/plate.js), never under a control.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const lineOf = (text, i) => text.slice(0, i).split('\n').length;

// the comma-separated parts of a value, at the top level of its brackets
function parts(value) {
  const out = []; let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// every custom property in the sheet, by name, with every definition of it (a scoped one counts as much as the first)
const bare = (value) => value.replace(/\s*!\s*important\s*$/i, '').trim(); // a value without its !important, which is no part of a shadow
function customProps(css) { const out = new Map(); for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) { if (!out.has(m[1])) out.set(m[1], []); out.get(m[1]).push(bare(m[2])); } return out; }
const NUM = /^[+-]?\d*\.?\d+(?:e[+-]?\d+)?[a-z%]*$/i; // a number with any unit, or none: whatever the unit is, it is a length here
const MATHS = /^(?:calc|min|max|clamp|env)\(/i;       // a length this reader cannot work out
// the words of one shadow, split on spaces outside brackets
function words(part) { const out = []; let depth = 0, cur = ''; for (const ch of part) { if (ch === '(') depth++; else if (ch === ')') depth--; if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; }
const isLength = (w) => NUM.test(w) || MATHS.test(w);
// a text with no length and no comma in it is a colour or a keyword: one is as good as another to this reader
const comma = (text) => { let depth = 0; for (const ch of text) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (ch === ',' && depth === 0) return true; } return false; };
const plain = (text) => (!comma(text) && !words(text).some(isLength) ? 'colour' : text);
// Every text a value can become once its variables are put in. CSS puts a variable's text in place before it reads the
// value, so a variable may hold a length, a run of lengths, the end of one shadow and the start of the next, or another
// variable; this does the same, with every definition the sheet gives each variable and with its fallback, each name
// once along the way. A variable the sheet never defines (set from script) is taken for a colour.
function expand(value, props, seen = new Set()) {
  const at = value.search(/var\(/i);
  if (at < 0) return [value];
  let depth = 0, end = at + 3; for (; end < value.length; end++) { if (value[end] === '(') depth++; else if (value[end] === ')' && --depth === 0) break; }
  const [name, ...rest] = parts(value.slice(at + 4, end)), fallback = rest.length ? rest.join(', ') : null;
  const texts = new Set();
  if (!seen.has(name)) { const inner = new Set(seen).add(name); for (const d of props.get(name) || []) for (const t of expand(d, props, inner)) texts.add(plain(t)); }
  if (fallback !== null) for (const t of expand(fallback, props, seen)) texts.add(plain(t));
  if (!texts.size) texts.add('colour');
  const out = new Set();
  for (const t of texts) for (const whole of expand(value.slice(0, at) + t + value.slice(end + 1), props, seen)) { out.add(whole); if (out.size >= 256) break; }
  return [...out];
}
// A shadow is soft when its third length, the blur, is not zero. Its lengths are x, y, blur and spread, in that order
// among its words; inset and the colour are passed over. A length that cannot be worked out (calc) counts as a blur,
// even one that would come to zero: the reader fails safe, and says which shadow it was.
function softPart(part) { const l = words(part).filter(isLength); return l.length >= 3 && (MATHS.test(l[2]) || parseFloat(l[2]) !== 0); }
// every box-shadow and text-shadow in the sheet, with the parts of it that are soft once its variables are put in
function shadows(css) {
  const props = customProps(css), out = [];
  for (const m of css.matchAll(/(?<![\w-])(box-shadow|text-shadow)\s*:\s*([^;{}]+)[;}]/gi)) {
    const bad = new Set();
    for (const text of expand(bare(m[2]), props)) for (const p of parts(text)) if (softPart(p)) bad.add(p.replace(/\s+/g, ' '));
    out.push({ prop: m[1], value: m[2].trim().replace(/\s+/g, ' '), soft: [...bad], line: lineOf(css, m.index) });
  }
  return out;
}
// Every gradient in a sheet, with the selector of the rule its declaration sits in: all of them, in order, duplicates
// kept, at every depth (a rule nested in a rule, a rule in a media query; an at-rule's own text is left out of the name).
function gradients(css) {
  const out = [], stack = [];
  let text = '';
  const flush = () => {
    const sel = stack.filter((x) => !x.startsWith('@')).join(' ');
    for (const decl of text.split(';')) {
      const re = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
      for (let g; (g = re.exec(decl));) {
        let depth = 0, end = g.index; for (; end < decl.length; end++) { if (decl[end] === '(') depth++; else if (decl[end] === ')' && --depth === 0) break; }
        out.push(`${sel} => ${decl.slice(g.index, end + 1).replace(/\s+/g, ' ')}`); re.lastIndex = end;
      }
    }
    text = '';
  };
  for (const ch of css) {
    if (ch === '{') { const cut = text.lastIndexOf(';') + 1, sel = text.slice(cut).trim().replace(/\s+/g, ' '); text = text.slice(0, cut); flush(); stack.push(sel); }
    else if (ch === '}') { flush(); stack.pop(); }
    else text += ch;
  }
  return out;
}

const SHEETS = ['web/style.css', 'extension/options.css'];
for (const file of SHEETS) {
  const css = stripComments(read(file));
  test(`${file}: no shadow has a blur radius`, () => {
    assert.deepEqual(shadows(css).filter((s) => s.soft.length).map((s) => `${file}:${s.line} ${s.prop}: ${s.value} (soft: ${s.soft.join(' | ')})`), []);
  });
  test(`${file}: nothing blurs and nothing glows`, () => {
    for (const [name, re] of [['blur()', /\bblur\(/i], ['backdrop-filter', /backdrop-filter/i], ['drop-shadow()', /drop-shadow\(/i], ['a radial gradient', /radial-gradient\(/i], ['a conic gradient', /conic-gradient\(/i]]) {
      const m = re.exec(css);
      assert.equal(m, null, m ? `${file}:${lineOf(css, m.index)} has ${name}` : '');
    }
  });
}

// The only gradients, each pinned to its selector and its exact text: a hairline, a hard-edged strip, a flat fill or
// moving type, never soft light. A new one, a second layer, or a change to one of these has to be added here on purpose.
const GRADIENTS = {
  'web/style.css': [
    '.resizer:hover, .resizer.drag => linear-gradient(to right, transparent 2px, var(--ink-3) 2px, var(--ink-3) 3px, transparent 3px)',
    '.ln.lit .cd => linear-gradient(var(--press), var(--press))',
    '.scrim.anchored => linear-gradient(to bottom, transparent var(--bar-h), var(--scrim-soft) var(--bar-h))',
    '.hc .px => repeating-linear-gradient(90deg, var(--rule-strong) 0 3px, transparent 3px 4px)',
    '.hc .px i => repeating-linear-gradient(90deg, var(--ok) 0 3px, transparent 3px 4px)',
    '.shimmer => linear-gradient(90deg, currentColor 0 40%, color-mix(in srgb, currentColor 35%, transparent) 50%, currentColor 60% 100%)',
  ],
  'extension/options.css': [],
};
for (const file of SHEETS) test(`${file}: every gradient is one of the known ones, unchanged`, () => {
  assert.deepEqual(gradients(stripComments(read(file))), GRADIENTS[file]);
});

test('the shadow and gradient readers are not fooled', () => {
  const softs = (css) => shadows(css).reduce((n, s) => n + s.soft.length, 0);
  assert.equal(softs('a { box-shadow: 0 1px var(--b) black; } :root { --b: 3px; }'), 1, 'a blur kept in a variable');
  assert.equal(softs(':root { --b: 0; } .x { --b: 3px; } a { box-shadow: 0 1px var(--b) black; }'), 1, 'a blur kept in a scoped redefinition');
  assert.equal(softs(':root { --s: red 0 1px\n 2px; } a { box-shadow: var(--s); }'), 1, 'a colour-first token over two lines');
  assert.equal(softs(':root { --s: 0 1px 0 #000; --t: var(--s), 0 2px 4px rgba(0,0,0,.2); } a { box-shadow: var(--t); }'), 1, 'a token built from a token');
  assert.equal(softs('a { box-shadow: var(--s, 0 0 3px red); }'), 1, 'a blur in a fallback');
  assert.equal(softs('a { box-shadow: 0 0 calc(2px + 1px) red; }'), 1, 'a blur worked out by calc');
  assert.equal(softs('a { box-shadow: 0 0 1vh red; }'), 1, 'a blur in another unit');
  assert.equal(softs('a { box-shadow: 0 0 1dvh red, 0 0 +3px red, 0 0 2cqw red; }'), 3, 'newer units and a signed number');
  assert.equal(softs(':root { --radius: 3px; --blur: var(--radius); } a { box-shadow: 0 0 var(--blur) red; }'), 1, 'a blur kept in a variable set from a variable');
  assert.equal(softs('a { box-shadow: 0 0 var(--blur, var(--radius, 3px)) red; }'), 1, 'a blur in a nested fallback');
  assert.equal(softs(':root { --a: var(--b); --b: var(--a); } a { box-shadow: 0 0 var(--a) red; }'), 0, 'a cycle ends');
  assert.equal(softs(':root { --skirt-offset: 0 2px; } a { box-shadow: var(--skirt-offset) 3px #000; }'), 1, 'two lengths kept in one variable, then a blur');
  assert.equal(softs(':root { --skirt-offset: 0 2px; } a { box-shadow: var(--skirt-offset) 0 #000; }'), 0, 'two lengths kept in one variable, then no blur');
  assert.equal(softs(':root { --o0: 0 0 0 0 transparent; --skirt: 4px var(--shade), var(--o0); } a { box-shadow: 0 2px var(--skirt); }'), 1, 'a variable that ends one shadow and starts the next');
  assert.equal(softs(':root { --lit: #fff; --t0: inset 0 0 0 0 transparent; --raised: inset 0 1px 0 var(--lit), var(--t0), 0 2px 0 var(--shade); } .x { --lit: rgba(255, 255, 255, 0.13); } a { box-shadow: var(--raised); }'), 0, 'a relief built from tokens, with a scoped colour');
  assert.equal(softs(':root { --raised: 0 1px 3px var(--shade); } a { box-shadow: var(--raised); } b { box-shadow: var(--raised), 0 0 0 1px red; }'), 2, 'a soft token, counted where it is used');
  assert.equal(softs('a { box-shadow: 0 2px 4px!important; } b { box-shadow: 0 2px 0 red !important; }'), 1, '!important is not part of the shadow');
  assert.equal(softs(':root { --tail: black,; } a { box-shadow: 0 2px var(--tail) 0 3px 4px red; }'), 1, 'a variable that ends a shadow with its comma');
  assert.equal(softs('a { BOX-SHADOW: 0 0 4PX red; }'), 1, 'upper case');
  assert.equal(softs(':root { --space: 1px 2px 3px; } a { padding: var(--space); box-shadow: 0 1px 0 #000; }'), 0, 'lengths that are not a shadow');
  assert.equal(softs('a { box-shadow: inset 0 0 0 1px var(--ink-3), 0 2px 0 var(--shade); } :root { --ink-3: #72727d; --shade: #c4c4cb; }'), 0, 'whole-pixel shadows with colours kept in variables');
  assert.equal(softs('a { box-shadow: 0 0 0 3px var(--press); } :root { --press: rgba(24, 24, 32, 0.08); }'), 0, 'a spread is not a blur');
  assert.deepEqual(gradients('a { background: linear-gradient(red, red), linear-gradient(to right, red, blue); } a { color: red; }'),
    ['a => linear-gradient(red, red)', 'a => linear-gradient(to right, red, blue)'], 'a second layer is seen');
  assert.equal(gradients('a { background: linear-gradient(red, blue); } a { background: linear-gradient(red, red); }').length, 2, 'a later block does not hide an earlier one');
  assert.deepEqual(gradients('.sheet { background: linear-gradient(red, blue); & .box { color: red; } } @media (min-width: 1px) { .x { background: linear-gradient(red, red) } }'),
    ['.sheet => linear-gradient(red, blue)', '.x => linear-gradient(red, red)'], 'a rule with a rule nested in it, and a rule in a media query');
});

test('the page draws no soft light from script', () => {
  const dir = path.join(root, 'web/js');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const [name, re] of [['shadowBlur', /\.shadowBlur\s*=/], ['a radial gradient', /createRadialGradient\(/], ['a blur filter', /filter\s*=\s*['"`][^'"`]*blur\(/], ['backdropFilter', /backdropFilter/], ['boxShadow', /\.boxShadow\s*=/]]) {
      assert.equal(re.test(js), false, `web/js/${f} uses ${name}`);
    }
  }
});

test('the plate engine: the 8×8 screen is a permutation, and Atkinson lands in three inks and paper', async () => {
  await import('../web/js/plate-core.js');
  const { B8, bayer8, tiers, TIERS, fbm } = globalThis.LoupePlate;
  assert.equal(B8.length, 64);
  assert.deepEqual([...B8].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i));
  assert.equal(bayer8(8, 8), bayer8(0, 0));
  assert.equal(bayer8(-1, -1), bayer8(7, 7));
  const w = 40, h = 30, paper = new Float32Array(w * h).fill(0.5), out = tiers(paper, w, h);
  assert.ok([...out].every((t) => t >= 0 && t <= TIERS));
  // a flat mid grey prints as a mix of the two middle tones, about half and half: the mean is kept
  const mean = out.reduce((a, t) => a + t / TIERS, 0) / out.length;
  assert.ok(Math.abs(mean - 0.5) < 0.06, `mean ${mean}`);
  assert.deepEqual([...tiers(new Float32Array(w * h).fill(1), w, h)].every((t) => t === TIERS), true);
  assert.deepEqual([...tiers(new Float32Array(w * h).fill(0), w, h)].every((t) => t === 0), true);
  const n = fbm(3.3, 7.1, 5);
  assert.ok(n >= 0 && n <= 1);
  assert.equal(fbm(3.3, 7.1, 5), n);
});
