import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../apps/web/dist/.vite/manifest.json', import.meta.url), 'utf8'),
);
for (const entry of ['index.html', 'dock/index.html']) {
  assert.equal(manifest[entry]?.isEntry, true, `Missing browser entry: ${entry}`);
}
const overlay = manifest['overlay/index.html'];
assert.ok(overlay?.file.endsWith('.css'), 'Foundation overlay must compile to CSS only');
assert.equal(
  overlay.imports?.length ?? 0,
  0,
  'Foundation overlay must not import console/runtime code',
);
const html = await readFile(
  new URL('../apps/web/dist/overlay/index.html', import.meta.url),
  'utf8',
);
assert.doesNotMatch(html, /<script\b/i, 'Inactive overlay must not ship executable scripts');
console.log('Three browser entries verified; inactive overlay ships no JavaScript.');
