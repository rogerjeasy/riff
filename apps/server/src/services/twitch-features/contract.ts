import { z } from 'zod';
import { TWITCH_ACTION_LIMITS } from '@riff/sdk';

export const FEATURES = ['polls', 'announcements', 'shoutouts'] as const;
export type Feature = (typeof FEATURES)[number];
/** Riff capability that each feature backs, for the "used by" summary. */
export const FEATURE_CAPABILITY = {
  polls: 'polls',
  announcements: 'chat.announce',
  shoutouts: 'shoutout',
} as const satisfies Record<Feature, string>;

export const SHOUTOUT_POLICY_LIMITS = Object.freeze({
  allowlist: 25,
  raiders: 20,
  raiderWindowMs: 60 * 60_000,
});
export const HISTORY_LIMIT = 20;

const login = z
  .string()
  .trim()
  .toLowerCase()
  .regex(new RegExp(TWITCH_ACTION_LIMITS.shoutout.loginPattern));
const channel = z
  .object({ id: z.string().regex(/^[0-9]{1,32}$/), login, displayName: z.string().max(60) })
  .strict();
export type ApprovedChannel = z.infer<typeof channel>;

const pollSnapshot = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().max(60),
    choices: z
      .array(
        z
          .object({
            id: z.string().max(100),
            title: z.string().max(25),
            votes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(5),
    status: z.enum(['ACTIVE', 'COMPLETED', 'TERMINATED', 'ARCHIVED', 'MODERATED', 'INVALID']),
    startedAt: z.number().int(),
    endsAt: z.number().int(),
    endedAt: z.number().int().nullable(),
    origin: z.enum(['manual', 'automation']),
    automationId: z.string().max(100).nullable(),
    refreshedAt: z.number().int(),
  })
  .strict();
export type PollSnapshot = z.infer<typeof pollSnapshot>;

const historyEntry = z
  .object({
    at: z.number().int(),
    kind: z.enum(['poll.start', 'poll.end', 'announce', 'shoutout']),
    origin: z.enum(['manual', 'automation', 'panic']),
    outcome: z.enum(['sent', 'refused', 'failed', 'simulated']),
    code: z.string().max(40),
    message: z.string().max(300),
    automationId: z.string().max(100).nullable(),
  })
  .strict();
export type HistoryEntry = z.infer<typeof historyEntry>;

/** Durable state; budgets and cooldowns survive restarts so a restart never refills them. */
export const storedSchema = z
  .object({
    version: z.literal(1),
    disabled: z.array(z.enum(FEATURES)).max(3),
    broadcasterType: z.enum(['partner', 'affiliate', '']).nullable(),
    eligibilityCheckedAt: z.number().int().nullable(),
    shoutout: z
      .object({
        mode: z.enum(['off', 'allowlist', 'raiders']),
        allowlist: z.array(channel).max(SHOUTOUT_POLICY_LIMITS.allowlist),
      })
      .strict(),
    raiders: z
      .array(z.object({ ...channel.shape, at: z.number().int() }).strict())
      .max(SHOUTOUT_POLICY_LIMITS.raiders),
    poll: pollSnapshot.nullable(),
    windows: z
      .object({
        announcements: z.array(z.number().int()).max(64),
        polls: z.array(z.number().int()).max(64),
        shoutouts: z.array(z.number().int()).max(64),
        shoutoutTargets: z.record(z.string(), z.number().int()),
      })
      .strict(),
    history: z.array(historyEntry).max(HISTORY_LIMIT),
  })
  .strict();
export type StoredTwitchFeatures = z.infer<typeof storedSchema>;

export function emptyState(): StoredTwitchFeatures {
  return {
    version: 1,
    disabled: [],
    broadcasterType: null,
    eligibilityCheckedAt: null,
    shoutout: { mode: 'off', allowlist: [] },
    raiders: [],
    poll: null,
    windows: { announcements: [], polls: [], shoutouts: [], shoutoutTargets: {} },
    history: [],
  };
}

/** Request bodies (routes parse with these; the Helix client re-validates Twitch bounds). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), {
      message: 'Control characters are not allowed',
    });
export const pollBody = z
  .object({
    title: text(TWITCH_ACTION_LIMITS.poll.titleLength),
    choices: z
      .array(text(TWITCH_ACTION_LIMITS.poll.choiceLength))
      .min(TWITCH_ACTION_LIMITS.poll.choices.min)
      .max(TWITCH_ACTION_LIMITS.poll.choices.max),
    durationSeconds: z
      .number()
      .int()
      .min(TWITCH_ACTION_LIMITS.poll.durationSeconds.min)
      .max(TWITCH_ACTION_LIMITS.poll.durationSeconds.max),
  })
  .strict();
export const announceBody = z
  .object({
    message: text(TWITCH_ACTION_LIMITS.announcement.messageLength),
    color: z.enum(['blue', 'green', 'orange', 'purple', 'primary']).default('primary'),
  })
  .strict();
export const shoutoutBody = z.object({ login }).strict();
export const policyBody = z
  .object({
    mode: z.enum(['off', 'allowlist', 'raiders']),
    logins: z.array(login).max(SHOUTOUT_POLICY_LIMITS.allowlist),
  })
  .strict();
export const featureToggleBody = z
  .object({ feature: z.enum(FEATURES), enabled: z.boolean() })
  .strict();
