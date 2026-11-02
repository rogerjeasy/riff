import { and, asc, count, eq, like } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { collaborationSessions, collaborationReceipts } from '../schema.js';
export type CollaborationRow = typeof collaborationSessions.$inferSelect;
/** Coordinator-only storage. Members receive allowlisted projections from the service. */
export function collaborationRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  const where = (id: string) =>
    and(eq(collaborationSessions.channelId, channelId), eq(collaborationSessions.id, id));
  return {
    atomic<T>(work: () => T) {
      return connection.client.transaction(work)();
    },
    list() {
      return db
        .select()
        .from(collaborationSessions)
        .where(eq(collaborationSessions.channelId, channelId))
        .all();
    },
    get(id: string) {
      return db.select().from(collaborationSessions).where(where(id)).get();
    },
    insert(row: Omit<CollaborationRow, 'channelId'>) {
      db.insert(collaborationSessions)
        .values({ ...row, channelId })
        .run();
    },
    save(row: CollaborationRow, expectedRevision: number) {
      const { id, ...patch } = row;
      return (
        db
          .update(collaborationSessions)
          .set({ ...patch, channelId })
          .where(and(where(id), eq(collaborationSessions.revision, expectedRevision)))
          .run().changes === 1
      );
    },
    hasReceipt(sessionId: string, eventId: string) {
      return !!db
        .select()
        .from(collaborationReceipts)
        .where(
          and(
            eq(collaborationReceipts.channelId, channelId),
            eq(collaborationReceipts.sessionId, sessionId),
            eq(collaborationReceipts.eventId, eventId),
          ),
        )
        .get();
    },
    receiptCount(sessionId: string) {
      return (
        db
          .select({ value: count() })
          .from(collaborationReceipts)
          .where(
            and(
              eq(collaborationReceipts.channelId, channelId),
              eq(collaborationReceipts.sessionId, sessionId),
            ),
          )
          .get()?.value ?? 0
      );
    },
    /** Audited host decisions (continuation choices, raid handoffs), oldest first. */
    decisions(sessionId: string) {
      return db
        .select({ code: collaborationReceipts.code, at: collaborationReceipts.at })
        .from(collaborationReceipts)
        .where(
          and(
            eq(collaborationReceipts.channelId, channelId),
            eq(collaborationReceipts.sessionId, sessionId),
            like(collaborationReceipts.eventId, 'audit:%'),
          ),
        )
        .orderBy(asc(collaborationReceipts.at))
        .limit(50)
        .all();
    },
    receipt(sessionId: string, eventId: string, code: string, at: number) {
      db.insert(collaborationReceipts).values({ channelId, sessionId, eventId, code, at }).run();
    },
  };
}
