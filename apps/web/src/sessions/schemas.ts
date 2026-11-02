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
const bounded = (min: number, max: number) => z.number().int().min(min).max(max);
/** Definition version 2 mechanics; the host remains the authority on cross-field rules. */
const mechanicsSchema = z
  .object({
    match: z
      .object({ rounds: bounded(2, 9), intermissionMs: bounded(0, 60000) })
      .strict()
      .nullable(),
    health: z
      .object({
        label,
        max: bounded(1, 1000),
        damage: bounded(1, 1000),
        heal: z
          .object({ command, amount: bounded(1, 1000) })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    burst: z
      .object({
        command: command.nullable(),
        label,
        participants: bounded(2, 50),
        windowMs: bounded(1000, 60000),
        points: bounded(0, 100),
        limit: bounded(1, 20),
        shieldMs: bounded(0, 60000),
      })
      .strict()
      .nullable(),
    milestones: z
      .array(
        z
          .object({
            id: teamId,
            label,
            score: bounded(1, 2560000),
            unlock: z
              .object({ command, points: bounded(1, 100) })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
const MURAL_PALETTE = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'white',
  'black',
] as const;
const text = (max: number) => label.max(max);
const optionLabel = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(
    (value) => !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
/** Definition version 3 formats; the host remains the authority on cross-field rules. */
const formatSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mural'),
      width: bounded(2, 16),
      height: bounded(2, 16),
      palette: z.array(z.enum(MURAL_PALETTE)).min(2).max(8),
      overwrite: z.boolean(),
      reveal: z.enum(['live', 'end']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('composition'),
      tieBreak: z.literal('first-listed'),
      stages: z
        .array(
          z
            .object({
              id: teamId,
              label,
              options: z
                .array(z.object({ id: teamId, label: optionLabel }).strict())
                .min(2)
                .max(4),
            })
            .strict(),
        )
        .min(2)
        .max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal('quiz'),
      passPercent: bounded(1, 100),
      revealMs: bounded(0, 30000),
      questions: z
        .array(
          z
            .object({
              prompt: text(140),
              options: z.array(optionLabel).min(2).max(4),
              answer: bounded(0, 3),
              explanation: text(200),
            })
            .strict(),
        )
        .min(1)
        .max(5),
    })
    .strict(),
]);
/** Browser-owned validation mirrors the public contract; no SDK runtime crosses HTTP. */
export const experienceDefinitionSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    title: label.max(120),
    durationMs: z.number().int().min(1000).max(3600000),
    maxParticipants: z.number().int().min(1).max(256),
    teams: z.array(z.object({ id: teamId, label, joinCommand: command }).strict()).max(8),
    resource: z.object({ name: label, perParticipant: z.number().int().min(1).max(100) }).strict(),
    contribution: z.object({ command, points: z.number().int().min(1).max(100) }).strict(),
    objective: z
      .object({
        kind: z.enum(['highest-score', 'collective-goal', 'burst']),
        target: z.number().int().min(1).max(2560000).nullable(),
      })
      .strict(),
    mechanics: mechanicsSchema.optional(),
    format: formatSchema.optional(),
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
    if ((value.version === 2) !== (value.mechanics !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Only version 2 definitions carry mechanics.' });
    }
    if (
      (value.version === 3) !== (value.format !== undefined) ||
      (value.format !== undefined && value.teams.length > 0) ||
      (value.format?.kind === 'quiz' &&
        value.format.questions.some((q) => q.answer >= q.options.length))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only teamless version 3 definitions carry a format.',
      });
    }
    if (
      (value.objective.kind === 'highest-score') !== (value.objective.target === null) ||
      (value.objective.kind === 'collective-goal' && value.teams.length > 0) ||
      (value.objective.kind === 'burst' && !value.mechanics?.burst)
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
    remainingMs: z.number().int().min(0).max(3660000),
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
    outcome: z.enum(['deadline', 'goal', 'elimination']).nullable(),
    mechanics: z
      .object({
        round: bounded(1, 9),
        wins: dictionary(bounded(0, 9), 8),
        history: z
          .array(
            z
              .object({
                round: bounded(1, 9),
                winner: z.string().max(32).nullable(),
                outcome: z.enum(['deadline', 'goal', 'elimination']),
                scores: dictionary(bounded(0, 2560000), 8),
              })
              .strict(),
          )
          .max(9),
        standings: dictionary(
          z
            .object({
              health: bounded(0, 1000).nullable(),
              eliminated: z.boolean(),
              contributions: integer,
              heals: integer,
              unlocks: dictionary(integer, 4),
              bursts: bounded(0, 20),
              burstWindow: z
                .array(z.object({ viewerId: z.string().min(1).max(100), at: integer }).strict())
                .max(50),
              shieldUntil: integer.nullable(),
              unlocked: z.array(teamId).max(4),
            })
            .strict(),
          8,
        ),
      })
      .strict()
      .optional(),
    format: z
      .object({
        canvas: z.array(z.number().int().min(-1).max(7)).max(256),
        choices: dictionary(z.array(z.number().int().min(-1).max(3)).max(5), 256),
      })
      .strict()
      .optional(),
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
          // A cooperative round that misses its target ends at the deadline without a winner.
          (value.winner === null && value.outcome !== 'deadline')))
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
    if (definition.mechanics) {
      // Version 2 scores include bursts and unlocks; the host validated the full ledger.
      const m = snapshot.mechanics;
      const sameKeys = (value: Record<string, unknown> | undefined) =>
        !!value &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key));
      const valid =
        !!m &&
        sameKeys(snapshot.scores) &&
        sameKeys(m.standings) &&
        sameKeys(m.wins) &&
        m.round <= (definition.mechanics.match?.rounds ?? 1) &&
        Object.keys(snapshot.participants).length <= definition.maxParticipants &&
        snapshot.remainingMs <=
          definition.durationMs + (definition.mechanics.match?.intermissionMs ?? 0) &&
        Object.values(m.standings).every(
          (standing) =>
            (definition.mechanics?.health
              ? standing.health !== null && standing.health <= definition.mechanics.health.max
              : standing.health === null) &&
            standing.bursts <= (definition.mechanics?.burst?.limit ?? 0),
        );
      if (!valid)
        ctx.addIssue({
          code: 'custom',
          message: 'Session evidence does not match the experience rules',
        });
      return;
    }
    if (snapshot.mechanics) {
      ctx.addIssue({ code: 'custom', message: 'Version 1 sessions carry no mechanics' });
      return;
    }
    const f = definition.format;
    if (Boolean(f) !== Boolean(snapshot.format)) {
      ctx.addIssue({ code: 'custom', message: 'Format state must match the definition' });
      return;
    }
    if (f && snapshot.format) {
      const slots =
        f.kind === 'composition' ? f.stages.length : f.kind === 'quiz' ? f.questions.length : 0;
      const canvasOk =
        f.kind === 'mural'
          ? snapshot.format.canvas.length === f.width * f.height &&
            snapshot.format.canvas.every((cell) => cell < f.palette.length)
          : snapshot.format.canvas.length === 0;
      const choicesOk = Object.values(snapshot.format.choices).every(
        (row) => f.kind !== 'mural' && row.length === slots,
      );
      if (!canvasOk || !choicesOk) {
        ctx.addIssue({ code: 'custom', message: 'Format state must match the definition' });
        return;
      }
    }
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
