import { eq } from 'drizzle-orm';
import type { DirectorState } from '@riff/sdk';
import type { DatabaseConnection } from '../client.js';
import { directorState } from '../schema.js';
import { DirectorError } from '../../services/director/contract.js';
export type StoredDirector = Omit<DirectorState, 'telemetry'>;
/** All director reads and writes stay inside the owning channel. */
export function directorRepository(connection: DatabaseConnection, channelId: string) {
  const { db, client } = connection;
  const get = () =>
    db.select().from(directorState).where(eq(directorState.channelId, channelId)).get()?.value;
  return {
    get,
    /** Claim before broadcasting; retries, approval and restart never refill this budget. */
    claimBatch(at: number, limit: number) {
      return client.transaction(() => {
        const row = db
          .select()
          .from(directorState)
          .where(eq(directorState.channelId, channelId))
          .get();
        if (
          !row ||
          !Number.isSafeInteger(at) ||
          at < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 60
        )
          return false;
        const clock = Math.max(at, ...row.batches);
        const batches = row.batches.filter((t) => t > clock - 60_000);
        if (batches.length >= limit) return false;
        db.update(directorState)
          .set({ batches: [...batches, clock] })
          .where(eq(directorState.channelId, channelId))
          .run();
        return true;
      })();
    },
    save(expectedRevision: number, value: StoredDirector) {
      client.transaction(() => {
        const before = get();
        if ((before?.revision ?? 0) !== expectedRevision || value.revision !== expectedRevision + 1)
          throw new DirectorError('STALE', 'Director settings changed. Reload before continuing.');
        if (before)
          db.update(directorState)
            .set({ value })
            .where(eq(directorState.channelId, channelId))
            .run();
        else db.insert(directorState).values({ channelId, value }).run();
      })();
    },
  };
}
