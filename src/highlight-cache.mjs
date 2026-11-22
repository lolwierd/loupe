import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { STATE_DIR } from './config.mjs';
import { highlightKey, langFor, MAX_HIGHLIGHT_LENGTH, tokenize } from './highlight.mjs';
import { single } from './util.mjs';

const directory = path.join(STATE_DIR, 'highlight-v1');
const memoryLimit = 24 * 1024 * 1024, diskLimit = 96 * 1024 * 1024;
const memory = new Map();
const inFlight = single();
let memoryBytes = 0;
const rest = new Map();
let restTimer = null;

function scheduleRest(key, text, file) {
  if (rest.has(key) || memory.has(key)) return;
  if (rest.size >= 8) rest.delete(rest.keys().next().value);
  rest.set(key, { text, file });
  if (restTimer) return;
  restTimer = setTimeout(async () => {
    while (rest.size) {
      const [key, { text, file }] = rest.entries().next().value;
      await highlightJSON(text, file).catch(() => {});
      rest.delete(key);
    }
    restTimer = null;
  }, 3500);
  restTimer.unref();
}

const workers = new Set(), queue = [];
function pump() {
  if (!queue.length) return;
  let slot = [...workers].find((candidate) => !candidate.job);
  if (!slot && workers.size < 2) {
    const worker = new Worker(new URL('./highlight-worker.mjs', import.meta.url));
    slot = { worker, job: null };
    workers.add(slot);
    worker.on('message', ({ json, error }) => {
      const job = slot.job;
      slot.job = null;
      worker.unref();
      if (error) job.reject(new Error(error));
      else job.resolve(json);
      pump();
    });
    const remove = (error) => {
      if (!workers.delete(slot)) return;
      slot.job?.reject(error);
      pump();
    };
    worker.on('error', remove);
    worker.on('exit', (code) => remove(new Error('Highlight worker exited (' + code + ')')));
  }
  if (!slot) return;
  const job = slot.job = queue.shift();
  slot.worker.ref();
  slot.worker.postMessage({ text: job.text, lang: job.lang });
}

function compute(text, lang) {
  return new Promise((resolve, reject) => { queue.push({ text, lang, resolve, reject }); pump(); });
}

export function primeHighlight(file) {
  if (!file || workers.size) return;
  const lang = langFor(file);
  if (lang !== 'text') {
    // Load the two engines and first grammar while the browser is preparing the cards.
    Promise.all([compute('', lang), compute('', lang)]).catch(() => {});
  }
}

let disk, diskBytes = 0, writes = Promise.resolve();
const cacheFile = /^[a-f0-9]{64}(\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?$/;

export function initHighlightCache() {
  return disk ||= openDisk().catch(() => null);
}

async function openDisk() {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const names = (await fs.readdir(directory)).filter((name) => cacheFile.test(name));
  const entries = (await Promise.all(names.map(async (name) => {
    const stat = await fs.lstat(path.join(directory, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat?.isFile()) return [name, stat];
  }))).filter(Boolean).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  diskBytes = entries.reduce((n, [, stat]) => n + stat.size, 0);
  const index = new Map(entries.map(([name, stat]) => [name, stat.size]));
  // a temp file is a write that never finished; one younger than ten minutes may be another loupe's (two on different
  // ports can share a state folder), so it is left for that one to rename
  const old = Date.now() - 10 * 60 * 1000;
  for (const [name, stat] of entries) {
    if (name.includes('.') && stat.mtimeMs < old) await drop(index, name).catch(() => {});
  }
  await prune(index, 0);
  return index;
}

async function drop(index, name) {
  await fs.rm(path.join(directory, name), { force: true });
  diskBytes -= index.get(name);
  index.delete(name);
}

async function prune(index, incoming) {
  // oldest first; one that cannot be removed is passed over, so it never stops the rest from going
  for (const name of [...index.keys()]) {
    if (diskBytes + incoming <= diskLimit) break;
    await drop(index, name).catch(() => {});
  }
}

function persist(index, key, json) {
  const size = Buffer.byteLength(json);
  if (size > diskLimit) return;
  writes = writes.then(async () => {
    if (index.has(key)) return;
    await prune(index, size);
    const temp = key + '.' + randomUUID();
    // Reserve space before writing and keep it reserved if cleanup fails.
    index.set(temp, size);
    diskBytes += size;
    try {
      await fs.writeFile(path.join(directory, temp), json, { mode: 0o600 });
      await fs.rename(path.join(directory, temp), path.join(directory, key));
    } catch (error) {
      await drop(index, temp);
      throw error;
    }
    index.delete(temp);
    index.set(key, size);
  }).catch(() => {});
}

export function highlightJSON(text, file, { through = 0, inline = false } = {}) {
  const lang = langFor(file);
  const whole = text;
  let partial = false;
  if (through > 0 && lang !== 'text' && text.length <= MAX_HIGHLIGHT_LENGTH) {
    let end = -1;
    for (let line = 0; line < through; line++) {
      end = text.indexOf('\n', end + 1);
      if (end < 0) break;
    }
    if (end >= 0) {
      text = text.slice(0, text[end - 1] === '\r' ? end - 1 : end);
      partial = true;
    }
  }
  const key = highlightKey(lang, text);
  const response = (json) => {
    if (!partial) return json;
    // Fill the whole-file viewer's cache after foreground highlight requests have had a chance to finish.
    scheduleRest(highlightKey(lang, whole), whole, file);
    return json.slice(0, -1) + ',"through":' + through + '}';
  };
  const hit = memory.get(key);
  if (hit) {
    memory.delete(key);
    memory.set(key, hit);
    return Promise.resolve(response(hit));
  }
  return inFlight(key, async () => {
    const index = await initHighlightCache();
    let json = index?.has(key) ? await fs.readFile(path.join(directory, key), 'utf8').catch(() => null) : null;
    if (json === null) {
      json = inline ? JSON.stringify(await tokenize(text, lang)) : await compute(text, lang);
      if (index) persist(index, key, json);
    }
    const size = json.length * 2;
    if (size <= memoryLimit) {
      while (memoryBytes + size > memoryLimit) {
        const [oldKey, old] = memory.entries().next().value;
        memory.delete(oldKey);
        memoryBytes -= old.length * 2;
      }
      memory.set(key, json);
      memoryBytes += size;
    }
    return json;
  }).then(response);
}
