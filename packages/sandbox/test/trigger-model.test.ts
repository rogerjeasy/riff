import { describe, expect, it } from 'vitest';
import { EXAMPLES, TRIGGER_KINDS, triggerKind } from '@riff/sdk';
import {
  artifactIdentity,
  createPreviewEngine,
  eventSchema,
  manifestSchema,
  matchesTrigger,
  scenarioStepSchema,
  syntheticTwitchEvent,
} from '@riff/sandbox';

// One discriminated trigger: `kind` is the single source of truth for the event source.
const policy = { audience: ['viewer'], maxPerViewer: 5, windowMs: 60_000 };
const chatTrigger = { command: '!wave', ...policy };
const pointsTrigger = { command: '!hydrate', ...policy, kind: 'points.redeem', reward: 'Hydrate' };
const eventTrigger = {
  command: '@raid',
  ...policy,
  kind: 'twitch.event',
  event: { kind: 'raid', minimum: 10 },
};
const manifest = (trigger: Record<string, unknown>) => ({
  sdkVersion: '0.4.0',
  experience: null,
  capabilities: ['overlay'],
  trigger,
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
});
const issues = (trigger: Record<string, unknown>) => {
  const parsed = manifestSchema.safeParse(manifest(trigger));
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('unified trigger model: valid kinds', () => {
  it('lists exactly three kinds and defaults an omitted kind to chat.command', () => {
    expect(TRIGGER_KINDS).toEqual(['chat.command', 'points.redeem', 'twitch.event']);
    expect(triggerKind({})).toBe('chat.command');
    expect(triggerKind({ kind: 'twitch.event' })).toBe('twitch.event');
  });

  it.each([
    ['chat (kind omitted)', chatTrigger],
    [
      'chat (explicit, strict-output nulls)',
      { ...chatTrigger, kind: 'chat.command', reward: null, event: null },
    ],
    ['points.redeem', pointsTrigger],
    ['points.redeem with event null', { ...pointsTrigger, event: null }],
    ['twitch.event', eventTrigger],
    ['twitch.event with reward null', { ...eventTrigger, reward: null }],
  ])('accepts %s', (_name, trigger) => {
    expect(issues(trigger)).toEqual([]);
  });

  it('keeps chat-command artifact identity byte-identical to the pre-unification hashes', () => {
    // Recorded before the trigger kinds were unified (prompt pack riff-compiler/11).
    const recorded: Record<string, string> = {
      'tomato-toss': 'f308c09bee0d0963ad8ea75515311f192ea5bfc493c07768e5dc5372117b000b',
      'heart-burst': 'c24ff5d9f127a9be0a1e4e6267ffa1da69529386f7d1c9e3c91a253e44ed4c69',
    };
    for (const example of EXAMPLES)
      expect(artifactIdentity({ source: example.source, manifest: example.manifest })).toBe(
        recorded[example.name],
      );
  });
});

describe('unified trigger model: impossible combinations are rejected with a reason', () => {
  it.each([
    [
      'a chat trigger with a reward',
      { ...chatTrigger, reward: 'Hydrate' },
      /Only trigger.kind "points.redeem" carries a reward/,
    ],
    [
      'a chat trigger with an event',
      { ...chatTrigger, event: { kind: 'raid', minimum: 1 } },
      /Only trigger.kind "twitch.event" carries an event/,
    ],
    [
      'a chat trigger with a reserved @event command',
      { ...chatTrigger, command: '@raid' },
      /lowercase !command/,
    ],
    ['a redemption without a reward', { ...pointsTrigger, reward: null }, /./],
    [
      'a redemption with an event',
      { ...pointsTrigger, event: { kind: 'cheer', minimum: 1 } },
      /Only trigger.kind "twitch.event" carries an event/,
    ],
    [
      'a redemption with a narrowed audience',
      { ...pointsTrigger, audience: ['moderator'] },
      /audience \['viewer'\]/,
    ],
    ['an event trigger without an event', { ...eventTrigger, event: null }, /./],
    [
      'an event trigger with a reward',
      { ...eventTrigger, reward: 'Hydrate' },
      /Only trigger.kind "points.redeem" carries a reward/,
    ],
    [
      'an event trigger with a chat command',
      { ...eventTrigger, command: '!raid' },
      /reserved command/,
    ],
    [
      'an event trigger with another kind’s token',
      { ...eventTrigger, command: '@cheer' },
      /reserved command @raid/,
    ],
    [
      'an event trigger with a narrowed audience',
      { ...eventTrigger, audience: ['subscriber'] },
      /audience \['viewer'\]/,
    ],
    [
      'an event on a trigger with no kind (pre-unification shape)',
      { ...chatTrigger, command: '@raid', event: { kind: 'raid', minimum: 1 } },
      /./,
    ],
    [
      'an unknown kind',
      { ...chatTrigger, kind: 'follow' },
      /trigger.kind is one of chat.command, points.redeem, twitch.event/,
    ],
  ])('rejects %s', (_name, trigger, reason) => {
    const found = issues(trigger as Record<string, unknown>);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(' | ')).toMatch(reason);
  });

  it('rejects an event or scenario step that claims two sources at once', () => {
    const twitch = syntheticTwitchEvent('raid', 20);
    const base = { id: 'x', channelId: 'c', viewerId: 'v', roles: ['viewer'], text: '', at: 0 };
    expect(eventSchema.safeParse({ ...base, kind: 'points.redeem', twitch }).success).toBe(false);
    const step = {
      id: 's',
      viewer: 'ada',
      roles: ['viewer'],
      text: '',
      at: 0,
      expect: 'ACCEPTED',
      effects: 1,
    };
    expect(scenarioStepSchema.safeParse({ ...step, kind: 'points.redeem', twitch }).success).toBe(
      false,
    );
  });
});

