// The desk's voices, made with Web Audio (no files). Each takes (ctx, at, out), so the app plays them live and the sound
// board renders the same code offline to draw and measure it. sound.js says when each one plays.
// D major pentatonic, D4 to D6: eleven rungs
export const LADDER = [293.66, 329.63, 369.99, 440, 493.88, 587.33, 659.25, 739.99, 880, 987.77, 1174.66];
const env = (ctx, g, at, peak, attack, decay) => { g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay); };
let noiseBuf = null;
const noise = (ctx) => {
  if (noiseBuf?.sampleRate === ctx.sampleRate) return noiseBuf;
  const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.5), ctx.sampleRate), d = b.getChannelData(0);
  let seed = 7; for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; } // the same grain every time
  return (noiseBuf = b);
};
function tone(ctx, out, at, { f, f2 = f, type = 'sine', peak = 0.2, attack = 0.002, decay = 0.08, glide = 0.03 }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, at); if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, at + glide);
  env(ctx, g, at, peak, attack, decay); o.connect(g).connect(out); o.start(at); o.stop(at + attack + decay + 0.02);
}
function burst(ctx, out, at, { type = 'bandpass', f = 2000, q = 1, peak = 0.2, decay = 0.02 }) {
  const s = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noise(ctx); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
  env(ctx, g, at, peak, 0.001, decay); s.connect(flt).connect(g).connect(out); s.start(at, Math.random() * 0.3); s.stop(at + decay + 0.03);
}
// a wood block: a short sine that drops a little as it is struck, with a click of the block's grain
const wood = (ctx, out, at, f, peak = 0.22, decay = 0.11) => {
  tone(ctx, out, at, { f: f * 1.5, f2: f, peak, decay, glide: 0.012 });
  tone(ctx, out, at, { f: f * 2.76, peak: peak * 0.18, decay: decay * 0.4 }); // the block's second mode, inharmonic
  burst(ctx, out, at, { f: f * 4, q: 3, peak: peak * 0.5, decay: 0.008 });
};

export const voices = {
  tick: (ctx, at, out, rung = 4) => wood(ctx, out, at, LADDER[Math.max(0, Math.min(LADDER.length - 1, rung))]),
  untick: (ctx, at, out, rung = 4) => wood(ctx, out, at, LADDER[Math.max(0, rung - 1)], 0.11, 0.07),
  resolve: (ctx, at, out) => { wood(ctx, out, at, LADDER[7], 0.14, 0.3); wood(ctx, out, at + 0.07, LADDER[10], 0.28, 0.55); }, // the fifth under, then the tonic
  stamp: (ctx, at, out) => {
    tone(ctx, out, at, { f: 120, f2: 52, peak: 0.45, decay: 0.16, glide: 0.09 });
    burst(ctx, out, at, { type: 'lowpass', f: 1800, q: 0.7, peak: 0.35, decay: 0.035 });
    tone(ctx, out, at + 0.045, { f: 90, f2: 60, peak: 0.12, decay: 0.06, glide: 0.04 }); // the rebound
  },
  clack: (ctx, at, out) => {
    burst(ctx, out, at, { type: 'highpass', f: 1500, peak: 0.32, decay: 0.006 });
    burst(ctx, out, at + 0.026, { type: 'bandpass', f: 900, q: 2, peak: 0.24, decay: 0.012 });
    tone(ctx, out, at + 0.026, { f: 3150, peak: 0.035, decay: 0.09 });
  },
  pluck: (ctx, at, out) => {
    for (const [f, dt] of [[440, 0], [659.25, 0.09]]) {
      tone(ctx, out, at + dt, { f, type: 'triangle', peak: 0.18, attack: 0.003, decay: 0.42 });
      tone(ctx, out, at + dt, { f: f * 2, peak: 0.05, attack: 0.002, decay: 0.12 });
      burst(ctx, out, at + dt, { f: f * 3, q: 4, peak: 0.08, decay: 0.006 });
    }
  },
  knock: (ctx, at, out) => {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.connect(out);
    tone(ctx, lp, at, { f: 174.6, f2: 160, peak: 0.22, decay: 0.12, glide: 0.04 });
    tone(ctx, lp, at + 0.11, { f: 146.8, f2: 130, peak: 0.18, decay: 0.16, glide: 0.05 });
    burst(ctx, lp, at, { type: 'lowpass', f: 500, peak: 0.15, decay: 0.02 });
  },
  bell: (ctx, at, out) => {
    for (const [r, p, d] of [[1, 0.1, 1.3], [2.01, 0.035, 0.7], [3.56, 0.02, 0.35], [5.4, 0.008, 0.2]]) tone(ctx, out, at, { f: 987.77 * r, peak: p, attack: 0.004, decay: d });
  },
};
// one chain for every voice: the level. Each voice is tuned to peak well under 1 on its own (the board measures it), and
// no two play at once, so nothing needs a limiter; Chrome's compressor adds its own make-up gain, which made the
// levels uneven.
export function chain(ctx, level = 0.6) {
  const g = ctx.createGain(); g.gain.value = level; g.connect(ctx.destination);
  return g;
}

