import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function largeFixture(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const write = (file, data) => writeFileSync(join(root, file), data);
  const source = (file, length, edits) => Array.from({ length }, (_, line) =>
    `export const value_${file}_${line} = ${line < edits ? line + 10000 : line}; // fixture value\n`).join('');
  const file = (i) => `src/file-${String(i).padStart(3, '0')}.js`;
  git('init', '-b', 'main');
  git('config', 'user.name', 'Loupe Perf');
  git('config', 'user.email', 'perf@example.invalid');
  for (let i = 0; i < 297; i++) write(file(i), source(i, i < 3 ? 3300 : 26, 0));
  for (const n of [1, 2]) write(`src/rename-${n}.txt`, `Original fixture document ${n}\n`);
  write('src/image.bin', Buffer.from([0, 1, 2, 3]));
  git('add', '.');
  git('commit', '-m', 'Base');
  git('switch', '-c', 'perf-change');
  for (let i = 0; i < 297; i++) write(file(i), source(i, i < 3 ? 3300 : 26, i < 3 ? 1650 : 17));
  for (const n of [1, 2]) git('mv', `src/rename-${n}.txt`, `src/renamed-${n}.txt`);
  write('src/image.bin', Buffer.from([0, 4, 5, 6]));
  git('add', '.');
  git('commit', '-m', 'Large change');
  write(file(296), source(296, 26, 19));
  write('src/untracked.js', 'export const untracked = true;\n');
}
