# @riff/twitch

The Twitch boundary (AGENTS.md §2.4). It contains the EventSub WebSocket client, the
Helix client, OAuth helpers and sourced fixtures. It imports no other `@riff/*`
package. Importing it opens no connection: the host creates each client explicitly and
passes in `fetch`, the WebSocket constructor and clocks.

## Modules

| Module             | Exports                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/triggers.ts`  | `TRIGGERS`, `triggerForSubscription(type, version)`                                                           | The single table of EventSub types and versions, with doc links, scopes and fixtures. `chat.message` maps to `channel.chat.message` v1.                                                                                                                                                                                                                                                                                                                                                               |
| `src/normalize.ts` | `normalizeChatMessage(event, { messageId, receivedAt })`, `sanitizeChatText`, `NormalizedChatMessage`         | `id` is the envelope `message_id`. Roles come only from badges (`broadcaster`, `moderator`, `subscriber`/`founder`, plus `viewer` for every chatter). Text has C0 controls and DEL removed and is capped at 500 characters. Returns `null` for an unparseable event.                                                                                                                                                                                                                                  |
| `src/eventsub.ts`  | `createEventSubClient(options)` → `{ start, stop, sessionId }`                                                | Handles `session_welcome` (`onWelcome` is called only for fresh sessions) and a watchdog at 1.5 × `keepalive_timeout_seconds`, reset by every valid message. On `session_reconnect` it opens the new URL first and closes the old socket only after the new welcome, without resubscribing. Notifications are deduplicated for 10 minutes, and revocations go to `onRevocation`. After an unexpected close or a watchdog timeout, it reconnects to a fresh session with jittered exponential backoff. |
| `src/helix.ts`     | `createHelixClient({ clientId, getAccessToken, fetch, baseUrl? })` → `createEventSubSubscription`, `getUsers` | This is the only Helix request builder. Every response is parsed with zod loose objects. It retries 429 (honoring `Ratelimit-Reset`) and 5xx with jittered backoff. It never retries 4xx, network failures or timeouts.                                                                                                                                                                                                                                                                               |
| `src/auth.ts`      | `buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`, `validateAccessToken`, `CHAT_READ_SCOPES`          | Authorization code grant flow against `id.twitch.tv`. `CHAT_READ_SCOPES = ['user:read:chat']`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/errors.ts`    | `TwitchError` (`code`, user-safe `message`, log `detail`)                                                     | Codes: `TWITCH_REJECTED`, `TWITCH_UNAUTHORIZED`, `TWITCH_FORBIDDEN`, `TWITCH_UNAVAILABLE`, `TWITCH_INVALID_RESPONSE`, `TWITCH_INVALID_REQUEST`. Messages and details never contain tokens.                                                                                                                                                                                                                                                                                                            |

## Wiring sketch (host side)

```ts
const helix = createHelixClient({ clientId, getAccessToken, fetch });
const eventsub = createEventSubClient({
  onWelcome: (sessionId) =>
    helix.createEventSubSubscription({
      type: TRIGGERS['chat.message'].type,
      version: TRIGGERS['chat.message'].version,
      condition: { broadcaster_user_id: channelId, user_id: channelId },
      sessionId,
    }),
  onNotification: (n) => {
    const chat = normalizeChatMessage(n.event, {
      messageId: n.messageId,
      receivedAt: n.receivedAt,
    });
    // ...
  },
  onRevocation: (r) => {
    /* mark subscription, raise incident */
  },
});
eventsub.start();
```

## Local testing with the Twitch CLI

`twitch event websocket start-server` runs a mock server. Pass
`url: 'ws://127.0.0.1:8080/ws'` to `createEventSubClient` and
`baseUrl: 'http://127.0.0.1:8080'` to `createHelixClient` (the mock subscription
endpoint is `/eventsub/subscriptions`). Then use `twitch event trigger channel.chat.message --transport=websocket`
and `twitch event websocket reconnect`.

## Fixtures

`fixtures/*.json` are copied from the official docs, and each carries a `_source` URL.
Credential-like example values are replaced with fakes and marked with `_note`.
