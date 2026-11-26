// The guide a chat can change, and the scenes in it (documents a model writes, rendered before they are kept); every edit
// can be undone; a new brief keeps what chats made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeScene } from '../src/scenes.mjs';
import { normalizeGuide, editGuide, undoGuide, carryChatParts, ensureIds, guideSummary, guidePart, guideEdits, chatEditsToBrief, checkId } from '../src/guide.mjs';

const file = (path, kind = 'code') => ({ path, kind, added: 3, deleted: 1 });
const FILES = [file('pantry/shelf.go'), file('pantry/shelf_test.go', 'test'), file('pantry/restock.go'), file('docs/pantry.md', 'docs'), file('go.sum', 'generated')];
const scene = (html, extra = {}) => ({ title: 'Restocking', why: 'Jars come and go over time.', section: 1, height: 260, html, ...extra });
const DRAWS = '<div class="shelf"><span class="jar">jar</span></div><style>.jar { animation: slide 2s infinite; } @keyframes slide { to { transform: translateX(80px); } }</style>';

function brief() {
  const b = normalizeGuide({
    tldr: 'The pantry restocks itself.', risk: 'typical', riskWhy: 'Shelves can overflow.',
    context: { system: 'A pantry.', before: 'Manual.', after: 'Automatic.' },
    diagrams: [{ kind: 'map', title: 'The pantry', nodes: [{ id: 'a', label: 'Shelf', kind: 'code', col: 0, row: 0, change: 'changed' }, { id: 'b', label: 'Restock', kind: 'code', col: 1, row: 0, change: 'new' }], edges: [{ from: 'b', to: 'a' }] }],
    plan: { start: 'pantry/shelf.go', steps: ['Read the shelf.'] },
    motion: { warranted: true, why: 'Jars arrive and expire over time.', title: 'A day of restocking', section: 1, story: 'The shelf fills, a jar expires, restock refills it.' },
    sections: [
      { title: 'The shelf holds jars', role: 'core', why: 'Why.', files: ['pantry/shelf.go', 'pantry/restock.go'] },
      { title: 'Tests', role: 'tests', why: 'Tests.', files: ['pantry/shelf_test.go'] },
    ],
  }, FILES);
  return { brief: { key: 'k1', at: 1000, ...b }, checks: {}, guideHistory: [] };
}

test('a scene is a document: kept with its html and its words cut to fit; none, or too much, is not kept', async () => {
  assert.match((await normalizeScene(scene(''))).problem, /no html/);
  assert.match((await normalizeScene(scene('x'.repeat(200001)))).problem, /over 200,000/);
  assert.match((await normalizeScene(null)).problem, /not an object/);
  const { scene: s } = await normalizeScene(scene(DRAWS, { title: 't'.repeat(200), height: 9000, section: -3 }));
  assert.equal(s.html, DRAWS); assert.equal(s.title.length, 80); assert.equal(s.height, 700); assert.equal(s.section, 0);
  assert.equal((await normalizeScene(scene(DRAWS, { height: 20 }))).scene.height, 200);
});
test('the brief says whether a scene is warranted, and its parts get ids', async () => {
  const { brief: b } = brief();
  assert.ok(b.sections.every((s) => s.id) && b.diagrams.every((d) => d.id));
  assert.equal(b.motion.warranted, true);
  assert.equal(b.motion.sectionId, b.sections[0].id);
  assert.equal(normalizeGuide({ motion: { warranted: true, story: '' } }, FILES).motion.warranted, false, 'no story, no scene');
  assert.deepEqual(b.sections.find((s) => s.title === 'Other changes').files, ['docs/pantry.md']);
  assert.deepEqual(b.sections.at(-1).files, ['go.sum'], 'generated files last, in their own');
});

// the checks a section shows ticked, by their words
const ticked = (d, sec) => (sec.check || []).filter((c) => d.checks[`${d.brief.at}:${sec.id}:${checkId(c)}`]);
const tick = (d, sec, c, v = 1) => { d.checks[`${d.brief.at}:${sec.id}:${checkId(c)}`] = v; };

test('a chat adds a section: it takes its files from the brief\'s sections, and undo puts the guide back', async () => {
  const d = brief(), before = JSON.stringify(d.brief.sections);
  const r = await editGuide(d, FILES, { op: 'add', kind: 'section', at: 0, value: { title: 'Restocking', role: 'core', why: 'It refills.', files: ['restock.go'] } }, { conv: 'chat-1' });
  assert.ok(r.ok, r.message);
  const [first, second] = d.brief.sections;
  assert.equal(first.title, 'Restocking'); assert.equal(first.by, 'chat'); assert.equal(first.origin, 'chat'); assert.equal(first.conv, 'chat-1');
  assert.deepEqual(first.files, ['pantry/restock.go']);
  assert.deepEqual(second.files, ['pantry/shelf.go'], 'the file left the section it was in');
  assert.match(guideSummary(d.brief), /made in chat/);
  assert.equal(guideEdits(d)[0].undo, true);
  assert.ok(undoGuide(d, r.entry.id, FILES).ok);
  assert.equal(JSON.stringify(d.brief.sections), before);
  assert.equal(undoGuide(d, r.entry.id, FILES).ok, false, 'an edit is undone once');
});

