import { z } from 'zod';
import {
  MECHANIC_LIMITS,
  SESSION_LIMITS,
  TRIGGER_LIMITS,
  type ExperienceDefinition,
  type SessionSnapshot,
} from '@riff/sdk';
import {
  mechanicsActionFor,
  stageMechanicsAction,
  advanceMechanics,
  createMechanicsState,
  maxRemainingMs,
  mechanicsProblems,
  mechanicsSchema,
  mechanicsStateSchema,
  validateMechanicsState,
} from './mechanics.js';

const timestamp = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - SESSION_LIMITS.durationMs.max);
const command = z.string().regex(new RegExp(TRIGGER_LIMITS.commandPattern));
const cleanText = (s: string) =>
  [...s].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const label = z.string().trim().min(1).max(SESSION_LIMITS.labelLength).refine(cleanText);
const teamId = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/)
  .refine((s) => !['__proto__', 'constructor', 'prototype', 'community', 'tie'].includes(s));
/** Validate generated rules before starting a session. Example: sessionDefinitionSchema.parse(value). */
export const sessionDefinitionSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    title: z.string().trim().min(1).max(SESSION_LIMITS.titleLength).refine(cleanText),
    durationMs: z
      .number()
      .int()
      .min(SESSION_LIMITS.durationMs.min)
      .max(SESSION_LIMITS.durationMs.max),
    maxParticipants: z.number().int().min(1).max(SESSION_LIMITS.maxParticipants),
    teams: z
      .array(z.object({ id: teamId, label, joinCommand: command }).strict())
      .max(SESSION_LIMITS.maxTeams),
    resource: z
      .object({
        name: label,
        perParticipant: z.number().int().min(1).max(SESSION_LIMITS.resourcePerParticipant),
      })
      .strict(),
    contribution: z
      .object({
        command,
        points: z.number().int().min(1).max(SESSION_LIMITS.pointsPerContribution),
      })
      .strict(),
    objective: z
      .object({
        kind: z.enum(['highest-score', 'collective-goal', 'burst']),
        target: z.number().int().min(1).max(SESSION_LIMITS.maxScore).nullable(),
      })
      .strict(),
    mechanics: mechanicsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.teams.map((t) => t.id),
      commands = value.teams.map((t) => t.joinCommand);
    if (
      new Set(ids).size !== ids.length ||
      new Set(commands).size !== commands.length ||
      commands.includes(value.contribution.command)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Team ids and commands must be unique and distinct from contribution command',
      });
    if ((value.objective.kind === 'highest-score') !== (value.objective.target === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Collective and burst goals require a target; highest-score uses null',
      });
    for (const message of mechanicsProblems(value)) ctx.addIssue({ code: 'custom', message });
    if (value.objective.kind === 'collective-goal' && value.teams.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Collective goals use the community score without teams',
      });
  });
const participantSchema = z
  .object({
    teamId: teamId.nullable(),
    remaining: z.number().int().min(0).max(SESSION_LIMITS.resourcePerParticipant),
    contributions: z.number().int().min(0).max(SESSION_LIMITS.resourcePerParticipant),
  })
  .strict();
