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
