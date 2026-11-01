import { createHash } from 'node:crypto';
import { z } from 'zod';
import { artifactSchema, scenariosSchema } from '@riff/sandbox';
import { AUDIENCE_ROLES, DECISION_CODES, SESSION_LIMITS } from '@riff/sdk';

export const SHARED_LIMITS = Object.freeze({
  members: 4,
  sessions: 20,
  receipts: 10000,
  pending: 128,
  inviteMs: 900000,
  leaseMs: 10000,
  pollMs: 2000,
});
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (s) => ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      'Control characters forbidden',
    );
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const roleSchema = z
  .object({
    id: identifier,
    label: safeText(60),
    channelId: z.string().regex(/^\d{1,32}$/),
    command: z
      .string()
      .regex(/^![a-z0-9_-]{1,32}$/)
      .refine((s) => s !== '!riff', 'Reserved command'),
    required: z.boolean(),
    fields: z
      .array(z.enum(['score', 'remaining', 'contributions']))
      .max(3)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const rolesSchema = z
  .array(roleSchema)
  .min(2)
  .max(SHARED_LIMITS.members)
  .superRefine((roles, ctx) => {
    for (const key of ['id', 'channelId', 'command'] as const)
      if (new Set(roles.map((r) => r[key])).size !== roles.length)
        ctx.addIssue({ code: 'custom', message: `Role ${key} values must be unique` });
    if (!roles.some((r) => r.required))
      ctx.addIssue({ code: 'custom', message: 'At least one role must be required' });
  });
export type SharedRole = z.infer<typeof roleSchema>;
export const contractSchema = z
  .object({
    id: z.string().uuid(),
    digest: digestSchema,
    versionId: z.string().uuid(),
    artifactId: digestSchema,
    artifact: artifactSchema,
    tests: scenariosSchema,
    title: safeText(120),
    roles: rolesSchema,
  })
  .strict()
  .superRefine((contract, ctx) => {
    const definition = contract.artifact.manifest.experience;
    if (!definition || definition.teams.length || definition.objective.kind !== 'collective-goal')
      ctx.addIssue({ code: 'custom', message: 'Sharing requires a teamless cooperative round' });
  });
export type SharedContract = z.infer<typeof contractSchema>;
/** Exact public recipe identity; approval excludes no rule, role or test. */
export function contractDigest(contract: Omit<SharedContract, 'digest'> | SharedContract): string {
  const { id, versionId, artifactId, artifact, tests, title, roles } = contract;
  return createHash('sha256')
    .update(JSON.stringify({ id, versionId, artifactId, artifact, tests, title, roles }))
    .digest('hex');
}
export const sharedStatusSchema = z.enum(['waiting', 'running', 'paused', 'finished']);
export const projectionSchema = z
  .object({
    sessionId: z.string().uuid(),
    digest: digestSchema,
    revision: z.number().int().nonnegative(),
    title: safeText(120),
    roleId: identifier,
    roleLabel: safeText(60),
    status: sharedStatusSchema,
    reason: safeText(240).nullable(),
    instructions: safeText(500),
    score: z.number().int().min(0).max(SESSION_LIMITS.maxScore).optional(),
    target: z.number().int().positive().max(SESSION_LIMITS.maxScore).optional(),
    remaining: z.number().int().min(0).max(SESSION_LIMITS.durationMs.max).optional(),
    contributions: z
      .number()
      .int()
      .min(0)
      .max(SESSION_LIMITS.maxParticipants * SESSION_LIMITS.resourcePerParticipant)
      .optional(),
  })
  .strict();
export type SharedProjection = z.infer<typeof projectionSchema>;
/** What the local overlay and console receive: the peer projection plus locally approved labels. */
export type SharedPresentationFrame = SharedProjection & { partners?: string[] };
export const inputSchema = z
  .object({
    id: z.string().min(1).max(100),
    channelId: z.string().regex(/^\d{1,32}$/),
    viewerId: z.string().min(1).max(100),
    roles: z.array(z.enum(AUDIENCE_ROLES)).min(1).max(4),
    text: z
      .string()
      .max(500)
      .refine((s) => ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)),
    sourceChannelId: z.string().regex(/^\d{1,32}$/),
    sourceMessageId: z.string().min(1).max(100),
  })
  .strict();
export type SharedInput = z.infer<typeof inputSchema>;
export const sharedDecisionSchema = z
  .object({
    code: z.enum([...DECISION_CODES, 'IGNORED']),
    reason: safeText(500),
    projection: projectionSchema,
  })
  .strict();
export type SharedDecision = z.infer<typeof sharedDecisionSchema>;
export interface SharedMember {
  roleId: string;
  tokenHash: string | null;
  expiresAt: number;
  approved: boolean;
  leaseUntil: number;
}
export interface SharedView {
  contract: SharedContract;
  revision: number;
  status: z.infer<typeof sharedStatusSchema>;
  reason: string | null;
  members: { roleId: string; approved: boolean; connected: boolean }[];
}
export class CollaborationError extends Error {
  constructor(
    public readonly code:
      'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT' | 'UNAUTHORIZED' | 'BLOCKED',
    message: string,
  ) {
    super(message);
  }
}

/** Public guidance is derived from approved authority, never supplied by a remote response. */
export function sharedPresentation(contract: SharedContract, roleId: string) {
  const role = contract.roles.find((r) => r.id === roleId);
  const rule = contract.artifact.manifest.experience;
  if (!role || !rule)
    throw new CollaborationError('BLOCKED', 'The approved shared role is missing.');
  const audience = contract.artifact.manifest.trigger.audience;
  const who = audience.includes('viewer') ? 'Everyone' : audience.join(' or ');
  return {
    title: contract.title,
    roleLabel: role.label,
    instructions: `${role.label}: ${who} can type ${role.command} · ${rule.resource.perParticipant} ${rule.resource.name} per person this round.`,
    ...(role.fields.includes('score') && rule.objective.target !== null
      ? { target: rule.objective.target }
      : {}),
  };
}
