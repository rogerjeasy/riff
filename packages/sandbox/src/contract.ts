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
  TRIGGER_LIMITS,
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
        command: z
          .string()
          .regex(new RegExp(`${TRIGGER_LIMITS.commandPattern}|${EVENT_COMMAND_PATTERN}`)),
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
        event: eventTriggerSchema.nullable().optional(),
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
    const event = manifest.trigger.event;
    if (event) {
      if (manifest.trigger.command !== eventTriggerCommand(event.kind))
        ctx.addIssue({
          code: 'custom',
          path: ['trigger', 'command'],
          message: `Event triggers use the reserved command ${eventTriggerCommand(event.kind)}`,
        });
      if (manifest.experience)
        ctx.addIssue({ code: 'custom', message: 'Event triggers cannot drive a session' });
      if (event.kind === 'subscribe' && event.minimum !== 1)
        ctx.addIssue({
          code: 'custom',
          path: ['trigger', 'event', 'minimum'],
          message: 'Every subscribe event has amount 1; use minimum 1',
        });
      if (manifest.trigger.audience.length !== 1 || manifest.trigger.audience[0] !== 'viewer')
        ctx.addIssue({
          code: 'custom',
          path: ['trigger', 'audience'],
          message: "Event triggers use audience ['viewer']; EventSub carries no chat roles",
        });
    } else if (!new RegExp(TRIGGER_LIMITS.commandPattern).test(manifest.trigger.command))
      ctx.addIssue({
        code: 'custom',
        path: ['trigger', 'command'],
        message: 'Reserved @event commands need trigger.event',
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
    twitch: twitchEventDetailSchema.nullable().optional(),
  })
  .strict();
export const effectSchema = z
  .object({
    kind: z.literal('projectile'),
    asset: z.enum(PROJECTILE_ASSETS),
    x: z.number().finite().min(0).max(1),
  })
  .strict();
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
    twitch: twitchEventDetailSchema.nullable().optional(),
    session: z
      .object({
        phase: z.enum(['running', 'paused', 'finished']).optional(),
        scores: z.record(z.string(), z.number().int().nonnegative()).optional(),
        remainingMs: z.number().int().nonnegative().optional(),
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