test('a section holds only the change\'s files; removing one sends its files to Other changes, which cannot be removed', async () => {
  const d = brief();
  assert.equal((await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'Elsewhere', role: 'core', why: '', files: ['not/here.go'] } })).ok, false);
  const tests = d.brief.sections.find((s) => s.role === 'tests');
  assert.ok((await editGuide(d, FILES, { op: 'remove', kind: 'section', id: tests.id })).ok);
  const other = d.brief.sections.find((s) => s.title === 'Other changes');
  assert.ok(other.files.includes('pantry/shelf_test.go'));
  assert.equal(d.brief.sections.flatMap((s) => s.files).length, FILES.length, 'every file in exactly one section');
  const r = await editGuide(d, FILES, { op: 'remove', kind: 'section', id: other.id });
  assert.equal(r.ok, false); assert.match(r.message, /no section claims/);
});

test('a chat\'s section takes files from other chat sections, but never all of one: that is removed by asking', async () => {
  const d = brief();
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'A', role: 'core', why: '', files: ['pantry/shelf.go', 'pantry/shelf_test.go'] } }, { conv: 'c' })).ok);
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'B', role: 'core', why: '', files: ['pantry/restock.go'] } }, { conv: 'c' })).ok);
  const all = await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'C', role: 'core', why: '', files: ['pantry/shelf.go', 'pantry/restock.go'] } }, { conv: 'c' });
  assert.equal(all.ok, false); assert.match(all.message, /"B", a section made in chat/);
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'C', role: 'core', why: '', files: ['pantry/shelf.go'] } }, { conv: 'c' })).ok);
  assert.deepEqual(d.brief.sections.find((s) => s.title === 'C').files, ['pantry/shelf.go']);
  assert.deepEqual(d.brief.sections.find((s) => s.title === 'A').files, ['pantry/shelf_test.go']);
  assert.equal(d.brief.sections.flatMap((s) => s.files).length, FILES.length);
});

test('a chat adds a scene that runs, is refused one that does not, and can replace and remove it', async () => {
  const d = brief();
  const bad = await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene('') });
  assert.equal(bad.ok, false); assert.match(bad.message, /no html/);
  // loupe renders it as the card would: one that shows nothing is refused, and what else it finds goes back to the chat
  const blank = await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { render: async () => ({ problem: 'it renders nothing: the frame stayed empty', errors: ['x is not defined'], cut: [] }) });
  assert.equal(blank.ok, false); assert.match(blank.message, /renders nothing.*x is not defined/);
  assert.equal(d.brief.scenes.length, 0, 'a refused scene leaves nothing');
  const rough = await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { render: async () => ({ problem: null, errors: [], cut: ['the text "front" is cut off in its box'] }) });
  assert.ok(rough.ok); assert.match(rough.message, /found: the text "front" is cut off/);
  assert.ok(undoGuide(d, rough.entry.id).ok);
  const add = await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { conv: 'chat-2' });
  assert.ok(add.ok, add.message);
  const sc = d.brief.scenes[0];
  assert.equal(sc.sectionId, d.brief.sections[0].id); assert.equal(sc.by, 'chat');
  const rep = await editGuide(d, FILES, { op: 'replace', kind: 'scene', id: sc.id, value: scene(DRAWS, { title: 'Restocking, slower' }) });
  assert.ok(rep.ok); assert.equal(d.brief.scenes[0].id, sc.id); assert.equal(d.brief.scenes[0].title, 'Restocking, slower');
  assert.equal(undoGuide(d, add.entry.id).ok, false, 'the newest edit is undone first');
  assert.ok(undoGuide(d, rep.entry.id).ok); assert.equal(d.brief.scenes[0].title, 'Restocking');
  assert.ok(undoGuide(d, add.entry.id).ok); assert.equal(d.brief.scenes.length, 0);
});

