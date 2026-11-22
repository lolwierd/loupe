// Installed before navigation. Rendering completion is observed after a rendering opportunity.
export function instrument() {
  const perf = window.loupePerf = { lastMutation: 0, first: null, longFrames: [] };
  const afterPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perf.longFrames.push({ start: entry.startTime, duration: entry.duration,
        scripts: entry.scripts.map(({ duration, sourceURL, sourceFunctionName }) => ({ duration, sourceURL, sourceFunctionName })) });
    }
  }).observe({ type: 'long-animation-frame', buffered: true });
  new MutationObserver((records) => {
    if (!records.some(({ target }) => target.nodeType === 1 && target.closest('#cards, #pbody'))) return;
    perf.lastMutation = performance.now();
    const first = perf.first === null && [...document.querySelectorAll('#cards .file:not(.shut)')].find((card) =>
      !card.querySelector('.fb > .empty-diff') &&
      card.querySelector('.fb > .loadd')?.textContent !== 'Binary file: no text diff.');
    if (first && first.querySelector('.fb .ln')) {
      perf.first = -1;
      afterPaint(() => { perf.first = performance.now(); });
    }
  }).observe(document, { childList: true, subtree: true });

  const ready = (done) => {
    const card = perf.card;
    switch (done) {
      case 'palette': return !!document.querySelector('.palette input');
      case 'query': return document.querySelector('.palette input')?.value === 'file';
      case 'chat': return document.querySelector('#ptab-chat')?.getAttribute('aria-selected') === 'true';
      case 'marks': return document.querySelector('#ptab-review')?.getAttribute('aria-selected') === 'true';
      case 'overview': return document.querySelector('#ptab-overview')?.getAttribute('aria-selected') === 'true';
      case 'viewed': return card.querySelector('[data-act="viewed"]')?.getAttribute('aria-pressed') === 'true';
      case 'viewer': return !!document.querySelector('#vbody .ln');
      case 'unified': case 'split': return card.classList.contains('split') === (done === 'split');
    }
  };
  perf.arm = (event, done) => {
    perf.input = new Promise((resolve, reject) => {
      let input, stopped = false;
      const timeout = setTimeout(() => {
        stopped = true;
        removeEventListener(event, start, true);
        reject(new Error(`No paint for ${done}: ${JSON.stringify({
          input, layout: localStorage.getItem('loupe.layout'), card: perf.card?.className,
        })}`));
      }, 5000);
      const start = (e) => {
        if (!e.isTrusted) return;
        input = { type: e.type, key: e.key, target: e.target.tagName };
        removeEventListener(event, start, true);
        const check = () => afterPaint(() => {
          if (stopped) return;
          if (!ready(done)) { check(); return; }
          clearTimeout(timeout);
          resolve(performance.now() - e.timeStamp);
        });
        check();
      };
      addEventListener(event, start, true);
    });
    perf.input.catch(() => {});
  };
}

export async function sweep(speed) {
  const el = document.querySelector('#center');
  const frames = [];
  const start = performance.now();
  let prior = 0, rest = 0;
  await new Promise((resolve) => {
    function frame(now) {
      const elapsed = prior ? now - prior : 0;
      if (prior) frames.push(elapsed);
      prior = now;
      const bottom = el.scrollHeight - el.clientHeight;
      // Leave overlap after a stall so an unloaded card still gets an intersection callback.
      const step = Math.min(speed * elapsed / 1000, el.clientHeight / 2);
      el.scrollTop = Math.min(bottom, el.scrollTop + step);
      // Leave a short window for visible lazy bodies to replace their placeholders at the bottom.
      if (el.scrollTop >= bottom - 1) rest += elapsed;
      else rest = 0;
      if (rest >= 350 && el.scrollTop >= el.scrollHeight - el.clientHeight - 1) resolve();
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  return { frames, start, end: performance.now() };
}

export function status() {
  const cards = [...document.querySelectorAll('#cards .file')];
  const pending = cards.filter((card) => !card.matches('.shut') &&
    [...card.querySelectorAll('.fb > .loadd:not(.empty-diff)')].some((el) => el.textContent === 'Loading…'));
  return {
    count: cards.length, pending: pending.map((card) => card.id),
    errors: cards.filter((card) => card.querySelector('.fb > .err')).map((card) => card.id),
    first: window.loupePerf.first, quiet: performance.now() - window.loupePerf.lastMutation,
  };
}
