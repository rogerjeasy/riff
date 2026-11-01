# F36 — Shared experiences across channels

Implement the next numbered approved feature directly on main, following the owner's
standing direct-implementation preference. No commit/push until requested.

## Intent and approach

Creators run one cooperative activity across independently operated Riff instances.
An immutable, verified teamless collective-goal artifact supplies the existing bounded
QuickJS behavior and session rules. A coordinator owns a separate session runtime,
never reuses local gameplay heaps/state, and persists accepted state before publication.
Each channel chooses a named role/command and an allowlist of aggregate public fields.
Role commands map explicitly to the pinned contribution command; this mapping and the
exact artifact are part of every creator's consent. No private participant snapshot,
local role credentials, tokens, or source prompts are projected.

Use a single coordinator plus authenticated polling members. Alternatives considered:
shared local heaps violate isolation; distributed gameplay writers risk divergent rounds.
Polling is a deliberate implementation choice: no additional infrastructure, bounded
leases, failure detection, and existing HTTP deployment. Channel-private operator APIs
remain local. Peer endpoints require scoped random bearer credentials and have no
operator power. Invitation material is sensitive and shown only when explicitly issued.
Receiving instances independently verify the artifact before approval and store their
connection secrets sealed using RIFF_SECRET. HTTPS is required except explicit loopback
addresses for local testing; redirects and URL credentials are rejected.

## Contract

A session has 2–4 immutable roles, one per Twitch channel ID; owner is one role.
Every role has id, label, command, required, and fields selected from score,
remaining, contributions. Status and instructions are always public. All members approve
one SHA-256 contract digest before first start; version/role changes require a new session.
Commands remain free chat participation, use the original artifact's local audience
eligibility, and cannot grant another channel's broadcaster/moderator privileges.
Shared Chat echoes retain source message/channel identity. Only the original channel's
authenticated input may contribute; durable source identities prevent duplicate effects.

Invitations expire after 15 minutes and are revoked after leave/reissue. At most one
active collaboration per local instance. Members heartbeat every 2 seconds with a
10-second lease. Required loss pauses the coordinator; optional loss follows the
preapproved continue policy. Rejoining and explicit owner resume preserve progress.
Coordinator restart pauses, expires member leases and requires explicit resume.
Local stop is synchronous and independent of peer/DB health; any in-flight request is
fenced. Poll failure shows a paused state and never advances a private copy of gameplay.
No outbound chat, remote arbitrary effect calls, raids, or automatic activation.

## Public projection and creator flow

Create from an already verified cooperative version; review roles and version digest;
issue invites; recipient inspects and independently verifies; recipient explicitly
approves; owner explicitly approves/starts once all grants are present. Both consoles
show membership and current paused/running/finished status. Owner can pause/resume;
each creator can leave immediately and its local panic stops collaboration too.
Overlay shows its role-specific instructions and permitted aggregates, in a free safe
region respecting the visual canvas. Cosmetic generated effects are not projected;
accepted gameplay totals remain authoritative. Private preview uses the same isolated
engine without live destinations and shows the contract before approval.

## Acceptance and constraints

A30/A31: all affected members approve exact authority; one original source event counts
once even when echoed/retried; foreign roles never become local authority; departed
members cannot read or submit; required failure pauses with no independent round.
Bounded queues, bodies, members, sessions and receipts; reject rather than evict live
dedupe history. Expired/stale credentials and stale revision controls fail closed.
Existing single-channel flows and overlay bundle boundary remain intact. No new
runtime dependencies. Real Twitch participation is wired through authenticated EventSub;
local test evidence is not a claim that two real creators have participated.
