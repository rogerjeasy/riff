import { z } from 'zod';
import { experienceDefinitionSchema } from '../sessions/schemas.js';
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const publicFields = ['score', 'remaining', 'contributions', 'mechanics'] as const;
/** What a role's command does in the one shared definition (absent = contribute). */
export const sharedActionSchema = z
  .string()
  .regex(/^(contribute|burst|unlock:[a-z][a-z0-9-]{0,31})$/);
export const roleSchema = z
  .object({
    id,
    label: text(60),
    channelId: z.string().regex(/^\d{1,32}$/),
    command: z
      .string()
      .regex(/^![a-z0-9_-]{1,32}$/)
      .refine((s) => s !== '!riff'),
    required: z.boolean(),
    action: sharedActionSchema.optional(),
    fields: z
      .array(z.enum(publicFields))
      .max(4)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const rolesSchema = z
  .array(roleSchema)
  .min(2)
  .max(4)
  .refine((roles) =>
    (['id', 'channelId', 'command'] as const).every(
      (key) => new Set(roles.map((role) => role[key])).size === roles.length,
    ),
  );
export type SharedRole = z.infer<typeof roleSchema>;
const state = z.enum(['waiting', 'running', 'paused', 'finished']);
/** Browser boundary contains public aggregates only; private session snapshots are rejected. */
export const projectionSchema = z
  .object({
    sessionId: z.string().uuid(),
    digest,
    revision: z.number().int().nonnegative(),
    title: text(120),
    roleId: id,
    roleLabel: text(60),
    status: state,
    reason: text(240).nullable(),
    instructions: text(500),
    score: z.number().int().min(0).max(2560000).optional(),
    target: z.number().int().positive().max(2560000).optional(),
    remaining: z.number().int().min(0).max(3600000).optional(),
    contributions: z.number().int().min(0).max(25600).optional(),
    bursts: z.number().int().min(0).max(1000).optional(),
    tier: z.number().int().min(0).max(4).optional(),
    presenter: text(60).optional(),
    // Added locally from the approved contract (never by the coordinator) for display.
    partners: z.array(text(60)).max(3).optional(),
  })
  .strict();
export type SharedProjection = z.infer<typeof projectionSchema>;
export const contractSchema = z
  .object({
    id: z.string().uuid(),
    digest,
    versionId: z.string().uuid(),
    artifactId: digest,
    title: text(120),
    roles: rolesSchema,
    raidHandoff: z.boolean().optional(),
    artifact: z
      .object({
        source: z.string().max(32768),
        manifest: z
          .object({
            sdkVersion: z.string().max(20),
            capabilities: z.array(z.string().max(40)).max(16),
            trigger: z
              .object({
                command: z.string().max(33),
                audience: z
                  .array(z.enum(['viewer', 'subscriber', 'moderator', 'broadcaster']))
                  .min(1)
                  .max(4),
                maxPerViewer: z.number().int().positive().max(100),
                windowMs: z.number().int().min(1000).max(3600000),
              })
              .strict(),
            limits: z
              .object({
                effectsPerEvent: z.number().int().nonnegative(),
                effectsPerMinute: z.number().int().nonnegative(),
              })
              .strict(),
            experience: experienceDefinitionSchema,
          })
          .strict(),
      })
      .strict(),
    tests: z.array(z.unknown()).min(3).max(100),
  })
  .strict()
  .refine((v) => {
    const experience = v.artifact.manifest.experience;
    return (
      experience.teams.length === 0 &&
      experience.version <= 2 &&
      (experience.objective.kind === 'collective-goal' ||
        (experience.objective.kind === 'burst' && experience.version === 2)) &&
      !experience.mechanics?.match &&
      !experience.mechanics?.health
    );
  });
export const sharedViewSchema = z
  .object({
    contract: contractSchema,
    revision: z.number().int().nonnegative(),
    status: state,
    reason: z.string().max(240).nullable(),
    members: z
      .array(
        z
          .object({
            roleId: id,
            approved: z.boolean(),
            connected: z.boolean(),
            dropped: z.boolean(),
            presenting: z.boolean(),
          })
          .strict(),
      )
      .max(4),
    lost: z.array(id).max(4),
    waitUntil: z.number().int().nonnegative().nullable(),
    decisions: z
      .array(z.object({ code: z.string().max(40), at: z.number().int().nonnegative() }).strict())
      .max(50),
  })
  .strict();
export const reviewSchema = z
  .object({
    contract: contractSchema,
    roleId: id,
    verification: z
      .object({
        ok: z.boolean(),
        generated: z.number().int().nonnegative(),
        host: z.number().int().nonnegative(),
        stages: z
          .array(z.object({ label: z.string().max(120), status: z.string().max(32) }))
          .max(16),
      })
      .strict(),
    preview: z
      .object({
        label: z.string().max(200),
        codes: z.array(z.string().max(40)).max(20),
        score: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .refine((review) => review.contract.roles.some((role) => role.id === review.roleId));
export const memberSchema = z
  .object({
    state: z.enum(['idle', 'review', 'connected', 'paused', 'stopped']),
    reason: z.string().max(500).nullable(),
    origin: z.string().max(256).nullable(),
    review: reviewSchema.nullable(),
    projection: projectionSchema.nullable(),
    canRecheck: z.boolean(),
  })
  .strict();
export const statusSchema = z
  .object({
    configured: z.boolean(),
    ready: z.boolean(),
    channelId: z.string().max(32).nullable(),
    login: z.string().max(64).nullable().optional(),
    sessions: z.array(sharedViewSchema).max(20),
    member: memberSchema,
  })
  .strict();
export type CollaborationStatus = z.infer<typeof statusSchema>;
export type SharedView = z.infer<typeof sharedViewSchema>;
export type MemberReview = z.infer<typeof reviewSchema>;
export const invitationSchema = z
  .object({ origin: z.string().max(256), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const issuedInvitationSchema = invitationSchema.extend({
  expiresAt: z.number().int().nonnegative(),
  roleId: id,
});

const INVITE_PREFIX = 'riff-invite:';
const toBase64Url = (text: string) =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text: string) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
};
/** One copyable line: `riff-invite:` plus the coordinator origin and token. */
export function inviteCode(origin: string, token: string): string {
  return INVITE_PREFIX + toBase64Url(JSON.stringify({ origin, token }));
}
/** Accepts an invitation code or the raw JSON form; returns null for anything else. */
export function parseInvite(input: string): z.infer<typeof invitationSchema> | null {
  const text = input.trim();
  try {
    const json = text.startsWith(INVITE_PREFIX)
      ? fromBase64Url(text.slice(INVITE_PREFIX.length))
      : text;
    const parsed = invitationSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
