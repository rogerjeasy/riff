import { eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { recipeState } from '../schema.js';
/** Identity of an edition this channel exported; it proves ownership of later revisions. */
export interface ExportedEdition {
  digest: string;
  recipeId: string;
  revision: number;
  title: string;
}
/**
 * The JSON blob. `exports` stays the digest list for older rows; `exportedEditions`
 * (added later, optional) carries recipe identity for the same digests.
 */
export type RecipeRecord = (typeof recipeState.$inferSelect)['value'] & {
  exportedEditions?: ExportedEdition[];
};
/** Private access is scoped; public projections are explicitly limited to published snapshots. */
export function recipeRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  return {
    get: (): RecipeRecord | undefined =>
      db.select().from(recipeState).where(eq(recipeState.channelId, channelId)).get()?.value,
    save: (value: RecipeRecord) =>
      db
        .insert(recipeState)
        .values({ channelId, value })
        .onConflictDoUpdate({ target: recipeState.channelId, set: { value } })
        .run(),
    published: () =>
      (
        db.select().from(recipeState).where(eq(recipeState.channelId, channelId)).get()?.value
          .publications ?? []
      ).filter((publication) => !publication.withheld),
  };
}