test('diagrams and the TLDR: replaced and undone; a diagram must draw; no guide, no edit', async () => {
  const d = brief(), dg = d.brief.diagrams[0];
  assert.equal((await editGuide(d, FILES, { op: 'replace', kind: 'diagram', id: dg.id, value: { kind: 'map', nodes: [{ id: 'x', label: 'Only one' }] } })).ok, false);
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'diagram', id: dg.id, value: { ...dg, title: 'The pantry, closer' } })).ok);
  assert.equal(d.brief.diagrams[0].title, 'The pantry, closer'); assert.equal(d.brief.diagrams[0].id, dg.id);
  const t = await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'It restocks at night.' });
  assert.ok(t.ok); assert.equal(d.brief.tldr, 'It restocks at night.');
  assert.ok(undoGuide(d, t.entry.id).ok); assert.equal(d.brief.tldr, 'The pantry restocks itself.'); assert.equal(d.brief.tldrBy, undefined);
  assert.equal((await editGuide({ brief: null }, FILES, { op: 'add', kind: 'section', value: {} })).ok, false);
  // two edits to the same words come back in order
  const a = await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'Same words.' }), b = await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'Same words.' });
  assert.equal(undoGuide(d, a.entry.id).ok, false); assert.ok(undoGuide(d, b.entry.id).ok); assert.ok(undoGuide(d, a.entry.id).ok);
  assert.equal(d.brief.tldr, 'The pantry restocks itself.');
});

test('undo is for the guide as the edit left it: a scene the brief drew since, or a new brief, stops it', async () => {
  const d = brief();
  const gone = await editGuide(d, FILES, { op: 'remove', kind: 'diagram', id: d.brief.diagrams[0].id }, { conv: 'c' });
  d.brief.scenes.push({ id: 'drawn', title: 'Drawn by the brief', by: 'brief', origin: 'brief', html: DRAWS, height: 260 }); // the brief's scene lands
  const u = undoGuide(d, gone.entry.id, FILES);
  assert.equal(u.ok, false); assert.match(u.message, /can no longer be undone/);
  assert.equal(guideEdits(d)[0].undo, false, 'the page offers no Undo it cannot do');
  const d2 = brief(), e = await editGuide(d2, FILES, { op: 'replace', kind: 'tldr', value: 'x' });
  d2.brief = { ...brief().brief, at: 2000 };
  assert.equal(undoGuide(d2, e.entry.id, FILES).ok, false);
});

test('undo after the change moved on still places every file the change has now', async () => {
  const d = brief();
  const r = await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'Restocking', role: 'core', why: '', files: ['pantry/restock.go'] } });
  const now = [...FILES, file('pantry/label.go')];
  assert.ok(undoGuide(d, r.entry.id, now).ok);
  assert.deepEqual(d.brief.sections.flatMap((s) => s.files).sort(), now.map((f) => f.path).sort());
});

test('ticks are the reader\'s: they follow a check\'s words through replace and undo, and are never undone', async () => {
  const d = brief(), sec = d.brief.sections[0];
  sec.check = ['Jars fit.', 'Lids close.'];
  tick(d, sec, 'Jars fit.');
  const r = await editGuide(d, FILES, { op: 'replace', kind: 'section', id: sec.id, value: { ...sec, check: ['Lids close.', 'Jars fit.', 'Labels face out.'] } });
  const now = d.brief.sections.find((s) => s.id === sec.id);
  assert.deepEqual(ticked(d, now), ['Jars fit.'], 'the tick moved with its check');
  tick(d, now, 'Labels face out.'); delete d.checks[`1000:${sec.id}:${checkId('Jars fit.')}`]; tick(d, now, 'Lids close.');
  assert.ok(undoGuide(d, r.entry.id, FILES).ok);
  assert.deepEqual(ticked(d, d.brief.sections.find((s) => s.id === sec.id)), ['Lids close.'], 'the reader\'s ticks since stand; a check that went takes its tick with it');
  // checks are each once: a tick is keyed by its words
  assert.deepEqual(normalizeGuide({ sections: [{ title: 'S', role: 'core', why: '', check: ['Same.', 'Same.', ' Same. '], files: ['pantry/shelf.go'] }] }, FILES).sections[0].check, ['Same.']);
});

test('a brief written before parts had ids keeps its ticks when they get them', async () => {
  const d = brief(), [a, b] = d.brief.sections;
  a.check = ['Jars fit.', 'Lids close.']; b.check = ['Tests run.'];
  for (const s of d.brief.sections) delete s.id;
  d.checks = { '1000:0:1': 5, '1000:1:0': 6, '999:0:0': 7 };
  ensureIds(d);
  assert.deepEqual(d.checks, { [`1000:${a.id}:${checkId('Lids close.')}`]: 5, [`1000:${b.id}:${checkId('Tests run.')}`]: 6, '999:0:0': 7 });
});

