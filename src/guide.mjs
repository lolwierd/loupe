// The guide: everything the brief writes, as the page shows it and as a chat may change it. That is its parts there
// are one of (the TLDR, the risk, how this part works, how to review it, the questions worth asking) and its lists
// (sections, diagrams, scenes). normalizeGuide turns a model's brief into one loupe can draw; editGuide is how a chat
// replaces a part, or adds, replaces, moves or removes one in a list; undoGuide takes an edit back. The guide is loupe's
// own state (review.json), not the repository, so every chat may change it, a read-only one on a pull request included.
//
// Rules every edit keeps: every changed file is in exactly one section (a file a chat's section claims leaves the
// model's; a file no section claims goes to "Other changes"); parts have stable ids, so ticks, anchors and undo survive
// sections moving; a part a chat made says so (by: 'chat', and which chat); and every edit is kept with what it
// replaced, so the page can undo it. Regenerating the brief keeps what chats made (carryChatParts).
import { rmSync } from 'node:fs';
import { uid } from './util.mjs';
import { normalizeScene } from './scenes.mjs';
import { checkId } from '../web/js/check-id.js';
export { checkId };

const str = (x, n = 4000) => String(x || '').slice(0, n);
const ROLES = new Set(['core', 'supporting', 'tests', 'config', 'docs', 'other']);
const resolver = (files) => {
  const known = new Set(files.map((f) => f.path));
  return (p) => {
    const raw = String(p || '').trim().replace(/^\.?\//, ''), tries = [...new Set([raw, raw.replace(/^[ab]\//, '')])];
    for (const s of tries) if (known.has(s)) return s; // the path as the change has it, then without a diff's a/ or b/
    for (const s of tries) { const hit = files.filter((f) => f.path.endsWith('/' + s)); if (hit.length === 1) return hit[0].path; } // a tail only one file ends in
    return null;
  };
};

// every file in exactly one section: the section just edited claims first, then chats' sections, then the model's in
// order; empty sections go;
// what nobody claims lands in "Other changes" (generated files in their own), keeping those sections' ids
function rehome(sections, files, first = null) {
  const known = new Set(files.map((f) => f.path)), owner = new Set();
  const real = sections.filter((s) => !s.synthetic);
  const claim = (s) => { s.files = s.files.filter((p) => known.has(p) && !owner.has(p) && owner.add(p)); };
  const lead = first && real.find((s) => s.id === first);
  if (lead) claim(lead); // the section just edited takes its files from wherever they were
  for (const chat of [true, false]) for (const s of real) if (s !== lead && (s.by === 'chat') === chat) claim(s);
  const out = real.filter((s) => s.files.length);
  const rest = files.filter((f) => !owner.has(f.path));
  const old = (title) => sections.find((s) => s.synthetic && s.title === title)?.id || uid();
  const gen = rest.filter((f) => f.kind === 'generated'), other = rest.filter((f) => f.kind !== 'generated');
  if (other.length) out.push({ id: old('Other changes'), title: 'Other changes', role: 'other', why: 'Files the guide did not place.', check: [], files: other.map((f) => f.path), synthetic: true });
  if (gen.length) out.push({ id: old('Generated and lock files'), title: 'Generated and lock files', role: 'other', why: 'Machine-written; skim for surprises.', check: [], files: gen.map((f) => f.path), synthetic: true });
  return out;
}

function section(s, files) {
  const resolve = resolver(files);
  return {
    id: typeof s.id === 'string' && s.id ? s.id : uid(),
    title: str(s.title || 'Untitled', 200), role: ROLES.has(s.role) ? s.role : 'other', why: str(s.why, 2000), context: str(s.context, 1000),
    check: [...new Set((Array.isArray(s.check) ? s.check : []).map((x) => str(x, 400).trim()).filter(Boolean))].slice(0, 5), // each once: a tick is keyed by its words
    files: (Array.isArray(s.files) ? s.files : []).map(resolve).filter(Boolean),
  };
}

// a diagram keeps only what it can draw: known kinds, nodes on the grid, edges between nodes that exist
function diagram(d) {
  const CH = new Set(['changed', 'new', 'removed']), KINDS = new Set(['code', 'data', 'external', 'actor', 'queue']);
  const grid = (n) => Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  const seenIds = new Set(), taken = new Set();
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).slice(0, 16).map((n) => ({ id: str(n.id, 40), label: str(n.label, 40), kind: KINDS.has(n.kind) ? n.kind : 'code', col: grid(n.col), row: grid(n.row), change: CH.has(n.change) ? n.change : 'none', section: Math.max(0, Math.round(Number(n.section) || 0)), ref: str(n.ref, 200) }))
    .filter((n) => n.id && n.label && !seenIds.has(n.id) && seenIds.add(n.id))
    .map((n) => { while (taken.has(`${n.col},${n.row}`)) n.row++; taken.add(`${n.col},${n.row}`); return n; }); // two nodes never share a cell
  const edges = (Array.isArray(d.edges) ? d.edges : []).slice(0, 24).map((e) => ({ from: str(e.from, 40), to: str(e.to, 40), label: str(e.label, 30), change: CH.has(e.change) ? e.change : 'none', step: Math.max(0, Math.round(Number(e.step) || 0)) }))
    .filter((e) => seenIds.has(e.from) && seenIds.has(e.to) && e.from !== e.to);
  const groups = (Array.isArray(d.groups) ? d.groups : []).slice(0, 4).map((g) => ({ label: str(g.label, 40), nodes: (Array.isArray(g.nodes) ? g.nodes : []).map(String).filter((id) => seenIds.has(id)) })).filter((g) => g.label && g.nodes.length);
  return { id: typeof d.id === 'string' && d.id ? d.id : uid(), kind: d.kind === 'flow' ? 'flow' : 'map', title: str(d.title, 120), caption: str(d.caption, 400), nodes, edges, groups };
}

