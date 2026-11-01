# Firebot adapter

`client.ts` talks to Firebot v5's local HTTP API (`/api/v1`, default port 7472) and its
root WebSocket on the same port. Checked on November 1, 2026 against crowbartools/Firebot
`src/server/api/v1/v1-router.ts`, the effects, custom-variable, commands and status
controllers, `src/server/websocket-server-manager.ts` and
`src/backend/effects/builtin/send-custom-websocket-event.ts`.

- **Connect**: `GET /status` must answer `{connections:{chat}}`, then the WebSocket sends
  `{type:"invoke",id,name:"subscribe-events",data:null}` and requires a matching
  `{type:"response",name:"success"}` within four seconds.
- **Discovery** (read-only): `GET /effects/preset` → `preset:<id>` actions,
  `GET /custom-variables` → `variable:<name>` actions, `GET /commands/custom` → command
  triggers shown to the creator but never invoked.
- **Invocation** is limited to identifiers returned by the latest discovery:
  `POST /effects/preset/<id>/run` with `{username:"Riff",args:{riffEventId,riffCausalId,riffOrigin,riffHops,riffAt}}`
  or `POST /custom-variables/<name>` with `{data:{riff},ttl:0}`. There is no generic request
  surface; anything else is a `ToolRefusal`.
- **Events**: only `custom-event:<name>` frames (sent by Firebot's "Send Custom WebSocket
  Event" effect) are forwarded. The data must contain `riff` metadata plus `riff.key`, the
  creator-chosen event key entered at connect time; it is compared in constant time and
  stripped before the service sees the event. Events without the key are reported as
  unauthenticated. `at` may be epoch seconds (`$unixTimestamp`) or numeric text and is
  normalized to milliseconds.
- **Origin**: Firebot's API has no authentication and listens on all interfaces, so the
  service accepts only explicitly entered local/private `http(s)` addresses; the key
  authenticates inbound events. Keys are never persisted and must be re-entered on every
  connect.
- **Health**: requests time out after four seconds, are never retried, cap at 16 pending
  and 256 KiB per response, and refuse redirects. The WebSocket caps frames at 64 KiB and
  is pinged every 15 seconds; a missed pong or close fences the connector through the
  service's `onClose`. Reconnection is explicit, never automatic.

The [production service](../../services/production/README.md) owns mappings, durable
deduplication, hop limits and finished-round claims. Native Firebot setups are read by
`services/production/native/firebot.ts` as data only. `test/firebot-protocol.test.ts` runs
this client against an in-process fake Firebot (HTTP + WebSocket); a live Firebot instance
still requires operator verification.
