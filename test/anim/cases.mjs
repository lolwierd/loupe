// Runs in the review page. Fixtures use the production CSS and exported painters.
export async function motionCases(checkResize = false) {
  const load = (name) => import('/web/js/' + name + '.js');
  const [{ S, toast }, { hooks }, { flashLines, isViewed, setViewed }, { flipCommitId }, { openSheet, closeSheet },
    { decorateState, endOpening }, { meter }, { menu, closeMenu }] = await Promise.all(
    ['core', 'hooks', 'cards', 'receipt', 'sheets', 'press', 'meter', 'ui'].map(load));
  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const next = () => new Promise(requestAnimationFrame);
  const append = (html, parent = document.body) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    return parent.appendChild(box.firstElementChild);
  };
  const raster = document.createElement('canvas');
  raster.width = 48;
  raster.height = 24;
  const ctx = raster.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const numbers = (value, size) => {
    const entries = value.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    return Array.from({ length: size }, (_, i) => entries[i] ?? 0);
  };
  const matrix = (style) => {
    const { m11, m12, m21, m22, m42 } = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
    return [m11, m12, m21, m22, m42];
  };
  function sample(selector, pixels, pseudo) {
    const node = typeof selector === 'function' ? selector() : typeof selector === 'string' ? $(selector) : selector;
    if (!node?.isConnected) return null;
    const { x, y, width, height } = node.getBoundingClientRect();
    if (!width || !height) return null;
    if (node.parentElement?.matches('.launch')) {
      const clip = node.parentElement.getBoundingClientRect();
      if (y >= clip.bottom || y + height <= clip.top || x >= clip.right || x + width <= clip.left) return null;
    }
    const layer = pseudo && getComputedStyle(node, pseudo);
    const style = layer && layer.animationName !== 'none' ? layer : getComputedStyle(node);
    const v = [x, y, width, height, +style.opacity];
    for (const key of ['backgroundColor', 'color', 'borderTopColor']) {
      const channels = numbers(style[key], 4);
      const alpha = style[key].startsWith('rgb(') || (style[key].startsWith('color(') && !style[key].includes('/')) ? 1 : channels[3];
      const scale = style[key].startsWith('color(') ? 255 : 1;
      v.push(...channels.slice(0, 3).map((n) => n * alpha * scale), alpha * 255);
    }
    v.push(...numbers(style.backgroundPosition, 2), ...numbers(style.boxShadow, 48));
    if (pseudo) v.push(...matrix(style));
    if (pixels && node.width && node.height) {
      const { width: w, height: h } = raster;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(node, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      for (let x = 0; x < w; x += 2) {
        let brightness = 0, coverage = 0;
        for (let y = 0; y < h; y++) for (let dx = 0; dx < 2; dx++) {
          const i = 4 * (y * w + x + dx);
          brightness += rgba[i + 3] * (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 765;
          coverage += rgba[i + 3];
        }
        v.push(brightness, coverage);
      }
    }
    if (node.matches('.flap')) {
      v.push((node.firstChild?.textContent || '').charCodeAt(0) || 0);
      for (const leaf of ['.old-top', '.new-bottom']) {
        const el = node.querySelector(leaf);
        v.push(...(el ? matrix(getComputedStyle(el)) : [0, 0, 0, 0, 0]));
      }
    }
    if (node.classList.contains('scroll-probe')) v.push(node.scrollTop);
    if (node.dataset.plate !== undefined) { // a plate developing: where its screen's threshold stands
      const id = /#([\w-]+)/.exec(node.style.filter)?.[1], dev = id && document.getElementById(id)?.querySelector('.dev');
      v.push(Number(dev?.getAttribute('values').trim().split(/\s+/).pop()) || 0);
    }
    return v;
  }
  const results = {};
  async function play(name, duration, action, selector, { pixels = false, pseudo, from = 0, until = duration, dwell = [] } = {}) {
    const samples = [];
    const start = await next();
    samples.push({ t: 0, v: sample(selector, pixels, pseudo) });
    action();
    for (let t = 0; t < duration;) {
      const frame = await next();
      t = frame - start;
      samples.push({ t, v: sample(selector, pixels, pseudo) });
    }
    if (!samples.some((f) => f.v)) throw new Error('Missing animation target: ' + name);
    results[name] = { samples, from, until, dwell };
  }

  const fixture = append('<div id="motion-fixture" style="position:fixed;z-index:95;left:15px;bottom:15px"></div>');
  const node = (html) => append(html, fixture);
  await play('Stamp touchdown', 170, () => hooks.stamp({ head: '7654321', at: Date.now() }), '.impress', { pixels: true });
  await play('Stamp lift', 1700, () => {}, '.impress', { pixels: true, from: 1250 });
  const file = S.files.find((f) => !isViewed(f));
  if (!file) throw new Error('The demo needs an unviewed file');
  const viewed = '[data-p="' + CSS.escape(file.path) + '"] .viewedbox';
  const other = S.files.find((f) => f !== file && !isViewed(f));
  if (!other) await setViewed(S.files.find((f) => f !== file).path, false);
  await wait(250);
  await play('Viewed check fade', 220, () => setViewed(file.path, true), viewed + ' .box canvas');
  await setViewed(file.path, false);
  await wait(250);
  await play('Viewed checkbox tint', 220, () => setViewed(file.path, true), viewed + ' .box');
  await setViewed(file.path, false);
  await wait(500);
  await play('Tally odometer', 260, () => setViewed(file.path, true), '#tally .odo .roll');
  await setViewed(file.path, false);
  await wait(500);
  await play('Viewed hop', 350, () => hooks.mote.viewed(), '#motedock .mote');
  await play('Viewed check rise', 700, () => hooks.mote.viewed(), '#motedock .motecheck');
  const goRoll = node('<span><span class="rollbox"><span class="roll"><span>Commit</span><span>Push</span></span></span></span>');
  goRoll.id = 'go';
  goRoll.firstElementChild.hidden = true;
  await play('Next action roll', 230, () => { goRoll.firstElementChild.hidden = false; }, '#motion-fixture #go .roll');
  goRoll.remove();
  await play('Receipt flip', 230, () => { toast('Committed fbcdef0'); flipCommitId('0bcdef0'); }, '#toast .flap');
  await play('Toast entrance', 220, () => { $('#toast').hidden = true; void $('#toast').offsetWidth; toast('File viewed'); }, '#toast');
  const row = $('#cards .fb .ln[data-k]');
  const card = row.closest('.fb');
  const side = row.dataset.side || 'new';
  await play('Mark flash', 1650, () => {
    flashLines(card.dataset.p, side, [Number(row.dataset.k)]);
    // Context rows in unified diffs may not have a side. Trigger the same rule if the fixture has no matching line.
    if (!$('#cards .ln.flash')) row.classList.add('flash');
  }, () => [...document.querySelectorAll('#cards .ln.flash .cd')].find((cell) =>
    getComputedStyle(cell).animationName === 'flash' || getComputedStyle(cell, '::after').animationName === 'flash'
  ), { pseudo: '::after' });
  const button = node('<button class="btn">Press</button>');
  await play('Button press and release', 240, () => { button.classList.add('struck'); setTimeout(() => button.classList.remove('struck'), 85); }, button);
  const glyph = node('<button class="icon"><svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg></button>');
  await play('Icon press and release', 240, () => {
    glyph.classList.add('struck');
    setTimeout(() => glyph.classList.remove('struck'), 85);
  }, glyph.firstElementChild);
  const segment = node('<div class="seg"><button>Split</button></div>').firstElementChild;
  await play('Segment selection', 170, () => segment.setAttribute('aria-pressed', 'true'), segment);
  const fold = node('<div class="trow dir"><svg class="chev" viewBox="0 0 16 16"><path d="M3 6l5 5 5-5"/></svg></div>');
  await play('Fold chevron', 170, () => fold.classList.add('shut'), fold.firstElementChild);
  const avatar = node('<canvas class="avatar" style="width:20px;height:20px"></canvas>');
  await play('Avatar fade', 170, () => avatar.classList.add('in'), avatar);
  const scroll = node('<div class="scroll-probe" style="height:32px;overflow:auto"><div style="height:732px"></div></div>');
  await play('Native smooth scroll', 540, () => scroll.scrollTo({ top: 650, behavior: 'smooth' }), scroll);
  const key = node('<kbd>V</kbd>');
  await play('Keyboard key press', 240, () => { key.classList.add('struck'); setTimeout(() => key.classList.remove('struck'), 85); }, key);
  await play('Menu entrance', 210, () => menu(button, [{ label: 'Motion' }], () => {}), '.menu');
  const menuRow = $('.menu .mi');
  await play('Menu row focus', 170, () => menuRow.setAttribute('aria-selected', 'true'), menuRow);
  closeMenu();
  await play('Palette entrance', 210, () => $('[data-act="palette"]').click(), '.palette');
  $('.palette input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await play('Write sheet', 220, () => openSheet('commit'), '.sheet');
  closeSheet();
  await play('Dialog plate', 210, () => openSheet('commit'), '[data-plate]');
  const send = $('.sheet [data-sh="go"]');
  send.querySelector(".gl").innerHTML = '<span class="launch"><canvas></canvas></span>Sending…';
  await play('Sending launch', 480, () => send.classList.add('sending'), '.sheet [data-sh="go"] .launch canvas');
  send.classList.remove('sending');
  await play('Failed send shake', 280, () => send.classList.add('failed'), send);
  const box = $('.sheet .box');
  await play('Drafted field', 730, () => box.classList.add('drafted'), box);
  closeSheet();
  const shimmer = node('<span class="shimmer" hidden>Thinking</span>');
  await play('Working shimmer', 1900, () => { shimmer.hidden = false; }, shimmer);
  const spark = node('<canvas class="spark" width="16" height="16"></canvas>');
  await play('Working spark', 800, () => {}, spark, { pixels: true });
  spark.classList.add('still');
  document.dispatchEvent(new Event('spark-wake'));
  await play('Spark landing', 400, () => spark.classList.add('landed'), spark);
  const note = node('<div>File note</div>');
  await play('File note fade', 160, () => note.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' }), note);

  const host = node('<span class="meter" style="display:block;width:300px;height:28px"></span>');
  const board = meter(host);
  const segs = [{ path: 'a', w: 4, state: 'left', read: 0 }, { path: 'b', w: 6, state: 'left', read: 0.5 }];
  const target = host.firstElementChild;
  await play('Meter opening', 700, () => board.update(segs, { opening: true }), target, { pixels: true });
  await wait(350);
  await play('Meter hover lamps', 620, () => host.dispatchEvent(new MouseEvent('mousemove', { clientX: target.getBoundingClientRect().x + 10 })), target, { pixels: true });
  host.dispatchEvent(new MouseEvent('mouseleave'));
  await wait(650);
  await play('Meter viewed burn and sparks', 740, () => board.update([{ ...segs[0], state: 'done' }, segs[1]]), target, { pixels: true });
  await wait(600);
  await play('Meter all-viewed glint', 780, () => board.glint(), target, { pixels: true });
  board.destroy();

  const dock = $('#motedock');
  const mote = dock.querySelector('.mote');
  // The sheet's background-position changes describe the selected drawing, not spatial motion.
  await play('Mote animation cels', 800, () => hooks.mote.acted(true), mote);
  await play('Mote shuffle', 1060, () => dock.classList.add('shuffle'), mote);
  dock.classList.remove('shuffle');
  for (const [label, kind, ms] of [['Mote rising note', 'note', 1400], ['Mote glint prop', 'glint', 700], ['Mote sleep prop', 'z', 1800]]) {
    const prop = append('<i class="moteprop ' + kind + '" hidden></i>', dock);
    prop.style.setProperty('--ms', ms + 'ms');
    await play(label, ms + 30, () => { prop.hidden = false; }, prop);
    prop.remove();
  }
  hooks.mote.progress(false, 0.9);
  await wait(400);
  await play('Mote lens gathers', 400, () => hooks.mote.progress(false, 0.15), '.motelight', { pixels: true });
  await play('Mote lens completion glint', 1600, () => hooks.mote.progress(true, 0), '.motelight', { pixels: true, dwell: [[280, 1050]] });
  await play('Mote flight out', 1450, () => hooks.mote.away(true), dock, { from: 400 });
  await play('Mote flight in', 1500, () => hooks.mote.away(false), dock, { until: 920 });
  await wait(300);
  // Give the real pointer handlers the fast last moves used to calculate a throw.
  mote.setPointerCapture = () => {};
  const ev = (type, x, y) => mote.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
  const toss = () => {
    const { left, top } = dock.getBoundingClientRect();
    ev('pointerdown', left + 10, top + 10);
    ev('pointermove', left - 12, top - 5);
    ev('pointermove', left - 26, top - 12);
    ev('pointerup', left - 63, top - 36);
  };
  const glide = [], landing = [], righting = [];
  const throwStart = await next();
  toss();
  for (let t = 0; t < 2800;) {
    t = (await next()) - throwStart;
    if (dock.classList.contains('rock')) righting.push({ t, v: sample(mote) });
    else if (dock.classList.contains('onback')) {
      if (t - (landing[0]?.t ?? t) <= 200) landing.push({ t, v: sample(mote) });
    } else if (!landing.length) glide.push({ t, v: sample(dock) });
    else break;
  }
  if (!glide.length || !landing.length || !righting.length || dock.matches('.onback, .rock')) {
    throw new Error('Mote did not land, rock, and get back up after a throw');
  }
  results['Mote throw glide'] = { samples: glide };
  results['Mote landing tumble'] = { samples: landing };
  results['Mote rock and righting'] = { samples: [...righting, { t: performance.now() - throwStart, v: sample(mote) }] };
  const { left, top } = dock.getBoundingClientRect();
  ev('pointerdown', left + 10, top + 10);
  ev('pointermove', left + 27, top + 10);
  ev('pointerup', left + 27, top + 10);
  if (dock.getBoundingClientRect().left <= left) throw new Error('Mote cannot be dragged after righting');

  if (checkResize) {
    toss();
    await next();
    await next();
    const before = dock.getBoundingClientRect();
    if (!dock.style.transform) throw new Error('Mote was not gliding before resize');
    // Even without changing the viewport bounds, resize used to restore the stale saved dock position.
    window.dispatchEvent(new Event('resize'));
    const after = dock.getBoundingClientRect();
    if (after.left !== before.left || after.top !== before.top || dock.style.transform || !dock.classList.contains('onback')) {
      throw new Error('Resize did not land Mote at the current glide position');
    }
    // let him get back up before the next case, so his tumble is not timed into the brayer's samples
    const settle = performance.now();
    while (dock.matches('.onback, .rock') && performance.now() - settle < 4000) await next();
  }

  const state = node('<div class="state" style="width:550px"><div class="box"></div></div>');
  await play('Opening brayer', 2500, () => decorateState(state, { m: { rec: { pr: { additions: 1200, deletions: 300 } } } }),
    '.forme canvas', { pixels: true, from: 150, until: 2400 });
  await endOpening();
  fixture.remove();
  return results;
}

export async function themeCase(dark, source, checkMask = false) {
  const label = source === 'system' ? 'System' : dark ? 'Dark' : 'Light';
  const root = document.documentElement;
  const start = performance.now();
  const toggle = document.querySelector('[data-act="theme"]');
  const inputSelector = '.palette input';
  if (source === 'menu' || source === 'system' || source === 'no-canvas') {
    toggle.click();
    const row = [...document.querySelectorAll('.menu .mi')].find((el) => el.querySelector('.ml')?.textContent === label);
    if (source === 'no-canvas') {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, options) {
        return type === '2d' && options?.willReadFrequently ? null : getContext.call(this, type, options);
      };
      try {
        row.click();
        if (root.dataset.theme !== (dark ? 'dark' : 'light') || root.classList.contains('theme-wave') ||
            root.style.getPropertyValue('--theme-mask')) throw new Error('Theme did not switch immediately without a mask canvas');
      } finally {
        HTMLCanvasElement.prototype.getContext = getContext;
      }
    } else row.click();
  } else if (source === 'palette') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    const input = document.querySelector(inputSelector);
    input.value = 'Theme: ' + label.toLowerCase();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  const samples = [];
  const masks = new Set();
  let wave = 0, origin = null, ended = false, began = null;
  // up to 2 s for the snapshot to be taken and the wave to begin, then 950 ms from its first frame (it runs 720)
  while (began === null ? performance.now() - start < 2000 : performance.now() - began < 950) {
    const t = (await new Promise(requestAnimationFrame)) - start;
    const radius = root.style.getPropertyValue('--theme-radius');
    if (checkMask) {
      if (radius) {
        const mask = root.style.getPropertyValue('--theme-mask');
        const layer = getComputedStyle(root, '::view-transition-new(root)');
        const underneath = getComputedStyle(root, '::view-transition-old(root)');
        const snapshot = document.getAnimations().some((animation) => animation.animationName === 'theme-snapshot');
        if (ended || !mask.startsWith('url("data:image/png;base64,') || layer.maskImage !== mask ||
            layer.animationName !== 'none' || layer.opacity !== '1' ||
            underneath.animationName !== 'none' || underneath.opacity !== '1' || !snapshot) {
          throw new Error('The theme wave lost its masked snapshot');
        }
        masks.add(mask);
      } else if (wave) ended = true;
    }
    if (radius) {
      began ??= performance.now();
      wave++;
      origin ||= root.style.getPropertyValue('--theme-origin');
    }
    samples.push({ t, v: radius ? [parseFloat(radius)] : null, wave: !!radius });
  }
  if (checkMask) {
    // Decode after recording so image readback doesn't affect the frame timings.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const coverage = [];
    for (const mask of masks) {
      const image = new Image();
      image.src = mask.slice(5, -2);
      await image.decode();
      canvas.width = image.width;
      canvas.height = image.height;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let covered = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) covered++;
      coverage.push(covered / (pixels.length / 4));
    }
    if (!ended || coverage[0] !== 0 || !coverage.some((n) => n > 0.1 && n < 0.9) || coverage.at(-1) < 0.99 ||
        coverage.some((n, i) => i > 0 && n < coverage[i - 1])) {
      throw new Error('Theme mask did not progressively reveal the page');
    }
  }
  const active = samples.filter((f) => f.wave);
  const frameTimes = active.slice(1).map(({ t }, i) => +((t - active[i].t).toFixed(2)));
  const duration = active.length ? +(active.at(-1).t - active[0].t).toFixed(2) : 0;
  const theme = getComputedStyle(root).colorScheme === 'dark' ? 'dark' : 'light';
  return { samples, from: active[0]?.t, until: active.at(-1)?.t, wave, origin, theme, duration, frameTimes };
}

export async function reducedCases() {
  const [{ S, toast }, { hooks }, { flipCommitId }, { isViewed, setViewed }, { openSheet, closeSheet }] = await Promise.all(
    ['core', 'hooks', 'receipt', 'cards', 'sheets'].map((name) => import('/web/js/' + name + '.js')));
  const $ = (s) => document.querySelector(s);
  toast('Committed fbcdef0');
  flipCommitId('0bcdef0');
  hooks.stamp({ head: '7654321', at: Date.now() });
  const receipt = !$('#toast .flap') && $('#toast').textContent.includes('fbcdef0');
  const stamp = !$('.impress');
  const toastStill = getComputedStyle($('#toast')).animationName === 'none';
  hooks.mote.away(true);
  const fliesOutInstantly = $('#motedock').classList.contains('away') && !$('.moteflight');
  hooks.mote.away(false);
  const fliesInInstantly = !$('#motedock').classList.contains('away') && !$('.moteflight');
  hooks.mote.viewed();
  const moteCheck = !$('.motecheck');
  const files = S.files.filter((f) => f.kind !== 'generated');
  if (files.filter((f) => !isViewed(f)).length < 2) await setViewed(files.find(isViewed).path, false);
  await setViewed(files.find((f) => !isViewed(f)).path, true);
  const tally = !$('#tally .roll');
  openSheet('commit');
  const sheet = getComputedStyle($('.sheet')).animationName === 'none';
  closeSheet();
  return { receipt, stamp, toast: toastStill, fliesOutInstantly, fliesInInstantly, moteCheck, tally, sheet };
}
