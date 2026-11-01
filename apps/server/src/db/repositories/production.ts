import { eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { productionState } from '../schema.js';
import type { StoredProduction } from '../../services/production/contract.js';
/** A connector never reads another channel's configuration or receipt history. */
export function productionRepository(connection: DatabaseConnection, channelId: string) {
  return {
    get: () =>
      connection.db
        .select()
        .from(productionState)
        .where(eq(productionState.channelId, channelId))
        .get()?.value as unknown as StoredProduction | undefined,
    save: (value: StoredProduction) =>
      connection.db
        .insert(productionState)
        .values({ channelId, value: value as unknown as Record<string, unknown> })
        .onConflictDoUpdate({
          target: productionState.channelId,
          set: { value: value as unknown as Record<string, unknown> },
        })
        .run(),
  };
}
