# F39 Production setup and F40 inclusive participation

Implement the approved roadmap on main. No commits until owner review. Existing engine,
exact-version approval, migrations, scenes and panic remain the authority.

## Approach

Use trusted host adapters with explicit connection and operation grants. The host must
reach OBS/Streamer.bot: local host is the direct setup; hosted operators use an explicitly
reachable secured endpoint. Do not expose an unauthenticated local bridge. Existing ws
and obs-websocket-js dependencies suffice. Guest code gets no raw connector capability.
Production secrets use the existing AES-GCM sealer and never reach public snapshots,
exports, overlay URLs, or model context. A channel without RIFF_SECRET cannot save secrets.

OBS: authenticated v5 connection, opt-in scene discovery, explicit selected scene/source
and operation grants, dry setup review bound to digest, then approved browser-source
creation/update. Setup is idempotent and rechecks the connected instance/scene. Display
connection errors safely. A test frame uses a dedicated preview URL/source setting with
clear labels; never runs a production action as preview. Creator confirms the visible
frame, then switches the owned browser source to the approved live overlay. Source
rollback restores only the setup change after checking current settings. Panic fences
all new external actions synchronously; it does not depend on the connection.

Streamer.bot: authenticated WebSocket Hello/challenge/Authenticate, bounded correlated
requests, Subscribe Custom.Event, selected GetActions/DoAction. Map one approved event
name to start/resume or pause an exact already approved local version; map a selected
round-finished event to a named allowed bot action. No arbitrary arguments or scripts.
Normalized production events are distinct from Twitch chat. Require origin, causal ID,
hop count and event ID in the mapped custom event arguments. Reject self-origin and
excess hops; persist bounded receipts before dispatch; ambiguous writes are never retried.
Restart disconnects and requires explicit reconnect. No queued effects replay.

Configuration import accepts an explicitly versioned Riff production mapping JSON,
shows a traceable diff and unsupported operations, and stages a draft for review. Never
pretend arbitrary native Streamer.bot/Firebot exports are completely migrated. Native
formats without a verified schema are listed as unsupported, including embedded scripts.

F40: durable per-channel broadcast settings (language en/fr/es/de, reduced motion,
contrast and readable labels). Public companion /participate shows only current approved
interaction instructions, eligibility, objective, phase, remaining time and aggregate
outcome; no viewer IDs, credentials or private drafts. Its device-local language, motion
and contrast preferences are explicit and persist. It offers text equivalents and
keyboard/mobile layouts. Existing intentional audience restrictions are described
truthfully; settings never silently rewrite approved eligibility or competitive rules.
Core public experiences continue using free chat, without a payment mechanism.

Late arrival help uses !riff help [en|fr|es|de] on authenticated chat, bounded to one help
response per viewer per 30 seconds and six channel responses per minute; event IDs dedupe.
It renders current instructions in existing protected scene panels, never fabricates
chat or sends outbound Twitch messages/scopes. Companion guidance is always readable.
Broadcast defaults persist across ordinary edits and rollback. Explicit recipe language
is retained unless the operator selects a channel-wide override. Channel reduced motion
always wins. Existing first-participation director policy remains cosmetic: test that
accepted scores/resources survive prioritization; no hidden gameplay personalization.

## Verification

A34: scoped discovery/control, private secrets, exact setup review, denied operations,
revocation/disconnect/panic fences, duplicate and causal-loop rejection, import diff.
A35: late help current rules, independent quotas/dedupe, explicit language/preferences,
mobile-readable text equivalent, settings persist through edit/remix; fairness retains
accepted gameplay. Inject transports and use real SQLite/sandbox. Real external OBS,
Streamer.bot and browser verification are separately reported, never inferred from mocks.
