// The guide: the brief's sections, diagrams and scenes, as the page shows them and as a chat may change them.
// normalizeGuide turns a model's brief into one loupe can draw; editGuide is how a chat adds, replaces or removes a
// part; undoGuide takes an edit back. The guide is loupe's own state (review.json), not the repository, so every chat
// may change it, a read-only one on a pull request included.
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

// A guide never hides a file: unknown paths are dropped, a file named twice stays in its first section, and every
// file no section named goes to a last section (generated ones to their own).
export function normalizeGuide(out, files) {
  const resolve = resolver(files);
  const numbered = (out.sections || []).map((s) => section(s, files)); // as the model numbered them, before any goes
  const sections = rehome(numbered, files);
  // Small models sometimes hand back the TLDR as a list, or as a list written into the string.
  let tl = out.tldr;
  if (typeof tl === 'string' && /^\s*\[/.test(tl)) { try { const a = JSON.parse(tl); if (Array.isArray(a)) tl = a; } catch { /* a string that starts with [ */ } }
  if (Array.isArray(tl)) tl = tl.map(String).join('\n\n');
  const c = out.context || {};
  const context = { system: str(c.system), before: str(c.before, 2000), after: str(c.after, 2000),
    glossary: (Array.isArray(c.glossary) ? c.glossary : []).slice(0, 8).map((g) => ({ term: str(g.term, 80), meaning: str(g.meaning, 400), where: str(g.where, 200) })).filter((g) => g.term && g.meaning) };
  const diagrams = (Array.isArray(out.diagrams) ? out.diagrams : []).slice(0, 3).map(diagram).filter((d) => d.nodes.length >= 2);
  const pl = out.plan || {};
  const plan = { start: resolve(pl.start) || resolve(out.startHere), why: str(pl.why, 400), steps: (Array.isArray(pl.steps) ? pl.steps : []).slice(0, 8).map((x) => str(x, 400)).filter(Boolean) };
  const questions = (Array.isArray(out.questions) ? out.questions : []).slice(0, 6).map((x) => str(x, 400)).filter(Boolean);
  const citations = Object.fromEntries((Array.isArray(out.citations) ? out.citations : []).slice(0, 64)
    .map((x) => [str(x?.ref, 250).trim(), str(x?.excerpt, 160).trim()])
    .filter(([ref, excerpt]) => /:\d+$/.test(ref) && excerpt));
  // whether the change needs a scene, and what it should show: a scene is written after the brief, in its own run
  const m = out.motion || {};
  const n = Math.max(0, Math.round(Number(m.section) || 0));
  const target = n ? numbered[n - 1]?.id : null;
  const motion = { warranted: m.warranted === true && !!str(m.story).trim(), why: str(m.why, 400), title: str(m.title, 80), sectionId: target && sections.some((s) => s.id === target) ? target : null, story: str(m.story, 4000) };
  return { tldr: String(tl || ''), risk: out.risk, riskWhy: out.riskWhy || '', startHere: plan.start, context, diagrams, plan, questions, sections, citations, motion, scenes: [], pending: false, error: null, step: null };
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
export function guideSummary(b) {
  if (!b?.sections) return 'There is no guide yet: the brief has not been written. The reviewer can write it from the Overview.';
  const secs = b.sections.map((s, k) => `${k + 1}. [${s.id || k}] ${s.role} · ${s.title} · ${s.files.join(', ')}${s.by === 'chat' ? ` · ${who(s)}` : ''}`).join('\n');
  const dgs = (b.diagrams || []).map((d) => `[${d.id}] ${d.kind} · ${d.title || '(untitled)'} · ${d.nodes.length} parts, ${d.edges.length} arrows · ${who(d)}`).join('\n') || '(none)';
  const scs = (b.scenes || []).map((s) => `[${s.id}] ${s.title} · ${s.sectionId ? `on section ${b.sections.findIndex((x) => x.id === s.sectionId) + 1}` : 'on the map'} · ${(s.html || '').length.toLocaleString('en-US')} characters of html · ${who(s)}`).join('\n') || '(none)';
  const mo = b.motion?.warranted ? `\nThe brief asked for a scene: ${b.motion.title || ''}. ${b.motion.why}` : '';
  return `TLDR:\n${b.tldr}\n\nSections (in reading order; [id]):\n${secs}\n\nDiagrams:\n${dgs}\n\nScenes (animations):\n${scs}${mo}\n\nread_guide with a part ("section", "diagram" or "scene" and its id) gives one part in full, as JSON; a scene's includes its code.`;
}
export function guidePart(b, kind, id) {
  const list = { section: b?.sections, diagram: b?.diagrams, scene: b?.scenes }[kind];
  const part = list?.find((p) => p.id === id);
  return part ? JSON.stringify(part, null, 1) : null;
}

// ------------------------------------------------------------------ what a chat changes
const LISTS = { section: 'sections', diagram: 'diagrams', scene: 'scenes' };
const clone = (x) => JSON.parse(JSON.stringify(x));
// { op: add | replace | remove, kind: section | diagram | scene | tldr, id, at (0-based place for an add), value }
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
const GUIDE = ['tldr', 'tldrBy', 'sections', 'diagrams', 'scenes', 'removedInChat'];
const snapshot = (b) => clone(Object.fromEntries(GUIDE.map((k) => [k, b[k] ?? null])));
const stateOf = (b) => JSON.stringify(GUIDE.map((k) => b[k] ?? null));
export async function editGuide(data, files, { op, kind, id, at, value }, { conv = null, live = () => true, signal = null, render = null } = {}) {
  const b0 = data.brief;
  if (!b0?.sections) return { ok: false, message: 'There is no guide yet: the brief has to be written first (the Overview\'s Write the guide).' };
  if (b0.pending) return { ok: false, message: 'The guide is being written again just now; edit it once the new one is in.' };
  if (!['add', 'replace', 'remove'].includes(op)) return { ok: false, message: 'op is add, replace or remove' };
  if (!['section', 'diagram', 'scene', 'tldr'].includes(kind)) return { ok: false, message: 'kind is section, diagram, scene or tldr' };
  ensureIds(data);
  const gen = b0.at, key = LISTS[kind], mark = { by: 'chat', conv, at: Date.now() };
  if (kind === 'tldr' && (op !== 'replace' || typeof value !== 'string' || !value.trim())) return { ok: false, message: 'the TLDR can only be replaced, with markdown text' };
  const target = op !== 'add' && id && key ? (b0[key] || []).find((p) => p.id === id) : null; // an add always gets an id of its own
  if (kind !== 'tldr' && op !== 'add' && !target) return { ok: false, message: `there is no ${kind} with id ${JSON.stringify(id)}; read_guide lists them` };
  const stamp = target ? target.edit ?? target.at ?? null : null; // which version of it this edit was asked against
  if (op === 'remove' && target?.synthetic) return { ok: false, message: `"${target.title}" holds the files no section claims; it goes by itself once another section takes them` };
  // 1. the part, built and checked; nothing of the guide is touched yet
  let part = null, notice = null; // notice: what the scene's check saw that is worth fixing (labels over each other)
  if (kind !== 'tldr' && op !== 'remove') {
    if (!value || typeof value !== 'object') return { ok: false, message: `give the ${kind} as an object in value` };
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
      // loupe renders it as the card would: one that shows nothing is not kept, and what else it finds goes back
      const seen = render ? await render(scene.html, scene.height, signal) : null;
      if (seen?.dir) rmSync(seen.dir, { recursive: true, force: true });
      if (seen?.failed) return { ok: false, message: `The scene was not kept: loupe could not render it (${seen.failed}). Fix it and try again.` };
      if (seen && !seen.unavailable && seen.problem) return { ok: false, message: `The scene was not kept: ${seen.problem}${seen.errors?.length ? ` (${seen.errors.join('; ')})` : ''}. Fix it and try again.` };
      notice = seen && !seen.unavailable ? [...(seen.errors || []).map((e) => `error: ${e}`), ...(seen.cut || [])].join('; ') || null : null;
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
  if (kind === 'tldr') {
    b.tldr = str(value, 3000); b.tldrBy = { conv, at: Date.now(), edit };
    return record(data, { kind, op, partId: 'tldr', title: 'the TLDR', before, conv, id: edit });
  }
  if (part) part.edit = edit;
  const list = clone(b[key] || []), where = id ? list.findIndex((p) => p.id === id) : -1;
  if (op !== 'add' && where < 0) return { ok: false, message: `The ${kind} ${id} went while this was being checked.` };
  if (op !== 'add' && (list[where].edit ?? list[where].at ?? null) !== stamp) return { ok: false, message: `The ${kind} ${id} was changed while this was being checked; read it and try again.` }; // another chat's edit to it landed first
  const gone = op !== 'add' ? list[where] : null;
  if (op === 'add') { const k = Number.isInteger(at) ? Math.max(0, Math.min(list.length, at)) : kind === 'section' ? list.filter((x) => !x.synthetic).length : list.length; list.splice(k, 0, part); }
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
  return { ok: true, entry, message: `${verb} ${kind === 'tldr' ? 'the TLDR' : `${kind} "${entry.title}" [${partId}]`}. The reviewer sees it now and can undo it from the page.` };
}

// the edit Undo would take back now: the newest not undone, on this brief, if the guide is still as it left it
function undoable(data) {
  const b = data.brief, e = (data.guideHistory || []).filter((x) => !x.undone).at(-1);
  return b && !b.pending && e && e.brief === (b.at || 0) && e.after === stateOf(b) ? e : null; // none while a new brief is written
}
export function undoGuide(data, entryId, files = null) {
  if (data.brief?.pending) return { ok: false, message: 'The guide is being written again just now; the new one replaces this edit\u2019s guide.' };
  const e = undoable(data);
  if (!e || e.id !== entryId) {
    const asked = (data.guideHistory || []).find((x) => x.id === entryId && !x.undone);
    return { ok: false, message: !asked ? 'That edit is not there to undo.' : 'The guide changed after that edit (a later edit, the brief’s scene, or a new brief); it can no longer be undone.' };
  }
  const b = data.brief;
  for (const k of GUIDE) { if (e.before[k] === null) delete b[k]; else b[k] = clone(e.before[k]); }
  if (files) b.sections = rehome(b.sections, files); // the change may have moved on since
  for (const sc of b.scenes || []) if (sc.sectionId && !b.sections.some((x) => x.id === sc.sectionId)) sc.sectionId = null; // its section went with the change
  e.undone = Date.now();
  return { ok: true, message: `Undid: ${e.op} ${e.kind} "${e.title}".` };
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
// changed, its TLDR if a chat rewrote it, and its parts a chat removed
export function dropsOnRegenerate(b) { return drops(b).n; }
// a chat changed or removed the scene the brief drew: drawing it again would undo that, so it is not done without asking
export const chatTouchedScene = (b) => (b?.scenes || []).some((s) => s.by === 'chat' && originOf(s) !== 'chat') || (b?.removedInChat || []).some((r) => r.kind === 'scene');
// which edits, and how many: the page shows the count and sends the key back, so a confirm is for exactly what it showed
export function drops(b) {
  if (!b) return { n: 0, key: '' };
  const changed = [...(b.sections || []), ...(b.diagrams || []), ...(b.scenes || [])].filter((p) => p.by === 'chat' && originOf(p) !== 'chat').map((p) => p.edit || `${p.id}@${p.at}`);
  const all = [...changed, ...(b.tldrBy ? [b.tldrBy.edit || `tldr@${b.tldrBy.at}`] : []), ...(b.removedInChat || []).map((r) => r.edit || `-${r.kind}:${r.id}`)];
  return { n: all.length, key: checkId(all.join('|')) };
}

// the edits the page can show and undo: newest first, without the parts themselves
export function guideEdits(data) {
  const next = undoable(data)?.id;
  return (data.guideHistory || []).slice().reverse().map(({ id, at, brief, conv, kind, op, partId, title, undone }) => ({ id, at, brief, conv, kind, op, partId, title, undone: !!undone, undo: id === next }));
}
