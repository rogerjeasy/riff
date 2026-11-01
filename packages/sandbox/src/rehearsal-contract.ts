import { createHash } from 'node:crypto';
import { DECISION_CODES, EFFECT_LIMITS, SESSION_LIMITS } from '@riff/sdk';
import { z } from 'zod';
import { eventSchema } from './contract.js';
import { sessionSnapshotSchema } from './session.js';

export const REHEARSAL_CONTRACT_VERSION = 1 as const;
export const REHEARSAL_LIMITS = Object.freeze({
  steps: 120,
  expectations: 20,
  scenarioBytes: 128 * 1024,
  resultBytes: 256 * 1024,
  summaryLength: 240,
  minimizationReplays: 24,
  minimizationSteps: 2400,
});
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const identity = z.string().min(1).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = eventSchema.shape.at;
const control = (kind: 'advance' | 'pause' | 'resume') =>
  z.object({ kind: z.literal(kind), key, at }).strict();
export const rehearsalStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), key, event: eventSchema }).strict(),
  control('advance'),
  control('pause'),
  control('resume'),
]);
export const rehearsalExpectationSchema = z.discriminatedUnion('kind', [
  z
    .object({ id: key, stepKey: key, kind: z.literal('decision'), value: z.enum(DECISION_CODES) })
    .strict(),
  z
    .object({
      id: key,
      stepKey: key,
      kind: z.literal('effects'),
      value: z.number().int().min(0).max(EFFECT_LIMITS.perEvent),
    })
    .strict(),
  z
    .object({
      id: key,
      stepKey: key,
      kind: z.literal('phase'),
      value: z.enum(['running', 'paused', 'finished']),
    })
    .strict(),
  z
    .object({
      id: key,
      stepKey: key,
      kind: z.literal('score'),
      teamId: identity,
      value: z.number().int().min(0).max(SESSION_LIMITS.maxScore),
    })
    .strict(),
  z
    .object({
      id: key,
      stepKey: key,
      kind: z.literal('remaining'),
      viewerId: identity,
      value: z.number().int().min(0).max(SESSION_LIMITS.resourcePerParticipant),
    })
    .strict(),
]);
export const rehearsalProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('synthetic') }).strict(),
  z
    .object({
      kind: z.literal('sanitized-recording'),
      originVersionId: identity,
      originArtifactId: hash,
      originSessionId: identity,
    })
    .strict(),
  z.object({ kind: z.literal('synthetic-derivative'), sourceScenarioHash: hash }).strict(),
]);
/** Host-only normalized input; callers must separately authorize recorded provenance. */
export const rehearsalScenarioSchema = z
  .object({
    version: z.literal(1),
    seed: z.number().int().min(1).max(0xffff_ffff),
    initialAt: at,
    initialSession: sessionSnapshotSchema.nullable(),
    steps: z.array(rehearsalStepSchema).max(REHEARSAL_LIMITS.steps),
    expectations: z.array(rehearsalExpectationSchema).max(REHEARSAL_LIMITS.expectations),
    provenance: rehearsalProvenanceSchema,
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const keys = new Set<string>();
    let clock = scenario.initialAt;
    for (const [i, step] of scenario.steps.entries()) {
      if (keys.has(step.key))
        ctx.addIssue({
          code: 'custom',
          message: 'Step keys must be unique',
          path: ['steps', i, 'key'],
        });
      keys.add(step.key);
      const time = step.kind === 'chat' ? step.event.at : step.at;
      if (step.kind !== 'chat' && time < clock)
        ctx.addIssue({
          code: 'custom',
          message: 'Control time cannot decrease',
          path: ['steps', i, 'at'],
        });
      clock = Math.max(clock, time);
    }
    const ids = new Set<string>();
    for (const [i, check] of scenario.expectations.entries()) {
      if (!keys.has(check.stepKey) || ids.has(check.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Expectations need unique ids and an existing step',
          path: ['expectations', i],
        });
      ids.add(check.id);
    }
    if (Buffer.byteLength(JSON.stringify(scenario), 'utf8') > REHEARSAL_LIMITS.scenarioBytes)
      ctx.addIssue({ code: 'custom', message: 'Scenario exceeds 128 KiB' });
  });
export type RehearsalScenario = z.infer<typeof rehearsalScenarioSchema>;
export type RehearsalStep = z.infer<typeof rehearsalStepSchema>;
export type RehearsalExpectation = z.infer<typeof rehearsalExpectationSchema>;
export type RehearsalProvenance = z.infer<typeof rehearsalProvenanceSchema>;
export type RehearsalErrorCode =
  | 'ABORTED'
  | 'INVALID_SCENARIO'
  | 'INVALID_CURSOR'
  | 'INCOMPATIBLE_SESSION'
  | 'INVALID_CHECK'
  | 'RESULT_LIMIT';
export class RehearsalError extends Error {
  constructor(
    public readonly code: RehearsalErrorCode,
    message: string,
  ) {
    super(message.slice(0, REHEARSAL_LIMITS.summaryLength));
    this.name = 'RehearsalError';
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}
/** Canonical JSON hash, independent of object insertion order. */
export function rehearsalHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
/** Validate and fingerprint exact normalized scenario inputs, expectations and provenance. */
export function rehearsalScenarioHash(scenario: unknown): string {
  return rehearsalHash(rehearsalScenarioSchema.parse(scenario));
}
export function assertRehearsalActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RehearsalError('ABORTED', 'Rehearsal cancelled.');
}
