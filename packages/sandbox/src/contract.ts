import { z } from 'zod';
import {
  AUDIENCE_ROLES,
  CAPABILITIES,
  DECISION_CODES,
  EFFECT_LIMITS,
  HOST_LIMITS,
  PROJECTILE_ASSETS,
  SCENARIO_LIMITS,
  SESSION_LIMITS,
  SDK_VERSION,
  TIMER_LIMITS,
  TRIGGER_LIMITS,
  TRIGGER_KINDS,
  CHANNEL_POINTS_LIMITS,
  PREDICTION_LIMITS,
  ANNOUNCEMENT_COLORS,
  TWITCH_ACTION_CAPABILITIES,
  TWITCH_ACTION_LIMITS,
  RAID_SHOUTOUT_EVENT,
  EVENT_COMMAND_PATTERN,
  EVENT_TRIGGER_LIMITS,
  SUBSCRIPTION_TIERS,
  TWITCH_EVENT_KINDS,
  eventTriggerCommand,
  type DecisionCode,
} from '@riff/sdk';

import { sessionDefinitionSchema } from './session.js';

const roleSchema = z.enum(AUDIENCE_ROLES);
/** F19 normalized Twitch event detail; synthetic in previews, EventSub-derived live. */
export const twitchEventDetailSchema = z
  .object({
    kind: z.enum(TWITCH_EVENT_KINDS),
    amount: z.number().int().min(1).max(EVENT_TRIGGER_LIMITS.amountMax),
    tier: z.enum(SUBSCRIPTION_TIERS).nullable(),
    anonymous: z.boolean(),
    gift: z.boolean(),
  })
  .strict()
  .superRefine((detail, ctx) => {
    const subscription = ['subscribe', 'gift', 'resub'].includes(detail.kind);
    if (subscription !== (detail.tier !== null))
      ctx.addIssue({ code: 'custom', message: 'Only subscription events carry a tier' });
    if (detail.anonymous && !['gift', 'cheer'].includes(detail.kind))
      ctx.addIssue({ code: 'custom', message: 'Only gifts and cheers can be anonymous' });
    if (detail.gift && detail.kind !== 'subscribe')
      ctx.addIssue({ code: 'custom', message: 'Only subscribe events can be gifted' });
    if (detail.kind === 'subscribe' && detail.amount !== 1)
      ctx.addIssue({ code: 'custom', message: 'A subscribe event has amount 1' });
  });
export const eventTriggerSchema = z
  .object({
    kind: z.enum(TWITCH_EVENT_KINDS),
    minimum: z
      .number()
      .int()
      .min(EVENT_TRIGGER_LIMITS.minimum.min)
      .max(EVENT_TRIGGER_LIMITS.minimum.max),
  })
  .strict();
const hasNoControlCharacters = (s: string) =>
  ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

const audienceSchema = z
  .array(roleSchema)
  .min(1)
  .max(4)
  .refine((list) => new Set(list).size === list.length, 'Audience roles must be unique');
// Key order is identity-relevant (artifactIdentity hashes the parsed manifest): every
// trigger variant keeps command, audience, maxPerViewer, windowMs, kind, reward, event.
const triggerPolicy = {
  audience: audienceSchema,
  maxPerViewer: z
    .number()
    .int()
    .min(TRIGGER_LIMITS.maxPerViewer.min)
    .max(TRIGGER_LIMITS.maxPerViewer.max),
  windowMs: z.number().int().min(TRIGGER_LIMITS.windowMs.min).max(TRIGGER_LIMITS.windowMs.max),
};
const chatCommand = z.string().regex(new RegExp(TRIGGER_LIMITS.commandPattern), {
  error: 'Chat and Channel Points triggers use a lowercase !command (^![a-z0-9_-]{1,32}$)',
});
const rewardTitle = z
  .string()
  .min(1)
  .refine(
    (title) =>
      title.trim() === title &&
      Array.from(title).length <= CHANNEL_POINTS_LIMITS.rewardTitleLength &&
      hasNoControlCharacters(title),
    'Reward titles are 1 to 45 trimmed characters',
  );
