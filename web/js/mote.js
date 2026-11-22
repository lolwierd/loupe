// Mote, loupe's helper: a small diff beetle, its shell half added-green and half removed-red, a lens in hand. It floats
// over the diff's bottom-right corner (drag it anywhere; it remembers where) and does what the desk is doing, so a glance tells you without reading: it works while
// an answer or the guide is being written, inspects the result when it lands, slumps when something fails, jumps when
// the last file is viewed or a dialog's send goes through, waits while a dialog asks you something, waves hello when a
// change opens (and when you click it), looks at the pointer when it comes near and at what just happened (the file you
// viewed, the mark you made, the answer that landed, the stamp, the next step after a write). Otherwise it is still,
// breathing now and then: it sits beside code you are reading, so it never loops for attention.
//
// The art is the Work Pets v2 sheet scaled down to its own 48 by 52 pixel grid (web/img/mote.png: 8 columns, 11 rows),
// drawn at one sheet pixel per CSS pixel and kept crisp with image-rendering: pixelated. Frame times are the sheet's.
import { S, $, pref, reducedMotion } from './core.js';
import { hooks } from './hooks.js';
import { fit, tok, isDark, watch, ordered, paint, lerp, smooth } from './dither.js';
import { makeFlightFrames, FLY_OFF, FLY_BACK, FLY_STEP, FLY_TRAVEL } from './motefly.js';

