import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { compileRuns, proposalGenerationRuns, sessionTransitions, versions } from '../schema.js';
import { createProposalService, ProposalError } from '../../services/proposals/service.js';

/** Resolve every immutable parent, including edits created through ordinary authoring. */
export function proposalLineageRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  const domain = createProposalService(connection, channelId);
  function generationForSelection(selectionId: string) {
    return db
      .select()
      .from(proposalGenerationRuns)
      .where(
        and(
          eq(proposalGenerationRuns.channelId, channelId),
          eq(proposalGenerationRuns.selectionId, selectionId),
        ),
      )
      .get();
  }
  function assertVersionLineage(versionId: string) {
    const seen = new Set<string>();
    let next: string | null = versionId;
    while (next) {
      if (seen.has(next)) throw new ProposalError('REVOKED');
      seen.add(next);
      const v = db
        .select()
        .from(versions)
        .where(and(eq(versions.channelId, channelId), eq(versions.id, next)))
        .get();
      if (!v) throw new ProposalError('NOT_FOUND');
      if (v.compileRunId) {
        const link = db
          .select()
          .from(proposalGenerationRuns)
          .where(
            and(
              eq(proposalGenerationRuns.channelId, channelId),
              eq(proposalGenerationRuns.runId, v.compileRunId),
            ),
          )
          .get();
        if (link) domain.assertSelectionAuthorized(link.selectionId);
      }
      next = v.parentVersionId;
    }
  }
  return {
    generationForSelection,
    assertVersionLineage,
    /** An ordinary edited descendant can apply a selection without activating its first candidate. */
    appliedVersionLineage() {
      const rows = db
        .select({
          id: versions.id,
          parentVersionId: versions.parentVersionId,
          activatedAt: versions.activatedAt,
        })
        .from(versions)
        .where(eq(versions.channelId, channelId))
        .all();
      const parents = new Map(rows.map((row) => [row.id, row.parentVersionId]));
      const applied = new Set<string>();
      for (const row of rows) {
        if (row.activatedAt === null) continue;
        let id: string | null = row.id;
        while (id && !applied.has(id)) {
          applied.add(id);
          id = parents.get(id) ?? null;
        }
      }
      return applied;
    },
    linkSelectionRun(selectionId: string, runId: string) {
      domain.assertSelectionAuthorized(selectionId);
      const run = db
        .select({ id: compileRuns.id })
        .from(compileRuns)
        .where(and(eq(compileRuns.channelId, channelId), eq(compileRuns.id, runId)))
        .get();
      if (!run) throw new ProposalError('NOT_FOUND');
      db.insert(proposalGenerationRuns).values({ selectionId, channelId, runId }).run();
    },
    run(id: string) {
      return db
        .select()
        .from(compileRuns)
        .where(and(eq(compileRuns.channelId, channelId), eq(compileRuns.id, id)))
        .get();
    },
    /** Crashed work is terminal, never implicitly retried on a fresh process. */
    reconcileProposalRuns() {
      const links = db
        .select()
        .from(proposalGenerationRuns)
        .where(eq(proposalGenerationRuns.channelId, channelId))
        .all();
      for (const link of links)
        db.update(compileRuns)
          .set({
            status: 'failed',
            error: 'Generation was interrupted. Create a new selection to try again.',
          })
          .where(
            and(
              eq(compileRuns.channelId, channelId),
              eq(compileRuns.id, link.runId),
              inArray(compileRuns.status, ['queued', 'drafting', 'verifying', 'repairing']),
            ),
          )
          .run();
    },
    invalidateUnauthorizedTransitions() {
      const open = db
        .select()
        .from(sessionTransitions)
        .where(
          and(
            eq(sessionTransitions.channelId, channelId),
            inArray(sessionTransitions.status, ['review', 'pending']),
          ),
        )
        .all();
      for (const transition of open) {
        try {
          assertVersionLineage(transition.targetVersionId);
        } catch (error) {
          if (!(error instanceof ProposalError)) throw error;
          db.update(sessionTransitions)
            .set({ status: 'cancelled', cancelledAt: Date.now() })
            .where(
              and(
                eq(sessionTransitions.channelId, channelId),
                eq(sessionTransitions.id, transition.id),
              ),
            )
            .run();
        }
      }
    },
  };
}