// The parts there is one of, shaped the same whether the brief or a chat wrote them. A chat only replaces one (there is
// nothing to add or remove), and gives it as read_guide shows it; an object's fields it leaves out keep their value,
// and a list it gives (glossary, steps) is the whole list. A field of the wrong type is refused, not read as empty.
// Each is marked <kind>By on the brief once a chat changes it.
const RISKS = new Set(['low', 'typical', 'high', 'very high']);
const contextOf = (c = {}) => ({ system: str(c.system), before: str(c.before, 2000), after: str(c.after, 2000),
  glossary: (Array.isArray(c.glossary) ? c.glossary : []).slice(0, 8).map((g) => ({ term: str(g?.term, 80), meaning: str(g?.meaning, 400), where: str(g?.where, 200) })).filter((g) => g.term && g.meaning) });
const planOf = (pl, resolve) => ({ start: resolve(pl.start), why: str(pl.why, 400), steps: (Array.isArray(pl.steps) ? pl.steps : []).slice(0, 8).map((x) => str(x, 400)).filter(Boolean) });
const questionsOf = (q) => (Array.isArray(q) ? q : []).slice(0, 6).map((x) => str(x, 400)).filter(Boolean);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// what is wrong with a list field, if it was given and is not a list of what it holds
const listProblem = (v, key, item, ok) => (key in v && !(Array.isArray(v[key]) && v[key].every(ok)) ? `${key} is the whole list, of ${item}` : null);
const isText = (x) => typeof x === 'string';
// make(value, brief, files) -> the brief's fields to set, or what is wrong with the value
export const ONE = {
  tldr: { label: 'the TLDR', fields: ['tldr'], read: (b) => b.tldr || '',
    make: (v) => (typeof v === 'string' && v.trim() ? { tldr: str(v, 3000) } : 'the TLDR is markdown text') },
  risk: { label: 'the risk', fields: ['risk', 'riskWhy'], read: (b) => ({ level: b.risk, why: b.riskWhy || '' }),
    make: (v, b) => {
      if (!isObject(v)) return 'give the risk as { level, why }';
      const level = v.level ?? b.risk;
      return RISKS.has(level) ? { risk: level, riskWhy: str(v.why ?? b.riskWhy, 600) } : 'level is low, typical, high or very high';
    } },
  context: { label: 'how this part works', fields: ['context'], read: (b) => contextOf(b.context),
    make: (v, b) => (!isObject(v) ? 'give it as { system, before, after, glossary }'
      : listProblem(v, 'glossary', '{ term, meaning, where }', isObject) || { context: contextOf({ ...b.context, ...v }) }) },
  plan: { label: 'how to review it', fields: ['plan', 'startHere'], read: (b) => b.plan || { start: b.startHere || null, why: '', steps: [] },
    make: (v, b, files) => {
      if (!isObject(v)) return 'give it as { start, why, steps }';
      const bad = listProblem(v, 'steps', 'strings', isText);
      if (bad) return bad;
      const resolve = resolver(files), cur = ONE.plan.read(b); // over what read_guide showed: a brief from before plans had only startHere
      if (v.start && !resolve(v.start)) return `start is one of the change's files, and ${JSON.stringify(v.start)} is not`;
      const plan = planOf({ ...cur, ...v }, resolve);
      if (!('start' in v)) plan.start = cur.start || null; // left out, so kept as it was, though the change may have moved past it
      return { plan, startHere: plan.start }; // the Overview's "Start with" and the map's are the same file
    } },
  questions: { label: 'the questions worth asking', fields: ['questions'], read: (b) => b.questions || [],
    make: (v) => (Array.isArray(v) && v.every(isText) ? { questions: questionsOf(v) } : 'give the whole list of questions, as an array of strings') },
};

