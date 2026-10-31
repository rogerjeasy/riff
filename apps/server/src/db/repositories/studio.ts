import { admissionRepository } from './admission.js';
import { sessionRepository } from './sessions.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, max } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { activity, automations, channelState, channels, compileRuns, versions } from '../schema.js';

export type VersionRow = typeof versions.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;
export type CompileRunRow = typeof compileRuns.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type ChannelStateRow = typeof channelState.$inferSelect;
export type VersionStatus = VersionRow['status'];

/** Every query is scoped to one channel; nothing here reads across tenants. */
export function forChannel(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  const now = () => Date.now();
  return {
    channelId,
    ...sessionRepository(connection, channelId),
    ...admissionRepository(connection, channelId),
    ensure(displayName: string) {
      db.insert(channels)
        .values({ id: channelId, displayName, createdAt: new Date() })
        .onConflictDoNothing()
        .run();
      db.insert(channelState)
        .values({ channelId, overlayKey: randomBytes(16).toString('base64url'), updatedAt: now() })
        .onConflictDoNothing()
        .run();
    },
    state(): ChannelStateRow {
      const row = db.select().from(channelState).where(eq(channelState.channelId, channelId)).get();
      if (!row) throw new Error('Channel state missing');
      return row;
    },
    updateState(patch: Partial<Omit<ChannelStateRow, 'channelId'>>) {
      db.update(channelState)
        .set({ ...patch, updatedAt: now() })
        .where(eq(channelState.channelId, channelId))
        .run();
    },
    automations(): AutomationRow[] {
      return db
        .select()
        .from(automations)
        .where(eq(automations.channelId, channelId))
        .orderBy(desc(automations.updatedAt))
        .all();
    },
    automation(id: string) {
      return db
        .select()
        .from(automations)
        .where(and(eq(automations.channelId, channelId), eq(automations.id, id)))
        .get();
    },
    createAutomation(title: string) {
      const row = {
        id: randomUUID(),
        channelId,
        title,
        activeVersionId: null,
        status: 'draft' as const,
        createdAt: now(),
        updatedAt: now(),
      };
      db.insert(automations).values(row).run();
      return row;
    },
    updateAutomation(
      id: string,
      patch: Partial<Pick<AutomationRow, 'title' | 'activeVersionId' | 'status'>>,
    ) {
      db.update(automations)
        .set({ ...patch, updatedAt: now() })
        .where(and(eq(automations.channelId, channelId), eq(automations.id, id)))
        .run();
    },
    versions(automationId?: string): VersionRow[] {
      return db
        .select()
        .from(versions)
        .where(
          automationId
            ? and(eq(versions.channelId, channelId), eq(versions.automationId, automationId))
            : eq(versions.channelId, channelId),
        )
        .orderBy(desc(versions.createdAt))
        .all();
    },
    version(id: string) {
      return db
        .select()
        .from(versions)
        .where(and(eq(versions.channelId, channelId), eq(versions.id, id)))
        .get();
    },
    insertVersion(
      row: Omit<
        VersionRow,
        'id' | 'channelId' | 'number' | 'createdAt' | 'approvedAt' | 'activatedAt' | 'incident'
      >,
    ) {
      return connection.client.transaction(() => {
        const last = db
          .select({ value: max(versions.number) })
          .from(versions)
          .where(eq(versions.automationId, row.automationId))
          .get();
        const full: VersionRow = {
          ...row,
          id: randomUUID(),
          channelId,
          number: (last?.value ?? 0) + 1,
          createdAt: now(),
          approvedAt: null,
          activatedAt: null,
          incident: null,
        };
        db.insert(versions).values(full).run();
        return full;
      })();
    },
    updateVersion(
      id: string,
      patch: Partial<Pick<VersionRow, 'status' | 'approvedAt' | 'activatedAt' | 'incident'>>,
    ) {
      db.update(versions)
        .set(patch)
        .where(and(eq(versions.channelId, channelId), eq(versions.id, id)))
        .run();
    },
    /** Atomically make `versionId` the active version of its automation. */
    activate(automationId: string, versionId: string) {
      connection.client.transaction(() => {
        const current = db
          .select()
          .from(automations)
          .where(and(eq(automations.channelId, channelId), eq(automations.id, automationId)))
          .get();
        if (current?.activeVersionId && current.activeVersionId !== versionId)
          db.update(versions)
            .set({ status: 'superseded' })
            .where(and(eq(versions.channelId, channelId), eq(versions.id, current.activeVersionId)))
            .run();
        db.update(versions)
          .set({ status: 'active', activatedAt: now(), approvedAt: now() })
          .where(and(eq(versions.channelId, channelId), eq(versions.id, versionId)))
          .run();
        db.update(automations)
          .set({ activeVersionId: versionId, status: 'live', updatedAt: now() })
          .where(and(eq(automations.channelId, channelId), eq(automations.id, automationId)))
          .run();
      })();
    },
    runs(limit = 20): CompileRunRow[] {
      return db
        .select()
        .from(compileRuns)
        .where(eq(compileRuns.channelId, channelId))
        .orderBy(desc(compileRuns.createdAt))
        .limit(limit)
        .all();
    },
    insertRun(row: Omit<CompileRunRow, 'channelId' | 'createdAt'>) {
      db.insert(compileRuns)
        .values({ ...row, channelId, createdAt: now() })
        .run();
    },
    updateRun(id: string, patch: Partial<Omit<CompileRunRow, 'id' | 'channelId'>>) {
      db.update(compileRuns)
        .set(patch)
        .where(and(eq(compileRuns.channelId, channelId), eq(compileRuns.id, id)))
        .run();
    },
    record(entry: Omit<ActivityRow, 'id' | 'channelId'>) {
      return db
        .insert(activity)
        .values({ ...entry, channelId })
        .returning()
        .get();
    },
    activity(limit = 50): ActivityRow[] {
      return db
        .select()
        .from(activity)
        .where(eq(activity.channelId, channelId))
        .orderBy(desc(activity.id))
        .limit(limit)
        .all();
    },
  };
}
export type ChannelRepository = ReturnType<typeof forChannel>;
