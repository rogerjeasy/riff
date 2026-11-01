import { eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { chatAuthoringState } from '../schema.js';

/** In-chat authoring state never leaves its owning channel. */
export function chatAuthoringRepository(connection: DatabaseConnection, channelId: string) {
  return {
    get: (): unknown =>
      connection.db
        .select()
        .from(chatAuthoringState)
        .where(eq(chatAuthoringState.channelId, channelId))
        .get()?.value,
    save: (value: Record<string, unknown>) =>
      connection.db
        .insert(chatAuthoringState)
        .values({ channelId, value })
        .onConflictDoUpdate({ target: chatAuthoringState.channelId, set: { value } })
        .run(),
  };
}
export type ChatAuthoringRepository = ReturnType<typeof chatAuthoringRepository>;