// A guide never hides a file: unknown paths are dropped, a file named twice stays in its first section, and every
// file no section named goes to a last section (generated ones to their own).
// The brief's lists are cut to what its prompt asks for, most important first: models write past the counts they are
// given (four checks of 50 words where three of 20 were asked). Only here: a chat's edit keeps the looser caps above,
// so a chat that renames a section never drops a check, or its tick, the brief had kept.
const BRIEF_MAX = { check: 3, questions: 3, glossary: 5, steps: 5 };
export function normalizeGuide(out, files) {
  const resolve = resolver(files);
  const numbered = (out.sections || []).map((s) => section(s, files)); // as the model numbered them, before any goes
  for (const s of numbered) s.check = s.check.slice(0, BRIEF_MAX.check);
  const sections = rehome(numbered, files);
  // Small models sometimes hand back the TLDR as a list, or as a list written into the string.
  let tl = out.tldr;
  if (typeof tl === 'string' && /^\s*\[/.test(tl)) { try { const a = JSON.parse(tl); if (Array.isArray(a)) tl = a; } catch { /* a string that starts with [ */ } }
  if (Array.isArray(tl)) tl = tl.map(String).join('\n\n');
  const context = contextOf(out.context || {});
  context.glossary = context.glossary.slice(0, BRIEF_MAX.glossary);
  const diagrams = (Array.isArray(out.diagrams) ? out.diagrams : []).slice(0, 3).map(diagram).filter((d) => d.nodes.length >= 2);
  const pl = out.plan || {};
  const plan = planOf({ ...pl, start: resolve(pl.start) ? pl.start : out.startHere }, resolve);
  plan.steps = plan.steps.slice(0, BRIEF_MAX.steps);
  const questions = questionsOf(out.questions).slice(0, BRIEF_MAX.questions);
  const citations = Object.fromEntries((Array.isArray(out.citations) ? out.citations : []).slice(0, 64)
    .map((x) => [str(x?.ref, 250).trim(), str(x?.excerpt, 160).trim()])
    .filter(([ref, excerpt]) => /:\d+$/.test(ref) && excerpt));
  // whether the change needs a scene, and what it should show: a scene is written after the brief, in its own run
  const m = out.motion || {};
  const n = Math.max(0, Math.round(Number(m.section) || 0));
  const target = n ? numbered[n - 1]?.id : null;
  const motion = { warranted: m.warranted === true && !!str(m.story).trim(), why: str(m.why, 400), title: str(m.title, 80), sectionId: target && sections.some((s) => s.id === target) ? target : null, story: str(m.story, 4000) };
  return { tldr: String(tl || ''), risk: RISKS.has(out.risk) ? out.risk : 'typical', riskWhy: str(out.riskWhy, 600), startHere: plan.start, context, diagrams, plan, questions, sections, citations, motion, scenes: [], pending: false, error: null, step: null };
}

// ------------------------------------------------------------------ ids on a brief written before parts had them
// A tick is keyed by the brief, the section's id and the check's own words (checkId), so it stays with its check
// however sections move, are replaced or are put back; a check whose words change starts unticked. A brief written
// before parts had ids keyed ticks by places: they move to the new keys here.
export function ensureIds(data) {
  const b = data.brief;
  if (!b) return;
  (b.sections || []).forEach((s, k) => {
    if (s.id) return;
    s.id = uid();
    for (const key of Object.keys(data.checks || {})) {
      const m = /^(\d+):(\d+):(\d+)$/.exec(key);
      if (m && Number(m[1]) === (b.at || 0) && Number(m[2]) === k && s.check?.[Number(m[3])] !== undefined) { data.checks[`${m[1]}:${s.id}:${checkId(s.check[Number(m[3])])}`] = data.checks[key]; delete data.checks[key]; }
    }
  });
  for (const d of b.diagrams || []) d.id ||= uid();
  b.scenes ||= [];
}

// ------------------------------------------------------------------ what a chat reads
const who = (p) => (originOf(p) === 'chat' ? 'made in chat' : p.by === 'chat' ? 'by the brief, changed in chat' : 'by the brief');
// the parts there is one of are short: shown whole, so a chat sees everything it may change in one read
export function guideSummary(b) {
  if (!b?.sections) return 'There is no guide yet: the brief has not been written. The reviewer can write it from the Overview.';
  const head = (kind, name) => `${name} [${kind}]${b[`${kind}By`] ? ' (changed in chat)' : ''}:`;
  const c = ONE.context.read(b), p = ONE.plan.read(b), qs = ONE.questions.read(b);
  const ctx = [c.system, c.before && `Before: ${c.before}`, c.after && `After: ${c.after}`, c.glossary.length && `Words you will meet: ${c.glossary.map((g) => `${g.term}: ${g.meaning}${g.where ? ` (${g.where})` : ''}`).join('; ')}`].filter(Boolean).join('\n') || '(empty)';
  const plan = [p.start && `Start with ${p.start}.${p.why ? ` ${p.why}` : ''}`, ...p.steps.map((x, k) => `${k + 1}. ${x}`)].filter(Boolean).join('\n') || '(empty)';
  const secs = b.sections.map((s, k) => `${k + 1}. [${s.id || k}] ${s.role} · ${s.title} · ${s.files.join(', ')}${s.by === 'chat' ? ` · ${who(s)}` : ''}`).join('\n');
  const dgs = (b.diagrams || []).map((d) => `[${d.id}] ${d.kind} · ${d.title || '(untitled)'} · ${d.nodes.length} parts, ${d.edges.length} arrows · ${who(d)}`).join('\n') || '(none)';
  const scs = (b.scenes || []).map((s) => `[${s.id}] ${s.title} · ${s.sectionId ? `on section ${b.sections.findIndex((x) => x.id === s.sectionId) + 1}` : 'on the map'} · ${(s.html || '').length.toLocaleString('en-US')} characters of html · ${who(s)}`).join('\n') || '(none)';
  const mo = b.motion?.warranted ? `\nThe brief asked for a scene: ${b.motion.title || ''}. ${b.motion.why}` : '';
  return `The guide, as the reviewer sees it. In a chat, edit_guide can change every part of it; [kind] or [id] says how to name a part.

${head('tldr', 'TLDR')}\n${b.tldr}\n\n${head('risk', 'Risk')} ${b.risk}. ${b.riskWhy || ''}\n\n${head('context', 'How this part works (the map\'s text)')}\n${ctx}\n\n${head('plan', 'How to review it')}\n${plan}\n\n${head('questions', 'Worth asking')}\n${qs.map((x) => `- ${x}`).join('\n') || '(none)'}

Sections (in reading order; [id]):\n${secs}\n\nDiagrams:\n${dgs}\n\nScenes (animations):\n${scs}${mo}\n\nread_guide with a part gives it in full, as JSON, as a chat's edit_guide takes it: "section", "diagram" or "scene" with its id (a scene's includes its code), or "tldr", "risk", "context", "plan" or "questions".`;
}
export function guidePart(b, kind, id) {
  if (ONE[kind]) return b?.sections ? JSON.stringify(ONE[kind].read(b), null, 1) : null;
  const list = { section: b?.sections, diagram: b?.diagrams, scene: b?.scenes }[kind];
  const part = list?.find((p) => p.id === id);
  return part ? JSON.stringify(part, null, 1) : null;
}

// ------------------------------------------------------------------ what a chat changes
const LISTS = { section: 'sections', diagram: 'diagrams', scene: 'scenes' };
const clone = (x) => JSON.parse(JSON.stringify(x));
// { op: add | replace | remove, kind: section | diagram | scene, or one of ONE (replace only), id, at, value }
// A replace keeps the fields its value leaves out, for every kind.
// at: the 0-based place to add a part at, or to move the part a replace changes to (a section moved keeps its id, its
// ticks and its scene, which removing it and adding it again would lose).
// Returns { ok, message, entry }; nothing changes unless ok. The part is built (a scene is played) before anything is
// touched, then committed against the guide as it is by then, or refused if the brief was written again meanwhile, or
// if live() says the turn that asked is over.
// A part says where it came from (origin: the brief, or a chat) apart from who last changed it (by): a new brief keeps
// what chats made, and writes afresh what it made itself, chat's changes to it included (the page asks first).
//
// Undo is a snapshot: each edit keeps the whole editable guide as it was before it, and undoing puts that back, for
// the newest edit, while the guide is still exactly as that edit left it (anything since, another edit, the brief's
// scene landing, a new brief, comes first or stops it). Ticks are the reader's, kept outside the guide, never undone.
const originOf = (p) => p?.origin || (p?.by === 'chat' ? 'chat' : 'brief');
const GUIDE = [...Object.entries(ONE).flatMap(([k, o]) => [...o.fields, `${k}By`]), 'sections', 'diagrams', 'scenes', 'removedInChat'];
const snapshot = (b) => clone(Object.fromEntries(GUIDE.map((k) => [k, b[k] ?? null])));
// the guide as one string, over the keys given: an edit is compared on the keys its own snapshot holds, so the last edit
// saved before a part became editable (its snapshot has fewer) can still be undone
const stateOf = (b, keys = GUIDE) => JSON.stringify(keys.map((k) => b[k] ?? null));
const KINDS = ['section', 'diagram', 'scene', ...Object.keys(ONE)];
export async function editGuide(data, files, { op, kind, id, at, value }, { conv = null, live = () => true, signal = null, render = null } = {}) {
  const b0 = data.brief;
  if (!b0?.sections) return { ok: false, message: 'There is no guide yet: the brief has to be written first (the Overview\'s Write the guide).' };
  if (b0.pending) return { ok: false, message: 'The guide is being written again just now; edit it once the new one is in.' };
  if (!['add', 'replace', 'remove'].includes(op)) return { ok: false, message: 'op is add, replace or remove' };
  if (!KINDS.includes(kind)) return { ok: false, message: `kind is ${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1)}` };
  ensureIds(data);
  const gen = b0.at, key = LISTS[kind], one = ONE[kind], mark = { by: 'chat', conv, at: Date.now() };
  if (one && op !== 'replace') return { ok: false, message: `the guide has exactly one ${kind}: replace it (to empty a list, replace it with an empty one)` };
  const fields = one ? one.make(value, b0, files) : null; // nothing is awaited before it is set, so it is made against the guide it lands on
  if (typeof fields === 'string') return { ok: false, message: fields };
  const target = op !== 'add' && id && key ? (b0[key] || []).find((p) => p.id === id) : null; // an add always gets an id of its own
  if (!one && op !== 'add' && !target) return { ok: false, message: `there is no ${kind} with id ${JSON.stringify(id)}; read_guide lists them` };
  const stamp = target ? target.edit ?? target.at ?? null : null; // which version of it this edit was asked against
  if (op === 'remove' && target?.synthetic) return { ok: false, message: `"${target.title}" holds the files no section claims; it goes by itself once another section takes them` };
  // "Other changes" (or the generated files) becomes a section like the others only by being named: a bare replace would
  // turn it into a chat's section with the same title, and the next unplaced file would bring a second one
  if (op === 'replace' && target?.synthetic && (!isObject(value) || !String(value.title || '').trim() || value.title === target.title)) return { ok: false, message: `"${target.title}" holds the files no section claims; give it a title of its own to make it a section, or put its files in another` };
  // 1. the part, built and checked; nothing of the guide is touched yet
  let part = null, notice = null; // notice: what the scene's check saw that is worth fixing (labels over each other)
  if (!one && op !== 'remove') {
    if (op === 'replace' && value === undefined) value = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: `give the ${kind} as an object in value` };
    // A replace keeps what it leaves out, as a part there is one of does: a move is an id and a place, a new title only
    // the title. (A chat that sent only { at } used to blank the section it meant to move.) A scene is placed by its
    // sectionId; a section number the chat changed from what it read moves it there, unless it changed the id as well
    // (a scene read back whole carries both, and the brief's keep the number they were drawn for).
    if (op === 'replace') {
      const renumbered = kind === 'scene' && 'section' in value && value.section !== target.section && !('sectionId' in value && value.sectionId !== target.sectionId);
      value = { ...target, ...value, ...(renumbered ? { sectionId: null } : {}) };
    }
    if (kind === 'section') {
      part = section({ ...value, id: target?.id ?? null }, files);
      if (!part.files.length) return { ok: false, message: 'a section needs at least one of the change\'s files (paths as the guide lists them)' };
    } else if (kind === 'diagram') {
      part = diagram({ ...value, id: target?.id ?? null });
      if (part.nodes.length < 2) return { ok: false, message: 'a diagram needs at least two nodes, each with an id and a label' };
    } else {
      if (!live()) return { ok: false, message: 'This turn is over; the edit was not made.' };
      // the section it belongs to, by id, as the guide is now (sections can move while its code is checked)
      const n = value.section === undefined ? 0 : value.section, secs = b0.sections || []; // a whole number as given: no coercion of null, true, "2" or [1]
      if (typeof value.sectionId === 'string' && value.sectionId && !secs.some((x) => x.id === value.sectionId)) return { ok: false, message: `There is no section ${value.sectionId} now; read_guide lists them (or give section 0 for the map).` };
      if (!Number.isInteger(n) || n < 0 || n > secs.length) return { ok: false, message: `section is a number from 0 (the map) to ${secs.length}` };
      const sectionId = typeof value.sectionId === 'string' && value.sectionId ? value.sectionId : n ? secs[n - 1].id : null;
      const { scene, problem } = await normalizeScene({ ...value, id: target?.id ?? null }, { by: 'chat', conv });
      if (!scene) return { ok: false, message: `The scene was not kept: ${problem}. Fix it and try again.` };
      // loupe renders it as the card would: one that shows nothing is not kept, and what else it finds goes back.
      // One that rendered with nothing found is marked clean, and a replace that leaves its document and height as
      // they were (a move, a new title) opens no Chrome for it again: that is some ten seconds of the chat's turn.
      // One kept unchecked, or with faults, is rendered again, so the check runs and the chat hears what it found.
      const same = op === 'replace' && target.clean === true && scene.html === target.html && scene.height === target.height;
      const seen = render && !same ? await render(scene.html, scene.height, signal) : null;
      if (seen?.dir) rmSync(seen.dir, { recursive: true, force: true });
      if (seen?.failed) return { ok: false, message: `The scene was not kept: loupe could not render it (${seen.failed}). Fix it and try again.` };
      if (seen && !seen.unavailable && seen.problem) return { ok: false, message: `The scene was not kept: ${seen.problem}${seen.errors?.length ? ` (${seen.errors.join('; ')})` : ''}. Fix it and try again.` };
      notice = seen && !seen.unavailable ? [...(seen.errors || []).map((e) => `error: ${e}`), ...(seen.cut || [])].join('; ') || null : null;
      if (same || (seen && !seen.unavailable && !notice)) scene.clean = true;
      scene.sectionId = sectionId;
      delete scene.section;
      part = scene;
    }
    Object.assign(part, mark, { origin: op === 'add' ? 'chat' : originOf(target) });
  }
  // 2. committed against the guide as it is now
  if (data.brief?.at !== gen || data.brief?.pending) return { ok: false, message: 'The guide was written again while this was being checked; read it and try again.' };
  if (!live()) return { ok: false, message: 'This turn is over; the edit was not made.' };
  if (part?.sectionId && !data.brief.sections.some((x) => x.id === part.sectionId)) return { ok: false, message: 'The section that scene was for went while it was being checked; read the guide and try again.' };
  const b = data.brief, before = snapshot(b), edit = uid(); // this edit's own id, stamped on what it leaves
  if (one) {
    Object.assign(b, fields); b[`${kind}By`] = { conv, at: Date.now(), edit };
    return record(data, { kind, op, partId: kind, title: one.label, before, conv, id: edit });
  }
  if (part) part.edit = edit;
  const list = clone(b[key] || []), where = id ? list.findIndex((p) => p.id === id) : -1;
  if (op !== 'add' && where < 0) return { ok: false, message: `The ${kind} ${id} went while this was being checked.` };
  if (op !== 'add' && (list[where].edit ?? list[where].at ?? null) !== stamp) return { ok: false, message: `The ${kind} ${id} was changed while this was being checked; read it and try again.` }; // another chat's edit to it landed first
  const gone = op !== 'add' ? list[where] : null;
  // a place among the parts a chat can order: a section goes before "Other changes" and the generated files, never after
  const place = (n) => Math.max(0, Math.min(kind === 'section' ? list.filter((x) => !x.synthetic).length : list.length, n));
  if (op === 'add') list.splice(Number.isInteger(at) ? place(at) : place(Infinity), 0, part);
  else if (op === 'replace' && Number.isInteger(at)) { list.splice(where, 1); list.splice(place(at), 0, part); }
  else if (op === 'replace') list[where] = part;
  else list.splice(where, 1);
  const after = kind === 'section' ? rehome(list, files, op === 'remove' ? null : part.id) : list;
  if (kind === 'section' && !after.length) return { ok: false, message: 'that would leave the guide with no sections' };
  // a section a chat made is removed only by asking: taking all its files would empty it, so that is refused
  const emptied = kind === 'section' ? before.sections.filter((x) => originOf(x) === 'chat' && !(op === 'remove' && x.id === id) && !after.some((y) => y.id === x.id)) : [];
  if (emptied.length) return { ok: false, message: `That would take every file of "${emptied[0].title}", a section made in chat; remove it first if that is meant.` };
  b[key] = after;
  // a scene on a section that went moves to the map, in this same edit (so Undo puts it back where it was)
  if (kind === 'section') for (const sc of b.scenes || []) if (sc.sectionId && !after.some((x) => x.id === sc.sectionId)) sc.sectionId = null;
  // a part of the brief's a chat removed: kept in mind, so Regenerate can say it comes back
  if (op === 'remove' && originOf(gone) !== 'chat') b.removedInChat = [...(b.removedInChat || []), { kind, id, title: gone.title || kind, edit }];
  const done = record(data, { kind, op, partId: part?.id || id, title: part?.title || gone?.title || kind, before, conv, id: edit });
  if (done.ok && notice) done.message += ` loupe rendered it and found: ${notice}. Replace it with that fixed.`;
  return done;
}

