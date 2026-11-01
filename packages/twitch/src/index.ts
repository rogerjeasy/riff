/** Twitch boundary. Importing this package opens no connection; the host wires clients explicitly. */
export type TwitchConnectionState = 'disconnected' | 'connecting' | 'connected' | 'revoked';

export {
  TwitchError,
  type TwitchErrorCode,
  type TwitchErrorDetail,
  type TwitchRefusalReason,
} from './errors.js';
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
  ANNOUNCEMENT_COLORS,
  POLL_STATUSES,
  TWITCH_FEATURE_LIMITS,
  type AnnouncementColor,
  type CreatePollInput,
  type CreatePollResult,
  type HelixPoll,
  type HelixPollChoice,
  type PollStatus,
  type SendAnnouncementInput,
  type SendShoutoutInput,
} from './helix.js';
export {
  HELIX_BASE_URL,
  MAX_USERS_PER_REQUEST,
  createHelixClient,
  type CreateEventSubSubscriptionInput,
  type CreateEventSubSubscriptionResult,
  type EventSubSubscription,
  type HelixClient,
  type HelixClientOptions,
  type HelixUser,
} from './helix.js';
export {
  CHAT_READ_SCOPES,
  TWITCH_FEATURE_SCOPES,
  type TwitchFeature,
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