test('a new brief keeps what chats made and writes its own parts again; Regenerate counts what it drops', async () => {
  const d = brief(), sec = d.brief.sections[0];
  await editGuide(d, FILES, { op: 'add', kind: 'section', at: 1, value: { title: 'Restocking', role: 'core', why: 'It refills.', files: ['pantry/restock.go'] } }, { conv: 'c' });
  await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { conv: 'c' });
  const mine = await editGuide(d, FILES, { op: 'add', kind: 'diagram', value: { kind: 'map', title: 'Mine', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] } });
  await editGuide(d, FILES, { op: 'replace', kind: 'diagram', id: mine.entry.partId, value: { kind: 'map', title: 'Mine, again', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] } });
  assert.equal(chatEditsToBrief(d), 0, 'changing what chat made is kept by a new brief');
  const cur = d.brief.sections.find((s) => s.id === sec.id); // as it is now: Restocking took one of its files
  await editGuide(d, FILES, { op: 'replace', kind: 'section', id: sec.id, value: { ...cur, title: 'Shelves, in chat\'s words' } });
  await editGuide(d, FILES, { op: 'remove', kind: 'diagram', id: d.brief.diagrams[0].id });
  await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'It restocks at night.' });
  assert.equal(chatEditsToBrief(d), 3, 'a brief section changed, a brief diagram removed, the TLDR rewritten');
  for (let i = 0; i < 25; i++) await editGuide(d, FILES, { op: 'add', kind: 'diagram', value: { kind: 'map', title: `Extra ${i}`, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] } });
  assert.equal(chatEditsToBrief(d), 3, 'read from the guide, not from the history (which keeps only the last edits)');
  const next = carryChatParts(d.brief, brief().brief, FILES);
  assert.ok(next.sections.some((s) => s.title === 'Restocking')); assert.ok(!next.sections.some((s) => s.title === 'Shelves, in chat\'s words'));
  assert.equal(next.sections.flatMap((s) => s.files).length, FILES.length);
  assert.equal(next.scenes.length, 1); assert.ok(next.diagrams.some((x) => x.title === 'Mine, again'));
  assert.equal(chatEditsToBrief({ brief: next }), 0);
});

test('an edit being checked when the brief was written again, or after its turn, is refused', async () => {
  const d = brief();
  const pending = editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { conv: 'c' });
  const fresh = brief().brief; fresh.at = 2000; d.brief = fresh;
  const r = await pending;
  assert.equal(r.ok, false); assert.match(r.message, /written again/);
  assert.equal(d.brief.scenes.length, 0); assert.equal(d.guideHistory.length, 0);
  let alive = true;
  const d3 = brief(), late = editGuide(d3, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { live: () => alive });
  alive = false;
  assert.equal((await late).ok, false);
  assert.equal((await editGuide(brief(), FILES, { op: 'replace', kind: 'tldr', value: 'Late.' }, { live: () => false })).ok, false);
});

test('the scene lands on the section the model meant, though a section before it held no file and went', () => {
  const g = normalizeGuide({ motion: { warranted: true, story: 'x', section: 2 }, sections: [{ title: 'Ghost', role: 'core', why: '', files: ['nowhere.go'] }, { title: 'Shelf', role: 'core', why: '', files: ['pantry/shelf.go'] }, { title: 'Restock', role: 'core', why: '', files: ['pantry/restock.go'] }] }, FILES);
  assert.equal(g.sections.find((s) => s.id === g.motion.sectionId)?.title, 'Shelf');
});

test('an add never takes the id of a part already there', async () => {
  const d = brief(), first = d.brief.sections[0];
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'section', id: first.id, value: { id: first.id, title: 'Copy', role: 'core', why: '', files: ['pantry/restock.go'] } })).ok);
  assert.equal(new Set(d.brief.sections.map((s) => s.id)).size, d.brief.sections.length);
  const dg = d.brief.diagrams[0];
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'diagram', id: dg.id, value: { ...dg } })).ok);
  assert.equal(new Set(d.brief.diagrams.map((x) => x.id)).size, d.brief.diagrams.length);
});

test('no edit or undo while a new brief is being written; a chat section is not emptied by another edit', async () => {
  const d = brief();
  const r = await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'Before.' });
  d.brief.pending = true;
  assert.equal((await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'During.' })).ok, false);
  assert.equal(undoGuide(d, r.entry.id, FILES).ok, false);
  delete d.brief.pending;
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'Restocking', role: 'core', why: '', files: ['pantry/restock.go'] } }, { conv: 'c' })).ok);
  const shelf = d.brief.sections.find((s) => s.files.includes('pantry/shelf.go'));
  const take = await editGuide(d, FILES, { op: 'replace', kind: 'section', id: shelf.id, value: { ...shelf, files: ['pantry/shelf.go', 'pantry/restock.go'] } });
  assert.equal(take.ok, false); assert.match(take.message, /made in chat/);
  assert.ok(d.brief.sections.some((s) => s.title === 'Restocking'));
});