function record(data, { kind, op, partId, title, before, conv, id = null }) {
  const entry = { id: id || uid(), at: Date.now(), brief: data.brief?.at || 0, conv, kind, op, partId, title: str(title, 120), before, after: stateOf(data.brief) };
  data.guideHistory = [...(data.guideHistory || []), entry].slice(-20); // each keeps the guide before it (scenes' code too): the last 20
  const verb = { add: 'Added', replace: 'Replaced', remove: 'Removed' }[op];
  return { ok: true, entry, message: `${verb} ${ONE[kind] ? ONE[kind].label : `${kind} "${entry.title}" [${partId}]`}. The reviewer sees it now and can undo it from the page.` };
}

// the edit Undo would take back now: the newest not undone, on this brief, if the guide is still as it left it
function undoable(data) {
  const b = data.brief, e = (data.guideHistory || []).filter((x) => !x.undone).at(-1);
  return b && !b.pending && e && e.brief === (b.at || 0) && e.after === stateOf(b, Object.keys(e.before || {})) ? e : null; // none while a new brief is written
}
export function undoGuide(data, entryId, files = null) {
  if (data.brief?.pending) return { ok: false, message: 'The guide is being written again just now; the new one replaces this edit\u2019s guide.' };
  const e = undoable(data);
  if (!e || e.id !== entryId) {
    const asked = (data.guideHistory || []).find((x) => x.id === entryId && !x.undone);
    return { ok: false, message: !asked ? 'That edit is not there to undo.' : 'The guide changed after that edit (a later edit, the brief’s scene, or a new brief); it can no longer be undone.' };
  }
  const b = data.brief;
  // a key the snapshot lacks (kept before loupe could edit that part) is left as it is, never cleared
  for (const k of GUIDE) { if (!(k in e.before)) continue; if (e.before[k] === null) delete b[k]; else b[k] = clone(e.before[k]); }
  if (files) b.sections = rehome(b.sections, files); // the change may have moved on since
  for (const sc of b.scenes || []) if (sc.sectionId && !b.sections.some((x) => x.id === sc.sectionId)) sc.sectionId = null; // its section went with the change
  e.undone = Date.now();
  return { ok: true, message: ONE[e.kind] ? `Undid the change to ${e.title}.` : `Undid: ${e.op} ${e.kind} "${e.title}".` };
}

