import { reducedMotion } from './core.js';
import { BAYER4 } from './dither.js';

const DURATION = 720, CELL = 3, RIM = 48;
const root = document.documentElement;
const scheme = matchMedia('(prefers-color-scheme: dark)');
export const systemTheme = () => scheme.matches ? 'dark' : 'light';

export function themeOrigin(element) {
  if (!element?.isConnected) return null;
  const { left, top, width, height } = element.getBoundingClientRect();
  return width && height ? [left + width / 2, top + height / 2] : null;
}

function radialMask(x, y, width, height) {
  const canvas = document.createElement('canvas');
  const w = canvas.width = Math.ceil(width / CELL), h = canvas.height = Math.ceil(height / CELL);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const image = ctx.createImageData(w, h), pixels = new Uint32Array(image.data.buffer);
  const thresholds = new Float32Array(w * h);
  for (let row = 0, i = 0; row < h; row++) {
    const dy = (row + 0.5) * CELL - y;
    for (let col = 0; col < w; col++, i++) {
      const dx = (col + 0.5) * CELL - x;
      const rank = BAYER4[(row & 3) * 4 + (col & 3)];
      thresholds[i] = Math.sqrt(dx * dx + dy * dy) + (rank - 7.5) * RIM / 16;
    }
  }
  return (radius) => {
    for (let i = 0; i < pixels.length; i++) pixels[i] = thresholds[i] <= radius ? 0xff000000 : 0;
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL();
    if (url === 'data:,') throw new Error('Theme mask canvas could not be encoded');
    return `url("${url}")`;
  };
}

let active;
export function animateTheme(update, origin, instant = false) {
  active?.finish();
  if (instant || reducedMotion() || document.hidden || !document.startViewTransition) {
    update();
    return;
  }

  const width = innerWidth, height = innerHeight;
  const [x, y] = origin || [width / 2, height / 2];
  const distance = Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + RIM;
  let mask, initialMask;
  try {
    mask = radialMask(x, y, width, height);
    initialMask = mask?.(-RIM / 2);
  } catch {
    // Canvas allocation or encoding can fail on large viewports.
  }
  if (!initialMask) {
    update();
    return;
  }

  let raf;
  root.style.setProperty('--theme-mask', initialMask);
  root.classList.add('theme-wave');
  // Keep the old choices through the old capture, including when the OS changes its media query first.
  const transition = document.startViewTransition(() => {
    if (active?.transition !== transition) return;
    root.classList.add('theme-capture');
    update();
  });
  const clean = () => {
    cancelAnimationFrame(raf);
    if (active?.transition !== transition) return;
    active = null;
    root.classList.remove('theme-wave', 'theme-capture');
    root.style.removeProperty('--theme-mask');
    root.style.removeProperty('--theme-radius');
    root.style.removeProperty('--theme-origin');
  };
  active = { transition, finish() { transition.skipTransition(); clean(); } };
  transition.ready.then(() => {
    if (active?.transition !== transition) return;
    root.classList.remove('theme-capture');
    let start;
    root.style.setProperty('--theme-origin', `${x}px ${y}px`);
    const draw = (now) => {
      if (active?.transition !== transition) return;
      start ??= now;
      const t = (now - start) / DURATION;
      if (t >= 1 || reducedMotion() || document.hidden || innerWidth !== width || innerHeight !== height) {
        active.finish();
        return;
      }
      const eased = t * t * (3 - 2 * t);
      const radius = -RIM / 2 + distance * eased;
      try {
        root.style.setProperty('--theme-mask', mask(radius));
      } catch {
        active.finish();
        return;
      }
      root.style.setProperty('--theme-radius', radius + 'px');
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
  }).catch(() => {});
  transition.finished.then(clean, clean);
}
