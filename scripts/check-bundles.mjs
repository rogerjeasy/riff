import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../apps/web/dist/.vite/manifest.json', import.meta.url), 'utf8'),
);
for (const entry of ['index.html', 'dock/index.html', 'overlay/index.html'])
  assert.equal(manifest[entry]?.isEntry, true, `Missing browser entry: ${entry}`);

// The overlay is a separate, read-only entry: it must not pull in console code.
const seen = new Set();
const walk = (key) => {
  if (seen.has(key)) return;
  seen.add(key);
  for (const next of manifest[key]?.imports ?? []) walk(next);
};
walk('overlay/index.html');
const overlayChunks = [...seen].map((key) => manifest[key]?.file).filter(Boolean);
for (const file of overlayChunks) {
  const code = await readFile(new URL(`../apps/web/dist/${file}`, import.meta.url), 'utf8');
  for (const marker of ['Approve v', 'Stop everything', '/api/compile-runs', 'x-riff-request'])
    assert.ok(!code.includes(marker), `Overlay bundle ${file} contains console code (${marker})`);
}
console.log(
  `Three browser entries verified; overlay ships ${overlayChunks.length} chunk(s) with no console code.`,
);
