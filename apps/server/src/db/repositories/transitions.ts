import { proposalLineageRepository } from './proposal-lineage.js';
import { ProposalError } from '../../services/proposals/service.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  advanceSession,
  classifyTransition,
  validatePreservingMigration,
  artifactIdentity,
  sessionDefinitionHash,
  sessionDigest,
  validateSessionSnapshot,
} from '@riff/sandbox';
import type { ExperienceDefinition, SessionSnapshot, SessionTransitionPlan } from '@riff/sdk';
import type { DatabaseConnection } from '../client.js';
import { versionApprovalBlockers } from '../version-health.js';
import {
  automations,
  channelState,
  experienceSessions,
  sessionJournal,
  sessionOutbox,
  sessionTransitions,
  versions,
} from '../schema.js';
export type TransitionRow = typeof sessionTransitions.$inferSelect;
/** Bind exact host-produced evidence, execution source and reviewed boundary. */
export function transitionEvidenceId(
  plan: SessionTransitionPlan,
  migrationSource: string,
  evidence: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ plan, migrationSource, evidence }))
    .digest('hex');
}
/** Tenant-scoped immutable evidence and atomic state/version/journal activation. */
export function transitionRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  const scoped = (id: string) =>
    and(eq(sessionTransitions.channelId, channelId), eq(sessionTransitions.id, id));
  const transition = (id: string) => db.select().from(sessionTransitions).where(scoped(id)).get();
  function invalidateTransitions(automationId?: string) {
    db.update(sessionTransitions)
      .set({ status: 'cancelled', cancelledAt: Date.now() })
      .where(
        and(
          eq(sessionTransitions.channelId, channelId),
          inArray(sessionTransitions.status, ['review', 'pending']),
          ...(automationId ? [eq(sessionTransitions.automationId, automationId)] : []),
        ),
      )
      .run();
  }
  return {
    transition,
    invalidateTransitions,
    transitions(automationId?: string) {
      return db
        .select()
        .from(sessionTransitions)
        .where(
          and(
            eq(sessionTransitions.channelId, channelId),
            ...(automationId ? [eq(sessionTransitions.automationId, automationId)] : []),
          ),
        )
        .orderBy(asc(sessionTransitions.createdAt))
        .all();
    },
    /** Hot path (every chat event and tick): only approved round-end work, no evidence blobs. */
    pendingTransitions() {
      return db
        .select({ id: sessionTransitions.id, automationId: sessionTransitions.automationId })
        .from(sessionTransitions)
        .where(
          and(
            eq(sessionTransitions.channelId, channelId),
            eq(sessionTransitions.status, 'pending'),
          ),
        )
        .orderBy(asc(sessionTransitions.createdAt))
        .all();
    },
    /**
     * Studio list view: open work plus the most recent outcomes, without migration source or
     * evidence. Full evidence is returned only by the preview call that created it.
     */
    transitionSummaries(automationId: string, recent = 10) {
      const columns = {
        id: sessionTransitions.id,
        status: sessionTransitions.status,
        sourceVersionId: sessionTransitions.sourceVersionId,
        targetVersionId: sessionTransitions.targetVersionId,
        plan: sessionTransitions.plan,
        createdAt: sessionTransitions.createdAt,
        approvedAt: sessionTransitions.approvedAt,
        appliedAt: sessionTransitions.appliedAt,
        cancelledAt: sessionTransitions.cancelledAt,
      };
      const scope = and(
        eq(sessionTransitions.channelId, channelId),
        eq(sessionTransitions.automationId, automationId),
      );
      const open = db
        .select(columns)
        .from(sessionTransitions)
        .where(and(scope, inArray(sessionTransitions.status, ['review', 'pending'])))
        .all();
      const closed = db
        .select(columns)
        .from(sessionTransitions)
        .where(and(scope, inArray(sessionTransitions.status, ['applied', 'cancelled'])))
        .orderBy(desc(sessionTransitions.createdAt))
        .limit(recent)
        .all();
      return [...open, ...closed].map(({ plan, ...row }) => ({ ...row, boundary: plan.boundary }));
    },
    insertTransition(
      input: Omit<
        TransitionRow,
        'id' | 'channelId' | 'createdAt' | 'approvedAt' | 'appliedAt' | 'cancelledAt' | 'status'
      >,
    ) {
      return connection.client.transaction(() => {
        const target = db
          .select()
          .from(versions)
          .where(
            and(
              eq(versions.channelId, channelId),
              eq(versions.id, input.targetVersionId),
              eq(versions.automationId, input.automationId),
            ),
          )
          .get();
        if (!target) throw new Error('Transition target does not belong to this channel');
        const row: TransitionRow = {
          ...input,
          id: randomUUID(),
          channelId,
          createdAt: Date.now(),
          approvedAt: null,
          appliedAt: null,
          cancelledAt: null,
          status: 'review',
        };
        db.insert(sessionTransitions).values(row).run();
        return row;
      })();
    },
    cancelTransition(id: string) {
      db.update(sessionTransitions)
        .set({ status: 'cancelled', cancelledAt: Date.now() })
        .where(and(scoped(id), inArray(sessionTransitions.status, ['review', 'pending'])))
        .run();
      return transition(id);
    },
    pendTransition(id: string) {
      return (
        db
          .update(sessionTransitions)
          .set({ status: 'pending', approvedAt: Date.now() })
          .where(and(scoped(id), eq(sessionTransitions.status, 'review')))
          .run().changes === 1
      );
    },
    commitTransition(
      id: string,
      expectedRevision: number,
      snapshot: SessionSnapshot,
      migrationAt: number,
    ) {
      return connection.client.transaction(() => {
        const t = transition(id);
        if (!t || !['review', 'pending'].includes(t.status)) return false;
        try {
          proposalLineageRepository(connection, channelId).assertVersionLineage(t.targetVersionId);
        } catch (error) {
          if (error instanceof ProposalError) return false;
          throw error;
        }
        const state = db
          .select()
          .from(channelState)
          .where(eq(channelState.channelId, channelId))
          .get();
        const current = db
          .select()
          .from(experienceSessions)
          .where(
            and(
              eq(experienceSessions.channelId, channelId),
              eq(experienceSessions.automationId, t.automationId),
            ),
          )
          .get();
        const automation = db
          .select()
          .from(automations)
          .where(and(eq(automations.channelId, channelId), eq(automations.id, t.automationId)))
          .get();
        const target = db
          .select()
          .from(versions)
          .where(and(eq(versions.channelId, channelId), eq(versions.id, t.targetVersionId)))
          .get();
        const source = db
          .select()
          .from(versions)
          .where(and(eq(versions.channelId, channelId), eq(versions.id, t.sourceVersionId)))
          .get();
        const definition = (target?.manifest as { experience?: ExperienceDefinition } | undefined)
          ?.experience;
        if (
          !state ||
          state.panic ||
          state.transitionEpoch !== t.epoch ||
          !current ||
          !automation ||
          !target ||
          !source ||
          target.automationId !== t.automationId ||
          source.automationId !== t.automationId ||
          versionApprovalBlockers(target, state.panic).length > 0 ||
          transitionEvidenceId(t.plan, t.migrationSource, t.evidence) !== t.evidenceId ||
          artifactIdentity({ source: source.source, manifest: source.manifest }) !==
            t.plan.sourceArtifactId ||
          artifactIdentity({ source: target.source, manifest: target.manifest }) !==
            t.plan.targetArtifactId ||
          !definition ||
          current.id !== t.sourceSessionId ||
          snapshot.id !== current.id ||
          current.versionId !== t.sourceVersionId ||
          current.revision !== expectedRevision ||
          automation.activeVersionId !== t.sourceVersionId ||
          target.artifactId !== t.plan.targetArtifactId ||
          sessionDefinitionHash(current.definition) !== t.plan.sourceDefinitionHash ||
          sessionDefinitionHash(definition) !== t.plan.targetDefinitionHash
        )
          return false;
        if (
          t.plan.boundary === 'stopped' &&
          (automation.status !== 'paused' || current.snapshot.phase !== 'paused')
        )
          return false;
        if (t.plan.boundary === 'round-end' && current.snapshot.phase !== 'finished') return false;
        const normalized = advanceSession(current.snapshot, migrationAt, current.definition);
        validateSessionSnapshot(definition, snapshot);
        validatePreservingMigration(
          {
            oldDefinition: current.definition,
            newDefinition: definition,
            snapshot: normalized,
            at: migrationAt,
          },
          { ...snapshot, revision: normalized.revision },
        );
        if (snapshot.revision !== normalized.revision + 1)
          throw new Error('Migration revision must advance once');
        const at = Date.now();
        const updated = db
          .update(experienceSessions)
          .set({
            versionId: target.id,
            definition,
            snapshot,
            revision: snapshot.revision,
            updatedAt: snapshot.updatedAt,
          })
          .where(
            and(
              eq(experienceSessions.channelId, channelId),
              eq(experienceSessions.automationId, t.automationId),
              eq(experienceSessions.revision, expectedRevision),
            ),
          )
          .run();
        if (updated.changes !== 1) return false;
        db.update(versions)
          .set({ status: 'superseded' })
          .where(and(eq(versions.channelId, channelId), eq(versions.id, t.sourceVersionId)))
          .run();
        db.update(versions)
          .set({ status: 'active', activatedAt: at, approvedAt: at })
          .where(and(eq(versions.channelId, channelId), eq(versions.id, target.id)))
          .run();
        db.update(automations)
          .set({
            activeVersionId: target.id,
            status: automation.status === 'paused' ? 'paused' : 'live',
            updatedAt: at,
          })
          .where(and(eq(automations.channelId, channelId), eq(automations.id, t.automationId)))
          .run();
        if (sessionDigest(normalized) !== sessionDigest(current.snapshot))
          db.insert(sessionJournal)
            .values({
              channelId,
              sessionId: current.id,
              automationId: t.automationId,
              versionId: t.sourceVersionId,
              kind: classifyTransition(current.snapshot, normalized),
              at: migrationAt,
              digest: sessionDigest(normalized),
            })
            .run();
        db.insert(sessionJournal)
          .values({
            channelId,
            sessionId: current.id,
            automationId: t.automationId,
            versionId: target.id,
            kind: 'migration',
            at: migrationAt,
            digest: sessionDigest(snapshot),
            migration: {
              oldDefinition: current.definition,
              newDefinition: definition,
              source: t.migrationSource,
              sourceVersionId: t.sourceVersionId,
              plan: t.plan,
            },
          })
          .run();
        db.delete(sessionOutbox)
          .where(
            and(
              eq(sessionOutbox.channelId, channelId),
              eq(sessionOutbox.automationId, t.automationId),
            ),
          )
          .run();
        invalidateTransitions(t.automationId);
        db.update(sessionTransitions)
          .set({
            status: 'applied',
            approvedAt: t.approvedAt ?? at,
            appliedAt: at,
            cancelledAt: null,
          })
          .where(scoped(id))
          .run();
        return true;
      })();
    },
  };
}