test('round thirteen: a copied id cannot empty a chat section; no Undo while a new brief is written; the drop key changes with the edits', async () => {
  const d = brief();
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'section', value: { title: 'Mine', role: 'core', why: '', files: ['pantry/restock.go'] } }, { conv: 'c' })).ok);
  const mine = d.brief.sections.find((s) => s.title === 'Mine');
  assert.equal((await editGuide(d, FILES, { op: 'add', kind: 'section', id: mine.id, value: { title: 'Copy', role: 'core', why: '', files: ['pantry/restock.go'] } }, { conv: 'c' })).ok, false);
  d.brief.pending = true;
  assert.ok(!guideEdits(d).some((e) => e.undo));
  delete d.brief.pending;
  const { drops } = await import('../src/guide.mjs');
  const t = await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'One.' });
  const k1 = drops(d.brief);
  undoGuide(d, t.entry.id, FILES);
  await editGuide(d, FILES, { op: 'remove', kind: 'diagram', id: d.brief.diagrams[0].id });
  const k2 = drops(d.brief);
  assert.equal(k1.n, k2.n); assert.notEqual(k1.key, k2.key, 'the same count, other edits: another key');
});

test('round fourteen: two edits in one millisecond have different keys; a chat\'s change to the brief\'s scene blocks a redraw', async () => {
  const { drops, chatTouchedScene } = await import('../src/guide.mjs');
  const d = brief(), realNow = Date.now;
  Date.now = () => 1234;
  try {
    await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'One.' }); const k1 = drops(d.brief).key;
    await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'Two.' }); const k2 = drops(d.brief).key;
    assert.notEqual(k1, k2);
  } finally { Date.now = realNow; }
  d.brief.scenes = [{ id: 'own', title: 'Own', by: 'brief', origin: 'brief', html: DRAWS, height: 260 }];
  assert.equal(chatTouchedScene(d.brief), false);
  await editGuide(d, FILES, { op: 'remove', kind: 'scene', id: 'own' });
  assert.equal(chatTouchedScene(d.brief), true);
});

test('round eighteen: a scene for a section that is not there is refused; removing a section moves its scenes to the map, and Undo puts them back', async () => {
  const d = brief();
  assert.equal((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: { ...scene(DRAWS), sectionId: 'gone' } })).ok, false);
  assert.equal((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: { ...scene(DRAWS), section: 9 } })).ok, false);
  const tests = d.brief.sections.find((s) => s.role === 'tests');
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: { ...scene(DRAWS), sectionId: tests.id } })).ok);
  const r = await editGuide(d, FILES, { op: 'remove', kind: 'section', id: tests.id });
  assert.ok(r.ok); assert.equal(d.brief.scenes[0].sectionId, null);
  assert.ok(undoGuide(d, r.entry.id, FILES).ok); assert.equal(d.brief.scenes[0].sectionId, tests.id);
});

test('round twenty-one: a section of null is refused; two chats replacing one scene cannot both land', async () => {
  const d = brief();
  assert.equal((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: { ...scene(DRAWS), section: null } })).ok, false);
  const a = await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) });
  assert.ok(a.ok);
  const id = d.brief.scenes[0].id;
  const [x, y] = await Promise.all([1, 2].map((k) => editGuide(d, FILES, { op: 'replace', kind: 'scene', id, value: scene(DRAWS, { title: `Take ${k}` }) })));
  assert.equal([x, y].filter((r) => r.ok).length, 1);
  assert.match([x, y].find((r) => !r.ok).message, /changed while this was being checked/);
});

test('round twenty-two: an edit to one scene leaves another being replaced alone; a section removed under a scene changes that scene', async () => {
  const d = brief();
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS, { title: 'A' }) })).ok);
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS, { title: 'B' }) })).ok);
  const [a, b] = d.brief.scenes;
  const [x, y] = await Promise.all([editGuide(d, FILES, { op: 'replace', kind: 'scene', id: a.id, value: scene(DRAWS, { title: 'A2' }) }), editGuide(d, FILES, { op: 'replace', kind: 'scene', id: b.id, value: scene(DRAWS, { title: 'B2' }) })]);
  assert.ok(x.ok && y.ok);
  assert.deepEqual(d.brief.scenes.map((s) => s.title), ['A2', 'B2']);
  const was = d.brief.scenes[0];
  const sec = d.brief.sections.find((s) => s.id === was.sectionId);
  assert.ok((await editGuide(d, FILES, { op: 'remove', kind: 'section', id: sec.id })).ok);
  assert.equal(d.brief.scenes[0].sectionId, null);
});

