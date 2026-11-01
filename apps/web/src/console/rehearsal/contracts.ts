import { z } from 'zod';
import { sessionSnapshotSchema } from '../../sessions/schemas.js';
const id = z.string().min(1).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const count = z.number().int().nonnegative();
const at = count.max(Number.MAX_SAFE_INTEGER - 86_400_000);
export const decisionCodes = [
  'ACCEPTED',
  'UNRELATED',
  'AUDIENCE',
  'VIEWER_LIMIT',
  'CHANNEL_LIMIT',
  'DUPLICATE',
  'INVALID_EVENT',
  'INCIDENT',
  'DISABLED',
  'CAPACITY',
  'STOPPED',
  'NOT_JOINED',
  'RESOURCE_LIMIT',
  'SESSION_PAUSED',
  'SESSION_FINISHED',
  'ALREADY_JOINED',
  'PARTICIPANT_LIMIT',
] as const;
export const presets = [
  'proof',
  'crowd-burst',
  'duplicate-delivery',
  'late-arrival',
  'exhaustion',
  'deadline',
] as const;
export const provenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('synthetic') }).strict(),
  z
    .object({
      kind: z.literal('sanitized-recording'),
      originVersionId: id,
      originArtifactId: hash,
      originSessionId: id,
    })
    .strict(),
  z.object({ kind: z.literal('synthetic-derivative'), sourceScenarioHash: hash }).strict(),
]);
const event = z
  .object({
    id,
    channelId: id,
    viewerId: id,
    roles: z
      .array(z.enum(['viewer', 'subscriber', 'moderator', 'broadcaster']))
      .min(1)
      .max(4),
    text: z.string().max(500),
    at,
  })
  .strict();
const control = (kind: 'advance' | 'pause' | 'resume') =>
  z.object({ kind: z.literal(kind), key, at }).strict();
const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), key, event }).strict(),
  control('advance'),
  control('pause'),
  control('resume'),
]);
const expectationSchema = z.discriminatedUnion('kind', [
  z
    .object({ id: key, stepKey: key, kind: z.literal('decision'), value: z.enum(decisionCodes) })
    .strict(),
  z.object({ id: key, stepKey: key, kind: z.literal('effects'), value: count.max(10) }).strict(),
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
      teamId: id,
      value: count.max(2_560_000),
    })
    .strict(),
  z
    .object({
      id: key,
      stepKey: key,
      kind: z.literal('remaining'),
      viewerId: id,
      value: count.max(100),
    })
    .strict(),
]);
export const scenarioSchema = z
  .object({
    version: z.literal(1),
    seed: count.min(1).max(0xffffffff),
    initialAt: at,
    initialSession: sessionSnapshotSchema.nullable(),
    steps: z.array(stepSchema).max(120),
    expectations: z.array(expectationSchema).max(20),
    provenance: provenanceSchema,
  })
  .strict()
  .superRefine((s, c) => {
    const keys = new Set(s.steps.map((x) => x.key));
    if (
      keys.size !== s.steps.length ||
      new Set(s.expectations.map((x) => x.id)).size !== s.expectations.length ||
      s.expectations.some((x) => !keys.has(x.stepKey))
    )
      c.addIssue({
        code: 'custom',
        message: 'Use unique steps and expectations tied to an existing step.',
      });
    let clock = s.initialAt;
    for (const step of s.steps) {
      const time = step.kind === 'chat' ? step.event.at : step.at;
      if (step.kind !== 'chat' && time < clock)
        c.addIssue({ code: 'custom', message: 'Control time cannot rewind.' });
      clock = Math.max(clock, time);
    }
    if (new TextEncoder().encode(JSON.stringify(s)).length > 131072)
      c.addIssue({ code: 'custom', message: 'Scenario exceeds 128 KiB.' });
  });
