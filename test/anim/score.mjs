const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
const round = (x) => Math.round(x * 100) / 100;

export function score({ samples, until = Infinity, from = 0, dwell = [] }) {
  const frames = samples.filter(({ t }) => t >= from && t <= until);
  // An interval that begins inside the window can miss the deadline by crossing its end.
  const times = samples.slice(1).flatMap((f, i) => {
    const prev = samples[i].t;
    return prev >= from && prev < until ? [f.t - prev] : [];
  });
  const measured = frames.filter((f) => f.v?.length);
  const ranges = measured[0]?.v.map((_, i) => {
    const values = measured.map(({ v }) => v[i]);
    return Math.max(0.1, Math.max(...values) - Math.min(...values));
  }) ?? [];
  const delta = measured.slice(1).map((f, i) => ({
    v: f.v.map((x, j) => (x - measured[i].v[j]) / ranges[j]),
    dt: f.t - measured[i].t,
    dwell: dwell.some(([lo, hi]) => measured[i].t >= lo && f.t <= hi),
  }));
  const norm = (values) => Math.hypot(...values);
  const moving = delta.map(({ v }) => norm(v) > 0.001);
  const first = moving.indexOf(true), last = moving.lastIndexOf(true);
  const motion = first < 0 ? [] : delta.slice(first, last + 1);
  const velocity = motion.map(({ v, dt }) => v.map((x) => x * 16.667 / Math.max(1, dt)));
  // Include the acceleration from rest and back to rest. This also gives single-frame jumps a score.
  const zero = ranges.map(() => 0);
  const stops = [zero, ...velocity, zero];
  const jerk = stops.slice(1).map((v, i) => norm(v.map((x, j) => x - stops[i][j])));
  const sorted = [...times].sort((a, b) => a - b);
  return { samples: frames.length, changed: moving.filter(Boolean).length,
    holds: motion.filter(({ dwell }, i) => !dwell && !moving[first + i]).length,
    jerk: round(Math.sqrt(jerk.reduce((n, x) => n + x * x, 0) / jerk.length) * 100),
    over167: times.filter((ms) => ms > 16.70001).length, missed: times.filter((ms) => ms > 25).length,
    p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted.at(-1) ?? 0) };
}
