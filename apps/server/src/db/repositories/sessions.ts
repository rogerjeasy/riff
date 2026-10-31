import { validateSessionSnapshot } from '@riff/sandbox';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  ChatEvent,
  ExecutionDecision,
  ExperienceDefinition,
  SessionSnapshot,
} from '@riff/sdk';
import type { DatabaseConnection } from '../client.js';
import {
  automations,
  experienceSessions,
  sessionEvents,
  sessionOutbox,
  versions,
} from '../schema.js';

export interface SessionCommit {
  automationId: string;
  versionId: string;
  expectedRevision: number;
  snapshot: SessionSnapshot;
  event?: ChatEvent;
  decision?: ExecutionDecision;
  viewer?: string | null;
}
/** All state, journal and outbox mutations stay inside channel-scoped transactions. */
export function sessionRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  const session = (automationId: string) =>
    db
      .select()
      .from(experienceSessions)
      .where(
        and(
          eq(experienceSessions.channelId, channelId),
          eq(experienceSessions.automationId, automationId),
        ),
      )
      .get();
  return {
    atomic<T>(work: () => T): T {
      return connection.client.transaction(work)();
    },
    session,
    sessions() {
      return db
        .select()
        .from(experienceSessions)
        .where(eq(experienceSessions.channelId, channelId))
        .all();
    },
    replaceSession(input: {
      automationId: string;
      versionId: string;
      definition: ExperienceDefinition;
      snapshot: SessionSnapshot;
    }) {
      const owner = db
        .select()
        .from(versions)
        .where(
          and(
            eq(versions.id, input.versionId),
            eq(versions.channelId, channelId),
            eq(versions.automationId, input.automationId),
          ),
        )
        .get();
      if (!owner) throw new Error('Session version does not belong to this channel');
      const snapshot = validateSessionSnapshot(input.definition, input.snapshot);
      const row = {
        ...input,
        snapshot,
        id: input.snapshot.id,
        channelId,
        revision: input.snapshot.revision,
        updatedAt: input.snapshot.updatedAt,
      };
      db.insert(experienceSessions)
        .values(row)
        .onConflictDoUpdate({ target: experienceSessions.automationId, set: row })
        .run();
      db.delete(sessionOutbox)
        .where(
          and(
            eq(sessionOutbox.channelId, channelId),
            eq(sessionOutbox.automationId, input.automationId),
          ),
        )
        .run();
    },
    removeSession(automationId: string) {
      db.delete(experienceSessions)
        .where(
          and(
            eq(experienceSessions.channelId, channelId),
            eq(experienceSessions.automationId, automationId),
          ),
        )
        .run();
      db.delete(sessionOutbox)
        .where(
          and(eq(sessionOutbox.channelId, channelId), eq(sessionOutbox.automationId, automationId)),
        )
        .run();
    },
    hasAutomationEvent(automationId: string, eventId: string) {
      return Boolean(
        db
          .select({ id: sessionEvents.id })
          .from(sessionEvents)
          .where(
            and(
              eq(sessionEvents.channelId, channelId),
              eq(sessionEvents.automationId, automationId),
              eq(sessionEvents.eventId, eventId),
            ),
          )
          .get(),
      );
    },
    hasSessionEvent(sessionId: string, eventId: string) {
      return Boolean(
        db
          .select({ id: sessionEvents.id })
          .from(sessionEvents)
          .where(
            and(
              eq(sessionEvents.channelId, channelId),
              eq(sessionEvents.sessionId, sessionId),
              eq(sessionEvents.eventId, eventId),
            ),
          )
          .get(),
      );
    },
    sessionEvents(sessionId: string) {
      return db
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.channelId, channelId), eq(sessionEvents.sessionId, sessionId)))
        .orderBy(asc(sessionEvents.at), asc(sessionEvents.revision))
        .all();
    },
    commitSession(input: SessionCommit) {
      return connection.client.transaction(() => {
        const current = session(input.automationId);
        const automation = db
          .select()
          .from(automations)
          .where(and(eq(automations.channelId, channelId), eq(automations.id, input.automationId)))
          .get();
        if (
          !current ||
          current.id !== input.snapshot.id ||
          current.revision !== input.expectedRevision ||
          current.versionId !== input.versionId ||
          automation?.activeVersionId !== input.versionId ||
          automation.status !== 'live'
        )
          return false;
        if (
          input.event &&
          db
            .select({ id: sessionEvents.id })
            .from(sessionEvents)
            .where(
              and(
                eq(sessionEvents.channelId, channelId),
                eq(sessionEvents.automationId, input.automationId),
                eq(sessionEvents.eventId, input.event.id),
              ),
            )
            .get()
        )
          return false;
        db.update(experienceSessions)
          .set({
            snapshot: input.snapshot,
            revision: input.snapshot.revision,
            updatedAt: input.snapshot.updatedAt,
          })
          .where(
            and(
              eq(experienceSessions.channelId, channelId),
              eq(experienceSessions.automationId, input.automationId),
            ),
          )
          .run();
        validateSessionSnapshot(current.definition, input.snapshot);
        if (
          input.snapshot.revision < input.expectedRevision ||
          (input.snapshot.revision === input.expectedRevision &&
            JSON.stringify(input.snapshot) !== JSON.stringify(current.snapshot))
        )
          throw new Error('Session revision must advance with state');
        if (input.event && input.decision) {
          db.insert(sessionEvents)
            .values({
              id: randomUUID(),
              channelId,
              sessionId: current.id,
              automationId: input.automationId,
              versionId: input.versionId,
              eventId: input.event.id,
              at: input.event.at,
              event: input.event,
              code: input.decision.code,
              revision: input.snapshot.revision,
            })
            .run();
          if (input.decision.code === 'ACCEPTED' && input.decision.effects.length) {
            const payload = { ...input.decision };
            delete payload.session;
            db.insert(sessionOutbox)
              .values({
                id: randomUUID(),
                channelId,
                sessionId: current.id,
                automationId: input.automationId,
                versionId: input.versionId,
                decision: payload,
                viewer: input.viewer ?? null,
                at: input.event.at,
                dispatchedAt: null,
              })
              .run();
          }
        }
        return true;
      })();
    },
    /** Controls already hold the runtime fence; publish state without accepting chat. */
    updateSessionControl(automationId: string, snapshot: SessionSnapshot, versionId?: string) {
      const current = session(automationId);
      if (!current || current.id !== snapshot.id) throw new Error('Session changed');
      db.update(experienceSessions)
        .set({
          snapshot,
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          ...(versionId ? { versionId } : {}),
        })
        .where(
          and(
            eq(experienceSessions.channelId, channelId),
            eq(experienceSessions.automationId, automationId),
          ),
        )
        .run();
      db.delete(sessionOutbox)
        .where(
          and(eq(sessionOutbox.channelId, channelId), eq(sessionOutbox.automationId, automationId)),
        )
        .run();
    },
    sessionOutbox(automationId: string) {
      return db
        .select()
        .from(sessionOutbox)
        .where(
          and(
            eq(sessionOutbox.channelId, channelId),
            eq(sessionOutbox.automationId, automationId),
            isNull(sessionOutbox.dispatchedAt),
          ),
        )
        .orderBy(asc(sessionOutbox.at))
        .all();
    },
    /** Claim before sending: a crash cannot replay an old cosmetic projectile. */
    claimSessionEffect(id: string) {
      return (
        db
          .update(sessionOutbox)
          .set({ dispatchedAt: Date.now() })
          .where(
            and(
              eq(sessionOutbox.channelId, channelId),
              eq(sessionOutbox.id, id),
              isNull(sessionOutbox.dispatchedAt),
            ),
          )
          .run().changes === 1
      );
    },
  };
}