test('round twenty-three: undoing an edit to a drawing leaves a scene being replaced meanwhile free to land', async () => {
  const d = brief();
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS, { title: 'A' }) })).ok);
  const dg = d.brief.diagrams[0];
  const r = await editGuide(d, FILES, { op: 'replace', kind: 'diagram', id: dg.id, value: { ...dg, title: 'Renamed' } });
  assert.ok(r.ok);
  const pending = editGuide(d, FILES, { op: 'replace', kind: 'scene', id: d.brief.scenes[0].id, value: scene(DRAWS, { title: 'A2' }) });
  assert.ok(undoGuide(d, r.entry.id, FILES).ok);
  assert.ok((await pending).ok);
  assert.equal(d.brief.scenes[0].title, 'A2'); assert.equal(d.brief.diagrams[0].title, dg.title);
});

test('a chat reads a scene back as it was written, and writing it again changes nothing', async () => {
  const d = brief();
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) })).ok);
  const was = d.brief.scenes[0], read = JSON.parse(guidePart(d.brief, 'scene', was.id));
  assert.equal(read.html, was.html);
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'scene', id: was.id, value: read })).ok);
  assert.equal(d.brief.scenes[0].html, was.html);
});


test('a section names files as the change has them: an exact path first, then without a/ or b/, then a tail only one file ends in', async () => {
  const files = [file('a/config.ts'), file('config.ts'), file('src/x/util.ts'), file('src/y/util.ts'), file('lib/only.ts')];
  const d = { brief: { key: 'k', at: 1, ...normalizeGuide({ sections: [{ title: 'All', role: 'core', why: 'w', files: files.map((f) => f.path) }] }, files) }, checks: {}, guideHistory: [] };
  const r = await editGuide(d, files, { op: 'add', kind: 'section', at: 0, value: { title: 'Config', role: 'config', why: 'w', files: ['a/config.ts', 'util.ts', 'b/only.ts'] } }, { conv: 'c' });
  assert.ok(r.ok, r.message);
  assert.deepEqual(d.brief.sections[0].files, ['a/config.ts', 'lib/only.ts'], 'a/config.ts is that file, not config.ts; util.ts names two files, so neither');
  assert.ok(d.brief.sections[1].files.includes('config.ts'));
});

test('a look-over fixes a scene with edits: each finds a passage that is there once; one that is not, and none land', async () => {
  const { applyEdits } = await import('../src/scenes.mjs');
  assert.deepEqual(applyEdits('<b>a</b><i>b</i>', [{ find: '<b>a</b>', replace: '<b>A</b>' }, { find: 'b</i>', replace: 'B</i>' }]), { html: '<b>A</b><i>B</i>' });
  assert.match(applyEdits('<p>x</p><p>x</p>', [{ find: '<p>x</p>', replace: '' }]).problem, /more than once/);
  assert.match(applyEdits('<p>x</p>', [{ find: 'nope', replace: '' }]).problem, /not in the document/);
  assert.match(applyEdits('<p>x</p>', [{ find: '', replace: 'y' }]).problem, /without find/);
  assert.deepEqual(applyEdits('<p>x</p>', []), { html: '<p>x</p>' });
});

// Every part of the guide is a chat's to change, not only its lists: the risk, the map's text, how to review it and the
// questions are replaced as the TLDR is, undone, and counted by Regenerate.
test('a chat replaces the risk, the map\'s text, the plan and the questions; leaving a field out keeps it', async () => {
  const d = brief();
  const read = (k) => JSON.parse(guidePart(d.brief, k));
  assert.deepEqual(read('risk'), { level: 'typical', why: 'Shelves can overflow.' });
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'risk', value: { level: 'low' } }, { conv: 'c' })).ok);
  assert.equal(d.brief.risk, 'low'); assert.equal(d.brief.riskWhy, 'Shelves can overflow.', 'why was left out, so it stays');
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'risk', value: { level: 'scary' } })).message, /low, typical, high or very high/);
  const ctx = await editGuide(d, FILES, { op: 'replace', kind: 'context', value: { glossary: [{ term: 'Jar', meaning: 'One item on a shelf.' }] } });
  assert.ok(ctx.ok, ctx.message);
  assert.equal(d.brief.context.system, 'A pantry.'); assert.deepEqual(d.brief.context.glossary, [{ term: 'Jar', meaning: 'One item on a shelf.', where: '' }]);
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'plan', value: { start: 'restock.go', steps: ['Read the restock.', 'Then the shelf.'] } })).ok);
  assert.equal(d.brief.plan.start, 'pantry/restock.go', 'named as the change has it');
  assert.equal(d.brief.startHere, 'pantry/restock.go', 'the Overview\'s Start with follows the map\'s');
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'plan', value: { start: 'kitchen/oven.go' } })).message, /one of the change's files/);
  assert.equal(d.brief.plan.start, 'pantry/restock.go');
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'questions', value: ['Does Restock stop when Put fails?'] })).ok);
  assert.deepEqual(d.brief.questions, ['Does Restock stop when Put fails?']);
  assert.match((await editGuide(d, FILES, { op: 'add', kind: 'questions', value: ['Another?'] })).message, /exactly one questions: replace it/);
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'questions', value: 'Another?' })).message, /array of strings/);
  const sum = guideSummary(d.brief);
  for (const s of ['Risk [risk] (changed in chat): low', 'Jar: One item on a shelf.', 'Start with pantry/restock.go', '- Does Restock stop when Put fails?']) assert.ok(sum.includes(s), s);
  assert.deepEqual(guideEdits(d).map((e) => e.title), ['the questions worth asking', 'how to review it', 'how this part works', 'the risk']);
  assert.equal(chatEditsToBrief(d), 4, 'a new brief would write each of them again');
  assert.equal(chatEditsToBrief({ brief: carryChatParts(d.brief, brief().brief, FILES) }), 0);
  // undone newest first, back to the brief's own words
  for (const e of guideEdits(d)) assert.ok(undoGuide(d, e.id, FILES).ok);
  const fresh = brief().brief;
  for (const k of ['risk', 'riskWhy', 'context', 'plan', 'startHere', 'questions']) assert.deepEqual(d.brief[k], fresh[k], k);
  for (const k of ['riskBy', 'contextBy', 'planBy', 'questionsBy']) assert.equal(d.brief[k], undefined, k);
  d.brief.pending = true;
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'risk', value: { level: 'high' } })).message, /being written again/);
});

