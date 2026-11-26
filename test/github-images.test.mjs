// Images from outside GitHub, shown through GitHub's image proxy: which ones a PR's text has, and their proxy
// addresses as GitHub's rendered HTML gives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOUPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-images-'));
const { outsideImages, proxiedImages, GITHUB_IMAGE } = await import('../src/github.mjs');

test('outside images: markdown and HTML images and picture sources not on GitHub, entities read', () => {
  const text = [
    '![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/x)',
    '<img src="https://vercel.com/api/www/avatar?projectId=p&amp;s=32" width="16" alt="" />',
    '<source media="(prefers-color-scheme: dark)" srcset="https://agents.vercel.sh/dark.svg">',
    '![shot](https://github.com/user-attachments/assets/abc) <img src="https://avatars.githubusercontent.com/u/1">',
    '[a link, not an image](https://example.com/page.png)',
  ].join('\n');
  assert.deepEqual([...outsideImages([text, null])], [
    'https://vercel.com/static/status/ready.svg',
    'https://vercel.com/api/www/avatar?projectId=p&s=32',
    'https://agents.vercel.sh/dark.svg',
  ]);
});

test('the hosts the page may load images from are exactly its img-src', () => {
  for (const u of ['https://github.com/a.png', 'https://camo.githubusercontent.com/x/y', 'https://private-user-images.githubusercontent.com/1']) assert.match(u, GITHUB_IMAGE);
  for (const u of ['https://gist.github.com/a.png', 'https://githubusercontent.com/a', 'https://github.com.evil.dev/a', 'http://github.com/a']) assert.doesNotMatch(u, GITHUB_IMAGE);
});

test('proxied images: each written address paired with its camo address, from img and source tags', () => {
  const html = '<img src="https://camo.githubusercontent.com/aa/11" alt="Ready" data-canonical-src="https://vercel.com/static/status/ready.svg" style="max-width: 100%;">' +
    '<picture><source media="(prefers-color-scheme: dark)" srcset="https://camo.githubusercontent.com/bb/22" data-canonical-src="https://agents.vercel.sh/dark.svg">' +
    '<img src="https://camo.githubusercontent.com/cc/33" width="16" data-canonical-src="https://vercel.com/api/www/avatar?projectId=p&amp;s=32"></picture>' +
    '<img src="https://github.com/user-attachments/assets/abc" alt="not proxied">';
  assert.deepEqual(proxiedImages(html), {
    'https://vercel.com/static/status/ready.svg': 'https://camo.githubusercontent.com/aa/11',
    'https://agents.vercel.sh/dark.svg': 'https://camo.githubusercontent.com/bb/22',
    'https://vercel.com/api/www/avatar?projectId=p&s=32': 'https://camo.githubusercontent.com/cc/33',
  });
});
