// Desk sounds: off until you turn them on (⌘K, "Turn desk sounds on"; kept in this browser), and started only by that
// click, since a browser plays nothing before one. Each sound answers one thing you did, made by voices.js with Web
// Audio (no files):
//   a file viewed      a wooden tick, pitched up a pentatonic ladder by how much of the change is read, so a review is
//                      a rising phrase and the last file resolves it (the tonic over its fifth, held a little longer)
//   viewed undone      the same tick a step down, quieter
//   approved           a rubber stamp: a low thump, the paper's slap, the rebound
//   committed          a typebar: two clicks and the slug's ring
//   pushed, PR opened  a plucked string, a fifth rising: sent off
//   a send failed      a dull knock, two notes falling, never an alarm
//   an answer landed   one soft bell, only while this tab is out of view (in view, the spark and Mote already say it)
// Nothing else makes a sound: no typing, no clicks, no scrolling.
import { S, pref } from './core.js';
import { hooks } from './hooks.js';
import { isViewed, lines } from './cards.js';
import { voices, chain, LADDER } from './voices.js';

const on = () => !!pref.get('deskSounds', false);
let ctx = null, out = null;
function play(name, arg) {
  if (!on()) return;
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ctx = new AC(); out = chain(ctx); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  voices[name]?.(ctx, ctx.currentTime + 0.01, out, arg);
  hooks.sound.last = name; // what played last, for tests and the curious
}

// how much is read, from the same files as the meter (every file but the generated ones), and whether it is all of it
const counted = () => S.files.filter((f) => f.kind !== 'generated');
const readShare = () => { const fs = counted(), t = fs.reduce((n, f) => n + lines(f), 0); return t ? fs.filter(isViewed).reduce((n, f) => n + lines(f), 0) / t : fs.every(isViewed) ? 1 : 0; };
const allRead = () => counted().length > 0 && counted().every(isViewed);
const rung = (share) => Math.round(share * (LADDER.length - 2)); // the top rung is kept for the last file
let before = null; // [share, all] after the last file you viewed or unviewed, for this change

hooks.sound = {
  on, play,
  set(v) { pref.set('deskSounds', !!v); if (v) play('tick', LADDER.length - 4); }, // turning it on is heard
  // a file viewed or unviewed by you (setViewed, after the review state has moved)
  viewed(id) {
    const now = readShare(), all = allRead(), [was, wasAll] = before?.id === id ? before.at : [null, null];
    before = { id, at: [now, all] };
    if (was === null) return play(all ? 'resolve' : 'tick', rung(now));
    if (all && !wasAll) play('resolve');
    else if (now > was) play('tick', rung(now));
    else if (now < was) play('untick', rung(now));
  },
  // where the review stood when the change opened, so the first file viewed rises from there
  opened(id) { before = { id, at: [readShare(), allRead()] }; },
  // a write went through
  wrote(kind) { if (kind === 'commit') play('clack'); else if (kind === 'push' || kind === 'openpr') play('pluck'); },
};
