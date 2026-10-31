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
/** Conservatively classify supported rule changes. Example: classifySessionTransition(oldRules, newRules). */
export function classifySessionTransition(
  oldDefinition: ExperienceDefinition,
  newDefinition: ExperienceDefinition,
): SessionTransitionClassification {
  const a = sessionDefinitionSchema.parse(oldDefinition),
    b = sessionDefinitionSchema.parse(newDefinition);
  if (sessionDefinitionHash(a) === sessionDefinitionHash(b)) return 'identical-definition';
  if (
    a.contribution.points !== b.contribution.points ||
    canonical(a.teams.map((t) => t.id).sort()) !== canonical(b.teams.map((t) => t.id).sort()) ||
    canonical(a.objective) !== canonical(b.objective) ||
    b.resource.perParticipant < a.resource.perParticipant ||
    b.durationMs < a.durationMs ||
    b.maxParticipants < a.maxParticipants
  )
    return 'reset-required';
  return 'migration-required';
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
  const candidate = validateSessionSnapshot(input.newDefinition, raw);
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