const noReward = z
  .null({ error: 'Only trigger.kind "points.redeem" carries a reward; use reward null' })
  .optional();
const noEvent = z
  .null({ error: 'Only trigger.kind "twitch.event" carries an event; use event null' })
  .optional();
/**
 * One trigger, one source, discriminated by `kind` (absent means chat.command, so
 * existing chat artifacts keep their identity). Combinations such as a reward on a
 * Twitch event or an event on a redemption cannot parse.
 */
export const triggerSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        command: chatCommand,
        ...triggerPolicy,
        kind: z.literal('chat.command').optional(),
        reward: noReward,
        event: noEvent,
      })
      .strict(),
    z
      .object({
        command: chatCommand,
        ...triggerPolicy,
        kind: z.literal('points.redeem'),
        reward: rewardTitle,
        event: noEvent,
      })
      .strict(),
    z
      .object({
        command: z.string().regex(new RegExp(EVENT_COMMAND_PATTERN), {
          error: 'Twitch event triggers use the reserved command "@" + event.kind',
        }),
        ...triggerPolicy,
        kind: z.literal('twitch.event'),
        reward: noReward,
        event: eventTriggerSchema,
      })
      .strict(),
  ],
  {
    // A missing trigger keeps zod's default wording ("received undefined").
    error: (issue) =>
      issue.input === undefined || typeof issue.input !== 'object'
        ? undefined
        : `trigger.kind is one of ${TRIGGER_KINDS.join(', ')} (absent means chat.command)`,
  },
);

export const manifestSchema = z
  .object({
    sdkVersion: z.enum(['0.3.0', SDK_VERSION]),
    experience: sessionDefinitionSchema.nullable().optional(),
    capabilities: z
      .array(z.enum(CAPABILITIES))
      .max(CAPABILITIES.length)
      .refine((list) => new Set(list).size === list.length, 'Capabilities must be unique'),
    trigger: triggerSchema,
    limits: z
      .object({
        effectsPerEvent: z.number().int().min(1).max(EFFECT_LIMITS.perEvent),
        effectsPerMinute: z.number().int().min(1).max(EFFECT_LIMITS.perMinute),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      manifest.experience &&
      (manifest.sdkVersion !== '0.4.0' ||
        !manifest.capabilities.includes('session') ||
        manifest.trigger.command !== manifest.experience.contribution.command)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Experiences require SDK 0.4.0, session capability and the canonical contribution command',
      });
    if (!manifest.experience && manifest.capabilities.includes('session'))
      ctx.addIssue({ code: 'custom', message: 'Session capability requires an experience' });
    if (manifest.capabilities.includes('timer') && manifest.sdkVersion !== '0.4.0')
      ctx.addIssue({ code: 'custom', message: 'Timer capability requires SDK 0.4.0' });
    if (manifest.experience && manifest.capabilities.includes('timer'))
      ctx.addIssue({
        code: 'custom',
        message:
          'Timers are not available inside stateful experiences; round deadlines are host-owned',
      });
    const trigger = manifest.trigger;
    const redeems = trigger.kind === 'points.redeem';
    const platform = trigger.kind === 'twitch.event';
    // Redemptions and EventSub notifications carry no chat badges, so no narrower
    // audience can be verified for either source.
    if (
      (redeems || platform) &&
      (trigger.audience.length !== 1 || trigger.audience[0] !== 'viewer')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['trigger', 'audience'],
        message: `${trigger.kind} triggers use audience ['viewer']; they carry no chat roles`,
      });
    if ((redeems || platform) && manifest.experience)
      ctx.addIssue({
        code: 'custom',
        path: ['experience'],
        message: 'Sessions are chat-only; remove the experience',
      });
    if (
      (redeems || platform || manifest.capabilities.includes('predictions')) &&
      manifest.sdkVersion !== '0.4.0'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Channel Points, Twitch event triggers and predictions require SDK 0.4.0',
      });
    const native = manifest.capabilities.filter((c) =>
      (TWITCH_ACTION_CAPABILITIES as readonly string[]).includes(c),
    );
    if (native.length && manifest.sdkVersion !== SDK_VERSION)
      ctx.addIssue({
        code: 'custom',
        message: `Native Twitch capabilities require sdkVersion ${SDK_VERSION}`,
      });
    const privileged: readonly string[] = TWITCH_ACTION_LIMITS.privilegedAudience;
    // F23 host-owned rule: a raid event trigger may shout out its raider (riff.shoutout.raider)
    // with the viewer audience; the bridge binds the target, so no guest login is trusted.
    const raidShoutout =
      trigger.kind === 'twitch.event' && trigger.event.kind === RAID_SHOUTOUT_EVENT;
    if (manifest.capabilities.includes('shoutout') && platform && !raidShoutout)
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Only a raid event trigger may shout out, and only the raiding broadcaster',
      });
    else if (
      (manifest.capabilities.includes('polls') ||
        (manifest.capabilities.includes('shoutout') && !raidShoutout)) &&
      trigger.audience.some((role) => !privileged.includes(role))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Polls and shoutouts may only be triggered by moderators or the broadcaster',
      });
    if (trigger.kind === 'twitch.event') {
      const event = trigger.event;
      if (trigger.command !== eventTriggerCommand(event.kind))
        ctx.addIssue({
          code: 'custom',
          path: ['trigger', 'command'],
          message: `Event triggers use the reserved command ${eventTriggerCommand(event.kind)}`,
        });
      if (event.kind === 'subscribe' && event.minimum !== 1)
        ctx.addIssue({
          code: 'custom',
          path: ['trigger', 'event', 'minimum'],
          message: 'Every subscribe event has amount 1; use minimum 1',
        });
    }
  });
