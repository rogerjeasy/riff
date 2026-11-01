import { describe, expect, it } from 'vitest';
import {
  artifactIdentity,
  createEngine,
  createRehearsalPreset,
  runRehearsal,
  eventSchema,
  hostScenarios,
  manifestSchema,
  syntheticTwitchEvent,
  verifyCandidate,
} from '@riff/sandbox';
import { EXAMPLES, eventTriggerCommand } from '@riff/sdk';

const cheerManifest = {
  sdkVersion: '0.4.0' as const,
  experience: null,
  capabilities: ['overlay' as const],
  trigger: {
    command: '@cheer',
    audience: ['viewer' as const],
    maxPerViewer: 3,
    windowMs: 60_000,
    event: { kind: 'cheer' as const, minimum: 100 },
  },
  limits: { effectsPerEvent: 3, effectsPerMinute: 90 },
};
// Bits decide how many stars rain: one per 100 bits, at most three.
const source = `async (event, riff) => {
  const n = Math.min(3, Math.max(1, Math.floor(event.twitch.amount / 100)));
  for (let i = 0; i < n; i++) await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: riff.util.random() });
}`;
const artifact = { source, manifest: cheerManifest };
const chat = (id: string, at: number, text: string) => ({
  id,
  channelId: 'c1',
  viewerId: 'alice',
  roles: ['viewer'],
  text,
  at,
});
const cheer = (id: string, at: number, bits: number, viewerId = 'alice', anonymous = false) => ({
  ...chat(id, at, ''),
  viewerId,
  twitch: syntheticTwitchEvent('cheer', bits, { anonymous }),
});

describe('F19 manifest contract', () => {
  it('accepts a reserved event command bound to its event kind', () => {
    expect(manifestSchema.safeParse(cheerManifest).success).toBe(true);
    expect(eventTriggerCommand('raid')).toBe('@raid');
  });

  it('rejects a mismatched reserved command, sessions and restricted audiences', () => {
    const bad = (edit: (m: Record<string, unknown> & typeof cheerManifest) => void) => {
      const copy = structuredClone(cheerManifest) as Record<string, unknown> & typeof cheerManifest;
      edit(copy);
      return manifestSchema.safeParse(copy).success;
    };
    expect(bad((m) => (m.trigger.command = '@raid'))).toBe(false);
    expect(bad((m) => (m.trigger.command = '!cheer'))).toBe(false);
    expect(bad((m) => ((m.trigger as { audience: string[] }).audience = ['subscriber']))).toBe(
      false,
    );
    expect(
      bad((m) => {
        m.trigger.event = { kind: 'subscribe' as 'cheer', minimum: 5 };
        m.trigger.command = '@subscribe';
      }),
    ).toBe(false);
    expect(bad((m) => ((m.trigger.event as { minimum: number }).minimum = 0))).toBe(false);
  });

  it('never lets a chat trigger claim a reserved @event command', () => {
    const manifest = structuredClone(cheerManifest) as Record<string, unknown> & {
      trigger: Record<string, unknown>;
    };
    delete manifest.trigger.event;
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('keeps legacy artifact identity unchanged when no event trigger is declared', () => {
    const example = EXAMPLES[0]!;
    const before = artifactIdentity({ source: example.source, manifest: example.manifest });
    expect(
      artifactIdentity({
        source: example.source,
        manifest: { ...example.manifest, trigger: { ...example.manifest.trigger } },
      }),
    ).toBe(before);
  });

  it('validates normalized detail consistency', () => {
    const base = chat('x', 0, '');
    expect(
      eventSchema.safeParse({
        ...base,
        twitch: { kind: 'raid', amount: 5, tier: '1000', anonymous: false, gift: false },
      }).success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({
        ...base,
        twitch: { kind: 'raid', amount: 5, tier: null, anonymous: true, gift: false },
      }).success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({
        ...base,
        twitch: syntheticTwitchEvent('gift', 5, { anonymous: true }),
      }).success,
    ).toBe(true);
  });
});

describe('F19 admission through the shared engine', () => {
  it('admits matching events, scales effects by amount and ignores chat', async () => {
    const engine = createEngine(artifact, { seed: 7 });
    try {
      const big = await engine.dispatch(cheer('c1', 0, 300));
      expect(big.code).toBe('ACCEPTED');
      expect(big.effects).toHaveLength(3);
      expect((await engine.dispatch(chat('m1', 1, '@cheer'))).code).toBe('UNRELATED');
      expect((await engine.dispatch(chat('m2', 2, '!cheer'))).code).toBe('UNRELATED');
      const low = await engine.dispatch(cheer('c2', 3, 99));
      expect(low.code).toBe('BELOW_MINIMUM');
      expect(low.effects).toHaveLength(0);
      expect(
        (
          await engine.dispatch({
            ...chat('r1', 4, ''),
            twitch: syntheticTwitchEvent('raid', 5000),
          })
        ).code,
      ).toBe('UNRELATED');
      expect((await engine.dispatch(cheer('c1', 5, 300))).code).toBe('DUPLICATE');
    } finally {
      engine.stop();
    }
  });

  it('applies the per-viewer allowance and shares one allowance for anonymous cheers', async () => {
    const engine = createEngine(artifact, { seed: 7 });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++)
        codes.push((await engine.dispatch(cheer(`a${i}`, i, 100, 'anonymous', true))).code);
      expect(codes).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'VIEWER_LIMIT']);
      expect((await engine.dispatch(cheer('b1', 10, 100, 'bob'))).code).toBe('ACCEPTED');
    } finally {
      engine.stop();
    }
  });

  it('keeps chat-command interactions blind to Twitch events', async () => {
    const example = EXAMPLES[0]!;
    const engine = createEngine(
      { source: example.source, manifest: example.manifest },
      { seed: 3 },
    );
    try {
      const decision = await engine.dispatch({
        ...chat('x1', 0, example.manifest.trigger.command),
        twitch: syntheticTwitchEvent('cheer', 100),
      });
      expect(decision.code).toBe('UNRELATED');
    } finally {
      engine.stop();
    }
  });
});