test('a replace keeps what it leaves out, so a move is an id and a place: the section keeps its words, id, ticks and scene, and never goes after Other changes', async () => {
  const d = brief(), [shelf, tests] = d.brief.sections;
  tick(d, shelf, 'Lids close.');
  shelf.check = ['Lids close.'];
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) }, { conv: 'c' })).ok);
  const r = await editGuide(d, FILES, { op: 'replace', kind: 'section', id: shelf.id, at: 99 }); // a move is an id and a place
  assert.ok(r.ok, r.message);
  assert.deepEqual(d.brief.sections.map((s) => s.title), ['Tests', 'The shelf holds jars', 'Other changes', 'Generated and lock files']);
  const moved = d.brief.sections[1];
  assert.equal(moved.id, shelf.id); assert.deepEqual(ticked(d, moved), ['Lids close.']); assert.equal(d.brief.scenes[0].sectionId, shelf.id);
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'section', id: shelf.id, at: 0, value: {} })).ok);
  assert.equal(d.brief.sections[0].why, 'Why.', 'what the value left out is kept');
  assert.equal(d.brief.sections[0].id, shelf.id); assert.equal(d.brief.sections[1].id, tests.id);
  const other = d.brief.sections.find((s) => s.synthetic);
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'section', id: other.id, at: 0, value: { ...other } })).message, /a title of its own/);
});

test('the brief\'s lists are cut to what its prompt asks for; a chat keeps the room it had', async () => {
  const many = (n, w) => Array.from({ length: n }, (_, k) => `${w} ${k + 1}.`);
  const g = normalizeGuide({
    risk: 'spicy', questions: many(6, 'Question'), plan: { start: 'nowhere.go', steps: many(8, 'Step') },
    context: { system: 's', glossary: many(8, 'Term').map((t) => ({ term: t, meaning: 'm' })) },
    sections: [{ title: 'Shelf', role: 'core', why: 'w', check: many(5, 'Check'), files: ['pantry/shelf.go'] }],
    startHere: 'pantry/shelf.go',
  }, FILES);
  assert.equal(g.risk, 'typical', 'a risk loupe cannot draw is the usual one');
  assert.deepEqual([g.questions.length, g.plan.steps.length, g.context.glossary.length, g.sections[0].check.length], [3, 5, 5, 3]);
  assert.equal(g.plan.start, 'pantry/shelf.go', 'the old startHere when the plan names no changed file');
  const d = { brief: { key: 'k', at: 1, ...g }, checks: {}, guideHistory: [] };
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'section', id: g.sections[0].id, value: { ...g.sections[0], check: many(5, 'Check') } })).ok);
  assert.equal(d.brief.sections[0].check.length, 5);
});

test('a replace keeps what it leaves out: a retitled diagram keeps its drawing; a scene keeps its section unless given one', async () => {
  const d = brief(), dg = d.brief.diagrams[0];
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'diagram', id: dg.id, value: { title: 'Pantry, renamed' } })).ok);
  assert.equal(d.brief.diagrams[0].title, 'Pantry, renamed'); assert.equal(d.brief.diagrams[0].nodes.length, 2);
  assert.ok((await editGuide(d, FILES, { op: 'add', kind: 'scene', value: scene(DRAWS) })).ok);
  const sc = d.brief.scenes[0];
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'scene', id: sc.id, value: { title: 'Slower' } })).ok);
  assert.equal(d.brief.scenes[0].sectionId, d.brief.sections[0].id); assert.equal(d.brief.scenes[0].html, DRAWS);
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'scene', id: sc.id, value: { section: 0 } })).ok);
  assert.equal(d.brief.scenes[0].sectionId, null, 'section 0 is the map');
});