export const artifactSchema = z
  .object({
    source: z.string().min(1).max(HOST_LIMITS.sourceBytes),
    manifest: manifestSchema,
  })
  .strict();
export const eventSchema = z
  .object({
    id: z.string().min(1).max(100),
    channelId: z.string().min(1).max(100),
    viewerId: z.string().min(1).max(100),
    roles: z.array(roleSchema).max(4),
    text: z.string().max(500).refine(hasNoControlCharacters, 'Control characters forbidden'),
    at: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2 * SESSION_LIMITS.durationMs.max),
    kind: z.literal('points.redeem').optional(),
    twitch: twitchEventDetailSchema.nullable().optional(),
  })
  .strict()
  .refine((event) => !(event.kind && event.twitch), {
    message: 'An event is a chat message, a redemption or a Twitch event, never two',
  });
const boundedText = (max: number) =>
  z
    .string()
    .refine(
      (text) =>
        text.trim().length > 0 &&
        Array.from(text.trim()).length <= max &&
        hasNoControlCharacters(text),
      `Use 1 to ${max} characters without control characters`,
    );
/** Guest prediction proposals: documented Twitch bounds, distinct outcomes, no extra fields. */
export const predictionProposalSchema = z
  .object({
    title: boundedText(PREDICTION_LIMITS.titleLength),
    outcomes: z
      .array(boundedText(PREDICTION_LIMITS.outcomeLength))
      .min(PREDICTION_LIMITS.outcomes.min)
      .max(PREDICTION_LIMITS.outcomes.max)
      .refine(
        (list) => new Set(list.map((o) => o.trim().toLowerCase())).size === list.length,
        'Outcomes must be distinct',
      ),
    windowSeconds: z
      .number()
      .int()
      .min(PREDICTION_LIMITS.windowSeconds.min)
      .max(PREDICTION_LIMITS.windowSeconds.max),
  })
  .strict()
  .transform((p) => ({
    title: p.title.trim(),
    outcomes: p.outcomes.map((o) => o.trim()),
    windowSeconds: p.windowSeconds,
  }));
export const effectSchema = z
  .object({
    kind: z.literal('projectile'),
    asset: z.enum(PROJECTILE_ASSETS),
    x: z.number().finite().min(0).max(1),
  })
  .strict();
/** Staged native Twitch action; strict and bounded on both sides of the bridge. */
const actionText = (max: number) =>
  z.string().trim().min(1).max(max).refine(hasNoControlCharacters, 'Control characters forbidden');
