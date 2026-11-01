import { z } from 'zod';

const command = z.string().regex(/^![a-z0-9_-]{1,32}$/);
const label = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(
    (value) =>
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
const teamId = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/)
  .refine(
    (value) => !['__proto__', 'constructor', 'prototype', 'community', 'tie'].includes(value),
  );
const integer = z.number().int().nonnegative().safe();
const timestamp = integer.max(Number.MAX_SAFE_INTEGER - 3600000);
/** Browser-owned validation mirrors the public contract; no SDK runtime crosses HTTP. */
export const experienceDefinitionSchema = z
  .object({
    version: z.literal(1),
    title: label.max(120),
    durationMs: z.number().int().min(1000).max(3600000),
    maxParticipants: z.number().int().min(1).max(256),
    teams: z.array(z.object({ id: teamId, label, joinCommand: command }).strict()).max(8),
    resource: z.object({ name: label, perParticipant: z.number().int().min(1).max(100) }).strict(),
    contribution: z.object({ command, points: z.number().int().min(1).max(100) }).strict(),
    objective: z
      .object({
        kind: z.enum(['highest-score', 'collective-goal']),
        target: z.number().int().min(1).max(2560000).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.teams.map((team) => team.id)).size !== value.teams.length ||
      new Set(value.teams.map((team) => team.joinCommand)).size !== value.teams.length ||
      value.teams.some((team) => team.joinCommand === value.contribution.command)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Team identities and commands must be unique.' });
    }
    if (
      (value.objective.kind === 'collective-goal') !== (value.objective.target !== null) ||
      (value.objective.kind === 'collective-goal' && value.teams.length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Collective goals require a target and community score.',
      });
    }
  });
export function dictionary<T>(schema: z.ZodType<T>, max: number) {
  return z.unknown().transform((value, ctx): Record<string, T> => {
    // Viewer identities are data, including __proto__; never discard or inherit them.
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
    for (const [key, entry] of Object.entries(value)) {
      const parsed = schema.safeParse(entry);
      if (!key || key.length > 100 || !parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid dictionary entry', path: [key] });
        return z.NEVER;
      }
      result[key] = parsed.data;
    }
    return result;
  });
}
export const sessionSnapshotSchema = z
  .object({
    id: z.string().min(1).max(100),
    phase: z.enum(['running', 'paused', 'finished']),
    startedAt: timestamp,
    deadlineAt: timestamp.nullable(),
    remainingMs: z.number().int().min(0).max(3600000),
    updatedAt: timestamp,
    revision: integer,
    participants: dictionary(
      z
        .object({
          teamId: teamId.nullable(),
          remaining: z.number().int().min(0).max(100),
          contributions: z.number().int().min(0).max(100),
        })
        .strict(),
      256,
    ),
    scores: dictionary(z.number().int().min(0).max(2560000), 8),
    winner: z.string().max(32).nullable(),
    outcome: z.enum(['deadline', 'goal']).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.updatedAt < value.startedAt ||
      (value.phase === 'running' &&
        (value.deadlineAt === null || value.outcome !== null || value.winner !== null)) ||
      (value.phase === 'paused' &&
        (value.deadlineAt !== null || value.outcome !== null || value.winner !== null)) ||
      (value.phase === 'finished' &&
        (value.deadlineAt !== null ||
          value.remainingMs !== 0 ||
          value.outcome === null ||
          value.winner === null))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent session phase or clock' });
    }
  });
export const overlaySessionSchema = z
  .object({
    versionId: z.string().optional(),
    automationId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    definition: experienceDefinitionSchema,
    snapshot: sessionSnapshotSchema,
  })
  .superRefine(({ definition, snapshot }, ctx) => {
    const keys = definition.teams.length ? definition.teams.map((team) => team.id) : ['community'];
    const totals = new Map(keys.map((key) => [key, 0]));
    let valid =
      Object.keys(snapshot.scores).length === keys.length &&
      keys.every((key) => Object.hasOwn(snapshot.scores, key)) &&
      Object.keys(snapshot.participants).length <= definition.maxParticipants &&
      snapshot.remainingMs <= definition.durationMs;
    for (const participant of Object.values(snapshot.participants)) {
      const key = participant.teamId ?? 'community';
      valid &&=
        totals.has(key) &&
        (definition.teams.length === 0 || participant.teamId !== null) &&
        participant.remaining + participant.contributions === definition.resource.perParticipant;
      totals.set(
        key,
        (totals.get(key) ?? 0) + participant.contributions * definition.contribution.points,
      );
    }
    valid &&=
      keys.every((key) => snapshot.scores[key] === totals.get(key)) &&
      (snapshot.winner === null || snapshot.winner === 'tie' || keys.includes(snapshot.winner));
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        message: 'Session evidence does not match the experience rules',
      });
  });