describe('F19 verification', () => {
  it('derives an independent event host suite and verifies a cheer candidate', async () => {
    const suite = hostScenarios(cheerManifest);
    expect(suite.map((scenario) => scenario.kind)).toEqual([
      'happy',
      'negative',
      'duplicate',
      'limit',
      'limit',
    ]);
    const step = (
      id: string,
      at: number,
      bits: number | null,
      expect: string,
      effects: number,
    ) => ({
      id,
      viewer: 'alice',
      roles: ['viewer'],
      text: bits === null ? 'hello chat' : '',
      at,
      expect,
      effects,
      twitch: bits === null ? null : syntheticTwitchEvent('cheer', bits),
      session: null,
    });
    const report = await verifyCandidate({
      source,
      manifest: cheerManifest,
      tests: [
        { name: 'cheer rains stars', kind: 'happy', steps: [step('a', 0, 200, 'ACCEPTED', 2)] },
        { name: 'small cheer', kind: 'limit', steps: [step('b', 0, 50, 'BELOW_MINIMUM', 0)] },
        { name: 'chat ignored', kind: 'negative', steps: [step('c', 0, null, 'UNRELATED', 0)] },
      ],
    });
    expect(report.failureReport).toBeNull();
    expect(report.ok).toBe(true);
  });
});

describe('F19 rehearsal presets', () => {
  it('rehearses event triggers with labeled synthetic Twitch events, never chat stand-ins', async () => {
    const scenario = createRehearsalPreset(artifact, 'proof', 11);
    expect(scenario.provenance).toEqual({ kind: 'synthetic' });
    const events = scenario.steps.flatMap((step) => (step.kind === 'chat' ? [step.event] : []));
    expect(events.filter((event) => event.twitch)).toHaveLength(2);
    expect(events.find((event) => event.twitch)?.twitch).toMatchObject({
      kind: 'cheer',
      amount: 100,
    });
    const result = await runRehearsal({ artifact, scenario });
    expect(result.status).toBe('passed');
  });
});
