// Scenes: short animated explainers of a change's core. Each is a document the model writes for its change (its own
// HTML, CSS and JavaScript), served by loupe in a sandboxed frame with no network (/scene-doc, web/js/scene-doc.js).
// The brief decides whether a change needs one and says what it should show; a separate run writes it, and before it
// is kept loupe renders it and its writer looks at the frames (src/scene-render.mjs).
import { uid } from './util.mjs';

export const SCENE_LIMITS = { html: 200000, minH: 200, maxH: 700 };
const str = (x, n) => (typeof x === 'string' ? x.trim().slice(0, n) : '');

// The scene as kept, or null with why. Words are cut to what fits; a document too large, or none, is not kept.
export async function normalizeScene(raw, { by = 'brief', conv = null, model = null } = {}) {
  if (!raw || typeof raw !== 'object') return { scene: null, problem: 'the scene is not an object' };
  const html = typeof raw.html === 'string' ? raw.html : '';
  if (!html.trim()) return { scene: null, problem: 'the scene has no html' };
  if (html.length > SCENE_LIMITS.html) return { scene: null, problem: `the html is over ${SCENE_LIMITS.html.toLocaleString('en-US')} characters` };
  return {
    scene: {
      id: typeof raw.id === 'string' && /^[\w-]{4,40}$/.test(raw.id) ? raw.id : uid(),
      title: str(raw.title, 80) || 'How it runs', why: str(raw.why, 300),
      section: Math.max(0, Math.round(Number(raw.section) || 0)),
      height: Math.round(Math.max(SCENE_LIMITS.minH, Math.min(SCENE_LIMITS.maxH, Number(raw.height) || 360))),
      html, by, at: Date.now(), ...(conv ? { conv } : {}), ...(model ? { model } : {}),
    },
    problem: null,
  };
}
