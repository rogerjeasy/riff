# Trusted production setup — F39

The production service owns external operations. Generated modules, recipe code and
private previews have no transport access. All HTTP routes are private, covered by
the host session gate and mutation guard. Configure `RIFF_SECRET` before connecting:
original/current OBS settings are AES-GCM sealed in channel-scoped `production_state`.
Connection passwords are used only for the live handshake and never persisted; rows
written by earlier builds have their sealed credentials scrubbed at startup. The view includes connection status, discovered names, exact
reviews and bounded decisions; it excludes passwords and browser-source URLs/keys.

## Connections and OBS setup

`connect` is explicit discovery consent. Use `ws` only for a directly entered local
or private IPv4 endpoint; use authenticated `wss` for other reachable endpoints. URL
credentials, query strings, fragments and metadata/wildcard endpoints are rejected.
A hosted Riff instance cannot automatically reach a creator's localhost. Authentication
must be enabled in both external tools. Reconnection is explicit, never automatic,
and revokes only that connector's authority. Every connection has a random identity.
OBS disconnect, connection loss or timeout drops an unapplied review and fences apply
and confirm of an applied one, but keeps its sealed original and expected snapshots:
after reconnecting, the creator can undo it (unchanged settings still required) or
re-review the same owned diagnostic source. Bot reconnection clears bot reviews and
grants. Approving a mapping review fences pending bot dispatches; merely reviewing,
importing or discarding never changes live mappings. OBS reconnection retains bot
grants. Panic/close retain a global fence across both tools. No work is replayed at boot.
Passwords must be re-entered on every connect.

Discovery keeps the first 200 scenes and 500 actions whose names/IDs are 1–120
characters; skipped entries are counted in the connection `reason` instead of
refusing the connection. Connection reasons and every `recent` entry are plain
language: adapter refusals (for example, "OBS WebSocket authentication is disabled")
are shown verbatim; unknown adapter errors are reported generically.

OBS uses WebSocket v5/RPC1, no event subscriptions. The creator selects a discovered
scene and source name, reviews dimensions and create/update intent, then approves the
exact digest. Apply creates or updates only a Riff-owned browser source to the public,
credential-free `/production-test` diagnostic page. Seeing that page is a human
verification step: the creator explicitly confirms before the host swaps in its live
scoped overlay URL. The adapter does not claim to inspect rendered pixels.

Before update it verifies the source has no direct or indirect references in other
scenes, including nested scenes/groups. Existing unrelated or non-browser inputs are
rejected. Live-source ownership requires this channel's complete overlay URL, including
its scoped key; sharing an origin/path is insufficient. A credential-free diagnostic
source is accepted only if this channel wrote its exact settings to that scene/source
in the current connection. Unclaimed diagnostics are never silently adopted. Source settings are compared before apply, confirm and rollback. Undo restores
the bounded sealed original JSON settings verbatim, including omitted default dimensions, or removes only the scene item created by this setup; it never
removes a global source. Undo requires the current reviewed connection and unchanged
settings. OBS disconnect or ambiguous OBS failure requires inspection and a fresh review;
there is no automatic compensating write against uncertain external state.

An operation has an eight-second service deadline; Streamer.bot requests have four
seconds. Timeout fences and disconnects the affected connector. Operations serialize
per connector: an OBS operation never blocks bot events or mapping review. Writes are never retried.
Panic clears transport authority synchronously before best-effort disconnect, even if
cleanup or storage fails. An already accepted external operation cannot be recalled.

## Streamer.bot mappings

Authentication and Custom.Event subscription use the documented WebSocket protocol
introduced in 0.2.5. The creator selects named enabled actions from GetActions and
reviews a maximum of 20 mappings. Each mapping binds a custom event name to start or
pause of an exact current, approved, healthy local version. The root control callback
retains the existing version/round authority. Optional `actionId` sends that named
DoAction once when the pinned version's round finishes. Selecting an external action
trusts the creator's existing action definition; Riff does not import or execute its
scripts internally. A changed local version invalidates the mapping at dispatch.

Custom.Event data must include this shape (synthetic values):

```json
{
  "eventName": "Start challenge",
  "args": {
    "riff": {
      "eventId": "unique-event",
      "causalId": "original-cause",
      "origin": "my-production-tool",
      "hops": 0,
      "at": 1793550000000
    }
  }
}
```

The transport authenticates the sender; metadata does not grant authority. Events
without approved mappings or valid metadata are rejected. Every ignored, rejected,
deduplicated or applied event is recorded in `recent` with its event name and reason. Self-origin, hops above two,
events over two minutes old or over 30 seconds ahead, duplicate event/causal IDs and
rate overflow never dispatch. Up to 16 controls can be pending, 60 receipts per minute,
2,000 receipts over ten minutes. Receipt claims persist before dispatch, including
ambiguous outcomes. Outbound round claims have separate durable per-mapping identity;
clock expiry cannot replay a finished round. Approval baselines already-finished rounds.
Observer work is single-flight. Outbound metadata preserves causal loop protection;
a tool that strips it cannot generate an accepted inbound event.

## Import and routes

Only `{format:"riff-production",version:1,mappings:[...]}` is supported. Import never
throws for unsupported content; it stages a review whose `unsupported` list blocks
approval. Native Streamer.bot/Firebot exports are named unsupported. A riff-production
document with another version, schema failures (for example 21 mappings) or
unknown/executable fields gets specific reasons; nothing is executed or migrated. A
well-formed document naming a non-current version or a missing/disabled action stages
its mappings with one problem per mapping. `differences` lists added, removed and
changed mappings against the approved set in plain language. Staging never approves.
Maximum import size is 32 KiB; HTTP body cap is 40 KiB.

GET `/api/production` returns `{state}`. Guarded POST routes also return `{state}`:

- `/connect`: `{kind:"obs"|"streamerbot",url,password,discover:true}`.
- `/disconnect`: `{kind}`.
- `/obs/review`: `{sceneName,inputName,width,height}` (320–3840 × 240–2160).
- `/obs/apply`, `/obs/confirm`, `/obs/rollback`: `{digest}`.
- `/mappings/review`: `{mappings:[{id,eventName,versionId,control:"start"|"pause",actionId:null|string}]}`.
- `/mappings/approve`: `{digest}` — replaces the live mappings.
- `/mappings/discard`: `{digest}` — drops the pending review; live mappings unchanged.
- `/import`: `{document}`.

Modules: `runtime.ts` (storage, epochs, per-connector deadlines, `revoke`, panic stop),
`connections.ts` (connect/discovery/disconnect), `obs-setup.ts`, `mappings.ts`
(review/approve/discard/import and diffs), `events.ts` (receipts, inbound events,
round-finished actions); `service.ts` only composes them.

Root calls synchronous `stop()` during panic, `observe()` on its timer and `close()`
on shutdown. Tests inject transports and use real SQLite. `production-protocol.test.ts`
runs the real adapters against in-process WebSocket servers speaking obs-websocket v5
(msgpack, as obs-websocket-js uses under Node) and the Streamer.bot protocol. Actual OBS rendering, bot execution and external connectivity
require separate operator verification; passing these tests does not claim those.

Protocol sources checked November 1, 2026:
[OBS v5 protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md),
[OBS browser settings](https://github.com/obsproject/obs-browser/blob/master/obs-browser-source.cpp),
[Streamer.bot authentication](https://docs.streamer.bot/api/websocket/guide/authentication),
[requests](https://docs.streamer.bot/api/websocket/requests),
[Custom.Event](https://docs.streamer.bot/api/websocket/events/custom/event).
