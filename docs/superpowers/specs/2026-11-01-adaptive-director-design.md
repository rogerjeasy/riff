# F37 Adaptive experience director

The director keeps the stream readable during bursts without changing admission,
scores, resources, eligibility, or generated code. It is a host presentation policy
applied after the existing durable gameplay/outbox transaction. It uses explicit
queue length and accepted activity, never inferred emotions or viewer profiles.

## Approach

Use a deterministic bounded host queue and creator-approved channel envelope. A
browser-only throttle could not provide authoritative explanations or replay;
changing guest cooldowns would affect competitive rules and belongs to F32. The
host queue is the implementation choice under the request to implement directly.

## Contract

An envelope sets min/max batch interval (250–2000 ms), batch size (1–6), intensity
(25–100 percent), interruptions (1–60 batches per rolling minute), and cosmetic
participation order (FIFO or first-time participant per round). Protected screen
areas remain owned by the existing scene canvas and apply to all emitted effects.
A gameplay mode always selects the calm endpoint; balanced mode selects it on
queue depth >= 8 or >= 12 accepted actions in the last 10 seconds. Lock freezes
settings. Manual overrides must fit the approved envelope. No new game-rule
parameters are accepted: commands, cooldowns, eligible audience and resources go
through existing behavior review/F32.

Queue capacity is 120 effects, freshness 5 seconds, bounded identity memory 2000
entries. Overflow, expiration, coalescing and clearing are counted and explained;
they never modify the already committed gameplay. Each batch presents at most the
selected size and coalesces the remaining pending cosmetics, with first-time
priority determining which effects remain visible. Round identity resets priority.
No reconnect/restart replays old cosmetics. Live delivery rechecks version, status,
round and panic before emission. Pause, rotation, version changes and panic clear
queued presentation. Panic fences memory before persistence.

## Review and controls

Channel-scoped durable drafts, approvals, controls and evidence use revision CAS.
Saving a draft does not change live settings. The creator runs a private synthetic
crowd burst against an exact stored artifact; real sandbox rehearsal records
accepted/blocked decisions and final scores while the same director policy runs
against its outputs. Evidence binds artifact, scenario, envelope, policy version
and trace. Approval requires the exact passing evidence and draft digest. Controls
include balanced/gameplay mode, lock, in-envelope override and immediate stop.
Restart retains approval but stops adaptation until explicit resume. Durable batch
claims preserve the rolling interruption allowance across approvals and restart. History is
bounded to 50 revisions of envelopes; old envelopes can be restored as drafts.

The console shows draft versus approved ranges, private replay and score proof,
live counters, current settings and reasons. Preview has no live sink. Browser
validation bounds intensity; existing scene protection and reduced motion remain
in force. This feature adds no Twitch scopes, outbound messages or dependencies.

## Acceptance

Tests cover deterministic surges, duplicate effects, independent identities,
round priority, bounded memory, limit enforcement, lock/override, stale approval,
restart, cross-channel isolation, failure-safe stop, late delivery invalidation,
private replay, preserved real sandbox scores/resources, accessible controls and
browser rendering. Existing regression suites and build/bundle checks run after
integration. Environment-blocked checks are reported accurately.
