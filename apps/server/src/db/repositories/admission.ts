import { and, asc, eq, gt, lt } from 'drizzle-orm';
import type { DecisionCode } from '@riff/sdk';
import type { DatabaseConnection } from '../client.js';
import { admissionEvents } from '../schema.js';

export type AdmissionRow = typeof admissionEvents.$inferSelect;

/** Channel-scoped durable admission and cosmetic budget records for live interactions. */
export function admissionRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  return {
    /** Whether this interaction already decided this event (any retained age). */
    hasAdmission(automationId: string, eventId: string) {
      return Boolean(
        db
          .select({ seq: admissionEvents.seq })
          .from(admissionEvents)
          .where(
            and(
              eq(admissionEvents.channelId, channelId),
              eq(admissionEvents.automationId, automationId),
              eq(admissionEvents.eventId, eventId),
            ),
          )
          .get(),
      );
    },
    recordAdmission(row: {
      automationId: string;
      eventId: string;
      viewerId: string;
      at: number;
      code: DecisionCode;
      effects: number;
    }) {
      db.insert(admissionEvents)
        .values({ channelId, ...row })
        .run();
    },
    /** Records newer than `since`, oldest first: the order counters were built in. */
    admissionsSince(since: number): AdmissionRow[] {
      return db
        .select()
        .from(admissionEvents)
        .where(and(eq(admissionEvents.channelId, channelId), gt(admissionEvents.at, since)))
        .orderBy(asc(admissionEvents.at), asc(admissionEvents.seq))
        .all();
    },
    pruneAdmissions(before: number) {
      return db
        .delete(admissionEvents)
        .where(and(eq(admissionEvents.channelId, channelId), lt(admissionEvents.at, before)))
        .run().changes;
    },
  };
}
