import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { sceneHeads, sceneRevisions } from '../schema.js';
import { SceneError, type SceneRevision } from '../../services/scenes/contract.js';
/** Every scene query is scoped to the owning channel. */
export function sceneRepository(connection: DatabaseConnection, channelId: string) {
  const { db, client } = connection;
  const scope = (versionId: string) =>
    and(eq(sceneHeads.channelId, channelId), eq(sceneHeads.versionId, versionId));
  const head = (versionId: string) => db.select().from(sceneHeads).where(scope(versionId)).get();
  return {
    head,
    history(versionId: string) {
      return db
        .select()
        .from(sceneRevisions)
        .where(
          and(eq(sceneRevisions.channelId, channelId), eq(sceneRevisions.versionId, versionId)),
        )
        .orderBy(asc(sceneRevisions.revision))
        .limit(100)
        .all()
        .map((row) => row.evidence);
    },
    append(versionId: string, artifactId: string, expectedRevision: number, next: SceneRevision) {
      client.transaction(() => {
        const current = head(versionId);
        if (
          (current?.revision ?? 0) !== expectedRevision ||
          (current && current.artifactId !== artifactId)
        )
          throw new SceneError('STALE');
        if (expectedRevision >= 100) throw new SceneError('LIMIT');
        if (next.revision !== expectedRevision + 1) throw new SceneError('INVALID');
        if (current)
          db.update(sceneHeads).set({ revision: next.revision }).where(scope(versionId)).run();
        else
          db.insert(sceneHeads)
            .values({
              versionId,
              channelId,
              artifactId,
              revision: next.revision,
              appliedRevision: null,
            })
            .run();
        db.insert(sceneRevisions)
          .values({
            id: randomUUID(),
            versionId,
            channelId,
            revision: next.revision,
            evidence: next,
            createdAt: Date.now(),
          })
          .run();
      })();
    },
    apply(versionId: string, expectedRevision: number) {
      const result = db
        .update(sceneHeads)
        .set({ appliedRevision: expectedRevision })
        .where(and(scope(versionId), eq(sceneHeads.revision, expectedRevision)))
        .run();
      if (result.changes !== 1) throw new SceneError('STALE');
    },
  };
}
