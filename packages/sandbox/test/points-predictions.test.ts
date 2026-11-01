import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@riff/sdk';
import {
  analyzeSource,
  createPreviewEngine,
  hostScenarios,
  manifestSchema,
  verifyCandidate,
} from '@riff/sandbox';

const redeemManifest = {
  sdkVersion: '0.4.0',
  experience: null,
  capabilities: ['overlay'],
  trigger: {
    kind: 'points.redeem',
    reward: 'Hydrate',
    command: '!hydrate',
    audience: ['viewer'],
    maxPerViewer: 2,
    windowMs: 60_000,
  },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const splash = `async (event, riff) => { await riff.overlay.emit({kind:'projectile', asset:'star', x:riff.util.random()}); }`;
const redemption = (id: string, at = 0, viewerId = 'alice', text = '') => ({
  id,
  at,
  viewerId,
  channelId: 'channel-a',
  roles: ['viewer'],
  text,
  kind: 'points.redeem',
});

const predictManifest = {
  sdkVersion: '0.4.0',
  experience: null,
  capabilities: ['predictions'],
  trigger: { command: '!predict', audience: ['broadcaster'], maxPerViewer: 1, windowMs: 60_000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const propose = `async (event, riff) => { await riff.predictions.propose({ title: 'Will we win?', outcomes: ['Yes', 'No'], windowSeconds: 120 }); }`;
const chat = (id: string, text: string, roles = ['broadcaster'], at = 0) => ({
  id,
  at,
  viewerId: 'host',
  channelId: 'channel-a',
  roles,
  text,
});

describe('points.redeem manifests', () => {
  it('require a reward title, the whole audience, SDK 0.4.0 and no experience', () => {
    expect(manifestSchema.safeParse(redeemManifest).success).toBe(true);
    const bad = (trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      manifestSchema.safeParse({
        ...redeemManifest,
        ...extra,
        trigger: { ...redeemManifest.trigger, ...trigger },
      }).success;
    expect(bad({ reward: null })).toBe(false);
    expect(bad({ reward: 'x'.repeat(46) })).toBe(false);
    expect(bad({ reward: 'bad\u0007' })).toBe(false);
    expect(bad({ audience: ['subscriber'] })).toBe(false);
    expect(bad({}, { sdkVersion: '0.3.0' })).toBe(false);
    // Chat triggers may not carry a reward.
    expect(bad({ kind: 'chat.command', reward: 'Hydrate' })).toBe(false);
    expect(bad({ kind: 'chat.command', reward: null })).toBe(true);
  });
});

describe('points.redeem admission', () => {
  it('admits only redemptions, with dedupe and the viewer window, never chat text', async () => {
    const engine = createPreviewEngine({ source: splash, manifest: redeemManifest }, 7);
    expect((await engine.dispatch(redemption('r1', 0))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(redemption('r1', 1))).code).toBe('DUPLICATE');
    expect((await engine.dispatch(redemption('r2', 2))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(redemption('r3', 3))).code).toBe('VIEWER_LIMIT');
    expect((await engine.dispatch({ ...chat('c1', '!hydrate', ['viewer'], 4) })).code).toBe(
      'UNRELATED',
    );
    engine.stop();
  });
  it('chat triggers ignore redemptions', async () => {
    const engine = createPreviewEngine(
      {
        source: splash,
        manifest: {
          ...redeemManifest,
          trigger: { ...redeemManifest.trigger, kind: 'chat.command', reward: null },
        },
      },
      7,
    );
    expect((await engine.dispatch({ ...redemption('r1'), text: '!hydrate' })).code).toBe(
      'UNRELATED',
    );
    expect((await engine.dispatch(chat('c1', '!hydrate', ['viewer'], 1))).code).toBe('ACCEPTED');
    engine.stop();
  });
  it('host policy suite covers redemptions and passes for a well-formed artifact', async () => {
    const suite = hostScenarios(redeemManifest as never);
    expect(suite.some((s) => s.steps.some((step) => step.kind === 'points.redeem'))).toBe(true);
    const report = await verifyCandidate({
      source: splash,
      manifest: redeemManifest,
      tests: [
        {
          name: 'A redemption splashes',
          kind: 'happy',
          steps: [
            {
              id: 'a',
              viewer: 'ada',
              roles: ['viewer'],
              text: '',
              at: 0,
              expect: 'ACCEPTED',
              effects: 1,
              kind: 'points.redeem',
            },
          ],
        },
        {
          name: 'Third redemption in a minute is refunded',
          kind: 'limit',
          steps: [
            {
              id: 'a',
              viewer: 'ada',
              roles: ['viewer'],
              text: '',
              at: 0,
              expect: 'ACCEPTED',
              effects: 1,
              kind: 'points.redeem',
            },
            {
              id: 'b',
              viewer: 'ada',
              roles: ['viewer'],
              text: '',
              at: 1,
              expect: 'ACCEPTED',
              effects: 1,
              kind: 'points.redeem',
            },
            {
              id: 'c',
              viewer: 'ada',
              roles: ['viewer'],
              text: '',
              at: 2,
              expect: 'VIEWER_LIMIT',
              effects: 0,
              kind: 'points.redeem',
            },
          ],
        },
        {
          name: 'Typing the handle in chat does nothing',
          kind: 'negative',
          steps: [
            {
              id: 'n',
              viewer: 'ada',
              roles: ['viewer'],
              text: '!hydrate',
              at: 0,
              expect: 'UNRELATED',
              effects: 0,
              kind: null,
            },
          ],
        },
      ],
    });
    expect(report.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ['manifest', 'passed'],
      ['static', 'passed'],
      ['compile', 'passed'],
      ['generated', 'passed'],
      ['host', 'passed'],
    ]);
  }, 30_000);
});

describe('predictions capability', () => {
  it('is part of the synchronized capability set and detected by static analysis', () => {
    expect(CAPABILITIES).toContain('predictions');
    expect(analyzeSource(propose, predictManifest as never).capabilitiesUsed).toEqual([
      'predictions',
    ]);
    expect(
      analyzeSource(propose, { ...predictManifest, capabilities: ['overlay'] } as never).findings,
    ).toContainEqual(expect.objectContaining({ rule: 'declared-capabilities' }));
  });
  it('returns a validated proposal in the decision without any effect or Twitch call', async () => {
    const engine = createPreviewEngine({ source: propose, manifest: predictManifest }, 7);
    const decision = await engine.dispatch(chat('p1', '!predict'));
    expect(decision.code).toBe('ACCEPTED');
    expect(decision.effects).toEqual([]);
    expect(decision.proposals).toEqual([
      { title: 'Will we win?', outcomes: ['Yes', 'No'], windowSeconds: 120 },
    ]);
    // The proposal counts toward the allowance like an effect.
    expect((await engine.dispatch(chat('p2', '!predict', ['broadcaster'], 1))).code).toBe(
      'VIEWER_LIMIT',
    );
    engine.stop();
  });
  it.each([
    ['an out-of-range window', `{ title: 'Ok?', outcomes: ['Yes','No'], windowSeconds: 5 }`],
    ['one outcome', `{ title: 'Ok?', outcomes: ['Yes'], windowSeconds: 60 }`],
    ['duplicate outcomes', `{ title: 'Ok?', outcomes: ['Yes','yes'], windowSeconds: 60 }`],
    ['a long title', `{ title: '${'x'.repeat(46)}', outcomes: ['a','b'], windowSeconds: 60 }`],
    ['extra authority', `{ title: 'Ok?', outcomes: ['a','b'], windowSeconds: 60, winner: 'a' }`],
  ])('treats %s as a fault and quarantines', async (_label, body) => {
    const engine = createPreviewEngine(
      {
        source: `async (e, riff) => { await riff.predictions.propose(${body}); }`,
        manifest: predictManifest,
      },
      7,
    );
    const decision = await engine.dispatch(chat('p1', '!predict'));
    expect(decision.code).toBe('INCIDENT');
    expect(decision.proposals).toBeUndefined();
    engine.stop();
  });
  it('allows at most one proposal per event and denies the undeclared capability', async () => {
    const twice = createPreviewEngine(
      {
        source: `async (e, riff) => { const p = { title: 'A?', outcomes: ['a','b'], windowSeconds: 60 }; await riff.predictions.propose(p); await riff.predictions.propose(p); }`,
        manifest: predictManifest,
      },
      7,
    );
    expect((await twice.dispatch(chat('p1', '!predict'))).code).toBe('INCIDENT');
    twice.stop();
    const undeclared = createPreviewEngine(
      { source: propose, manifest: { ...predictManifest, capabilities: ['overlay'] } },
      7,
    );
    expect((await undeclared.dispatch(chat('p1', '!predict'))).code).toBe('INCIDENT');
    undeclared.stop();
  });
  it('a proposing artifact passes the host policy suite', async () => {
    const report = await verifyCandidate({
      source: propose,
      manifest: predictManifest,
      tests: [
        {
          name: 'Host proposes',
          kind: 'happy',
          steps: [
            {
              id: 'a',
              viewer: 'host',
              roles: ['broadcaster'],
              text: '!predict',
              at: 0,
              expect: 'ACCEPTED',
              effects: 0,
            },
          ],
        },
        {
          name: 'Viewers cannot',
          kind: 'role',
          steps: [
            {
              id: 'b',
              viewer: 'v',
              roles: ['viewer'],
              text: '!predict',
              at: 0,
              expect: 'AUDIENCE',
              effects: 0,
            },
          ],
        },
        {
          name: 'Chat is ignored',
          kind: 'negative',
          steps: [
            {
              id: 'c',
              viewer: 'host',
              roles: ['broadcaster'],
              text: 'hi',
              at: 0,
              expect: 'UNRELATED',
              effects: 0,
            },
          ],
        },
      ],
    });
    expect(report.ok).toBe(true);
  }, 30_000);
});
