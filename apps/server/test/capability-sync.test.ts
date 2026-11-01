import { expect, it } from 'vitest';
import { COMPILE_OUTPUT_JSON_SCHEMA } from '@riff/compiler';
import { createEngine } from '@riff/sandbox';
import { CAPABILITIES, RIFF_DTS, SDK_GUIDE } from '@riff/sdk';

/** AGENTS §2.1: the d.ts, the sandbox bridge and the compiler validator name one set. */
it('the d.ts, the sandbox bridge and the compiler manifest validator expose the same capabilities', async () => {
  const sdk = [...CAPABILITIES].sort();

  const riff = RIFF_DTS.slice(RIFF_DTS.indexOf('export interface Riff {'));
  const declared = [...riff.slice(0, riff.indexOf('\n  }')).matchAll(/^\s{4}(\w+): \{/gm)].map(
    (match) => match[1],
  );
  expect(declared.filter((name) => name !== 'util').sort()).toEqual(sdk);

  const validator =
    COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1].properties.capabilities.items.enum;
  expect([...validator].sort()).toEqual(sdk);

  // The bridge is observed from inside a real isolate: its namespaces are exactly the set.
  const expected = JSON.stringify([...sdk, 'util'].sort());
  const engine = createEngine(
    {
      source: `async (event, riff) => {
        if (JSON.stringify(Object.keys(riff).sort()) !== '${expected}') throw new Error('mismatch');
        await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: 0.5 });
        await riff.timer.cancel('none');
      }`,
      manifest: {
        sdkVersion: '0.4.0',
        capabilities: ['overlay', 'timer'],
        trigger: { command: '!sync', audience: ['viewer'], maxPerViewer: 1, windowMs: 60_000 },
        limits: { effectsPerEvent: 1, effectsPerMinute: 10 },
      },
    },
    { seed: 1 },
  );
  try {
    const decision = await engine.dispatch({
      id: 'sync',
      channelId: 'c',
      viewerId: 'v',
      roles: ['viewer'],
      text: '!sync',
      at: 0,
    });
    expect(decision.code).toBe('ACCEPTED');
  } finally {
    engine.stop();
  }
  for (const capability of sdk) expect(SDK_GUIDE).toContain(`capability \`${capability}\``);
});
