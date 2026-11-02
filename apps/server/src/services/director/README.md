# Adaptive director

The director is a channel-scoped host presentation service. Approved ranges control
projectile batching, frequency and intensity. The policy uses accepted activity and
queue depth; it never changes gameplay admission, scores, resources or eligibility.

Participation policy decides who wins a contested presentation slot: `fifo` (arrival
order), `first-time` (a viewer's first action this round) or `rotation` (F40 opportunity
rotation). Rotation gives each slot to the pending viewer whose last presented turn is
oldest — never-shown viewers first, ties by arrival order, so replay is exact — and puts a
viewer already picked for this batch behind everyone else. Turn memory is bounded like
identity memory. The policy sees only viewer id, round and arrival; it has no spending,
subscription or role input, and it only orders cosmetics that were already counted. Batch
decisions say "Priority to viewers who haven’t had a turn yet." `participation()` exposes the
approved policy while presentation is enabled so the participation service can explain it
on stream (`fairnessCopy`, en/fr/es/de).

`policy.ts` is deterministic, has no I/O or clock dependency, bounds pending effects
at 120 and expires them after five seconds. `rehearsal.ts` runs an exact stored
artifact twice in isolated sandbox rehearsals, compares evidence and state, and
feeds accepted outputs through the same presentation policy. The sandbox scenario
delivers its 40-viewer burst 1 ms apart; the director sees those same decisions at a
realistic 150 ms chat cadence (`DIRECTOR_REHEARSAL_SPACING_MS`), so the replay shows
regular batches, the switch to calm settings and recovery. Only presentation timing
is spaced; gameplay decisions, scores and state come unchanged from the sandbox runs.
Synthetic samples, accounting and final scores are private evidence, never live
deliveries.

Decision history explains changes rather than logging every tick: a reason is recorded
when the adaptation level (regular, calm, gameplay focus) or creator control changes,
when the interruption limit is first reached, or when effects expire or are cleared.
Consecutive batches and expirations merge into one running entry, so a long burst
cannot push mode changes and clears out of the 50-entry history. Thresholds live in
`DIRECTOR_LIMITS` in `policy.ts`.

`service.ts` owns durable revision-checked drafts, exact evidence approval and
controls. A new draft leaves the live approval intact. Manual settings outside
approved ranges are rejected. Lock freezes current settings while retaining caps.
Stop fences memory before writing; restart requires explicit resume. A separate
rolling batch claim in the channel record persists before emission, so reapproval
and restart cannot refill the interruption allowance. Historical
envelopes restore as new drafts, with fresh evidence and approval. Generated code
has no director capability. Commands, cooldowns, audience and resource changes use
behavior review and F32.

The broker accepts only live decisions after durable admission. Delayed emissions
recheck active version, automation status, round and panic. Pause, rotation, activation,
round reset and panic clear queued cosmetics, each with its own human-readable reason. The existing scene renderer still owns protected
screen regions; intensity changes scale sprites without bypassing clipping or
reduced motion. Shared-session authoritative HUD projections are not throttled.

The operator API is GET `/api/director`, and POST `/api/director/draft`, `/rehearse`,
`/approve`, `/control`, `/stop`. Mutations use the existing same-origin guard and,
when configured, hosted-console authentication. `director_state` stores a bounded
channel document with the 50 most recent envelope revisions; saving beyond that drops
the oldest revision but never the approved one. No pending cosmetics persist. Stored
state is parsed on boot; an unreadable approval fails closed to stopped with no
approval. Validation errors name the field in creator language; permanent conflicts
return 409, a busy rehearsal 429, and a stress test interrupted by stop, panic,
shutdown or its deadline returns 409 with a plain explanation rather than a 500.
A rehearsal runs at most 60 seconds, with one per channel. Identity memory is
bounded to 2000 entries (oldest evicted first, so a busy stream keeps presenting and
counting), accepted-activity memory to 2000 entries and decision
history to 50 entries. The live gameplay queue separately admits at most 128
pending chat messages; overflow returns visible CAPACITY before counting anything.
