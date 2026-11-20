// Live sessions: a running Claude Code session that the loupe mod registered (`/loupe live`). A chat linked to it
// sends each question into that session as a prompt, and its answer comes back here. This is opt-in per session:
// unlike a fork, the live session answers with its own tools and permissions, in its own transcript.
import { uid } from './util.mjs';

const sessions = new Map(); // sessionId -> { sessionId, cwd, title, repos, seen, queue: [], waiting: Map(qid -> resolver) }
const STALE_MS = 15000;

export function register({ sessionId, cwd, title, repos }) {
  const s = sessions.get(sessionId) || { sessionId, queue: [], waiting: new Map() };
  Object.assign(s, { cwd, title: String(title || '').slice(0, 200), repos: (repos || []).filter((r) => typeof r === 'string').slice(0, 20), seen: Date.now(), off: false });
  sessions.set(sessionId, s);
  return s;
}
export function unregister(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.off = true;
  for (const [, w] of s.waiting) w.fail('the session left live mode');
  sessions.delete(sessionId);
}
export const known = (sessionId) => sessions.has(sessionId);
export const isLive = (sessionId) => { const s = sessions.get(sessionId); return !!s && !s.off && Date.now() - s.seen < STALE_MS; };
// The live sessions working in a workspace's checkout.
export function forRoot(root) {
  return [...sessions.values()].filter((s) => isLive(s.sessionId) && (s.repos.includes(root) || s.cwd === root || (s.cwd || '').startsWith(root + '/')))
    .map(({ sessionId, cwd, title, repos }) => ({ sessionId, cwd, title, repos }));
}

// The mod asks for the next question every couple of seconds; that is also its heartbeat.
export function next(sessionId, hold = false) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.seen = Date.now();
  return hold ? null : s.queue.shift() || null;
}
export function send(sessionId, text) {
  const s = sessions.get(sessionId);
  if (!s || !isLive(sessionId)) return Promise.reject(new Error('that session is not live any more (run /loupe live in it again)'));
  const q = { id: uid(), text };
  s.queue.push(q);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.waiting.delete(q.id); reject(new Error('no answer from the live session in 30 minutes')); }, 30 * 60 * 1000);
    s.waiting.set(q.id, { ok: (a) => { clearTimeout(timer); resolve(a); }, fail: (m) => { clearTimeout(timer); reject(new Error(m)); } });
  });
}
export function answer(sessionId, qid, a) {
  const w = sessions.get(sessionId)?.waiting.get(qid);
  if (!w) return false;
  sessions.get(sessionId).waiting.delete(qid);
  if (a.error) w.fail(String(a.error)); else w.ok(a);
  return true;
}