const W = 48, H = 52;
const ROW = { idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
const ends = (n, each, last) => [...Array(n - 1).fill(each), last];
const TIMES = {
  idle: [280, 110, 110, 140, 140, 320], waving: ends(4, 140, 280), jumping: ends(5, 140, 280), failed: ends(8, 140, 240),
  waiting: ends(6, 150, 260), running: ends(6, 120, 220), review: ends(6, 150, 280), 'running-right': ends(8, 120, 220), 'running-left': ends(8, 120, 220),
};
const sum = (a) => a.reduce((n, t) => n + t, 0);
const REVIEW_MS = sum(TIMES.review) + 60, JUMP_MS = sum(TIMES.jumping) + 60; // a look waits for the pose before it
const HOLD = { failed: 4 }; // the pose a slumped Mote keeps: the failed row's lowest point, not its recovery
const LOOK_NEAR = 36, LOOK_FAR = 480, LOOK_HOLD = 2500, GLANCE_HOLD = 1200; // px: inside is looked at by nobody; beyond is ignored; ms

// ------------------------------------------------------------------ his eyes
// Mote looks with his eyes. The sheet's look rows turn his whole head (the face swings to one side, the eyes thin out
// and the smile goes), and switching among sixteen of them as the pointer moved made him twitch and look like another
// drawing. So he keeps his idle face and moves only his pupils, a pixel toward what he looks at, in eight directions:
// a strip of ten faces drawn once from the idle frame (centre, the eight clockwise from up, a blink). Eyes jump rather
// than glide, at most every 120 ms, and only when the direction has really changed (it holds within 30° of the one it
// has); a jump across his face blinks first, as a face does.
const EYES = [[19, 30], [28, 30]]; // each pupil's top left on the idle frame, 2 × 2 sheet pixels, with cream round it
const DIRS = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // centre, then clockwise from up
const BLINK = 9, EYE_STEP = 120, BLINK_MS = 90;
let strip = null, flightFrames = null;
(async () => {
  try {
    const sheet = new Image(); sheet.src = '/web/img/mote.png'; await sheet.decode();
    prepareFlight(sheet).catch(() => { /* no frames, so hide and show immediately */ });
    const c = Object.assign(document.createElement('canvas'), { width: W * 10, height: H }), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(sheet, 0, 0, W, H, 0, 0, W, H);
    const at = (x, y) => `rgba(${[...g.getImageData(x, y, 1, 1).data].slice(0, 3).join(',')},1)`;
    const cream = at(22, 30), pupil = at(EYES[0][0], EYES[0][1]);
    for (let i = 0; i < 10; i++) {
      g.drawImage(sheet, 0, 0, W, H, i * W, 0, W, H);
      for (const [x, y] of EYES) {
        g.fillStyle = cream; g.fillRect(i * W + x, y, 2, 2);
        g.fillStyle = pupil;
        if (i === BLINK) g.fillRect(i * W + x, y + 1, 2, 1); // shut: one line where the pupils were
        else g.fillRect(i * W + x + DIRS[i][0], y + DIRS[i][1], 2, 2);
      }
    }
    strip = c.toDataURL('image/png'); // a data: URL: the page's img-src allows data:, not blob:
  } catch { strip = null; } // no strip, no looking: he stays as he is
})();

async function prepareFlight(sheet) {
  const frames = makeFlightFrames(sheet);
  await Promise.all(Object.values(frames).map((src) => {
    const frame = new Image(); frame.src = src; return frame.decode();
  }));
  flightFrames = frames;
}

export const moteHTML = (pose = '') => `<span class="mote"${pose ? ` data-pose="${pose}"` : ''} aria-hidden="true"></span>`;

class Mote {
  // hold: a state whose last frame it keeps when at rest (home's slumped Mote), instead of idling and looking around
  constructor(el, { hold = null } = {}) {
    this.el = el; this.base = 'idle'; this.once = null; this.timer = 0; this.looking = false; this.lookTimer = 0; this.hold = hold;
    this.eye = 0; this.wantEye = 0; this.eyeAt = 0; this.eyeTimer = 0; this.target = null;
    this.draw(0, 0); this.rest();
  }
  draw(row, col) { this.el.style.backgroundImage = this.el.style.backgroundSize = ''; this.el.style.backgroundPosition = `${-col * W}px ${-row * H}px`; }
  // one of the ten faces: his idle frame with the pupils moved (or shut)
  face(i) { this.el.style.backgroundImage = `url(${strip})`; this.el.style.backgroundSize = `${W * 10}px ${H}px`; this.el.style.backgroundPosition = `${-i * W}px 0`; }
  stop() { clearTimeout(this.timer); this.timer = 0; }
  pause() { this.stop(); clearTimeout(this.aux); clearTimeout(this.lifeT); this.aux = this.lifeT = 0; this.endLook(false); this.once = null; this.queued = null; this.el.parentElement?.classList.remove('onback', 'rock'); } // a paused pose takes its successor with it (and a thrown one is back on his feet)
  // play a state's frames: once, then back to what the desk is doing; or around and around for a working state
  run(state, loop) {
    this.stop(); this.endLook(false);
    const row = ROW[state], times = TIMES[state];
    if (reducedMotion() || document.hidden) { // a still pose that says the same, held as long as the motion would take
      this.draw(row, state === 'jumping' ? 2 : times.length > 2 ? 1 : 0);
      if (!loop && !document.hidden) this.timer = setTimeout(() => this.done(), Math.max(1200, times.reduce((a, b) => a + b, 0)));
      return;
    }
    let i = 0;
    const step = () => {
      this.draw(row, i);
      const t = times[i];
      i++;
      if (i >= times.length) { if (!loop) { this.timer = setTimeout(() => this.done(), t); return; } i = 0; }
      this.timer = setTimeout(step, t);
    };
    step();
  }
  // a pose ended: the one that waited for it plays now, else back to the desk's pose, and a look the pointer asked for
  // during a breath is taken now
  done() {
    this.once = null;
    const q = this.queued; this.queued = null;
    if (q) return this.play(q);
    this.rest();
    const look = this.pendingLook; this.pendingLook = null;
    if (look) this.lookAt(look[0], look[1]);
  }
  // still, on the first idle frame, with a breath every seven to twelve seconds
  rest() {
    if (this.once) return; // a move in progress owns the timer and comes back here when it ends
    this.stop();
    if (this.base !== 'idle') return this.run(this.base, true);
    if (this.hold) return this.draw(ROW[this.hold], HOLD[this.hold] ?? TIMES[this.hold].length - 1);
    this.draw(0, 0);
    if (reducedMotion() || document.hidden) return;
    this.timer = setTimeout(() => { if (!this.looking) { this.once = 'breath'; this.run('idle', false); } }, 7000 + Math.random() * 5000);
  }
  set(base) { if (base === this.base) return; if (this.once === 'doze') life.wake(false); this.base = base; if (!this.once) this.rest(); }
  // pleased: his eyes shut in a smile for a moment (the blink face, held), then back to what he was doing; never over a
  // pose that is playing
  pleased(ms = 380) {
    if (this.once && this.once !== 'breath') return;
    this.stop(); this.endLook(false); this.once = 'pleased';
    this.face(BLINK);
    this.timer = setTimeout(() => this.done(), ms);
  }
  // a pose: played now, or, while another plays, next (the newest one waiting wins); a pose is never cut for another
  play(state) {
    if (this.once === 'doze') life.wake(false); // something happened: he wakes for it
    if (this.once && this.once !== 'breath') { this.queued = state; return; } // his own small things finish first too
    this.once = state; this.run(state, false);
  }
  // look toward a point, with his eyes: eight directions, clockwise from straight up. glance: a point he was shown (an
  // event), looked at however far it is and held a shorter while; else the pointer, within LOOK_FAR, held LOOK_HOLD
  lookAt(x, y, glance = false) {
    if (this.hold || this.base !== 'idle' || (this.once && this.once !== 'breath') || reducedMotion() || document.hidden || !strip) return;
    if (!glance && this.once === 'breath') { this.pendingLook = [x, y]; return; } // the breath finishes first
    if (!glance && performance.now() < (this.glanceUntil || 0)) return; // a glance at an event holds against the pointer
    if (glance) this.glanceUntil = performance.now() + GLANCE_HOLD;
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    const dx = x - (r.left + 24), dy = y - (r.top + 31), d = Math.hypot(dx, dy); // from between his eyes
    if (!glance && d > LOOK_FAR) return;
    if (d < LOOK_NEAR) { if (this.looking) this.endLook(); return; }
    if (this.once === 'breath') this.once = null;
    this.stop(); this.looking = true; this.target = [x, y];
    const ang = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    let k = Math.round(ang / 45) % 8;
    if (this.eye) { const off = Math.abs((((ang - (this.eye - 1) * 45) % 360) + 540) % 360 - 180); if (off <= 30) k = this.eye - 1; } // holds while near its own
    this.moveEyes(k + 1);
    clearTimeout(this.lookTimer);
    this.lookTimer = setTimeout(() => this.endLook(), glance ? GLANCE_HOLD : LOOK_HOLD);
  }
  // the pupils toward face want: a jump at most every EYE_STEP ms, a blink first across his face. While a wait or a blink
  // is under way a new target only replaces where they will go, so a moving pointer can neither hold his eyes shut
  // nor keep them waiting
  moveEyes(want) {
    this.wantEye = want;
    if (this.eyeTimer) return;
    const step = () => {
      this.eyeTimer = 0;
      if (!this.looking) return;
      const w = this.wantEye;
      if (w === this.eye) return this.face(w);
      const wait = EYE_STEP - (performance.now() - this.eyeAt);
      if (wait > 0) { this.eyeTimer = setTimeout(step, wait); return; }
      const turn = (((w - this.eye) % 8) + 8) % 8;
      if (this.eye && Math.min(turn, 8 - turn) >= 3) { // three or four directions round: across his face
        this.eye = 0; this.eyeAt = performance.now(); this.face(BLINK);
        this.eyeTimer = setTimeout(step, BLINK_MS);
        return;
      }
      this.eye = w; this.eyeAt = performance.now(); this.face(w);
    };
    step();
  }
  // the look over: the pupils back to centre, and the desk's own pose (breathing, or what it is doing)
  endLook(rest = true) {
    clearTimeout(this.lookTimer); clearTimeout(this.eyeTimer); this.eyeTimer = 0;
    const was = this.looking; this.looking = false; this.eye = 0; this.target = null;
    if (was && rest) this.rest();
  }
}

// ------------------------------------------------------------------ its lens's light on the desk
// Mote holds a lens, and a lens held over a desk throws a spot of light on it. The spot is how much of the change is
// left: with most of it unread the light is spread wide and weak, a pale disc inside the lens's shadow; it gathers as
// the lines left fall; with every file viewed it is one point, the shadow deepens round it, and a four-pointed glint
// stands on it while Mote jumps (held, with reduced motion). Drawn on Mote's own grid, one art pixel to a CSS pixel,
// with the app's 4×4 Bayer matrix (docs/COMPONENTS.md, Print textures). The canvas rides in the dock, so it goes
// wherever Mote is dragged, and never takes the pointer.
const LENS_W = 76, LENS_H = 18, FOOT = 9, LX = 46, LY = 11; // the patch of desk, the feet's row on it, where the light lands
let lens = null, share = 1, allNow = false, glintUntil = 0, unwatchLens = null;
function drawLens() {
  if (!lens?.isConnected || lens.parentElement?.classList.contains('away')) return;
  const g = fit(lens), f = share, dark = isDark();
  const r = 1.2 + 10 * f, core = lerp(0.95, 0.3, f), shadowR = 13;
  const field = (x, y) => {
    const fe = ((x - 25) / 17) ** 2 + ((y - FOOT) / 3.2) ** 2; // the contact shadow under its feet
    const contact = fe < 1 ? 0.45 * (1 - smooth(0.4, 1, fe)) + 0.2 : 0;
    const ld = Math.hypot(x - LX, (y - LY) / 0.42); // the lens's shadow, squashed onto the desk; deeper round a gathered point
    const lensShadow = ld < shadowR ? (0.5 + 0.45 * (1 - f) * (1 - smooth(5, 12, ld))) * (1 - smooth(shadowR - 4, shadowR, ld)) : 0;
    const light = ld < r + 1 ? core * (1 - smooth(r * 0.2, r + 1, ld)) : 0;
    return { ink: Math.max(contact, lensShadow * (1 - Math.min(1, light * 2))), light };
  };
  const mask = ordered(g, (x, y) => field(x, y).ink, { cell: g.d, ink: 1 });
  ordered(g, (x, y) => field(x, y).light, { cell: g.d, ink: 2, into: mask });
  if (allNow && (Date.now() < glintUntil || reducedMotion())) {
    const put = (ax, ay) => { for (let Y = ay * g.d; Y < (ay + 1) * g.d; Y++) for (let X = ax * g.d; X < (ax + 1) * g.d; X++) if (X < g.W && Y < g.H) mask[Y * g.W + X] = 3; };
    for (let k = -3; k <= 3; k++) { put(LX + k, LY); put(LX, LY + k); }
    for (const [dx, dy] of [[-1, -1], [1, 1], [1, -1], [-1, 1]]) put(LX + dx, LY + dy);
  }
  const hi = tok('--hi'); // the light is the app's own highlight, light in both themes; the shadow is ink, seen through
  paint(lens, g, mask, [null, dark ? [0, 0, 0, 200] : [...tok('--ink').slice(0, 3), 120], [...hi.slice(0, 3), dark ? 220 : 255], hi]);
}

// ------------------------------------------------------------------ the floating one on a change's page
let main = null, words = null, wordsTimer = 0, helloTimer = 0, lastBusy = new Map(), briefWas = false, allWas = null;
const say = (text, ms = 0) => {
  if (!words) return;
  clearTimeout(wordsTimer);
  words.textContent = text || '';
  if (text) { const dock = $('#motedock'); if (dock) aim(dock); }
  if (main) main.el.title = text || 'Mote';
  if (ms && !document.hidden) wordsTimer = setTimeout(() => say(status()), ms);
};
const kindOf = (m) => (m?.role === 'codex' ? 'Codex' : 'Claude');
// what is running now, in a few words
function status() {
  const b = S.review?.brief;
  if (b?.pending) return b.tldr ? 'Rewriting the guide and map' : 'Writing the guide and map';
  const run = Object.values(S.review?.convs || {}).flatMap((c) => c.messages || []).find((m) => m.pending && m.role !== 'user');
  return run ? `${kindOf(run)} is answering` : '';
}
// where it floats: the spot you dragged it to, as a share of the window so a resize keeps it in view; else the corner,
// where its bubble opens to its left. (The spot is kept under a new name since the corner moved from the bottom left:
// a spot dragged out from the old corner is not kept.)
const SPOT = 'moteSpot';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function place(dock) {
  const at = pref.get(SPOT, null);
  if (!at) { dock.style.left = dock.style.top = dock.style.bottom = ''; aim(dock); return; }
  const x = clamp(at.x * innerWidth, 4, innerWidth - W - 4), y = clamp(at.y * innerHeight, 4, innerHeight - H - 4);
  dock.style.left = `${Math.round(x)}px`; dock.style.top = `${Math.round(y)}px`; dock.style.bottom = 'auto';
  aim(dock);
}
addEventListener('resize', () => { const d = $('#motedock'); if (d) place(d); });
// its bubble opens toward the side with more room (in the corner, over the diff); checked wherever it is put, when it
// has something to say, and when the inspector opens, closes or is resized
let panelWatch = null;
function aim(dock) { const r = dock.getBoundingClientRect(); dock.classList.toggle('flip', r.left > innerWidth - r.right); }
// mount into its floating spot; called when a change opens
let mountedFor = null;
hooks.moteMount = (allViewed, left = 1) => {
  const dock = $('#motedock');
  // the same change drawn again (a save in the tree, a refresh, another scope): he carries on with whatever he was doing
  if (main && dock && mountedFor === S.id && main.el.isConnected && dock.contains(main.el)) {
    share = left; allNow = !!allViewed; allWas = allNow; drawLens(); hooks.mote.sync(); return;
  }
  mountedFor = S.id;
  landing?.(); // a flight under way ends now: the dock is drawn again below
  main?.pause(); life.stop();
  clearTimeout(wordsTimer); clearTimeout(helloTimer);
  words = null;
  if (!dock) { main = null; return; }
  dock.innerHTML = `<canvas class="motelight" aria-hidden="true" style="width:${LENS_W}px;height:${LENS_H}px;top:${H - FOOT - 4}px"></canvas>${moteHTML()}<span class="mw"></span>`;
  dock.classList.toggle('away', away());
  place(dock);
  panelWatch?.disconnect();
  const panel = $('#panel');
  if (panel) { panelWatch = new ResizeObserver(() => aim(dock)); panelWatch.observe(panel); }
  lens = dock.querySelector('.motelight'); share = left; allNow = !!allViewed; glintUntil = 0;
  unwatchLens?.(); unwatchLens = watch(lens, drawLens);
  words = dock.querySelector('.mw');
  lastBusy = new Map(); briefWas = !!S.review?.brief?.pending; allWas = !!allViewed;
  if (away()) { main = null; return; } // flown off: not mounted until he is called back
  main = new Mote(dock.querySelector('.mote'));
  hooks.mote.sync();
  if (!document.hidden) helloTimer = setTimeout(() => { if (main.base === 'idle') main.play('waving'); }, 500);
  life.start();
};
hooks.mote = {
  // after any change to answers, the brief or a dialog: the working pose while something runs, and what just ended
  sync() {
    if (!main) return;
    const b = S.review?.brief;
    const pending = new Map();
    for (const c of Object.values(S.review?.convs || {})) for (const m of c.messages || []) if (m.pending && m.role !== 'user') pending.set(m.id, c.id);
    const ended = [...lastBusy.keys()].filter((id) => !pending.has(id));
    const lastEnded = new Map(ended.map((id) => [id, lastBusy.get(id)]));
    let failed = false, landed = false;
    for (const id of ended) {
      const m = S.review?.convs?.[lastBusy.get(id)]?.messages?.find((x) => x.id === id);
      if (m?.error) failed = true; else if (m) landed = true;
    }
    if (briefWas && !b?.pending) { if (b?.error) failed = true; else landed = true; }
    lastBusy = pending; briefWas = !!b?.pending;
    main.set(pending.size || b?.pending ? 'running' : document.querySelector('.sheetscrim') ? 'waiting' : 'idle');
    if (failed) { main.play('failed'); say(ended.length ? 'That answer failed' : 'The guide failed', 5000); }
    else if (landed) {
      main.play('review'); say(ended.length ? 'Answer ready' : 'Guide ready', 4000);
      if (document.hidden) hooks.sound?.play('bell'); // one bell, for the tab you are not looking at
      // then a look at what landed: the answer's mark at its lines, or the map the guide drew
      const conv = ended.map((id) => lastEnded.get(id)).find(Boolean), th = conv && S.review?.threads?.find((t) => t.conv === conv);
      hooks.mote.glance(() => (th ? document.querySelector(`.mrow[data-t="${CSS.escape(th.id)}"]`) : ended.length ? null : $('#mapcard')), REVIEW_MS);
    }
    else say(status());
  },
  // after the viewed count changes: a jump when the last file goes viewed, and the lens's light gathered to match
  progress(all, left = share) {
    if (!main) return;
    share = left; allNow = !!all;
    if (allWas === false && all) { main.play('jumping'); say('Every file viewed', 4000); glintUntil = Date.now() + 1400; setTimeout(drawLens, 1450); }
    allWas = all;
    drawLens();
  },
  // a file viewed: he hops (his light stays on the desk), pleased, and a small check rises off his head; then he looks at
  // the file's row. A hop runs to its end: a file viewed while he is in the air adds its check beside the first and leaves
  // the hop as it is. The last file viewed is his jump instead (progress), so it gets no hop.
  viewed() {
    const m = main, dock = m?.el.parentElement;
    if (!m || !dock || reducedMotion() || document.hidden || allNow) return;
    const n = dock.querySelectorAll('.motecheck').length;
    if (n < 4) {
      const chk = document.createElement('i');
      chk.className = 'motecheck'; chk.setAttribute('aria-hidden', 'true'); chk.style.setProperty('--n', n);
      chk.addEventListener('animationend', () => chk.remove(), { once: true });
      dock.append(chk);
    }
    if (dock.classList.contains('hop')) return;
    dock.classList.add('hop');
    m.el.addEventListener('animationend', () => dock.classList.remove('hop'), { once: true });
    m.pleased();
  },
  // one of his small things now (by its place in LIFE), or a doze, for tests and for the curious
  live: (i) => (i === 'doze' ? main && life.doze(main) : life.tick(i)),
  // under the loupe (eggs.js): he waves back through the glass, once per look
  peered() { if (main && !main.once && main.base === 'idle' && !reducedMotion()) main.play('waving'); },
  // away: flown off (true) or called back (false); isAway for the palette's and the view menu's rows
  away: (on) => setAway(on),
  isAway: () => away(),
  // what it is doing, for tests and for the curious
  state: () => main && { base: main.base, once: main.once, looking: main.looking, eye: main.eye, hidden: document.hidden, reduced: reducedMotion() },
  // a dialog's send went through, or did not; then, if it went, a look at what comes next (at: the element, found then)
  acted(ok, at = null) { if (!main) return; main.play(ok ? 'jumping' : 'failed'); hooks.mote.sync(); if (ok && at) hooks.mote.glance(at, JUMP_MS); },
  // a look at something that just happened, after ms (a pose playing first); el, or a function that finds it then
  glance(el, ms = 0) {
    const m = main; // the Mote it was meant for: none, if the change was left meanwhile
    if (!m) return;
    let tries = 0;
    const go = () => {
      const t = typeof el === 'function' ? el() : el;
      if (main !== m || !t?.isConnected || !m.el.isConnected) return;
      if (m.once && m.once !== 'breath' && tries++ < 10) { setTimeout(go, 120); return; } // a pose still playing: after it
      const r = t.getBoundingClientRect();
      if (!r.width && !r.height) return;
      m.lookAt(Math.max(0, Math.min(innerWidth, r.left + r.width / 2)), Math.max(0, Math.min(innerHeight, r.top + r.height / 2)), true);
    };
    if (ms) setTimeout(go, ms); else requestAnimationFrame(go);
  },
};

// ------------------------------------------------------------------ his life
// Left alone he lives a little: every 9 to 30 s, when nothing is going on (the desk idle, no pose, no look, no dialog,
// the tab in front, motion allowed), he does one small thing, never the same twice running. After a few minutes with
// no key or pointer he dozes, a z rising now and then, and wakes with a start when you come back. Late at night (after
// eleven, before five) he dozes sooner and blinks slower.
const night = () => { const h = new Date().getHours(); return h >= 23 || h < 5; };
const rand = (a, b) => a + Math.random() * (b - a);
let lastInput = Date.now();
function prop(kind, { dx = 0, ms = 900 } = {}) {
  const dock = main?.el.parentElement;
  if (!dock || dock.querySelectorAll('.moteprop').length > 3) return;
  const p = document.createElement('i');
  p.className = `moteprop ${kind}`; p.setAttribute('aria-hidden', 'true');
  p.style.setProperty('--dx', `${dx}px`); p.style.setProperty('--ms', `${ms}ms`);
  p.addEventListener('animationend', () => p.remove(), { once: true });
  dock.append(p);
}
// eyes to a direction (1 up, then clockwise; 0 the centre) for a while, then the next
function eyes(m, path) {
  let t = 0;
  m.looking = true;
  for (const [dir, ms] of path) { setTimeout(() => { if (m.once === 'life') { m.looking = dir !== 0; m.eye = dir; m.face(dir); } }, t); t += ms; }
  return t;
}
const LIFE = [
  // looks left, then right, then back
  { w: 4, run: (m) => eyes(m, [[7, 650], [0, 180], [3, 700], [0, 120]]) },
  // two quick blinks
  { w: 4, run: (m) => eyes(m, [[BLINK, 90], [0, 140], [BLINK, 90], [0, 60]]) },
  // a slow blink, slower at night
  { w: 2, run: (m) => eyes(m, [[BLINK, night() ? 700 : 320], [0, 80]]) },
  // a peek at the code, down and to the left, held
  { w: 3, run: (m) => eyes(m, [[6, 1400], [0, 80]]) },
  // a look up toward the top bar's count
  { w: 2, run: (m) => eyes(m, [[1, 900], [8, 500], [0, 80]]) },
  // a look at his loupe, the inspecting pose
  { w: 2, run: (m) => { m.run('review', false); return sum(TIMES.review); } },
  // a note hummed
  { w: 2, run: (m) => { prop('note', { dx: 4, ms: 1400 }); return eyes(m, [[BLINK, 260], [0, 900]]); } },
  // a glint on his lens
  { w: 2, run: () => { prop('glint', { ms: 700 }); return 760; } },
  // a little hop, pleased
  { w: 1, run: (m) => { const d = m.el.parentElement; d.classList.add('hop'); m.el.addEventListener('animationend', () => d.classList.remove('hop'), { once: true }); return eyes(m, [[BLINK, 300], [0, 60]]); } },
  // a shuffle to one side and back
  { w: 2, run: (m) => { const d = m.el.parentElement; d.classList.add('shuffle'); m.el.addEventListener('animationend', () => d.classList.remove('shuffle'), { once: true }); return eyes(m, [[7, 500], [3, 520], [0, 60]]); } },
  // a wave at nobody, now and then
  { w: 1, run: (m) => { m.run('waving', false); return sum(TIMES.waving); } },
];
const life = {
  timer: 0, last: -1, dozing: false, zTimer: 0,
  start() { this.stop(); this.next(); },
  stop() { this.wake(false, false); clearTimeout(this.timer); this.timer = 0; },
  next(ms = rand(9000, 30000)) { clearTimeout(this.timer); this.timer = setTimeout(() => this.tick(), ms); },
  free(m) { return m && m.el.isConnected && !m.hold && m.base === 'idle' && !m.once && !m.queued && !m.looking && !document.hidden && !reducedMotion() && !document.querySelector('.scrim, .sheetscrim'); },
  // pick: one of LIFE by its place, for a test or the curious (hooks.mote.live); else weighted, never the last one again
  tick(pick) {
    const m = main;
    if (!m || !m.el.isConnected || document.hidden) return; // a hidden tab starts him again when it is shown
    if (!this.free(m)) return this.next(rand(4000, 9000));
    if (pick === undefined && Date.now() - lastInput > (night() ? 90000 : 240000)) return this.doze(m);
    const total = LIFE.reduce((n, x, i) => n + (i === this.last ? 0 : x.w), 0);
    let r = Math.random() * total, i = 0;
    for (; i < LIFE.length; i++) { if (i === this.last) continue; r -= LIFE[i].w; if (r <= 0) break; }
    if (pick !== undefined) i = pick;
    this.last = i = Math.min(i, LIFE.length - 1);
    m.stop(); m.once = 'life';
    const ms = LIFE[i].run(m) || 600;
    m.lifeT = setTimeout(() => { m.lifeT = 0; m.looking = false; m.eye = 0; if (m.once === 'life') m.done(); this.next(); }, ms); // its own timer: the pose it plays keeps m.timer
  },
  doze(m) {
    this.dozing = true; m.stop(); m.once = 'doze'; m.face(BLINK);
    const z = () => { if (!this.dozing) return; prop('z', { dx: rand(-2, 6), ms: 1800 }); this.zTimer = setTimeout(z, rand(2200, 3400)); };
    z();
  },
  // a key or the pointer: awake, with a start, and a look at where you are
  wake(react = true, carryOn = true) {
    if (!this.dozing) return;
    this.dozing = false; clearTimeout(this.zTimer);
    const m = main;
    if (!m) return;
    m.once = null; m.face(0);
    if (react && !reducedMotion()) { const d = m.el.parentElement; d.classList.add('hop'); m.el.addEventListener('animationend', () => d.classList.remove('hop'), { once: true }); }
    m.rest(); if (carryOn) this.next();
  },
};
const touched = () => { lastInput = Date.now(); if (life.dozing) life.wake(); };
for (const ev of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(ev, touched, { passive: true, capture: true });
document.addEventListener('pointermove', () => { if (life.dozing || Date.now() - lastInput > 1000) touched(); }, { passive: true });


// ------------------------------------------------------------------ away, and back
// A double click (or Hide Mote in ⌘K or the view menu) makes him crouch and lift the green and red halves of his shell
// as wings, with his hind wings buzzing beneath. He climbs out of the window toward the nearer side, swaying as he
// picks up speed. Show Mote brings him back to his spot, where he touches down, folds his wings and waves. The 12 fps
// cels are drawn over the dock. With reduced motion or unavailable cels he is just gone, or there.
// Away, he is not mounted (main is null), so every hook and his life do nothing without a guard of their own;
// the dock stays, hidden, for him to come back to, and a change in another tab is followed here.
const AWAY = 'moteAway';
const away = () => !!pref.get(AWAY, false);
let flight = 0, leaving = false;
function fly(dock, out, done) {
  landing?.();
  if (!out) dock.classList.remove('away'); // an interrupted takeoff just completed its hide
  if (!flightFrames || reducedMotion() || document.hidden) { dock.style.transform = ''; done(); return; }
  const art = document.createElement('img');
  art.className = 'moteflight'; art.alt = '';
  const frames = out ? FLY_OFF : FLY_BACK;
  const takeoff = FLY_OFF.length - FLY_TRAVEL;
  const r = dock.getBoundingClientRect(), side = r.left + W / 2 < innerWidth / 2 ? -1 : 1;
  const rise = r.top + H + 32, drift = 120 + Math.random() * 80;
  let index = 0;
  const land = () => {
    if (landing !== land) return;
    clearTimeout(flight); flight = 0; landing = null;
    art.remove(); dock.classList.remove('flying'); dock.style.transform = '';
    done();
  };
  landing = land;
  dock.append(art);
  dock.classList.add('flying');
  const step = () => {
    if (document.hidden || index === frames.length) { land(); return; }
    const path = out ? index - takeoff + 1 : FLY_TRAVEL - index;
    let x = 0, y = 0;
    if (path > 0) {
      const k = path / FLY_TRAVEL, e = k * k;
      y = -2 - e * rise;
      x = side * e * drift + Math.round(Math.sin(k * Math.PI * 5) * 3);
    }
    dock.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    art.src = flightFrames[frames[index++]];
    flight = setTimeout(step, FLY_STEP);
  };
  step();
}
let landing = null; // the flight under way's end, for a tab hidden mid-flight
function setAway(on) {
  pref.set(AWAY, !!on);
  const dock = $('#motedock');
  if (!dock) return;
  drag = null; dock.classList.remove('drag'); // a press held through it carries nothing
  if (on) {
    if (!main || leaving) return; // gone already, or going
    const m = main; main = null; leaving = true; // unmounted at once: nothing reaches him while he flies off
    m.pause(); life.stop(); clearTimeout(helloTimer); say('');
    m.draw(ROW.jumping, 2); // in the air
    fly(dock, true, () => { leaving = false; dock.classList.add('away'); });
  } else {
    if (main && !leaving) return; // here already
    leaving = false;
    dock.classList.remove('away'); place(dock);
    main?.pause();
    const m = main = new Mote(dock.querySelector('.mote'));
    m.stop(); m.once = 'flying'; m.draw(ROW.jumping, 2); // nothing else draws him while he lands
    fly(dock, false, () => { if (main !== m) return; m.once = null; m.rest(); m.play('waving'); hooks.mote.sync(); if (!document.hidden) life.start(); });
  }
}
// another tab sent him off or called him back: this one follows
addEventListener('storage', (e) => { if (e.key === 'loupe.' + AWAY) setAway(away()); });

// ------------------------------------------------------------------ the still ones on home
// home's quiet states: Mote at rest where nothing waits on you, slumped where a link led nowhere
const homeMotes = new Set();
function pruneHomeMotes() {
  for (const m of homeMotes) if (!m.el.isConnected) { m.pause(); homeMotes.delete(m); }
}
export function wakeMotes(root = document) {
  pruneHomeMotes();
  for (const el of root.querySelectorAll('.mote[data-pose]:not([data-awake])')) {
    el.dataset.awake = '1';
    const failed = el.dataset.pose === 'failed', m = new Mote(el, { hold: failed ? 'failed' : null });
    if (failed) m.play('failed');
    homeMotes.add(m);
  }
}

// ------------------------------------------------------------------ the pointer, and a click to say hello
let raf = 0, px = 0, py = 0;
document.addEventListener('pointermove', (e) => {
  px = e.clientX; py = e.clientY;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (main?.el.isConnected) main.lookAt(px, py);
    pruneHomeMotes();
    for (const m of homeMotes) m.lookAt(px, py);
  });
}, { passive: true });
// a press that moves carries it; one that does not says hello
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const m = e.target.closest?.('#motedock .mote');
  if (!m || e.button !== 0 || flight || !main) return; // not one in flight
  const dock = m.parentElement, r = dock.getBoundingClientRect();
  drag = { dock, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false, trail: [] };
  m.setPointerCapture?.(e.pointerId); e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  drag.moved = true; drag.dock.classList.add('drag');
  const x = clamp(e.clientX - drag.dx, 4, innerWidth - W - 4), y = clamp(e.clientY - drag.dy, 4, innerHeight - H - 4);
  Object.assign(drag.dock.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto' });
  drag.trail.push([e.clientX, e.clientY, e.timeStamp]); if (drag.trail.length > 6) drag.trail.shift(); // for a throw
  aim(drag.dock);
});
// ------------------------------------------------------------------ thrown
// Let go of him mid-swing and he flies on a little, skids, and lands on his back, as a beetle does: legs paddling at
// the air, a rock to one side, and a heave that rights him with a hop. Only for a real throw (faster than 1.4 px/ms
// over the last moves), and not with reduced motion, where he lands where he was let go.
const THROW = 1.4;
function thrown(d, m, e) {
  const t = d.trail.filter((p) => e.timeStamp - p[2] < 90);
  if (t.length < 2 || reducedMotion()) return false;
  const [x0, y0, t0] = t[0], dt = Math.max(8, e.timeStamp - t0);
  let vx = (e.clientX - x0) / dt, vy = (e.clientY - y0) / dt;
  if (Math.hypot(vx, vy) < THROW) return false;
  const dock = d.dock;
  m.pause(); life.stop(); m.once = 'thrown'; say('');
  m.draw(ROW.jumping, 2);
  let last = performance.now();
  const glide = () => { // on, slowing, kept inside the window
    if (m.once !== 'thrown' || main !== m) return; // called off meanwhile
    const now = performance.now(), k = Math.min(48, now - last); last = now;
    const r = dock.getBoundingClientRect();
    const x = clamp(r.left + vx * k, 4, innerWidth - W - 4), y = clamp(r.top + vy * k, 4, innerHeight - H - 4);
    if (x <= 4 || x >= innerWidth - W - 4) vx = 0; if (y <= 4 || y >= innerHeight - H - 4) vy = 0;
    Object.assign(dock.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, bottom: 'auto' });
    vx *= Math.pow(0.86, k / 16); vy *= Math.pow(0.86, k / 16);
    if (Math.hypot(vx, vy) > 0.08 && m.once === 'thrown') return requestAnimationFrame(glide);
    pref.set(SPOT, { x: x / innerWidth, y: y / innerHeight }); aim(dock);
    onBack(dock, m);
  };
  requestAnimationFrame(glide);
  return true;
}
function onBack(dock, m) {
  if (m.once !== 'thrown') return;
  dock.classList.add('onback');
  m.run('running-right', true); // his legs, at the air (m.timer is their loop's)
  m.once = 'thrown';
  m.aux = setTimeout(() => { // a rock, then the heave over, on a timer of its own
    dock.classList.add('rock');
    m.aux = setTimeout(() => {
      m.aux = 0; m.stop();
      dock.classList.remove('onback', 'rock');
      m.once = null; m.play('jumping');
      m.aux = setTimeout(() => { m.aux = 0; if (main === m && !away()) { say(status()); life.start(); } }, JUMP_MS);
    }, 520);
  }, 1300);
}
document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null; d.dock.classList.remove('drag');
  if (!d.moved) { main?.play('waving'); return; }
  if (main && thrown(d, main, e)) return;
  const r = d.dock.getBoundingClientRect();
  pref.set(SPOT, { x: r.left / innerWidth, y: r.top / innerHeight });
});
// a double click: he flies off (⌘K's Show Mote calls him back)
document.addEventListener('dblclick', (e) => { if (e.target.closest?.('#motedock .mote')) setAway(true); });
// a hidden tab keeps no timers; it picks up again on the right frame
document.addEventListener('visibilitychange', () => {
  pruneHomeMotes();
  if (document.hidden) {
    landing?.(); // a flight under way lands, or leaves, at once
    clearTimeout(wordsTimer); clearTimeout(helloTimer);
    main?.pause(); life.stop(); // nobody is watching: no life either
    for (const m of homeMotes) m.pause();
  } else {
    if (main) { life.start(); main.pause(); main.rest(); say(status()); }
    for (const m of homeMotes) { m.pause(); m.rest(); }
  }
});
