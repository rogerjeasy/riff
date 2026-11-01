import { and, asc, desc, eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { rehearsalScenarios, rehearsalRuns, rehearsalRegressions } from '../schema.js';
import {
  RehearsalServiceError,
  type RegressionRecord,
  type RunRecord,
  type ScenarioRecord,
} from '../../services/rehearsal/contract.js';
/** All private reads and writes are tenant-scoped; immutable evidence embeds its input. */
export function rehearsalRepository(connection: DatabaseConnection, channelId: string) {
  const { db, client } = connection;
  const scoped = (id: string) =>
    and(eq(rehearsalScenarios.channelId, channelId), eq(rehearsalScenarios.id, id));
  const scenario = (id: string): ScenarioRecord | undefined => {
    const row = db.select().from(rehearsalScenarios).where(scoped(id)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      scenario: row.scenario,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };
  return {
    rehearsalScenarios(): ScenarioRecord[] {
      return db
        .select()
        .from(rehearsalScenarios)
        .where(eq(rehearsalScenarios.channelId, channelId))
        .orderBy(desc(rehearsalScenarios.updatedAt))
        .limit(50)
        .all()
        .map(({ channelId: _, ...row }) => row);
    },
    rehearsalScenario: scenario,
    saveRehearsalScenario(row: ScenarioRecord, expectedRevision?: number) {
      return client.transaction(() => {
        if (expectedRevision === undefined) {
          if (
            db
              .select()
              .from(rehearsalScenarios)
              .where(eq(rehearsalScenarios.channelId, channelId))
              .limit(50)
              .all().length >= 50
          )
            throw new RehearsalServiceError('LIMIT');
          db.insert(rehearsalScenarios)
            .values({ ...row, channelId })
            .run();
        } else {
          const current = scenario(row.id);
          if (!current) throw new RehearsalServiceError('NOT_FOUND');
          if (current.revision !== expectedRevision) throw new RehearsalServiceError('STALE');
          db.update(rehearsalScenarios).set(row).where(scoped(row.id)).run();
        }
        return row;
      })();
    },
    deleteRehearsalScenario(id: string, expectedRevision: number) {
      client.transaction(() => {
        const current = scenario(id);
        if (!current) throw new RehearsalServiceError('NOT_FOUND');
        if (current.revision !== expectedRevision) throw new RehearsalServiceError('STALE');
        db.delete(rehearsalScenarios).where(scoped(id)).run();
      })();
    },
    rehearsalRuns(): RunRecord[] {
      return db
        .select()
        .from(rehearsalRuns)
        .where(eq(rehearsalRuns.channelId, channelId))
        .orderBy(desc(rehearsalRuns.createdAt), desc(rehearsalRuns.id))
        .limit(100)
        .all()
        .map((r) => r.evidence);
    },
    rehearsalRun(id: string) {
      return db
        .select()
        .from(rehearsalRuns)
        .where(and(eq(rehearsalRuns.channelId, channelId), eq(rehearsalRuns.id, id)))
        .get()?.evidence;
    },
    insertRehearsalRun(row: RunRecord) {
      client.transaction(() => {
        db.insert(rehearsalRuns)
          .values({ id: row.id, channelId, evidence: row, createdAt: row.createdAt })
          .run();
        const oldest = db
          .select({ id: rehearsalRuns.id })
          .from(rehearsalRuns)
          .where(eq(rehearsalRuns.channelId, channelId))
          .orderBy(desc(rehearsalRuns.createdAt), desc(rehearsalRuns.id))
          .limit(101)
          .all()
          .slice(100);
        for (const r of oldest)
          db.delete(rehearsalRuns)
            .where(and(eq(rehearsalRuns.channelId, channelId), eq(rehearsalRuns.id, r.id)))
            .run();
      })();
      return row;
    },
    rehearsalRegressions(): RegressionRecord[] {
      return db
        .select()
        .from(rehearsalRegressions)
        .where(eq(rehearsalRegressions.channelId, channelId))
        .orderBy(asc(rehearsalRegressions.createdAt), asc(rehearsalRegressions.id))
        .limit(50)
        .all()
        .map((r) => r.evidence);
    },
    rehearsalRegression(id: string) {
      return db
        .select()
        .from(rehearsalRegressions)
        .where(and(eq(rehearsalRegressions.channelId, channelId), eq(rehearsalRegressions.id, id)))
        .get()?.evidence;
    },
    insertRehearsalRegression(row: RegressionRecord) {
      client.transaction(() => {
        const all = db
          .select()
          .from(rehearsalRegressions)
          .where(eq(rehearsalRegressions.channelId, channelId))
          .limit(50)
          .all();
        if (all.length >= 50 || all.filter((r) => r.automationId === row.automationId).length >= 10)
          throw new RehearsalServiceError('LIMIT');
        db.insert(rehearsalRegressions)
          .values({
            id: row.id,
            channelId,
            automationId: row.automationId,
            evidence: row,
            createdAt: row.createdAt,
          })
          .run();
      })();
      return row;
    },
    deleteRehearsalRegression(id: string) {
      if (
        !db
          .delete(rehearsalRegressions)
          .where(
            and(eq(rehearsalRegressions.channelId, channelId), eq(rehearsalRegressions.id, id)),
          )
          .run().changes
      )
        throw new RehearsalServiceError('NOT_FOUND');
    },
  };
}
