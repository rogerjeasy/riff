import { z } from 'zod';

/** Browser-side mirror of the server's F30 insights contract (validated on arrival). */
export const RANGES = [
  { value: 'stream', label: 'Last stream' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
] as const;
export type InsightRange = (typeof RANGES)[number]['value'];

const count = z.number().int().nonnegative();
const reason = z.string().max(40);
export const insightsSchema = z.object({
  range: z.object({
    kind: z.enum(['stream', '24h', '7d']),
    from: z.number(),
    to: z.number(),
    bucketMs: z.number().positive(),
  }),
  minimumGroup: z.number().int().positive(),
  empty: z.boolean(),
  participation: z.object({
    participants: count.nullable(),
    attempts: count,
    admitted: count,
    blocked: count,
    activeMinutes: count,
    perActiveMinute: z.number().nonnegative(),
    series: z
      .array(
        z.object({
          start: z.number(),
          suppressed: z.boolean(),
          admitted: count.nullable(),
          blocked: count.nullable(),
          participants: count.nullable(),
        }),
      )
      .max(60),
  }),
  blocked: z.object({
    total: count,
    reasons: z.array(z.object({ reason, label: z.string().max(80), count })).max(20),
  }),
  automations: z
    .array(
      z.object({
        automationId: z.string(),
        title: z.string().max(200),
        triggers: count,
        admitted: count,
        blocked: count,
        participants: count.nullable(),
        incidents: count,
        reasons: z.array(z.object({ reason, count })).max(20),
      }),
    )
    .max(50),
  sessions: z.object({ started: count, finished: count, goal: count, deadline: count }),
  compiles: z.object({
    total: count,
    ready: count,
    question: count,
    unsupported: count,
    failed: count,
    cancelled: count,
    successRate: z.number().min(0).max(1).nullable(),
    medianMs: count.nullable(),
    p90Ms: count.nullable(),
  }),
  incidents: z.object({ total: count }),
  proposals: z.object({
    suggestions: count,
    contributors: count.nullable(),
    ballots: count,
    votes: count,
    selections: count,
  }),
  takeaways: z
    .array(z.object({ tone: z.enum(['good', 'warn', 'info']), text: z.string().max(300) }))
    .max(6),
});
export type Insights = z.infer<typeof insightsSchema>;

export const REASON_LABELS: Record<string, string> = {
  'viewer-limit': 'Per-viewer limit',
  'channel-budget': 'Channel effect budget',
  role: 'Audience not allowed',
  finished: 'Round already finished',
  paused: 'Paused or stopped',
  resources: 'Out of round resources',
  join: 'Join step missing',
  'participant-cap': 'Round full',
  duplicate: 'Duplicate delivery',
  capacity: 'Gameplay queue full',
  error: 'Invalid event or incident',
};
