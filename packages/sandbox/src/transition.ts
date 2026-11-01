import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { ExperienceDefinition, SessionSnapshot, SessionTransitionPlan } from '@riff/sdk';
import { sessionDefinitionSchema, validateSessionSnapshot } from './session.js';

export const MIGRATION_LIMITS = Object.freeze({
  sourceBytes: 32768,
  inputBytes: 262144,
  outputBytes: 262144,
  memoryBytes: 32 * 1024 * 1024,
  cpuMs: 50,
  wallMs: 2000,
  startupMs: 10000,
  jobs: 100,
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sessionTransitionPlanSchema = z
  .object({
    version: z.literal(1),
    sourceArtifactId: hash,
    targetArtifactId: hash,
    sourceDefinitionHash: hash,
    targetDefinitionHash: hash,
    migrationSourceHash: hash,
    boundary: z.enum(['immediate', 'round-end', 'stopped']),
    preserve: z.tuple([
      z.literal('identity'),
      z.literal('participants'),
      z.literal('teams'),
      z.literal('scores'),
      z.literal('contributions'),
      z.literal('phase'),
      z.literal('time'),
    ]),
    resets: z.tuple([]),
  })
  .strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Content identity independent of object-key order. Example: sessionDefinitionHash(definition). */
export function sessionDefinitionHash(definition: ExperienceDefinition): string {
  return createHash('sha256')
    .update(canonical(sessionDefinitionSchema.parse(definition)))
    .digest('hex');
}
/** Hash exact migration bytes. Example: migrationSourceHash(source). */
export function migrationSourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
/** Bind a validated plan immutably. Example: transitionIdentity(plan). */
export function transitionIdentity(plan: SessionTransitionPlan): string {
  return createHash('sha256')
    .update(canonical(sessionTransitionPlanSchema.parse(plan)))
    .digest('hex');
}
export type SessionTransitionClassification =
  'identical-definition' | 'migration-required' | 'reset-required';
export interface SessionTransitionAssessment {
  kind: SessionTransitionClassification;
  /** Plain-language reasons current progress cannot be kept; empty unless reset-required. */
  reasons: string[];
}
/** Classify with creator-facing reasons. Example: assessSessionTransition(oldRules, newRules).reasons. */
export function assessSessionTransition(
  oldDefinition: ExperienceDefinition,
  newDefinition: ExperienceDefinition,
): SessionTransitionAssessment {
  const a = sessionDefinitionSchema.parse(oldDefinition),
    b = sessionDefinitionSchema.parse(newDefinition);
  if (sessionDefinitionHash(a) === sessionDefinitionHash(b))
    return { kind: 'identical-definition', reasons: [] };
  const reasons: string[] = [];
  if (a.contribution.points !== b.contribution.points)
    reasons.push(
      `Points per ${a.contribution.command} change from ${a.contribution.points} to ${b.contribution.points}, so existing scores would mean something different.`,
    );
  if (canonical(a.teams.map((t) => t.id).sort()) !== canonical(b.teams.map((t) => t.id).sort()))
    reasons.push('The teams change, so current players cannot keep their team.');
  if (canonical(a.objective) !== canonical(b.objective))
    reasons.push('The way the round is won changes.');
  if (b.resource.perParticipant < a.resource.perParticipant)
    reasons.push(
      `Each player would get fewer ${b.resource.name} (${a.resource.perParticipant} → ${b.resource.perParticipant}); Riff never takes away what players already have.`,
    );
  if (b.durationMs < a.durationMs) reasons.push('The round gets shorter.');
  reasons.push(...mechanicsResetReasons(a, b));
  if (b.maxParticipants < a.maxParticipants)
    reasons.push(
      `Fewer players are allowed (${a.maxParticipants} → ${b.maxParticipants}), which could remove someone already playing.`,
    );
  return { kind: reasons.length ? 'reset-required' : 'migration-required', reasons };
}
/**
 * Version 2 compatibility: labels may change and the intermission may grow; every other
 * mechanics change alters what existing pools, bursts, unlocks or match wins mean.
 */
function mechanicsResetReasons(a: ExperienceDefinition, b: ExperienceDefinition): string[] {
  const x = a.mechanics,
    y = b.mechanics;
  if (!x && !y) return [];
  if (!x || !y)
    return [
      x
        ? 'Match, health, burst and milestone rules are removed, so current round state cannot carry over.'
        : 'Match, health, burst or milestone rules are added, so the current round has no state for them.',
    ];
  const reasons: string[] = [];
  const same = (u: unknown, v: unknown) => canonical(u) === canonical(v);
  if (
    (x.match?.rounds ?? null) !== (y.match?.rounds ?? null) ||
    (y.match?.intermissionMs ?? 0) < (x.match?.intermissionMs ?? 0)
  )
    reasons.push(
      `The match changes (${x.match ? `best of ${x.match.rounds}` : 'one round'} → ${y.match ? `best of ${y.match.rounds}` : 'one round'}, or a shorter break), so round wins would mean something different.`,
    );
  const health = (h: typeof x.health) => (h ? { ...h, label: '' } : null);
  if (!same(health(x.health), health(y.health)))
    reasons.push(
      'Health, damage or healing changes, so current pools and eliminations would not fit.',
    );
  const burst = (v: typeof x.burst) => (v ? { ...v, label: '' } : null);
  if (!same(burst(x.burst), burst(y.burst)))
    reasons.push('The burst rule changes, so counted viewers and triggered bursts would not fit.');
  const milestones = (list: typeof x.milestones) => list.map((item) => ({ ...item, label: '' }));
  if (!same(milestones(x.milestones), milestones(y.milestones)))
    reasons.push('Milestones or unlocked commands change, so reached tiers would not fit.');
  return reasons;
}
/** Conservatively classify supported rule changes. Example: classifySessionTransition(oldRules, newRules). */
export function classifySessionTransition(
  oldDefinition: ExperienceDefinition,
  newDefinition: ExperienceDefinition,
): SessionTransitionClassification {
  return assessSessionTransition(oldDefinition, newDefinition).kind;
}
const FAILURE_REASONS: [RegExp, string][] = [
  [
    /preservation requirements/,
    'The migration changed progress it must keep: players, teams, scores, contributions or the round clock.',
  ],
  [/explicit reset/, 'These rules cannot keep current progress; a fresh round is required.'],
  [
    /invalid snapshot/,
    'The migration returned progress that does not fit the new rules, such as scores that no longer add up.',
  ],
  [/budget|did not settle|Async/, 'The migration ran past its time, memory or size budget.'],
  [
    /trapped|invalid JSON|failed or exceeded|Dynamic import/,
    'The migration code threw or returned something other than progress.',
  ],
  [/worker/, 'The isolated migration worker could not run. Try again.'],
];
/**
 * Creator-facing explanation for a host-raised migration failure. Only host-authored messages are
 * matched; guest output never reaches this text. Example: migrationFailureReason(error).
 */
export function migrationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return (
    FAILURE_REASONS.find(([pattern]) => pattern.test(message))?.[1] ??
    'The migration result did not pass the host’s progress checks.'
  );
}
export interface SessionMigrationInput {
  oldDefinition: ExperienceDefinition;
  newDefinition: ExperienceDefinition;
  snapshot: SessionSnapshot;
  at: number;
}
/** Validate guest output independently; revision advances only in host code. Example: validatePreservingMigration(input, output). */
export function validatePreservingMigration(
  input: SessionMigrationInput,
  raw: unknown,
): SessionSnapshot {
  const old = validateSessionSnapshot(input.oldDefinition, input.snapshot);
  if (!Number.isSafeInteger(input.at) || input.at < old.updatedAt)
    throw new Error('Invalid migration timestamp');
  if (classifySessionTransition(input.oldDefinition, input.newDefinition) === 'reset-required')
    throw new Error('Transition requires explicit reset');
  let candidate: SessionSnapshot;
  try {
    candidate = validateSessionSnapshot(input.newDefinition, raw);
  } catch {
    throw new Error('Migration returned an invalid snapshot');
  }
  const expected = structuredClone(old),
    delta =
      input.newDefinition.resource.perParticipant - input.oldDefinition.resource.perParticipant;
  for (const p of Object.values(expected.participants)) p.remaining += delta;
  if (canonical(candidate) !== canonical(expected))
    throw new Error('Migration violated preservation requirements');
  if (old.revision === Number.MAX_SAFE_INTEGER) throw new Error('Revision exhausted');
  return validateSessionSnapshot(input.newDefinition, { ...candidate, revision: old.revision + 1 });
}
/** Run isolated, bounded guest expression with frozen JSON input, then host-validate it. Example: await runSessionMigration('(input) => input.snapshot', input). */
export async function runSessionMigration(
  source: string,
  input: SessionMigrationInput,
): Promise<SessionSnapshot> {
  const serialized = JSON.stringify(input);
  if (
    Buffer.byteLength(source) > MIGRATION_LIMITS.sourceBytes ||
    Buffer.byteLength(serialized) > MIGRATION_LIMITS.inputBytes
  )
    throw new Error('Migration input exceeds budget');
  validateSessionSnapshot(input.oldDefinition, input.snapshot);
  sessionDefinitionSchema.parse(input.newDefinition);
  const output = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(new URL('./migration-worker.js', import.meta.url), {
      execArgv: [],
      workerData: { source, input: serialized },
    });
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error: Error | null, value?: unknown) => {
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(
      () => finish(new Error('Migration startup budget exceeded')),
      MIGRATION_LIMITS.startupMs,
    );
    worker.on('error', () => finish(new Error('Migration worker failed')));
    worker.on('exit', (code) => {
      if (code !== 0) finish(new Error('Migration worker exited'));
    });
    worker.on('message', (raw: unknown) => {
      if (raw === 'ready') {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new Error('Migration wall budget exceeded')),
          MIGRATION_LIMITS.wallMs,
        );
        worker.postMessage('run');
        return;
      }
      const parsed = z
        .object({ ok: z.boolean(), json: z.string().max(MIGRATION_LIMITS.outputBytes).optional() })
        .strict()
        .safeParse(raw);
      if (!parsed.success || !parsed.data.ok || !parsed.data.json) {
        finish(new Error('Migration failed or exceeded budget'));
        return;
      }
      try {
        finish(null, JSON.parse(parsed.data.json));
      } catch {
        finish(new Error('Migration returned invalid JSON'));
      }
    });
  });
  return validatePreservingMigration(input, output);
}
