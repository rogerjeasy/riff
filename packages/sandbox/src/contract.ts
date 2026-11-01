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
  type DecisionCode,
} from '@riff/sdk';

import { sessionDefinitionSchema } from './session.js';

const roleSchema = z.enum(AUDIENCE_ROLES);
const hasNoControlCharacters = (s: string) =>
  ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export const manifestSchema = z
  .object({
    sdkVersion: z.enum(['0.3.0', SDK_VERSION]),
    experience: sessionDefinitionSchema.nullable().optional(),
    capabilities: z
      .array(z.enum(CAPABILITIES))
      .max(CAPABILITIES.length)
      .refine((list) => new Set(list).size === list.length, 'Capabilities must be unique'),
    trigger: z
      .object({
        command: z.string().regex(new RegExp(TRIGGER_LIMITS.commandPattern)),
        audience: z
          .array(roleSchema)
          .min(1)
          .max(4)
          .refine((list) => new Set(list).size === list.length, 'Audience roles must be unique'),
        maxPerViewer: z
          .number()
          .int()
          .min(TRIGGER_LIMITS.maxPerViewer.min)
          .max(TRIGGER_LIMITS.maxPerViewer.max),
        windowMs: z
          .number()
          .int()
          .min(TRIGGER_LIMITS.windowMs.min)
          .max(TRIGGER_LIMITS.windowMs.max),
        kind: z.enum(TRIGGER_KINDS).optional(),
        reward: z
          .string()
          .min(1)
          .refine(
            (title) =>
              title.trim() === title &&
              Array.from(title).length <= CHANNEL_POINTS_LIMITS.rewardTitleLength &&
              hasNoControlCharacters(title),
            'Reward titles are 1 to 45 trimmed characters',
          )
          .nullable()
          .optional(),
      })
      .strict(),
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
    const redeems = manifest.trigger.kind === 'points.redeem';
    if (redeems && !manifest.trigger.reward)
      ctx.addIssue({ code: 'custom', message: 'points.redeem triggers name the reward title' });
    if (!redeems && manifest.trigger.reward)
      ctx.addIssue({ code: 'custom', message: 'Only points.redeem triggers carry a reward' });
    // Redemptions carry no chat badges, so no narrower audience can be verified.
    if (
      redeems &&
      (manifest.trigger.audience.length !== 1 || manifest.trigger.audience[0] !== 'viewer')
    )
      ctx.addIssue({ code: 'custom', message: "points.redeem audience must be ['viewer']" });
    if (redeems && manifest.experience)
      ctx.addIssue({ code: 'custom', message: 'Sessions are chat-only; remove the experience' });
    if (
      (redeems || manifest.capabilities.includes('predictions')) &&
      manifest.sdkVersion !== '0.4.0'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Channel Points triggers and predictions require SDK 0.4.0',
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
    if (
      (manifest.capabilities.includes('polls') || manifest.capabilities.includes('shoutout')) &&
      manifest.trigger.audience.some((role) => !privileged.includes(role))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Polls and shoutouts may only be triggered by moderators or the broadcaster',
      });
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
  })
  .strict();
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
  .strict();
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
