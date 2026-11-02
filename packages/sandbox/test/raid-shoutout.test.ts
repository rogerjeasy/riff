import { describe, expect, it } from 'vitest';
import { RIFF_DTS } from '@riff/sdk';
import {
  createPreviewEngine,
  hostScenarios,
  manifestSchema,
  syntheticTwitchEvent,
  verifyCandidate,
} from '@riff/sandbox';

// F23 host-owned rule: a raid event trigger may shout out the raiding broadcaster only.
const raidTrigger = {
  command: '@raid',
  audience: ['viewer'],
  maxPerViewer: 5,
  windowMs: 60_000,
  kind: 'twitch.event',
  event: { kind: 'raid', minimum: 10 },
};
const manifest = (
  trigger: Record<string, unknown> = raidTrigger,
  capabilities = ['overlay', 'shoutout'],
) => ({
  sdkVersion: '0.4.0',
  experience: null,
  capabilities,
  trigger,
  limits: { effectsPerEvent: 3, effectsPerMinute: 60 },
});
const welcome = `async (event, riff) => {
  await riff.shoutout.raider();
  for (let i = 0; i < 2; i++) await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: riff.util.random() });
}`;
const raid = (id: string, viewers: number, at = 0, raider = 'raider-42') => ({
  id,
  channelId: 'channel-a',
  viewerId: raider,
  roles: ['viewer'],
  text: '',
  at,
  twitch: syntheticTwitchEvent('raid', viewers),
});

describe('raid shoutout manifest rule', () => {
  it('lets a raid event trigger use shoutout with the viewer audience', () => {
    expect(manifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it.each([
    [
      'a cheer trigger',
      { ...raidTrigger, command: '@cheer', event: { kind: 'cheer', minimum: 100 } },
    ],
    [
      'a subscribe trigger',
      { ...raidTrigger, command: '@subscribe', event: { kind: 'subscribe', minimum: 1 } },
    ],
  ])('rejects shoutouts from %s', (_name, trigger) => {
    const parsed = manifestSchema.safeParse(manifest(trigger));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message).join(' ')).toMatch(
      /Only a raid event trigger may shout out/,
    );
  });

  it('keeps viewer-triggered chat shoutouts and raid-triggered polls rejected', () => {
    const chat = { command: '!so', audience: ['viewer'], maxPerViewer: 1, windowMs: 60_000 };
    expect(manifestSchema.safeParse(manifest(chat, ['shoutout'])).success).toBe(false);
    expect(manifestSchema.safeParse(manifest(raidTrigger, ['polls'])).success).toBe(false);
  });

  it('declares raider() next to send() in the d.ts the compiler sees', () => {
    expect(RIFF_DTS).toContain(
      'shoutout: { send(target: { login: string }): Promise<void>; raider(): Promise<void> }',
    );
  });
});

describe('raid shoutout bridge', () => {
  it('binds the target to the raiding broadcaster of the current event', async () => {
    const engine = createPreviewEngine({ source: welcome, manifest: manifest() }, 7);
    try {
      const decision = await engine.dispatch(raid('r1', 25));
      expect(decision.code).toBe('ACCEPTED');
      expect(decision.actions).toEqual([{ kind: 'shoutout.raider', raiderId: 'raider-42' }]);
      expect(decision.effects).toHaveLength(2);
      // The same handler for a different raid binds that raid's broadcaster.
      const next = await engine.dispatch(raid('r2', 25, 1, 'raider-7'));
      expect(next.actions).toEqual([{ kind: 'shoutout.raider', raiderId: 'raider-7' }]);
    } finally {
      engine.stop();
    }
  });

  it('ignores guest arguments to raider(): the host still binds the raider', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.shoutout.raider({ login: 'evil', raiderId: '1' }); }`,
        manifest: manifest(),
      },
      7,
    );
    try {
      expect((await engine.dispatch(raid('r1', 25))).actions).toEqual([
        { kind: 'shoutout.raider', raiderId: 'raider-42' },
      ]);
    } finally {
      engine.stop();
    }
  });

  it('rejects a guest-chosen target from a raid trigger with a structured reason', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.shoutout.send({ login: 'somebodyelse' }); }`,
        manifest: manifest(),
      },
      7,
    );
    try {
      const decision = await engine.dispatch(raid('r1', 25));
      expect(decision.code).toBe('INCIDENT');
      expect(decision.reason).toContain('Raid shoutouts may only target the raiding broadcaster');
      expect(decision.actions).toBeUndefined();
    } finally {
      engine.stop();
    }
  });

  it('refuses raider() outside a raid event trigger', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.shoutout.raider(); }`,
        manifest: manifest(
          { command: '!so', audience: ['broadcaster'], maxPerViewer: 1, windowMs: 60_000 },
          ['shoutout'],
        ),
      },
      7,
    );
    try {
      const decision = await engine.dispatch({
        id: 'c1',
        channelId: 'channel-a',
        viewerId: 'owner',
        roles: ['broadcaster'],
        text: '!so',
        at: 0,
      });
      expect(decision.code).toBe('INCIDENT');
      expect(decision.reason).toContain('only available while handling a raid event trigger');
    } finally {
      engine.stop();
    }
  });

  it('stages nothing for a raid below the minimum viewer count', async () => {
    const engine = createPreviewEngine({ source: welcome, manifest: manifest() }, 7);
    try {
      const small = await engine.dispatch(raid('r1', 3));
      expect(small.code).toBe('BELOW_MINIMUM');
      expect(small.actions).toBeUndefined();
    } finally {
      engine.stop();
    }
  });

  it('verifies a raid shoutout candidate against the independent host suite', async () => {
    const step = (id: string, viewers: number | null, expect: string, effects: number, at = 0) => ({
      id,
      viewer: 'raider',
      roles: ['viewer'],
      text: viewers === null ? 'hello chat' : '',
      at,
      expect,
      effects,
      twitch: viewers === null ? null : syntheticTwitchEvent('raid', viewers),
      session: null,
    });
    const candidate = manifest();
    expect(hostScenarios(candidate as never).length).toBeGreaterThan(0);
    const report = await verifyCandidate({
      source: welcome,
      manifest: candidate,
      tests: [
        { name: 'raid shouts out', kind: 'happy', steps: [step('a', 20, 'ACCEPTED', 3)] },
        { name: 'small raid', kind: 'limit', steps: [step('b', 2, 'BELOW_MINIMUM', 0)] },
        { name: 'chat ignored', kind: 'negative', steps: [step('c', null, 'UNRELATED', 0)] },
      ],
    });
    expect(report.failureReport).toBeNull();
    expect(report.ok).toBe(true);
  });
});
