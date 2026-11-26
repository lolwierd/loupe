// A key presses the control it drives. A shortcut whose control is in view shows the same press as a click on it (the
// .struck rules beside :active in style.css: the control shades and gives), and any key hint printed on screen for that
// key bottoms out with it, so the keyboard and the screen agree about what just happened. The press lasts while the key
// is down, and 90 ms at least, so a quick tap is seen. A key that drives nothing in view presses nothing.
import { S, $, $$, fileOf } from './core.js';

const MIN = 90;
const visible = (el) => { if (!el?.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
const card = () => (S.current ? document.getElementById('f-' + fileOf(S.current)?.i) : null);
const inField = (e) => !!e.target.closest?.('input, textarea, select, [contenteditable]');

// the control a key drives where it is drawn; a function, because the app may draw it again while the key is down
function target(e) {
  const k = e.key, mod = e.metaKey || e.ctrlKey;
  const sheet = $('.sheetscrim .sheet');
  if (sheet) return mod && k === 'Enter' ? () => sheet.querySelector('[data-sh="go"]') : null;
  // a field's send, on the field's own conditions (cards.js, panel.js): a question sends on ↵, writing for GitHub on ⌘↵
  const typing = !e.shiftKey && !e.isComposing && e.keyCode !== 229, inText = e.target.tagName === 'TEXTAREA'; // the sends fire from their text only
  const draft = e.target.closest?.('.draft');
  if (draft) return inText && k === 'Enter' && (draft.classList.contains('gh') ? mod : typing) ? () => draft.querySelector('[data-act="draft-send"]') : null;
  const box = e.target.closest?.('#chatbox, #markbox, #commentbox, #ghbox');
  if (box) {
    const ask = box.id === 'chatbox' || box.id === 'markbox', act = { commentbox: 'ghcomment', ghbox: 'ghreply' }[box.id];
    if (!inText || k !== 'Enter' || !(ask ? typing : mod)) return null;
    return () => (act ? $(`[data-act="${act}"]`) : box.querySelector('button.primary, button.send, [data-act$="send"]'));
  }
  if (inField(e) || mod || e.altKey || $('.scrim')) return null; // a field, or the palette and the key sheet, own their keys
  if (!S.id) { const row = document.activeElement?.closest?.('.hrow'); return k === 'Enter' && row ? () => row : null; } // home
  // fixed now, at keydown: the app moves the current file and flips the order right after this
  const c = card(), order = S.order === 'guide' ? 'tree' : 'guide', cardNow = () => (c?.isConnected ? c : c && document.getElementById(c.id));
  return {
    v: () => cardNow()?.querySelector('[data-act="viewed"]'),
    o: () => cardNow()?.querySelector('.fh [data-act="fold"].icon'),
    t: () => $('[data-act="togglebin"]'), b: () => $('[data-act="toggledock"]:not([hidden])'), p: () => $('[data-act="togglepanel"]'), r: () => $('[data-act="refresh"]'),
    g: () => $(`#ordseg [data-o="${order}"]`),
    '[': () => $('#backslip .link'),
    1: () => $('#ptab-overview'), 2: () => $('#ptab-chat'), 3: () => $('#ptab-review'),
  }[k] || null;
}
// the key as a hint prints it
function label(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Enter') return mod ? ['⌘↵'] : ['↵'];
  if (mod || e.altKey || e.key.length !== 1) return [];
  return [e.key.toLowerCase()];
}
const hints = (e) => { const want = label(e); return want.length ? () => $$('kbd').filter((k) => want.includes(k.textContent.trim().toLowerCase())) : null; };

const down = new Map(); // physical key (e.code, so Shift or a layout cannot rename it on the way up) → its press
const keyOf = (e) => e.code || e.key.toLowerCase();
const strike = (find) => { const out = (find() || []).filter(visible); for (const el of out) el.classList.add('struck'); return out; };
const fading = new Set(); // presses let go of, still within their minimum
function release(code) {
  const d = down.get(code); if (!d) return;
  down.delete(code); fading.add(d);
  setTimeout(() => {
    fading.delete(d);
    const held = new Set([...down.values(), ...fading].flatMap((x) => x.els)); // another press of the same control keeps it down
    for (const el of new Set([...d.els, ...d.find()])) if (!held.has(el)) el.classList.remove('struck');
  }, Math.max(0, MIN - (performance.now() - d.at)));
}
window.addEventListener('keydown', (e) => {
  if (e.repeat || ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
  const t = target(e), h = hints(e);
  if (!t && !h) return;
  const find = () => [...[].concat(t?.() || []), ...(h?.() || [])].filter(Boolean);
  const id = keyOf(e);
  release(id);
  const d = { find, els: strike(find), at: performance.now() };
  down.set(id, d);
  // the app answers after this listener and may draw the control again (the viewed box, a moved tab): press the new one
  requestAnimationFrame(() => { if (down.get(id) === d) d.els = [...new Set([...d.els, ...strike(find)])]; });
}, true);
window.addEventListener('keyup', (e) => { release(keyOf(e)); if (e.key === 'Meta' || e.key === 'Control') for (const c of [...down.keys()]) release(c); }, true);
window.addEventListener('blur', () => { for (const c of [...down.keys()]) release(c); });