describe('unified trigger model: each kind routes only its own source', () => {
  const chatEvent = { text: '!wave' };
  const handleEvent = { text: '!hydrate' };
  const redemption = { text: '', kind: 'points.redeem' as const };
  const raid = { text: '', twitch: { kind: 'raid' as const } };
  const cheer = { text: '', twitch: { kind: 'cheer' as const } };
  const parse = (trigger: Record<string, unknown>) =>
    manifestSchema.parse(manifest(trigger)).trigger;

  it('chat.command matches chat text only', () => {
    const t = parse(chatTrigger);
    expect(matchesTrigger(chatEvent, t)).toBe(true);
    expect(matchesTrigger({ ...redemption, text: '!wave' }, t)).toBe(false);
    expect(matchesTrigger({ ...raid, text: '!wave' }, t)).toBe(false);
  });

  it('points.redeem matches linked redemptions only, never its chat handle', () => {
    const t = parse(pointsTrigger);
    expect(matchesTrigger(redemption, t)).toBe(true);
    expect(matchesTrigger(handleEvent, t)).toBe(false);
    expect(matchesTrigger(raid, t)).toBe(false);
  });

  it('twitch.event matches its own event kind only, never chat or redemptions', () => {
    const t = parse(eventTrigger);
    expect(matchesTrigger(raid, t)).toBe(true);
    expect(matchesTrigger(cheer, t)).toBe(false);
    expect(matchesTrigger({ text: '@raid' }, t)).toBe(false);
    expect(matchesTrigger(redemption, t)).toBe(false);
  });

  it('routes end to end through the engine with BELOW_MINIMUM only for event triggers', async () => {
    const source = `async (event, riff) => { await riff.overlay.emit({kind:'projectile', asset:'star', x:0.5}); }`;
    const run = async (trigger: Record<string, unknown>) => {
      const engine = createPreviewEngine({ source, manifest: manifest(trigger) }, 3);
      const base = { channelId: 'c', viewerId: 'ada', roles: ['viewer'] };
      try {
        return [
          (await engine.dispatch({ ...base, id: 'chat', text: '!wave', at: 0 })).code,
          (await engine.dispatch({ ...base, id: 'redeem', text: '', at: 1, kind: 'points.redeem' }))
            .code,
          (
            await engine.dispatch({
              ...base,
              id: 'raid',
              text: '',
              at: 2,
              twitch: syntheticTwitchEvent('raid', 20),
            })
          ).code,
          (
            await engine.dispatch({
              ...base,
              id: 'small',
              text: '',
              at: 3,
              twitch: syntheticTwitchEvent('raid', 2),
            })
          ).code,
        ];
      } finally {
        engine.stop();
      }
    };
    expect(await run(chatTrigger)).toEqual(['ACCEPTED', 'UNRELATED', 'UNRELATED', 'UNRELATED']);
    expect(await run(pointsTrigger)).toEqual(['UNRELATED', 'ACCEPTED', 'UNRELATED', 'UNRELATED']);
    expect(await run(eventTrigger)).toEqual([
      'UNRELATED',
      'UNRELATED',
      'ACCEPTED',
      'BELOW_MINIMUM',
    ]);
  });
});
