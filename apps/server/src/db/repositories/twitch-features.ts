import { eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { twitchFeatureState } from '../schema.js';

/** One channel's native Twitch feature row; never reads another channel's state. */
export function twitchFeaturesRepository(connection: DatabaseConnection, channelId: string) {
  return {
    get: (): unknown =>
      connection.db
        .select()
        .from(twitchFeatureState)
        .where(eq(twitchFeatureState.channelId, channelId))
        .get()?.value,
    save: (value: Record<string, unknown>) =>
      connection.db
        .insert(twitchFeatureState)
        .values({ channelId, value })
        .onConflictDoUpdate({ target: twitchFeatureState.channelId, set: { value } })
        .run(),
  };
}
export type TwitchFeaturesRepository = ReturnType<typeof twitchFeaturesRepository>;
