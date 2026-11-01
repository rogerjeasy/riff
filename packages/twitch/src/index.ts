/** Twitch boundary. Importing this package opens no connection; the host wires clients explicitly. */
export type TwitchConnectionState = 'disconnected' | 'connecting' | 'connected' | 'revoked';

export { TwitchError, type TwitchErrorCode, type TwitchErrorDetail } from './errors.js';
export type { FetchLike } from './http.js';
export {
  TRIGGERS,
  triggerForSubscription,
  type TriggerDefinition,
  type TriggerName,
} from './triggers.js';
export {
  MAX_CHAT_TEXT_LENGTH,
  normalizeChatMessage,
  sanitizeChatText,
  type ChatRole,
  type NormalizedChatMessage,
} from './normalize.js';
export {
  DEDUPE_WINDOW_MS,
  EVENTSUB_WEBSOCKET_URL,
  KEEPALIVE_WATCHDOG_FACTOR,
  createEventSubClient,
  type EventSubClient,
  type EventSubClientOptions,
  type EventSubNotification,
  type EventSubRevocation,
  type EventSubSocket,
  type EventSubState,
  type EventSubStateDetail,
  type EventSubWebSocketConstructor,
  type TimerHandle,
} from './eventsub.js';
export {
  HELIX_BASE_URL,
  MAX_USERS_PER_REQUEST,
  MAX_CHAT_MESSAGE_LENGTH,
  createHelixClient,
  type SendChatMessageInput,
  type SendChatMessageResult,
  type CreateEventSubSubscriptionInput,
  type CreateEventSubSubscriptionResult,
  type EventSubSubscription,
  type HelixClient,
  type HelixClientOptions,
  type HelixUser,
} from './helix.js';
export {
  CHAT_READ_SCOPES,
  CHAT_WRITE_SCOPES,
  TWITCH_AUTHORIZE_URL,
  TWITCH_TOKEN_URL,
  TWITCH_VALIDATE_URL,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  validateAccessToken,
  type TokenValidation,
  type TwitchTokenSet,
} from './auth.js';
export {
  CHANNEL_POINTS_LIMITS,
  PREDICTION_LIMITS,
  predictionInputProblem,
  type ChannelPointsApi,
  type CustomReward,
  type CustomRewardInput,
  type CustomRewardRedemption,
  type CustomRewardUpdate,
  type EndPredictionInput,
  type Prediction,
  type PredictionInput,
  type PredictionOutcome,
  type PredictionStatus,
  type PredictionsApi,
  type RedemptionStatus,
} from './helix.js';
export { normalizeRedemption, type NormalizedRedemption } from './normalize.js';
export { CHANNEL_POINTS_SCOPES, PREDICTION_SCOPES } from './auth.js';
