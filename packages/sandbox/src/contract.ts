import { z } from 'zod';
import {
  AUDIENCE_ROLES,
  CAPABILITIES,
  DECISION_CODES,
  EFFECT_LIMITS,
  HOST_LIMITS,
  PROJECTILE_ASSETS,
  SCENARIO_LIMITS,
  SDK_VERSION,
  TRIGGER_LIMITS,
  type DecisionCode,
} from '@riff/sdk';

const roleSchema = z.enum(AUDIENCE_ROLES);
const hasNoControlCharacters = (s: string) =>
  ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export const manifestSchema = z
  .object({
    sdkVersion: z.literal(SDK_VERSION),
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
  .strict();
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
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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
