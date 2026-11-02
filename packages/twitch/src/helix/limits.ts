/**
 * Documented request bounds, checked before any request is sent.
 * Channel Points: https://dev.twitch.tv/docs/api/reference/#create-custom-rewards
 * Predictions: https://dev.twitch.tv/docs/api/reference/#create-prediction
 */
export const CHANNEL_POINTS_LIMITS = Object.freeze({
  /** "The title may contain a maximum of 45 characters". */
  titleLength: 45,
  /** "The prompt is limited to a maximum of 200 characters." */
  promptLength: 200,
  /** "The minimum is 1 point." No maximum is documented. */
  minCost: 1,
  /** "The maximum number of custom rewards per channel is 50". */
  rewardsPerChannel: 50,
  /** Update Redemption Status: "You may specify a maximum of 50 IDs." */
  redemptionIdsPerUpdate: 50,
  /** Update Custom Reward 400: global_cooldown_seconds "the maximum is 604800". */
  maxCooldownSeconds: 604_800,
  /** Get Custom Reward Redemption: page size 1..50. */
  pageSize: 50,
});

export const PREDICTION_LIMITS = Object.freeze({
  /** "The title is limited to a maximum of 45 characters." */
  titleLength: 45,
  /** Outcome "title is limited to a maximum of 25 characters." */
  outcomeLength: 25,
  /** "The list must contain a minimum of 2 choices and up to a maximum of 10 choices." */
  outcomes: { min: 2, max: 10 },
  /** "The minimum is 30 seconds and the maximum is 1800 seconds (30 minutes)." */
  windowSeconds: { min: 30, max: 1800 },
  /** Get Predictions: "You may specify a maximum of 25 IDs." and page size 1..25. */
  idsPerRequest: 25,
});
