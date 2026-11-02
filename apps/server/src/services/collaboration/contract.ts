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
  /** How long the host may choose to wait for a lost required channel. */
  waitMs: 120000,
  /** Host-initiated continuation decisions per session (audit receipts). */
  decisions: 32,
  /** How long an outgoing raid this coordinator observed can confirm a handoff. */
  raidMs: 300000,
});
/**
 * What a role's command does inside the one pinned shared definition. Absent means
 * `contribute` (the original single shared action). `burst` and `unlock:<milestone>` map to
 * the definition's own version 2 commands, so no role gains authority the definition lacks.
 */
export const sharedActionSchema = z
  .string()
  .regex(/^(contribute|burst|unlock:[a-z][a-z0-9-]{0,31})$/, 'Unknown shared action');
export type SharedAction = z.infer<typeof sharedActionSchema>;
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
    action: sharedActionSchema.optional(),
    fields: z
      .array(z.enum(['score', 'remaining', 'contributions', 'mechanics']))
      .max(4)
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
    /** Opt-in, approved by every channel: a raid from the host may hand off presentation. */
    raidHandoff: z.boolean().optional(),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const problem = sharedProblem(contract.artifact.manifest.experience, contract.roles);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
type Definition = NonNullable<z.infer<typeof artifactSchema>['manifest']['experience']>;
/**
 * Shared sessions are cooperative and teamless. Version 2 burst and milestones work on the
 * one community side. Health needs two or more opposing teams (and is therefore impossible
 * here); best-of-N `match` is excluded because its intermissions reset the shared pool and
 * would need a separate reviewed continuity model for departures and raid handoff.
 */
export function sharedProblem(
  definition: Definition | null | undefined,
  roles: readonly Pick<SharedRole, 'action'>[],
): string | null {
  if (!definition || definition.teams.length)
    return 'Sharing requires a teamless cooperative round';
  const kind = definition.objective.kind;
  if (kind !== 'collective-goal' && !(kind === 'burst' && definition.version === 2))
    return 'Sharing requires a teamless cooperative round';
  if (definition.version === 2 && (definition.mechanics?.match || definition.mechanics?.health))
    return 'Shared rounds support burst and milestones; best-of-N matches and health are excluded';
  for (const role of roles)
    if (actionCommand(definition, role.action) === null)
      return 'Every role action must use a command from the approved definition';
  if (!objectiveReachable(definition, roles))
    return 'At least one role must be able to reach the shared objective';
  return null;
}
/** The definition command a role action dispatches, or null when the definition lacks it. */
export function actionCommand(definition: Definition, action: SharedAction | undefined) {
  if (!action || action === 'contribute') return definition.contribution.command;
  if (definition.version !== 2) return null;
  if (action === 'burst') return definition.mechanics?.burst?.command ?? null;
  const id = action.slice('unlock:'.length);
  return definition.mechanics?.milestones.find((m) => m.id === id)?.unlock?.command ?? null;
}
/** Whether these roles' actions can still complete the objective (contributions or bursts). */
export function objectiveReachable(
  definition: Definition,
  roles: readonly Pick<SharedRole, 'action'>[],
) {
  const actions = new Set(roles.map((r) => r.action ?? 'contribute'));
  if (definition.objective.kind === 'burst' && definition.mechanics?.burst?.command)
    return actions.has('burst');
  return actions.has('contribute');
}
export type SharedContract = z.infer<typeof contractSchema>;
/** Exact public recipe identity; approval excludes no rule, role or test. */
export function contractDigest(contract: Omit<SharedContract, 'digest'> | SharedContract): string {
  // Optional additions (raidHandoff, role.action) serialize away when absent, so digests of
  // agreements created before them stay stable.
  const { id, versionId, artifactId, artifact, tests, title, roles, raidHandoff } = contract;
  return createHash('sha256')
    .update(
      JSON.stringify({ id, versionId, artifactId, artifact, tests, title, roles, raidHandoff }),
    )
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
    /** Version 2 community standing, granted by the `mechanics` field. */
    bursts: z.number().int().min(0).max(1000).optional(),
    tier: z.number().int().min(0).max(4).optional(),
    /** Role label of the channel presenting after an approved raid handoff. */
    presenter: safeText(60).optional(),
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
  /** The host chose to continue without this required role; it no longer gates play. */
  dropped?: boolean;
  /** The host chose to wait for this lost role until this time. */
  waitUntil?: number;
  /** This role presents the shared session after an approved raid handoff. */
  presenting?: boolean;
  /** This (raiding) role handed off presentation; its departure no longer pauses play. */
  released?: boolean;
}
/** One audited host decision: continuation choices and raid handoffs. */
export interface SharedDecisionRecord {
  code: string;
  at: number;
}
export interface SharedView {
  contract: SharedContract;
  revision: number;
  status: z.infer<typeof sharedStatusSchema>;
  reason: string | null;
  members: {
    roleId: string;
    approved: boolean;
    connected: boolean;
    dropped: boolean;
    presenting: boolean;
  }[];
  /** Required roles that are gone while play is paused: the host's continuation choice. */
  lost: string[];
  waitUntil: number | null;
  decisions: SharedDecisionRecord[];
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
  const burst = rule.version === 2 ? rule.mechanics?.burst : null;
  const milestone =
    role.action?.startsWith('unlock:') && rule.version === 2
      ? rule.mechanics?.milestones.find((m) => `unlock:${m.id}` === role.action)
      : undefined;
  const effect =
    role.action === 'burst' && burst
      ? `${burst.participants} different viewers within ${Math.ceil(burst.windowMs / 1000)}s trigger ${burst.label}${burst.points ? ` (+${burst.points} points)` : ''}.`
      : milestone?.unlock
        ? `unlocks after ${milestone.label} · +${milestone.unlock.points} points, one ${rule.resource.name} each.`
        : `${rule.resource.perParticipant} ${rule.resource.name} per person this round.`;
  return {
    title: contract.title,
    roleLabel: role.label,
    instructions: `${role.label}: ${who} can type ${role.command} · ${effect}`,
    ...(role.fields.includes('score') &&
    rule.objective.kind === 'collective-goal' &&
    rule.objective.target !== null
      ? { target: rule.objective.target }
      : {}),
  };
}