// Parse dictionary entries individually: some schema libraries silently drop __proto__.
// Null-prototype dictionaries preserve every normalized viewer identity as data.
function dictionary<T>(schema: z.ZodType<T>, max: number) {
  return z.unknown().transform((value, ctx): Record<string, T> => {
    const result: Record<string, T> = Object.create(null);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > max
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid bounded dictionary' });
      return z.NEVER;
    }
    for (const [key, item] of Object.entries(value)) {
      const parsed = schema.safeParse(item);
      if (!key || key.length > 100 || !parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid dictionary entry', path: [key] });
        return z.NEVER;
      }
      result[key] = parsed.data;
    }
    return result;
  });
}
/** Validate persisted JSON state. Example: sessionSnapshotSchema.parse(snapshot). */
export const sessionSnapshotSchema = z
  .object({
    id: z.string().min(1).max(100),
    phase: z.enum(['running', 'paused', 'finished']),
    startedAt: timestamp,
    deadlineAt: timestamp.nullable(),
    remainingMs: z
      .number()
      .int()
      .min(0)
      .max(SESSION_LIMITS.durationMs.max + MECHANIC_LIMITS.intermissionMs.max),
    updatedAt: timestamp,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    participants: dictionary(participantSchema, SESSION_LIMITS.maxParticipants),
    scores: dictionary(
      z.number().int().min(0).max(SESSION_LIMITS.maxScore),
      SESSION_LIMITS.maxTeams,
    ),
    winner: z.string().max(32).nullable(),
    outcome: z.enum(['deadline', 'goal', 'elimination']).nullable(),
    mechanics: mechanicsStateSchema.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      s.updatedAt < s.startedAt ||
      (s.phase === 'running' &&
        (s.deadlineAt === null ||
          s.remainingMs === 0 ||
          s.deadlineAt !== s.updatedAt + s.remainingMs ||
          s.outcome !== null ||
          s.winner !== null)) ||
      (s.phase === 'paused' &&
        (s.deadlineAt !== null ||
          s.remainingMs === 0 ||
          s.outcome !== null ||
          s.winner !== null)) ||
      (s.phase === 'finished' &&
        (s.deadlineAt !== null || s.remainingMs !== 0 || s.outcome === null))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent session phase or clock' });
  });
/** Check snapshot rules as well as JSON shape. Example: validateSessionSnapshot(definition, snapshot). */
export function validateSessionSnapshot(
  definition: ExperienceDefinition,
  raw: unknown,
): SessionSnapshot {
  const d = sessionDefinitionSchema.parse(definition),
    s = sessionSnapshotSchema.parse(raw);
  const keys = d.teams.length ? d.teams.map((t) => t.id) : ['community'];
  if (
    Object.keys(s.scores).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(s.scores, key)) ||
    Object.keys(s.participants).length > d.maxParticipants ||
    s.remainingMs > maxRemainingMs(d) ||
    (!d.mechanics && s.remainingMs > d.durationMs) ||
    (!d.mechanics && (s.mechanics !== undefined || s.outcome === 'elimination'))
  )
    throw new Error('Snapshot does not match experience definition');
  if (d.mechanics) {
    for (const participant of Object.values(s.participants)) {
      const key = participant.teamId ?? 'community';
      if (
        !keys.includes(key) ||
        (d.teams.length > 0 && participant.teamId === null) ||
        participant.remaining + participant.contributions !== d.resource.perParticipant
      )
        throw new Error('Invalid session participant resources');
    }
    validateMechanicsState(d, s);
    return s;
  }
  const totals: Record<string, number> = Object.create(null);
  for (const key of keys) totals[key] = 0;
  for (const participant of Object.values(s.participants)) {
    const key = participant.teamId ?? 'community';
    if (
      !keys.includes(key) ||
      (d.teams.length > 0 && participant.teamId === null) ||
      participant.remaining + participant.contributions !== d.resource.perParticipant
    )
      throw new Error('Invalid session participant resources');
    totals[key] = (totals[key] ?? 0) + participant.contributions * d.contribution.points;
  }
  if (
    keys.some((key) => s.scores[key] !== totals[key]) ||
    (s.winner !== null && s.winner !== 'tie' && !keys.includes(s.winner))
  )
    throw new Error('Invalid session scores');
  const goalReached =
    d.objective.kind === 'collective-goal' &&
    (s.scores.community ?? 0) >= (d.objective.target ?? Infinity);
  if (
    (goalReached && (s.phase !== 'finished' || s.outcome !== 'goal' || s.winner !== 'community')) ||
    (s.outcome === 'goal' && !goalReached) ||
    (s.outcome === 'deadline' &&
      s.winner !== (d.objective.kind === 'collective-goal' ? null : winner(s.scores)))
  )
    throw new Error('Invalid session outcome');
  return s;
}
/** Create host-owned state. Example: createSessionSnapshot(definition, 0, 'round-1'). */
export function createSessionSnapshot(
  definition: ExperienceDefinition,
  at: number,
  id = 'preview',
): SessionSnapshot {
  const d = sessionDefinitionSchema.parse(definition);
  timestamp.parse(at);
  const scores: Record<string, number> = Object.create(null);
  for (const key of d.teams.length ? d.teams.map((t) => t.id) : ['community']) scores[key] = 0;
  return sessionSnapshotSchema.parse({
    id,
    phase: 'running',
    startedAt: at,
    deadlineAt: at + d.durationMs,
    remainingMs: d.durationMs,
    updatedAt: at,
    revision: 0,
    participants: Object.create(null),
    scores,
    winner: null,
    outcome: null,
    ...(d.mechanics ? { mechanics: createMechanicsState(d) } : {}),
  });
}
function winner(scores: Record<string, number>): string {
  const entries = Object.entries(scores),
    max = Math.max(...entries.map(([, value]) => value));
  const leaders = entries.filter(([, value]) => value === max);
  return leaders.length === 1 ? (leaders[0]?.[0] ?? 'tie') : 'tie';
}
/** Advance time and finish at the deadline. Example: advanceSession(snapshot, event.at). */
export function advanceSession(
  snapshot: SessionSnapshot,
  at: number,
  definition?: ExperienceDefinition,
): SessionSnapshot {
  const next = sessionSnapshotSchema.parse(snapshot);
  timestamp.parse(at);
  if (at < next.updatedAt) throw new Error('Session time cannot decrease');
  if (next.phase !== 'running') return next;
  if (definition?.mechanics) {
    const d = sessionDefinitionSchema.parse(definition);
    if (next.updatedAt !== at) {
      next.updatedAt = at;
      next.revision++;
    }
    advanceMechanics(d, next, at);
    return next;
  }
  next.remainingMs = Math.max(0, (next.deadlineAt ?? at) - at);
  if (next.updatedAt !== at) {
    next.updatedAt = at;
    next.revision++;
  }
  if (next.remainingMs === 0) {
    next.phase = 'finished';
    next.deadlineAt = null;
    next.winner = definition?.objective.kind === 'collective-goal' ? null : winner(next.scores);
    next.outcome = 'deadline';
  }
  return next;
}
/**
 * Apply one version 2 gameplay command with host rules only (no guest handler), e.g. to
 * build realistic populated snapshots for migration checks. Example:
 * applySessionCommand(definition, snapshot, { viewerId: 'ada', at: 5, text: '!attack' }).
 */
