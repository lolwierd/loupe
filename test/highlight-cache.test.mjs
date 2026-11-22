import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('startup removes interrupted writes and counts any remaining temp files against the cap', { timeout: 5000 }, async (t) => {
  const state = await fs.mkdtemp(path.join(tmpdir(), 'loupe-highlight-cache-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  process.env.LOUPE_HOME = state;
  const directory = path.join(state, 'highlight-v1');
  await fs.mkdir(directory);
  const MiB = 1024 * 1024;
  const entry = 'a'.repeat(64);
  const orphan = 'b'.repeat(64) + '.' + randomUUID();
  const stuck = 'c'.repeat(64) + '.' + randomUUID();
  for (const [name, size] of [[entry, 94 * MiB], [orphan, 4 * MiB], [stuck, 2 * MiB]]) {
    const file = await fs.open(path.join(directory, name), 'w');
    await file.truncate(size);
    await file.close();
  }
  // the oldest first: the kept entry, then two writes interrupted long ago
  await fs.utimes(path.join(directory, entry), 1, 1);
  await fs.utimes(path.join(directory, orphan), 2, 2);
  await fs.utimes(path.join(directory, stuck), 3, 3);
  // a write still in progress, perhaps another loupe's on the same state folder: too young to be anyone's leftover
  const young = 'd'.repeat(64) + '.' + randomUUID();
  await fs.writeFile(path.join(directory, young), '');
  await fs.writeFile(path.join(directory, 'unrelated'), '');

  const rm = fs.rm;
  t.mock.method(fs, 'rm', (file, options) => {
    if (file === path.join(directory, stuck)) return Promise.reject(new Error('temp file could not be removed'));
    return rm(file, options);
  });
  const { highlightJSON, initHighlightCache } = await import('../src/highlight-cache.mjs');
  await initHighlightCache();
  assert.deepEqual((await fs.readdir(directory)).sort(), [entry, stuck, young, 'unrelated'].sort());

  const rename = fs.rename;
  const written = Promise.withResolvers();
  t.mock.method(fs, 'rename', async (temp, dest) => {
    try {
      const names = await fs.readdir(directory);
      assert.ok(names.includes(path.basename(temp)));
      assert.ok(names.includes(stuck));
      assert.ok(!names.includes(entry));
      const sizes = await Promise.all(names.map(async (name) => (await fs.stat(path.join(directory, name))).size));
      assert.ok(sizes.reduce((total, size) => total + size, 0) <= 96 * MiB);
      await rename(temp, dest);
      written.resolve(dest);
    } catch (error) {
      written.reject(error);
      throw error;
    }
  });
  const json = await highlightJSON('a'.repeat(MiB), 'file.txt', { inline: true });
  const dest = await written.promise;
  assert.equal(await fs.readFile(dest, 'utf8'), json);
});
