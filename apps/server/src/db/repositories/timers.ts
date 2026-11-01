import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import { applyTimerOps, type TimerEntry } from '@riff/sandbox';
import type { TimerOp } from '@riff/sdk';
import type { DatabaseConnection } from '../client.js';
import { timers } from '../schema.js';

export type TimerRow = typeof timers.$inferSelect;

/** Channel-scoped persisted named timers. No query reads another tenant's timers. */
export function timerRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  const scoped = (automationId?: string) =>
    automationId
      ? and(eq(timers.channelId, channelId), eq(timers.automationId, automationId))
      : eq(timers.channelId, channelId);
  return {
    timers(automationId?: string): TimerRow[] {
      return db
        .select()
        .from(timers)
        .where(scoped(automationId))
        .orderBy(asc(timers.scheduledAt), asc(timers.name))
        .all();
    },
    /** Pending rows due at or before `at`, oldest first. */
    dueTimers(at: number): TimerRow[] {
      return db
        .select()
        .from(timers)
        .where(and(eq(timers.channelId, channelId), lte(timers.scheduledAt, at)))
        .orderBy(asc(timers.scheduledAt), asc(timers.name))
        .all();
    },
    /**
     * Apply one accepted handler's staged operations atomically and in order, with the
     * same restart/cancel/bound semantics as previews. A failed bound check writes nothing.
     */
    applyTimerOps(
      automationId: string,
      versionId: string,
      ops: readonly TimerOp[],
      at: number,
      createdBy: string,
    ) {
      return connection.client.transaction(() => {
        const rows = db.select().from(timers).where(scoped(automationId)).all();
        const table = new Map<string, TimerEntry>(
          rows.map((row) => [
            row.name,
            {
              name: row.name,
              intervalMs: row.intervalMs,
              repeat: row.repeat,
              scheduledAt: row.scheduledAt,
              createdAt: row.createdAt,
              fires: row.fires,
            },
          ]),
        );
        const changed = applyTimerOps(table, ops, at);
        for (const name of changed) {
          db.delete(timers)
            .where(and(scoped(automationId), eq(timers.name, name)))
            .run();
          const entry = table.get(name);
          if (entry)
            db.insert(timers)
              .values({
                id: randomUUID(),
                channelId,
                automationId,
                versionId,
                createdBy,
                ...entry,
              })
              .run();
        }
        return changed;
      })();
    },
    /** Re-arm a repeating timer or settle a one-shot; scoped to the exact row identity. */
    settleTimer(id: string, next: number | null) {
      if (next === null)
        db.delete(timers)
          .where(and(eq(timers.channelId, channelId), eq(timers.id, id)))
          .run();
      else {
        const row = db
          .select()
          .from(timers)
          .where(and(eq(timers.channelId, channelId), eq(timers.id, id)))
          .get();
        if (row)
          db.update(timers)
            .set({ scheduledAt: next, fires: row.fires + 1 })
            .where(and(eq(timers.channelId, channelId), eq(timers.id, id)))
            .run();
      }
    },
    /** Delete pending timers for one automation (or the whole channel). Returns rows removed. */
    cancelTimers(automationId?: string, name?: string) {
      return db
        .delete(timers)
        .where(
          name !== undefined && automationId
            ? and(scoped(automationId), eq(timers.name, name))
            : scoped(automationId),
        )
        .run().changes;
    },
  };
}