// What the Fable reviews found (26 Nov 2026), each kept from coming back.
test('the last edit saved before a part was editable can still be undone: it is compared on the keys it kept', async () => {
  const d = brief(), was = d.brief.tldr;
  const r = await editGuide(d, FILES, { op: 'replace', kind: 'tldr', value: 'Rewritten.' });
  const old = ['tldr', 'tldrBy', 'sections', 'diagrams', 'scenes', 'removedInChat'], e = d.guideHistory[0]; // as the version before saved it
  e.before = Object.fromEntries(old.map((k) => [k, e.before[k]])); e.after = JSON.stringify(old.map((k) => d.brief[k] ?? null));
  assert.equal(guideEdits(d)[0].undo, true);
  assert.ok(undoGuide(d, r.entry.id, FILES).ok); assert.equal(d.brief.tldr, was); assert.equal(d.brief.risk, 'typical', 'a key it did not keep is left alone');
});

test('a plan edit keeps a start it leaves out, also on a brief that had only startHere; a wrong type is refused', async () => {
  const d = brief();
  delete d.brief.plan; d.brief.startHere = 'pantry/shelf.go';
  assert.equal(JSON.parse(guidePart(d.brief, 'plan')).start, 'pantry/shelf.go');
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'plan', value: { steps: ['Read the shelf first.'] } })).ok);
  assert.equal(d.brief.plan.start, 'pantry/shelf.go'); assert.equal(d.brief.startHere, 'pantry/shelf.go');
  // the change moved on and the start is not in it now: an edit that does not name a start leaves it as it was
  const fewer = FILES.filter((f) => f.path !== 'pantry/shelf.go');
  assert.ok((await editGuide(d, fewer, { op: 'replace', kind: 'plan', value: { why: 'The shelf is where jars live.' } })).ok);
  assert.equal(d.brief.plan.start, 'pantry/shelf.go'); assert.equal(d.brief.startHere, 'pantry/shelf.go');
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'plan', value: { steps: 'Read it.' } })).message, /whole list/);
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'context', value: { glossary: 'Jar' } })).message, /whole list/);
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'questions', value: [{ q: 'Why?' }] })).message, /array of strings/);
  assert.deepEqual(d.brief.plan.steps, ['Read the shelf first.']); assert.deepEqual(d.brief.context.glossary, []);
});

test('a scene read back whole and sent again with a new section number moves there; the number it was drawn for does not move it', async () => {
  const d = brief();
  d.brief.sections.splice(1, 0, ...normalizeGuide({ sections: [{ title: 'Restock', role: 'core', why: 'w', files: ['pantry/restock.go'] }] }, FILES).sections.slice(0, 1));
  d.brief.sections[0].files = ['pantry/shelf.go'];
  const [shelf, restock] = d.brief.sections;
  d.brief.scenes.push({ id: 'drawn1', title: 'Drawn by the brief', why: '', section: 1, sectionId: shelf.id, by: 'brief', origin: 'brief', html: DRAWS, height: 260, at: 5 });
  const read = () => JSON.parse(guidePart(d.brief, 'scene', 'drawn1'));
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'scene', id: 'drawn1', value: { ...read(), title: 'Renamed' } })).ok);
  assert.equal(d.brief.scenes[0].sectionId, shelf.id, 'echoed whole, with the number it was drawn for: it stays');
  assert.ok((await editGuide(d, FILES, { op: 'replace', kind: 'scene', id: 'drawn1', value: { ...read(), section: 2 } })).ok);
  assert.equal(d.brief.scenes[0].sectionId, restock.id, 'a number changed from what was read moves it');
});

test('"Other changes" becomes a section only when named: a bare replace is refused, a title makes it a section like the others', async () => {
  const d = brief(), other = d.brief.sections.find((s) => s.title === 'Other changes');
  assert.match((await editGuide(d, FILES, { op: 'replace', kind: 'section', id: other.id })).message, /a title of its own/);
  assert.equal(chatEditsToBrief(d), 0);
  const r = await editGuide(d, FILES, { op: 'replace', kind: 'section', id: other.id, value: { title: 'The pantry\'s docs', role: 'docs' } });
  assert.ok(r.ok, r.message);
  const named = d.brief.sections.find((s) => s.id === other.id);
  assert.equal(named.title, 'The pantry\'s docs'); assert.equal(named.synthetic, undefined); assert.deepEqual(named.files, ['docs/pantry.md']);
  assert.equal(d.brief.sections.filter((s) => s.title === 'Other changes').length, 0);
});
