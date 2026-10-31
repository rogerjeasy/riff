import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  artifactIdentity,
  createEngine,
  eventSchema,
  migrationSourceHash,
  runSessionMigration,
  sessionDefinitionHash,
  sessionDigest,
  sessionSeed,
  assessSessionTransition,
  migrationFailureReason,
  resumeSession,
  transitionIdentity,
} from '@riff/sandbox';
import type {
  ChatEvent,
  PermissionManifest,
  SessionTransitionBoundary,
  SessionTransitionPlan,
} from '@riff/sdk';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import { transitionEvidenceId, type TransitionRow } from '../../db/repositories/transitions.js';
import type { LiveRuntime } from '../live/runtime.js';
import { experienceOf, SessionConfigurationError } from '../live/sessions.js';
import { approvalBlockers, diffVersions } from './views.js';
import { StudioError } from './errors.js';
let previews = 0;
export interface TransitionApproval {
  evidenceId: string;
  artifactId: string;
  expectedActiveVersionId: string;
  sessionId: string;
  boundary: SessionTransitionBoundary;
}
export interface TransitionPreviewInput {
  migrationSource: string;
  boundary: SessionTransitionBoundary;
  events?: ChatEvent[] | undefined;
  seed?: number | undefined;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Private bounded rehearsals never receive live sinks, admission stores or runtime engines. */
export function createTransitionService(
  repo: ChannelRepository,
  runtime: LiveRuntime,
  changed: () => void,
) {
  let previewing = false;
  const required = (id: string) => {
    const t = repo.transition(id);
    if (!t) throw new StudioError('NOT_FOUND', 'That transition no longer exists.');
    return t;
  };
  function current(t: TransitionRow) {
    if (transitionEvidenceId(t.plan, t.migrationSource, t.evidence) !== t.evidenceId)
      throw new StudioError('STALE', 'The transition evidence changed. Review again.');
    const automation = repo.automation(t.automationId);
    const session = repo.session(t.automationId);
    const source = repo.version(t.sourceVersionId);
    const target = repo.version(t.targetVersionId);
    if (
      !session ||
      session.id !== t.sourceSessionId ||
      automation?.activeVersionId !== t.sourceVersionId ||
      session.versionId !== t.sourceVersionId ||
      source?.artifactId !== t.plan.sourceArtifactId ||
      (source &&
        artifactIdentity({ source: source.source, manifest: source.manifest }) !==
          t.plan.sourceArtifactId) ||
      target?.artifactId !== t.plan.targetArtifactId ||
      repo.state().transitionEpoch !== t.epoch
    )
      throw new StudioError(
        'STALE',
        'The source session or artifacts changed. Review the transition again.',
      );
    const blockers = target
      ? approvalBlockers(target, runtime.panicked)
      : ['The target version is missing.'];
    if (blockers.length) throw new StudioError('BLOCKED', blockers.join(' '));
    return { automation, session };
  }
  return {
    async preview(version: VersionRow, raw: TransitionPreviewInput) {
      const input = z
        .object({
          migrationSource: z.string().min(1).max(32768),
          boundary: z.enum(['immediate', 'round-end', 'stopped']),
          events: z.array(eventSchema).max(24).optional(),
          seed: z.number().int().min(1).max(0xffffffff).optional(),
        })
        .strict()
        .parse(raw);
      if (previewing || previews >= 2)
        throw new StudioError(
          'BLOCKED',
          'Another transition rehearsal is running. Try again shortly.',
        );
      const blockers = approvalBlockers(version, runtime.panicked);
      if (blockers.length) throw new StudioError('BLOCKED', blockers.join(' '));
      const read = repo.atomic(() => {
        const session = repo.session(version.automationId);
        const automation = repo.automation(version.automationId);
        const source = automation?.activeVersionId
          ? repo.version(automation.activeVersionId)
          : undefined;
        return {
          session,
          source,
          automation,
          journal: session ? repo.sessionJournal(session.id) : [],
          epoch: repo.state().transitionEpoch,
        };
      });
      const { session, source, automation } = read;
      const targetDefinition = experienceOf(version);
      if (
        !session ||
        !source ||
        !automation ||
        !source.artifactId ||
        !version.artifactId ||
        !targetDefinition ||
        source.id === version.id
      )
        throw new StudioError(
          'BLOCKED',
          'Select a different verified stateful version and a current session first.',
        );
      const assessment = assessSessionTransition(session.definition, targetDefinition);
      if (assessment.kind === 'reset-required')
        throw new StudioError(
          'BLOCKED',
          `These rules cannot keep current progress: ${assessment.reasons.join(' ')} Choose “Start a fresh round” to reset instead.`,
        );
      const plan: SessionTransitionPlan = {
        version: 1,
        sourceArtifactId: source.artifactId,
        targetArtifactId: version.artifactId,
        sourceDefinitionHash: sessionDefinitionHash(session.definition),
        targetDefinitionHash: sessionDefinitionHash(targetDefinition),
        migrationSourceHash: migrationSourceHash(input.migrationSource),
        boundary: input.boundary,
        preserve: ['identity', 'participants', 'teams', 'scores', 'contributions', 'phase', 'time'],
        resets: [],
      };
      previewing = true;
      previews++;
      try {
        const at = Math.max(session.snapshot.updatedAt, session.snapshot.startedAt);
        const migrated = await runSessionMigration(input.migrationSource, {
          oldDefinition: session.definition,
          newDefinition: targetDefinition,
          snapshot: session.snapshot,
          at,
        });
        const seed = input.seed ?? sessionSeed(session.id);
        const viewer = Object.keys(session.snapshot.participants)[0] ?? 'rehearsal-viewer';
        const commands = [
          session.definition.teams[0]?.joinCommand ?? session.definition.contribution.command,
          session.definition.contribution.command,
          targetDefinition.contribution.command,
          targetDefinition.contribution.command,
        ];
        const events = input.events?.length
          ? input.events
          : commands.map((text, i): ChatEvent => ({
              id: `rehearsal-${i}`,
              channelId: repo.channelId,
              viewerId: viewer,
              roles: ['viewer'],
              text,
              at: at + i + 1,
            }));
        if (events.some((e) => e.channelId !== repo.channelId))
          throw new StudioError('BLOCKED', 'Rehearsal inputs must belong to this channel.');
        // A paused round would answer every rehearsal message with "paused" and prove nothing.
        // Resume private copies at the same instant so both versions face live-like rules.
        const resumedPrivately = session.snapshot.phase === 'paused';
        const rehearse = (snapshot: typeof migrated) =>
          resumedPrivately ? resumeSession(snapshot, at) : snapshot;
        const before = createEngine(
          { source: source.source, manifest: source.manifest },
          { seed, mode: 'preview', session: rehearse(session.snapshot) },
        );
        const after = createEngine(
          { source: version.source, manifest: version.manifest },
          { seed, mode: 'preview', session: rehearse(migrated) },
        );
        const steps = [];
        try {
          for (const event of events) {
            const a = await before.dispatch(event);
            const b = await after.dispatch(event);
            const view = (d: typeof a) => ({
              code: d.code,
              reason: d.reason.slice(0, 256),
              effects: d.effects.slice(0, 4),
              snapshotDigest: d.session ? sessionDigest(d.session) : null,
            });
            steps.push({ eventId: event.id, before: view(a), after: view(b) });
          }
          const evidence = {
            version: 1,
            planId: transitionIdentity(plan),
            sourceSessionId: session.id,
            sourceRevision: session.revision,
            sourceDigest: sessionDigest(session.snapshot),
            sourceJournalHash: hash(read.journal),
            preserved: [...plan.preserve],
            changed: diffVersions(source, version),
            reset: [],
            takesEffect: input.boundary,
            beforeRules: {
              definition: session.definition,
              audience: (source.manifest as PermissionManifest).trigger.audience,
            },
            afterRules: {
              definition: targetDefinition,
              audience: (version.manifest as PermissionManifest).trigger.audience,
            },
            migration: { at, before: session.snapshot, after: migrated },
            comparison: {
              provenance: 'synthetic' as const,
              label: input.events?.length
                ? 'Creator-provided hypothetical future inputs'
                : 'Host-generated hypothetical future inputs',
              resumedPrivately,
              seed,
              events,
              inputHash: hash(events),
              steps,
              before: before.session,
              after: after.session,
            },
          };
          if (Buffer.byteLength(JSON.stringify(evidence)) > 2_000_000)
            throw new StudioError(
              'BLOCKED',
              'The transition evidence exceeds the private rehearsal limit.',
            );
          if (
            repo.automation(version.automationId)?.activeVersionId !== source.id ||
            repo.session(version.automationId)?.id !== session.id ||
            repo.state().transitionEpoch !== read.epoch ||
            runtime.panicked
          )
            throw new StudioError('STALE', 'The session changed during rehearsal. Review again.');
          const row = repo.insertTransition({
            automationId: version.automationId,
            sourceVersionId: source.id,
            targetVersionId: version.id,
            sourceSessionId: session.id,
            sourceRevision: session.revision,
            sourceDigest: sessionDigest(session.snapshot),
            epoch: read.epoch,
            migrationSource: input.migrationSource,
            plan,
            evidence,
            evidenceId: transitionEvidenceId(plan, input.migrationSource, evidence),
          });
          changed();
          return row;
        } finally {
          before.stop();
          after.stop();
        }
      } catch (error) {
        if (error instanceof StudioError) throw error;
        throw new StudioError(
          'BLOCKED',
          `${migrationFailureReason(error)} Current progress is unchanged.`,
        );
      } finally {
        previews--;
        previewing = false;
      }
    },
    async approve(id: string, expected: TransitionApproval) {
      const t = required(id);
      if (
        t.evidenceId !== expected.evidenceId ||
        t.plan.targetArtifactId !== expected.artifactId ||
        t.sourceVersionId !== expected.expectedActiveVersionId ||
        t.sourceSessionId !== expected.sessionId ||
        t.plan.boundary !== expected.boundary
      )
        throw new StudioError(
          'STALE',
          'Approval must match the exact transition, evidence, source session and boundary reviewed.',
        );
      if (!['review', 'pending'].includes(t.status))
        throw new StudioError(
          'STALE',
          'This transition was already applied or cancelled. Review again.',
        );
      const state = current(t);
      if (
        t.plan.boundary === 'stopped' &&
        (state.automation.status !== 'paused' || state.session.snapshot.phase !== 'paused')
      )
        throw new StudioError(
          'BLOCKED',
          'Stop this interaction before approving a stopped transition.',
        );
      if (t.plan.boundary === 'round-end' && state.session.snapshot.phase !== 'finished') {
        repo.atomic(() => {
          current(t);
          repo.pendTransition(id);
        });
        changed();
        return required(id);
      }
      try {
        await runtime.activateTransition(id);
      } catch (error) {
        if (error instanceof SessionConfigurationError)
          throw new StudioError('STALE', error.message);
        throw error;
      }
      changed();
      return required(id);
    },
    cancel(id: string) {
      required(id);
      const t = repo.cancelTransition(id);
      if (!t) throw new StudioError('NOT_FOUND', 'That transition no longer exists.');
      changed();
      return t;
    },
  };
}