export function applySessionCommand(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  event: { viewerId: string; at: number; text: string },
): { code: string; snapshot: SessionSnapshot } {
  const d = sessionDefinitionSchema.parse(definition);
  if (!d.mechanics) throw new Error('Host-only commands require version 2 mechanics');
  const next = advanceSession(validateSessionSnapshot(d, snapshot), event.at, d);
  if (next.phase !== 'running')
    return {
      code: next.phase === 'paused' ? 'SESSION_PAUSED' : 'SESSION_FINISHED',
      snapshot: next,
    };
  const action = mechanicsActionFor(
    d,
    (text, command) => text.trim().toLowerCase() === command.toLowerCase(),
    event.text,
  );
  if (!action) return { code: 'UNRELATED', snapshot: next };
  const stage = stageMechanicsAction(d, next, event, action);
  return { code: stage.code, snapshot: validateSessionSnapshot(d, next) };
}
/** Freeze remaining round time. Example: pauseSession(snapshot, now). */
export function pauseSession(
  snapshot: SessionSnapshot,
  at: number,
  definition?: ExperienceDefinition,
): SessionSnapshot {
  const next = advanceSession(snapshot, at, definition);
  if (next.phase === 'running') {
    next.phase = 'paused';
    next.deadlineAt = null;
    next.revision = snapshot.revision + 1;
  }
  return next;
}
/** Restart the clock without restoring consumed resources. Example: resumeSession(snapshot, now). */
export function resumeSession(snapshot: SessionSnapshot, at: number): SessionSnapshot {
  const next = sessionSnapshotSchema.parse(snapshot);
  timestamp.parse(at);
  if (at < next.updatedAt) throw new Error('Session time cannot decrease');
  if (next.phase === 'paused') {
    next.phase = 'running';
    next.deadlineAt = at + next.remainingMs;
    next.updatedAt = at;
    next.revision++;
  }
  return next;
}