const decisionSchema = z
  .object({
    eventId: id,
    artifactId: hash,
    code: z.enum(decisionCodes),
    reason: z.string().max(240),
    effects: z
      .array(
        z
          .object({
            kind: z.literal('projectile'),
            asset: z.enum(['tomato', 'star', 'heart']),
            x: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(10),
    mode: z.enum(['preview', 'live']),
    viewerId: id.nullable(),
    at: at.nullable(),
    allowance: z
      .object({ used: count, max: count, windowMs: count, nextAt: at.nullable() })
      .strict()
      .nullable(),
  })
  .strict();
const failureShape = {
  id,
  stepKey: key,
  category: z.enum(['expectation', 'invariant']),
  kind: z.enum(['decision', 'effects', 'phase', 'score', 'remaining', 'quarantine', 'consistency']),
  expected: z.union([z.string(), z.number(), z.null()]),
  actual: z.union([z.string(), z.number(), z.null()]),
};
export const resultSchema = z
  .object({
    contractVersion: z.literal(1),
    artifactId: hash,
    scenarioHash: hash,
    evidenceHash: hash,
    seed: count.min(1).max(0xffffffff),
    initialAt: at,
    provenance: provenanceSchema,
    through: count.max(120),
    totalSteps: count.max(120),
    status: z.enum(['passed', 'failed', 'incomplete']),
    timeline: z
      .array(
        z
          .object({
            through: count.min(1).max(120),
            key,
            kind: z.enum(['chat', 'advance', 'pause', 'resume']),
            at,
            decision: decisionSchema.nullable(),
            stateDigest: hash,
          })
          .strict(),
      )
      .max(120),
    cursor: z
      .object({
        at,
        session: sessionSnapshotSchema.nullable(),
        stateDigest: hash,
        decision: decisionSchema.nullable(),
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            ...failureShape,
            status: z.enum(['passed', 'failed', 'pending']),
            summary: z.string().max(240),
          })
          .strict(),
      )
      .max(260),
  })
  .strict();
export const scenarioRecordSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    revision: count,
    scenario: scenarioSchema,
    createdAt: at,
    updatedAt: at,
  })
  .strict();
const minimizedSchema = z
  .object({
    scenario: scenarioSchema,
    run: resultSchema,
    checkId: id,
    failure: z.object(failureShape).strict(),
    originalEvidenceHash: hash,
    originalStepCount: count.max(120),
    removedSteps: count.max(120),
    attempts: count.max(24),
    dispatchedSteps: count.max(2400),
    budgetStopped: z.boolean(),
  })
  .strict();
export const rehearsalRunSchema = z
  .object({
    id,
    scenarioId: id.nullable(),
    scenarioRevision: count.nullable(),
    versionId: id,
    artifactId: hash,
    compareVersionId: id.nullable(),
    compareArtifactId: hash.nullable(),
    scenario: scenarioSchema,
    result: resultSchema,
    comparison: resultSchema.nullable(),
    differences: z
      .array(
        z
          .object({
            through: count,
            key,
            decision: z.boolean(),
            effects: z.boolean(),
            state: z.boolean(),
          })
          .strict(),
      )
      .max(120),
    freshStart: z.boolean(),
    minimization: minimizedSchema.nullable(),
    createdAt: at,
  })
  .strict();
export const regressionSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    automationId: id,
    originVersionId: id,
    originArtifactId: hash,
    sourceRunId: id,
    scenario: scenarioSchema,
    checkId: id,
    failure: z.object(failureShape).strict(),
    failedEvidenceHash: hash,
    createdAt: at,
  })
  .strict();
export type RehearsalScenario = z.infer<typeof scenarioSchema>;
export type RehearsalStep = RehearsalScenario['steps'][number];
export type Expectation = RehearsalScenario['expectations'][number];
export type ScenarioRecord = z.infer<typeof scenarioRecordSchema>;
export type RehearsalResult = z.infer<typeof resultSchema>;
export type RehearsalRun = z.infer<typeof rehearsalRunSchema>;
export type Regression = z.infer<typeof regressionSchema>;
export interface RegressionEvidence {
  regressionId: string;
  originVersionId: string;
  originArtifactId: string;
  scenarioHash: string;
  result: RehearsalResult | null;
  ok: boolean;
  failure: string | null;
}
