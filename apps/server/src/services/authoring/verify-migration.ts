import type { SessionSnapshot } from '@riff/sdk';
import type { Evidence } from '../automations/views.js';
import {
  advanceSession,
  classifySessionTransition,
  createSessionSnapshot,
  manifestSchema,
  pauseSession,
  runSessionMigration,
  validateSessionSnapshot,
  verifyCandidate,
  type VerificationReport,
} from '@riff/sandbox';

export interface AuthoringVerification extends VerificationReport {
  migration?: Evidence['migration'];
  rehearsal?: Evidence['rehearsal'];
}

/** Model and offline artifacts pass the same independent, effect-free host checks. */
export async function verifyAuthoredCandidate(
  candidate: { source: string; manifest: unknown; tests: unknown; migrationSource?: string },
  baseManifest: unknown,
): Promise<AuthoringVerification> {
  const report = await verifyCandidate(candidate);
  const snapshots: string[] = [];
  const finish = (failure: string | null): AuthoringVerification => ({
    ...report,
    ok: failure === null,
    failureReport: failure,
    ...(candidate.migrationSource
      ? {
          migration: {
            source: candidate.migrationSource,
            ok: failure === null,
            snapshots,
            failure,
          },
        }
      : {}),
  });
  if (!report.ok)
    return finish(report.failureReport ?? 'Candidate verification failed before migration checks.');
  const old = manifestSchema.safeParse(baseManifest);
  const next = manifestSchema.parse(candidate.manifest);
  if (!old.success || !old.data.experience || !next.experience) {
    if (!candidate.migrationSource) return report;
    return finish('A migration requires old and new session rules.');
  }
  const oldDefinition = old.data.experience,
    newDefinition = next.experience;
  if (!candidate.migrationSource) {
    // Legacy outputs remain compatible; explicit server previews independently validate fallback.
    return report;
  }
  // Incompatible changes keep the explicit full-reset workflow. They carry no preserving proof.
  if (classifySessionTransition(oldDefinition, newDefinition) === 'reset-required')
    return finish(
      'These rules require an explicit full reset; omit migrationSource and review reset consent.',
    );
  try {
    const empty = createSessionSnapshot(oldDefinition, 1000, 'host-migration-check');
    const populated = structuredClone(empty);
    const key = oldDefinition.teams[0]?.id ?? 'community';
    const fill = (snapshot: SessionSnapshot, contributions: number) => {
      snapshot.participants.alice = {
        teamId: oldDefinition.teams[0]?.id ?? null,
        contributions,
        remaining: oldDefinition.resource.perParticipant - contributions,
      };
      snapshot.scores[key] = contributions * oldDefinition.contribution.points;
      if (
        oldDefinition.objective.kind === 'collective-goal' &&
        (snapshot.scores[key] ?? 0) >= (oldDefinition.objective.target ?? Infinity)
      ) {
        snapshot.phase = 'finished';
        snapshot.deadlineAt = null;
        snapshot.remainingMs = 0;
        snapshot.outcome = 'goal';
        snapshot.winner = 'community';
      }
      return validateSessionSnapshot(oldDefinition, snapshot);
    };
    const populatedState = fill(populated, 1);
    const exhausted = fill(structuredClone(empty), oldDefinition.resource.perParticipant);
    const paused = pauseSession(
      populatedState.phase === 'running' ? populatedState : empty,
      1000,
      oldDefinition,
    );
    const finished = advanceSession(populatedState, 1000 + oldDefinition.durationMs, oldDefinition);
    const cases = { empty, populated: populatedState, exhausted, paused, finished };
    for (const [name, snapshot] of Object.entries(cases)) {
      await runSessionMigration(candidate.migrationSource, {
        oldDefinition,
        newDefinition,
        snapshot,
        at: snapshot.updatedAt,
      });
      snapshots.push(name);
    }
    return finish(null);
  } catch {
    return finish(
      'The separate migration failed independent preservation checks for empty, populated, exhausted, paused or finished progress. Fix it before approval.',
    );
  }
}
