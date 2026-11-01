import { z } from 'zod';
const range = (min: number, max: number) =>
  z
    .object({ min: z.number().int().min(min).max(max), max: z.number().int().min(min).max(max) })
    .strict()
    .refine((v) => v.min <= v.max, 'Minimum must not exceed maximum');
export const envelopeSchema = z
  .object({
    version: z.literal(1),
    intervalMs: range(250, 2000),
    batchSize: range(1, 6),
    intensity: range(25, 100),
    interruptionsPerMinute: z.number().int().min(1).max(60),
    participation: z.enum(['fifo', 'first-time']),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export const defaultEnvelope: Envelope = {
  version: 1,
  intervalMs: { min: 500, max: 1500 },
  batchSize: { min: 1, max: 4 },
  intensity: { min: 35, max: 100 },
  interruptionsPerMinute: 30,
  participation: 'first-time',
};
export type Settings = z.infer<typeof settings>;
export type Decision = z.infer<typeof telemetry>['decisions'][number];
/** Creator-language validation; the zod schema stays the authority on accepted shapes. */
export function envelopeProblems(envelope: Envelope) {
  const problems: { key: keyof Envelope; message: string }[] = [];
  const bounds = {
    intervalMs: ['Pause between batches', 250, 2000],
    batchSize: ['Effects per batch', 1, 6],
    intensity: ['Visual intensity', 25, 100],
  } as const;
  for (const [key, [label, low, high]] of Object.entries(bounds) as [
    keyof typeof bounds,
    (typeof bounds)[keyof typeof bounds],
  ][]) {
    const { min, max } = envelope[key];
    if (![min, max].every((v) => Number.isInteger(v) && v >= low && v <= high))
      problems.push({ key, message: `${label} must be a whole number from ${low} to ${high}.` });
    else if (min > max)
      problems.push({
        key,
        message:
          key === 'intervalMs'
            ? 'During a burst, the pause between batches must be at least as long as in quiet chat.'
            : `During a burst, ${label.toLowerCase()} must not exceed the quiet-chat value.`,
      });
  }
  const n = envelope.interruptionsPerMinute;
  if (!Number.isInteger(n) || n < 1 || n > 60)
    problems.push({
      key: 'interruptionsPerMinute',
      message: 'Interruptions per minute must be a whole number from 1 to 60.',
    });
  return problems;
}
const settings = z.object({
  intervalMs: z.number().int().min(250).max(2000),
  batchSize: z.number().int().min(1).max(6),
  intensity: z.number().int().min(25).max(100),
});
const mode = z.enum(['balanced', 'gameplay', 'locked', 'manual']);
const count = z.number().int().nonnegative();
const telemetry = z.object({
  mode,
  settings,
  accepted: count,
  offered: count,
  presented: count,
  coalesced: count,
  expired: count,
  cleared: count,
  pending: count.max(120),
  decisions: z
    .array(
      z.object({
        at: z.number(),
        reason: z.string().max(500),
        settings,
        pending: count,
        activity: count,
      }),
    )
    .max(50),
});
const frame = z.object({
  id: z.string().max(200),
  asset: z.enum(['tomato', 'star', 'heart']),
  x: z.number().min(0).max(1),
  viewer: z.string().max(100).nullable(),
  automationId: z.string().optional(),
  versionId: z.string().optional(),
  intensity: z.number().int().min(25).max(100).optional(),
});
const revision = z.object({
  revision: count,
  digest: z.string().max(128),
  envelope: envelopeSchema,
});
export const evidenceSchema = z.object({
  hash: z.string(),
  digest: z.string(),
  versionId: z.string(),
  artifactId: z.string(),
  scenarioHash: z.string(),
  rehearsalHash: z.string(),
  passed: z.boolean(),
  accepted: count,
  blocked: count,
  scores: z.record(z.string(), z.number()),
  contributions: count,
  stateDigest: z.string(),
  replayStateDigest: z.string(),
  telemetry,
  samples: z
    .array(z.object({ at: z.number().nonnegative(), frames: z.array(frame).max(120) }))
    .max(1000),
  provenance: z.literal('synthetic'),
});
export const stateSchema = z.object({
  revision: count,
  draft: revision.extend({ evidence: evidenceSchema.nullable() }).nullable(),
  approved: revision.extend({ evidenceHash: z.string(), approvedAt: z.number() }).nullable(),
  enabled: z.boolean(),
  mode,
  settings: settings.nullable(),
  history: z.array(revision).max(50),
  telemetry: telemetry.nullable(),
});
export type DirectorState = z.infer<typeof stateSchema>;
