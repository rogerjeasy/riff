import { z } from 'zod';

/** Boundary validation for GET /api/twitch/features; unknown fields are ignored. */
export const featureNames = ['polls', 'announcements', 'shoutouts'] as const;
export type FeatureName = (typeof featureNames)[number];
const featureSchema = z.object({
  feature: z.enum(featureNames),
  capability: z.string(),
  scope: z.string(),
  state: z.enum(['not-connected', 'needs-grant', 'disabled', 'checking', 'ineligible', 'ready']),
  message: z.string().max(400),
  usedBy: z
    .array(z.object({ automationId: z.string(), title: z.string(), live: z.boolean() }))
    .max(200),
});
export type FeatureStatus = z.infer<typeof featureSchema>;
const pollSchema = z.object({
  id: z.string(),
  title: z.string(),
  choices: z.array(z.object({ id: z.string(), title: z.string(), votes: z.number() })).max(5),
  status: z.enum(['ACTIVE', 'COMPLETED', 'TERMINATED', 'ARCHIVED', 'MODERATED', 'INVALID']),
  startedAt: z.number(),
  endsAt: z.number(),
  endedAt: z.number().nullable(),
  origin: z.enum(['manual', 'automation']),
  automationId: z.string().nullable(),
  refreshedAt: z.number(),
});
export type ActivePoll = z.infer<typeof pollSchema>;
const budget = z.object({
  used: z.number(),
  limit: z.number(),
  windowMs: z.number(),
  availableAt: z.number().nullable().optional(),
});
const channelSchema = z.object({ id: z.string(), login: z.string(), displayName: z.string() });
export const snapshotSchema = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
  stopped: z.boolean(),
  broadcasterType: z.string().nullable(),
  features: z.array(featureSchema).length(3),
  poll: pollSchema.nullable(),
  shoutout: z.object({
    mode: z.enum(['off', 'allowlist', 'raiders']),
    allowlist: z.array(channelSchema).max(25),
    raiders: z.array(z.object({ login: z.string(), displayName: z.string(), at: z.number() })),
    availableAt: z.number().nullable(),
  }),
  budgets: z.object({ announcements: budget, polls: budget, shoutouts: budget }),
  history: z
    .array(
      z.object({
        at: z.number(),
        kind: z.enum(['poll.start', 'poll.end', 'announce', 'shoutout']),
        origin: z.enum(['manual', 'automation', 'panic']),
        outcome: z.enum(['sent', 'refused', 'failed', 'simulated']),
        code: z.string(),
        message: z.string(),
        automationId: z.string().nullable(),
      }),
    )
    .max(50),
});
export type TwitchFeatures = z.infer<typeof snapshotSchema>;
export const responseSchema = z.object({ features: snapshotSchema });

/** Twitch's documented request bounds, mirrored for inline validation and counters. */
export const LIMITS = {
  pollTitle: 60,
  pollChoice: 25,
  choices: { min: 2, max: 5 },
  durations: [15, 30, 60, 120, 300, 600, 1800] as const,
  announcement: 500,
  login: /^[a-z0-9_]{1,25}$/,
};
