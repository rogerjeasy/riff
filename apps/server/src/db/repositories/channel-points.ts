import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import { channelPointRedemptions, channelPointRewards, predictionRequests } from '../schema.js';

export type RewardRow = typeof channelPointRewards.$inferSelect;
export type RedemptionRow = typeof channelPointRedemptions.$inferSelect;
export type PredictionRequestRow = typeof predictionRequests.$inferSelect;

/** Redemption history kept for the console queue; older settled rows are pruned. */
export const REDEMPTION_RETENTION = 500;
/** Prediction requests kept for the console. */
export const PREDICTION_REQUEST_RETENTION = 50;

/** Channel-scoped Channel Points storage; every query is bound to one channel. */
export function channelPointsRepository(connection: DatabaseConnection, channelId: string) {
  const { db, client } = connection;
  const reward = (rewardId: string) =>
    db
      .select()
      .from(channelPointRewards)
      .where(
        and(
          eq(channelPointRewards.channelId, channelId),
          eq(channelPointRewards.rewardId, rewardId),
        ),
      )
      .get();
  return {
    rewards(): RewardRow[] {
      return db
        .select()
        .from(channelPointRewards)
        .where(eq(channelPointRewards.channelId, channelId))
        .orderBy(desc(channelPointRewards.createdAt))
        .all();
    },
    reward,
    rewardForAutomation(automationId: string) {
      return db
        .select()
        .from(channelPointRewards)
        .where(
          and(
            eq(channelPointRewards.channelId, channelId),
            eq(channelPointRewards.automationId, automationId),
          ),
        )
        .get();
    },
    insertReward(row: Omit<RewardRow, 'channelId'>) {
      db.insert(channelPointRewards)
        .values({ ...row, channelId })
        .run();
    },
    updateReward(rewardId: string, patch: Partial<Omit<RewardRow, 'channelId' | 'rewardId'>>) {
      db.update(channelPointRewards)
        .set(patch)
        .where(
          and(
            eq(channelPointRewards.channelId, channelId),
            eq(channelPointRewards.rewardId, rewardId),
          ),
        )
        .run();
    },
    /** One reward per automation: linking moves the link atomically. */
    link(rewardId: string, automationId: string | null, policy: RewardRow['policy'], at: number) {
      client.transaction(() => {
        if (automationId)
          db.update(channelPointRewards)
            .set({ automationId: null, updatedAt: at })
            .where(
              and(
                eq(channelPointRewards.channelId, channelId),
                eq(channelPointRewards.automationId, automationId),
              ),
            )
            .run();
        db.update(channelPointRewards)
          .set({ automationId, policy, updatedAt: at })
          .where(
            and(
              eq(channelPointRewards.channelId, channelId),
              eq(channelPointRewards.rewardId, rewardId),
            ),
          )
          .run();
      })();
    },
    deleteReward(rewardId: string) {
      db.delete(channelPointRewards)
        .where(
          and(
            eq(channelPointRewards.channelId, channelId),
            eq(channelPointRewards.rewardId, rewardId),
          ),
        )
        .run();
    },
    /** Insert a redemption once; false when this redemption id was already recorded. */
    claimRedemption(row: Omit<RedemptionRow, 'channelId'>): boolean {
      return client.transaction(() => {
        const existing = db
          .select({ id: channelPointRedemptions.redemptionId })
          .from(channelPointRedemptions)
          .where(
            and(
              eq(channelPointRedemptions.channelId, channelId),
              eq(channelPointRedemptions.redemptionId, row.redemptionId),
            ),
          )
          .get();
        if (existing) return false;
        db.insert(channelPointRedemptions)
          .values({ ...row, channelId })
          .run();
        const stale = db
          .select({ id: channelPointRedemptions.redemptionId })
          .from(channelPointRedemptions)
          .where(eq(channelPointRedemptions.channelId, channelId))
          .orderBy(desc(channelPointRedemptions.receivedAt))
          .limit(1)
          .offset(REDEMPTION_RETENTION)
          .get();
        if (stale) {
          const cutoff = db
            .select({ at: channelPointRedemptions.receivedAt })
            .from(channelPointRedemptions)
            .where(
              and(
                eq(channelPointRedemptions.channelId, channelId),
                eq(channelPointRedemptions.redemptionId, stale.id),
              ),
            )
            .get();
          if (cutoff)
            db.delete(channelPointRedemptions)
              .where(
                and(
                  eq(channelPointRedemptions.channelId, channelId),
                  lt(channelPointRedemptions.receivedAt, cutoff.at),
                  inArray(channelPointRedemptions.status, ['fulfilled', 'refunded']),
                ),
              )
              .run();
        }
        return true;
      })();
    },
    redemption(redemptionId: string) {
      return db
        .select()
        .from(channelPointRedemptions)
        .where(
          and(
            eq(channelPointRedemptions.channelId, channelId),
            eq(channelPointRedemptions.redemptionId, redemptionId),
          ),
        )
        .get();
    },
    updateRedemption(
      redemptionId: string,
      patch: Partial<
        Pick<RedemptionRow, 'status' | 'code' | 'reason' | 'updatedAt' | 'automationId'>
      >,
    ) {
      db.update(channelPointRedemptions)
        .set(patch)
        .where(
          and(
            eq(channelPointRedemptions.channelId, channelId),
            eq(channelPointRedemptions.redemptionId, redemptionId),
          ),
        )
        .run();
    },
    redemptions(limit = 50): RedemptionRow[] {
      return db
        .select()
        .from(channelPointRedemptions)
        .where(eq(channelPointRedemptions.channelId, channelId))
        .orderBy(desc(channelPointRedemptions.receivedAt))
        .limit(limit)
        .all();
    },
    queued(): RedemptionRow[] {
      return db
        .select()
        .from(channelPointRedemptions)
        .where(
          and(
            eq(channelPointRedemptions.channelId, channelId),
            inArray(channelPointRedemptions.status, ['queued', 'failed']),
          ),
        )
        .all();
    },
    // Prediction requests
    insertRequest(row: Omit<PredictionRequestRow, 'channelId'>): boolean {
      return client.transaction(() => {
        if (
          row.eventId &&
          row.automationId &&
          db
            .select({ id: predictionRequests.id })
            .from(predictionRequests)
            .where(
              and(
                eq(predictionRequests.channelId, channelId),
                eq(predictionRequests.automationId, row.automationId),
                eq(predictionRequests.eventId, row.eventId),
              ),
            )
            .get()
        )
          return false;
        db.insert(predictionRequests)
          .values({ ...row, channelId })
          .run();
        const keep = db
          .select({ id: predictionRequests.id })
          .from(predictionRequests)
          .where(eq(predictionRequests.channelId, channelId))
          .orderBy(desc(predictionRequests.createdAt))
          .limit(PREDICTION_REQUEST_RETENTION)
          .all()
          .map((r) => r.id);
        const all = db
          .select({ id: predictionRequests.id })
          .from(predictionRequests)
          .where(eq(predictionRequests.channelId, channelId))
          .all()
          .map((r) => r.id)
          .filter((id) => !keep.includes(id));
        if (all.length)
          db.delete(predictionRequests)
            .where(
              and(eq(predictionRequests.channelId, channelId), inArray(predictionRequests.id, all)),
            )
            .run();
        return true;
      })();
    },
    request(id: string) {
      return db
        .select()
        .from(predictionRequests)
        .where(and(eq(predictionRequests.channelId, channelId), eq(predictionRequests.id, id)))
        .get();
    },
    requests(limit = 20): PredictionRequestRow[] {
      return db
        .select()
        .from(predictionRequests)
        .where(eq(predictionRequests.channelId, channelId))
        .orderBy(desc(predictionRequests.createdAt))
        .limit(limit)
        .all();
    },
    updateRequest(
      id: string,
      patch: Partial<
        Pick<PredictionRequestRow, 'status' | 'predictionId' | 'message' | 'updatedAt'>
      >,
    ) {
      db.update(predictionRequests)
        .set(patch)
        .where(and(eq(predictionRequests.channelId, channelId), eq(predictionRequests.id, id)))
        .run();
    },
    dismissProposed(at: number, message: string) {
      db.update(predictionRequests)
        .set({ status: 'dismissed', message, updatedAt: at })
        .where(
          and(
            eq(predictionRequests.channelId, channelId),
            eq(predictionRequests.status, 'proposed'),
          ),
        )
        .run();
    },
  };
}
export type ChannelPointsRepository = ReturnType<typeof channelPointsRepository>;