export const actionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('poll.start'),
      title: actionText(TWITCH_ACTION_LIMITS.poll.titleLength),
      choices: z
        .array(actionText(TWITCH_ACTION_LIMITS.poll.choiceLength))
        .min(TWITCH_ACTION_LIMITS.poll.choices.min)
        .max(TWITCH_ACTION_LIMITS.poll.choices.max)
        .refine(
          (list) => new Set(list.map((c) => c.toLowerCase())).size === list.length,
          'Poll choices must be unique',
        ),
      durationSeconds: z
        .number()
        .int()
        .min(TWITCH_ACTION_LIMITS.poll.durationSeconds.min)
        .max(TWITCH_ACTION_LIMITS.poll.durationSeconds.max),
    })
    .strict(),
  z.object({ kind: z.literal('poll.end') }).strict(),
  z
    .object({
      kind: z.literal('announce'),
      message: actionText(TWITCH_ACTION_LIMITS.announcement.messageLength),
      color: z.enum(ANNOUNCEMENT_COLORS).default('primary'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('shoutout'),
      login: z
        .string()
        .trim()
        .toLowerCase()
        .regex(new RegExp(TWITCH_ACTION_LIMITS.shoutout.loginPattern)),
    })
    .strict(),
  // Host-bound only: the bridge fills raiderId from the raid event; guests never supply it.
  z
    .object({
      kind: z.literal('shoutout.raider'),
      raiderId: z.string().min(1).max(100),
    })
    .strict(),
]);
const decisionCodeSchema = z.enum(DECISION_CODES as [DecisionCode, ...DecisionCode[]]);
export const scenarioStepSchema = z
  .object({
    viewer: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    roles: z.array(roleSchema).min(1).max(4),
    text: z.string().max(500).refine(hasNoControlCharacters, 'Control characters forbidden'),
    at: z.number().int().nonnegative().max(86_400_000),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    expect: decisionCodeSchema,
    effects: z.number().int().min(0).max(EFFECT_LIMITS.perEvent),
    timers: z
      .object({
        fired: z.number().int().min(0).max(TIMER_LIMITS.previewFiresPerAdvance),
        effects: z
          .number()
          .int()
          .min(0)
          .max(EFFECT_LIMITS.perEvent * TIMER_LIMITS.previewFiresPerAdvance),
      })
      .strict()
      .nullable()
      .optional(),
    kind: z.literal('points.redeem').nullable().optional(),
    twitch: twitchEventDetailSchema.nullable().optional(),
    session: z
      .object({
        phase: z.enum(['running', 'paused', 'finished']).optional(),
        scores: z.record(z.string(), z.number().int().nonnegative()).optional(),
        remainingMs: z.number().int().nonnegative().optional(),
        round: z.number().int().min(1).max(9).optional(),
        winner: z.string().max(32).nullable().optional(),
        wins: z.record(z.string(), z.number().int().nonnegative()).optional(),
        standings: z
          .record(
            z.string(),
            z
              .object({
                health: z.number().int().nonnegative().nullable().optional(),
                eliminated: z.boolean().optional(),
                bursts: z.number().int().nonnegative().optional(),
                tier: z.number().int().nonnegative().optional(),
              })
              .strict(),
          )
          .optional(),
        participants: z
          .record(
            z.string(),
            z
              .object({
                remaining: z.number().int().nonnegative().optional(),
                contributions: z.number().int().nonnegative().optional(),
                teamId: z.string().nullable().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((step) => !(step.kind && step.twitch), {
    message: 'A step is a chat message, a redemption (kind) or a Twitch event (twitch), never two',
  });
export const scenarioSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(['happy', 'limit', 'role', 'negative', 'duplicate', 'window']),
    steps: z
      .array(scenarioStepSchema)
      .min(1)
      .max(SCENARIO_LIMITS.maxSteps)
      .refine(
        (steps) => steps.every((step, i) => i === 0 || step.at >= (steps[i - 1]?.at ?? 0)),
        'Scenario time must not decrease',
      ),
  })
  .strict();
export const scenariosSchema = z
  .array(scenarioSchema)
  .min(SCENARIO_LIMITS.minScenarios)
  .max(SCENARIO_LIMITS.maxScenarios);
