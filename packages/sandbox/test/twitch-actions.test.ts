import { describe, expect, it } from 'vitest';
import {
  analyzeSource,
  createEngine,
  createPreviewEngine,
  manifestSchema,
  verifyCandidate,
} from '@riff/sandbox';

const base = {
  sdkVersion: '0.4.0',
  experience: null,
  trigger: { command: '!vote', audience: ['broadcaster'], maxPerViewer: 2, windowMs: 60_000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 10 },
};
const event = (id: string, at = 0, text = '!vote', roles = ['broadcaster']) => ({
  id,
  at,
  viewerId: 'owner',
  channelId: 'channel-a',
  roles,
  text,
});
const pollSource = `async (event, riff) => { await riff.polls.start({ title: 'Next challenge?', choices: ['Speedrun', 'Hardcore'], durationSeconds: 120 }); }`;

describe('native Twitch action bridge', () => {
  it('stages a validated poll without any Twitch call and counts it as an effect', async () => {
    const engine = createPreviewEngine(
      { source: pollSource, manifest: { ...base, capabilities: ['polls'] } },
      7,
    );
    const decision = await engine.dispatch(event('a'));
    expect(decision.code).toBe('ACCEPTED');
    expect(decision.effects).toEqual([]);
    expect(decision.actions).toEqual([
      {
        kind: 'poll.start',
        title: 'Next challenge?',
        choices: ['Speedrun', 'Hardcore'],
        durationSeconds: 120,
      },
    ]);
    expect(decision.mode).toBe('preview');
    expect(decision.allowance?.used).toBe(1);
    engine.stop();
  });

  it('quarantines a handler that uses an undeclared native capability (manifest first)', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.chat.announce({ message: 'hi' }); }`,
        manifest: { ...base, capabilities: ['polls'] },
      },
      7,
    );
    const decision = await engine.dispatch(event('a'));
    expect(decision.code).toBe('INCIDENT');
    expect(decision.reason).toContain('undeclared capability chat.announce');
    engine.stop();
  });

  it('rejects requests outside Twitch bounds inside the isolate', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.polls.start({ title: 'x', choices: ['only'], durationSeconds: 5 }); }`,
        manifest: { ...base, capabilities: ['polls'] },
      },
      7,
    );
    const decision = await engine.dispatch(event('a'));
    expect(decision.code).toBe('INCIDENT');
    expect(decision.actions).toBeUndefined();
    engine.stop();
  });

  it('enforces the automation per-event limit before anything leaves the isolate', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.chat.announce({ message: 'one' }); await riff.chat.announce({ message: 'two' }); }`,
        manifest: {
          ...base,
          trigger: { ...base.trigger, audience: ['viewer'] },
          capabilities: ['chat.announce'],
        },
      },
      7,
    );
    const decision = await engine.dispatch(event('a', 0, '!vote', ['viewer']));
    expect(decision.code).toBe('INCIDENT');
    expect(decision.reason).toContain('per event');
    engine.stop();
  });

  it('applies the automation per-minute budget to staged actions', async () => {
    const engine = createEngine(
      {
        source: `async (event, riff) => { await riff.chat.announce({ message: 'Go!', color: 'green' }); }`,
        manifest: {
          ...base,
          trigger: { ...base.trigger, audience: ['viewer'], maxPerViewer: 5 },
          limits: { effectsPerEvent: 1, effectsPerMinute: 2 },
          capabilities: ['chat.announce'],
        },
      },
      { seed: 3, mode: 'live' },
    );
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push((await engine.dispatch(event(String(i), i, '!vote', ['viewer']))).code);
    expect(codes).toEqual(['ACCEPTED', 'ACCEPTED', 'CHANNEL_LIMIT']);
    engine.stop();
  });

  it('normalizes shoutout logins and defaults announcement colors', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.shoutout.send({ login: ' TwitchDev ' }); await riff.chat.announce({ message: 'Go follow them!' }); }`,
        manifest: {
          ...base,
          limits: { effectsPerEvent: 2, effectsPerMinute: 10 },
          capabilities: ['shoutout', 'chat.announce'],
        },
      },
      7,
    );
    const decision = await engine.dispatch(event('a'));
    expect(decision.actions).toEqual([
      { kind: 'shoutout', login: 'twitchdev' },
      { kind: 'announce', message: 'Go follow them!', color: 'primary' },
    ]);
    engine.stop();
  });

  it('cannot forge an action kind through the request object', async () => {
    const engine = createPreviewEngine(
      {
        source: `async (event, riff) => { await riff.chat.announce({ kind: 'shoutout', login: 'x', message: 'hi' }); }`,
        manifest: {
          ...base,
          trigger: { ...base.trigger, audience: ['viewer'] },
          capabilities: ['chat.announce'],
        },
      },
      7,
    );
    // The bridge overwrites `kind`, and strict validation rejects the stray `login`.
    expect((await engine.dispatch(event('a', 0, '!vote', ['viewer']))).code).toBe('INCIDENT');
    engine.stop();
  });
});

describe('native capability manifests', () => {
  it('limits polls and shoutouts to moderators and the broadcaster', () => {
    for (const capability of ['polls', 'shoutout'] as const) {
      const viewer = manifestSchema.safeParse({
        ...base,
        trigger: { ...base.trigger, audience: ['viewer'] },
        capabilities: [capability],
      });
      expect(viewer.success).toBe(false);
      expect(
        manifestSchema.safeParse({
          ...base,
          trigger: { ...base.trigger, audience: ['moderator', 'broadcaster'] },
          capabilities: [capability],
        }).success,
      ).toBe(true);
    }
    expect(
      manifestSchema.safeParse({
        ...base,
        trigger: { ...base.trigger, audience: ['viewer'] },
        capabilities: ['chat.announce'],
      }).success,
    ).toBe(true);
  });

  it('requires the SDK version that introduced native capabilities', () => {
    expect(
      manifestSchema.safeParse({ ...base, sdkVersion: '0.3.0', capabilities: ['polls'] }).success,
    ).toBe(false);
  });

  it('detects dotted capability use for least privilege', () => {
    const analysis = analyzeSource(
      `async (event, riff) => { await riff.chat.announce({ message: 'hi' }); }`,
      { ...base, capabilities: [] } as never,
    );
    expect(analysis.capabilitiesUsed).toEqual(['chat.announce']);
    expect(analysis.findings.map((f) => f.rule)).toContain('declared-capabilities');
  });

  it('passes the host policy suite for an owner-only poll', async () => {
    const report = await verifyCandidate({
      source: pollSource,
      manifest: { ...base, capabilities: ['polls'] },
      tests: [
        {
          name: 'Owner starts a poll',
          kind: 'happy',
          steps: [
            {
              id: 'a',
              viewer: 'owner',
              roles: ['broadcaster'],
              text: '!vote',
              at: 0,
              expect: 'ACCEPTED',
              effects: 1,
            },
          ],
        },
        {
          name: 'Viewers cannot start polls',
          kind: 'role',
          steps: [
            {
              id: 'b',
              viewer: 'ada',
              roles: ['viewer'],
              text: '!vote',
              at: 0,
              expect: 'AUDIENCE',
              effects: 0,
            },
          ],
        },
        {
          name: 'Other chat does nothing',
          kind: 'negative',
          steps: [
            {
              id: 'c',
              viewer: 'owner',
              roles: ['broadcaster'],
              text: 'hello',
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
