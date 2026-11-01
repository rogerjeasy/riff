import { z } from 'zod';
import type { DecisionCode } from '@riff/sdk';

/** Any group smaller than this is reported as suppressed rather than counted. */
export const MIN_GROUP = 3;
export const INSIGHT_RANGES = ['stream', '24h', '7d'] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];
/** A "stream" is the latest run of chat activity without a gap this long. */
export const STREAM_GAP_MS = 30 * 60_000;
export const STREAM_MAX_MS = 12 * 60 * 60_000;
export const MAX_BUCKETS = 48;

export const BLOCKED_REASONS = [
  'viewer-limit',
  'channel-budget',
  'role',
  'finished',
  'paused',
  'resources',
  'join',
  'participant-cap',
  'duplicate',
  'capacity',
  'mechanics',
  'below-minimum',
  'error',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** Host decision codes grouped into creator-facing reasons; UNRELATED is not a trigger. */
export const REASON_OF: Record<Exclude<DecisionCode, 'ACCEPTED' | 'UNRELATED'>, BlockedReason> = {
  VIEWER_LIMIT: 'viewer-limit',
  CHANNEL_LIMIT: 'channel-budget',
  AUDIENCE: 'role',
  SESSION_FINISHED: 'finished',
  SESSION_PAUSED: 'paused',
  STOPPED: 'paused',
  DISABLED: 'paused',
  RESOURCE_LIMIT: 'resources',
  NOT_JOINED: 'join',
  ALREADY_JOINED: 'join',
  PARTICIPANT_LIMIT: 'participant-cap',
  DUPLICATE: 'duplicate',
  CAPACITY: 'capacity',
  ELIMINATED: 'mechanics',
  LOCKED: 'mechanics',
  HEALTH_FULL: 'mechanics',
  BURST_COUNTED: 'mechanics',
  BURST_ACTIVE: 'mechanics',
  BURST_LIMIT: 'mechanics',
  ROUND_INTERMISSION: 'mechanics',
  BELOW_MINIMUM: 'below-minimum',
  INVALID_EVENT: 'error',
  INCIDENT: 'error',
};
export const REASON_LABEL: Record<BlockedReason, string> = {
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
  mechanics: 'Game rule (eliminated, locked, burst or round break)',
  'below-minimum': 'Twitch event below the minimum',
  error: 'Invalid event or incident',
};

const count = z.number().int().nonnegative();
const reasonCount = z.object({ reason: z.enum(BLOCKED_REASONS), count }).strict();
export const insightsSchema = z
  .object({
    range: z
      .object({
        kind: z.enum(INSIGHT_RANGES),
        from: z.number().int(),
        to: z.number().int(),
        bucketMs: z.number().int().positive(),
      })
      .strict(),
    minimumGroup: z.literal(MIN_GROUP),
    empty: z.boolean(),
    participation: z
      .object({
        /** Null when 1–2 people took part: too few to report without singling anyone out. */
        participants: count.nullable(),
        attempts: count,
        admitted: count,
        blocked: count,
        activeMinutes: count,
        perActiveMinute: z.number().nonnegative(),
        series: z
          .array(
            z
              .object({
                start: z.number().int(),
                suppressed: z.boolean(),
                admitted: count.nullable(),
                blocked: count.nullable(),
                participants: count.nullable(),
              })
              .strict(),
          )
          .max(MAX_BUCKETS + 1),
      })
      .strict(),
    blocked: z
      .object({
        total: count,
        reasons: z.array(reasonCount.extend({ label: z.string() }).strict()),
      })
      .strict(),
    automations: z
      .array(
        z
          .object({
            automationId: z.string(),
            title: z.string().max(200),
            triggers: count,
            admitted: count,
            blocked: count,
            participants: count.nullable(),
            incidents: count,
            reasons: z.array(reasonCount),
          })
          .strict(),
      )
      .max(50),
    sessions: z.object({ started: count, finished: count, goal: count, deadline: count }).strict(),
    compiles: z
      .object({
        total: count,
        ready: count,
        question: count,
        unsupported: count,
        failed: count,
        cancelled: count,
        successRate: z.number().min(0).max(1).nullable(),
        medianMs: count.nullable(),
        p90Ms: count.nullable(),
      })
      .strict(),
    incidents: z.object({ total: count }).strict(),
    proposals: z
      .object({
        suggestions: count,
        contributors: count.nullable(),
        ballots: count,
        votes: count,
        selections: count,
      })
      .strict(),
    takeaways: z
      .array(z.object({ tone: z.enum(['good', 'warn', 'info']), text: z.string().max(300) }))
      .max(6),
  })
  .strict();
export type Insights = z.infer<typeof insightsSchema>;
