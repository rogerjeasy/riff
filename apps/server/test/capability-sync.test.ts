import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CAPABILITIES, RIFF_DTS, SDK_GUIDE } from '@riff/sdk';
import { COMPILE_OUTPUT_JSON_SCHEMA, compileOutputSchema } from '@riff/compiler';
import { createEngine, createPreviewEngine, manifestSchema, verifyCandidate } from '@riff/sandbox';

/** AGENTS §2.1: the d.ts, the sandbox bridge and the compiler validator name one set. */
it('the d.ts, the sandbox bridge and the compiler manifest validator expose the same capabilities', async () => {
  const sdk = [...CAPABILITIES].sort();
  // A dotted capability such as `chat.announce` lives under its leading namespace.
  const namespaces = [...new Set(CAPABILITIES.map((c) => c.split('.')[0]))].sort();

  const riff = RIFF_DTS.slice(RIFF_DTS.indexOf('export interface Riff {'));
  const declared = [...riff.slice(0, riff.indexOf('\n  }')).matchAll(/^\s{4}(\w+): \{/gm)].map(
    (match) => match[1],
  );
  expect(declared.filter((name) => name !== 'util').sort()).toEqual(namespaces);

  const validator =
    COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1].properties.capabilities.items.enum;
  expect([...validator].sort()).toEqual(sdk);

  // The bridge is observed from inside a real isolate: its namespaces are exactly the set.
  const expected = JSON.stringify([...namespaces, 'util'].sort());
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

// AGENTS §2.1: capability names appear in the d.ts, the sandbox bridge and the manifest
// validator, and the three sets must be equal.
it('keeps the d.ts, the sandbox bridge and the manifest validators on one capability set', async () => {
  const sdk = [...CAPABILITIES].sort();
  const schemaManifest = COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1];
  expect([...schemaManifest.properties.capabilities.items.enum].sort()).toEqual(sdk);
  for (const capability of CAPABILITIES) {
    expect(SDK_GUIDE).toContain(`capability \`${capability}\``);
    // Every capability's leading namespace is a member of the declared Riff bridge.
    expect(RIFF_DTS).toMatch(
      new RegExp(`\\n\\s+(?:/\\*\\*[^\\n]*\\n\\s+)?${capability.split('.')[0]}: \\{`),
    );
  }
  // The validator accepts each capability alone (with the policy it requires) and nothing else.
  const accepted = CAPABILITIES.filter(
    (capability) =>
      manifestSchema.safeParse({
        sdkVersion: '0.4.0',
        experience: null,
        capabilities: [capability],
        trigger: { command: '!x', audience: ['broadcaster'], maxPerViewer: 1, windowMs: 60_000 },
        limits: { effectsPerEvent: 1, effectsPerMinute: 1 },
      }).success || capability === 'session',
  );
  expect([...accepted].sort()).toEqual(sdk);
  expect(
    manifestSchema.safeParse({
      sdkVersion: '0.4.0',
      capabilities: ['chat.say'],
      trigger: { command: '!x', audience: ['broadcaster'], maxPerViewer: 1, windowMs: 60_000 },
      limits: { effectsPerEvent: 1, effectsPerMinute: 1 },
    }).success,
  ).toBe(false);
  // The live bridge exposes exactly the namespaces the d.ts declares (plus util).
  const engine = createPreviewEngine(
    {
      source: `async (event, riff) => { const keys = Object.keys(riff).sort().join(','); await riff.chat.announce({ message: keys }); }`,
      manifest: {
        sdkVersion: '0.4.0',
        experience: null,
        capabilities: ['chat.announce'],
        trigger: { command: '!x', audience: ['viewer'], maxPerViewer: 1, windowMs: 60_000 },
        limits: { effectsPerEvent: 1, effectsPerMinute: 1 },
      },
    },
    7,
  );
  const decision = await engine.dispatch({
    id: 'k',
    channelId: 'c',
    viewerId: 'v',
    roles: ['viewer'],
    text: '!x',
    at: 0,
  });
  engine.stop();
  const bridge = decision.actions?.[0]?.kind === 'announce' ? decision.actions[0].message : '';
  const namespaces = [...new Set(CAPABILITIES.map((c) => c.split('.')[0]))];
  expect(bridge.split(',')).toEqual([...namespaces, 'util'].sort());
});

it('every recorded native-action compiler output passes the sandbox pipeline', async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../packages/compiler/fixtures/twitch-actions.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: { output: unknown }[] };
  for (const recorded of fixture.cases) {
    const output = compileOutputSchema.parse(recorded.output);
    const report = await verifyCandidate({
      source: output.source ?? '',
      manifest: output.manifest,
      tests: output.tests,
    });
    expect(report.failureReport).toBeNull();
    expect(report.ok).toBe(true);
  }
}, 60_000);
