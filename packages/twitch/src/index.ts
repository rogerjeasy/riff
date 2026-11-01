/** Twitch boundary. Importing this package opens no connection; the host wires clients explicitly. */
export type TwitchConnectionState = 'disconnected' | 'connecting' | 'connected' | 'revoked';

export { TwitchError, type TwitchErrorCode, type TwitchErrorDetail } from './errors.js';
export type { FetchLike } from './http.js';
export {
  EVENT_TRIGGER_NAMES,
  TRIGGERS,
  missingScopes,
  scopesForTriggers,
  triggerCondition,
  triggerForSubscription,
  type EventTriggerName,
  type TriggerDefinition,
  type TriggerName,
} from './triggers.js';
export {
  ANONYMOUS_VIEWER_ID,
  MAX_EVENT_AMOUNT,
  normalizeTwitchEvent,
  type NormalizedTwitchEvent,
  type SubscriptionTier,
  type TwitchEventKind,
} from './normalize-events.js';
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
