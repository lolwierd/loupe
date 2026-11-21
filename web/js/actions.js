// Doing things. The daemon previews every write (what, where, against which state) and runs it only while that
// state still holds. The bigger writes open their sheet below the top bar, where the preview is read as you type;
// small ones (a reply, a comment, a resolve) run from their own button, because the box they are typed in already
// says where they go.
import { S, api, wsApi, toast } from './core.js';
import { hooks } from './hooks.js';

export const preview = (kind, payload) => api(wsApi(`/actions/${kind}/preview`), { method: 'POST', body: { payload } });
export const run = (kind, payload, guard) => api(wsApi(`/actions/${kind}`), { method: 'POST', body: { payload, guard } });
const SHEETS = new Set(['review', 'commit', 'push', 'openpr', 'stacklink']);

let busy = false;
export async function act(kind, payload = {}) {
  if (SHEETS.has(kind)) { hooks.openSheet?.(kind, payload); return false; }
  if (busy) return false;
  busy = true;
  const id = S.id;
  try {
    const pv = await preview(kind, payload);
    if (S.id !== id) return false;
    const r = await run(kind, payload, pv.guard);
    toast(r.message);
    if (S.id === id) hooks.afterAct?.(kind, r);
    return r;
  } catch (e) { toast(e.message); hooks.sound?.play('knock'); return false; }
  finally { busy = false; }
}
hooks.act = act;