// A new brief keeps what chats made: their sections (in the same place, with their files), diagrams and scenes.
// What a chat removed or replaced of the old brief's is written fresh by the new one (the page says so first).
export function carryChatParts(prev, next, files) {
  if (!prev) return next;
  const chatSections = (prev.sections || []).map((s, k) => [s, k]).filter(([s]) => originOf(s) === 'chat');
  for (const [s, k] of chatSections) next.sections.splice(Math.min(k, next.sections.filter((x) => !x.synthetic).length), 0, clone(s));
  if (chatSections.length) next.sections = rehome(next.sections, files);
  next.diagrams = [...next.diagrams, ...(prev.diagrams || []).filter((d) => originOf(d) === 'chat').map(clone)];
  const ids = new Set(next.sections.map((s) => s.id));
  next.scenes = [...(next.scenes || []), ...(prev.scenes || []).filter((s) => originOf(s) === 'chat').map((s) => ({ ...clone(s), sectionId: ids.has(s.sectionId) ? s.sectionId : null }))];
  return next;
}
// what a regeneration would undo: edits a chat made to parts the brief wrote
export function chatEditsToBrief(data) { return dropsOnRegenerate(data.brief); }
// read from the guide itself, not from the history (which keeps only the last edits): the brief's own parts a chat
// changed (the ones there is one of included: the TLDR, the risk, ...), and its parts a chat removed
export function dropsOnRegenerate(b) { return drops(b).n; }
// a chat changed or removed the scene the brief drew: drawing it again would undo that, so it is not done without asking
export const chatTouchedScene = (b) => (b?.scenes || []).some((s) => s.by === 'chat' && originOf(s) !== 'chat') || (b?.removedInChat || []).some((r) => r.kind === 'scene');
// which edits, and how many: the page shows the count and sends the key back, so a confirm is for exactly what it showed
export function drops(b) {
  if (!b) return { n: 0, key: '' };
  const changed = [...(b.sections || []), ...(b.diagrams || []), ...(b.scenes || [])].filter((p) => p.by === 'chat' && originOf(p) !== 'chat').map((p) => p.edit || `${p.id}@${p.at}`);
  const ones = Object.keys(ONE).map((k) => b[`${k}By`] && (b[`${k}By`].edit || `${k}@${b[`${k}By`].at}`)).filter(Boolean);
  const all = [...changed, ...ones, ...(b.removedInChat || []).map((r) => r.edit || `-${r.kind}:${r.id}`)];
  return { n: all.length, key: checkId(all.join('|')) };
}

// the edits the page can show and undo: newest first, without the parts themselves
export function guideEdits(data) {
  const next = undoable(data)?.id;
  return (data.guideHistory || []).slice().reverse().map(({ id, at, brief, conv, kind, op, partId, title, undone }) => ({ id, at, brief, conv, kind, op, partId, title, undone: !!undone, undo: id === next }));
}
