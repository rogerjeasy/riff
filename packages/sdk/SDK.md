# Riff SDK 0.4.0 — handler contract

Compatibility: existing 0.3.0 projectile artifacts retain their rolling allowance
semantics and artifact identity. 0.4.0 adds canonical host-owned sessions. 0.2.0
artifacts must be regenerated.

## Handler

Source is ONE JavaScript function expression `(event, riff) => void | Promise<void>`.
No imports, require, eval, Function, Date, Math.random, timers, network, filesystem or
globalThis. Loops need explicit bounds. Every invocation starts from fresh globals and
closures; nothing survives to the next event. The host has already checked the
command, the audience and every allowance before the handler runs, so a handler only
decides which effects to show.

`event`: { id, channelId, viewerId, roles, text, at }. roles ⊆ viewer, subscriber,
moderator, broadcaster; every chatter has `viewer`. text ≤ 500 chars.

`riff.overlay.emit(effect): Promise<void>` (capability `overlay`) stages one
projectile: { kind: 'projectile', asset: 'tomato' | 'star' | 'heart', x } with x a
finite number in [0, 1] (horizontal launch position). Example:
`await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() })`

`riff.util.now()` returns event.at. `riff.util.random()` is a seeded deterministic
number in [0, 1).

Any thrown error, invalid effect, undeclared capability, too many effects, more than
25 bridge calls, 50 ms CPU, 2 s wall time or 64 MB memory quarantines the version and
discards every effect from that event.

## Canonical stateful experiences (SDK 0.4.0)

Use sdkVersion:'0.4.0', declare capability `session` and an `experience` definition. The host interprets the
rules; generated handlers control visuals. `riff.session.snapshot()` returns a fresh,
deeply frozen JSON snapshot of the staged state, including the accepted contribution.
Example: `const total = riff.session.snapshot().scores.community;`
The handler never changes resources, enrollment, score, clock or outcome directly.
Any guest fault discards the staged contribution and all its effects atomically.

ExperienceDefinition = {
  version: 1, title: string (1..120), durationMs: 1000..3600000,
  maxParticipants: 1..256,
  teams: [{ id, label, joinCommand }], // 0..8; unique ids and commands
  resource: { name, perParticipant: 1..100 },
  contribution: { command, points: 1..100 },
  objective: { kind: 'highest-score' | 'collective-goal', target: number | null }
}
Names and labels are bounded to 60 characters. Team ids are lowercase [a-z0-9_-],
1..32 characters; reserved object keys, community and tie are excluded. Commands
match trigger.command syntax and team commands must differ from contribution.command.
trigger.command MUST equal experience.contribution.command. Collective goals use
no teams and a positive target ≤ 2560000; highest-score requires target:null.
The optional experience field may be absent or null for legacy projectile behavior.

Tomato Battle: teams red/blue join via !red/!blue; contribute via !throw, three
resources per participant, one point per action, durationMs:120000, highest-score.
Community Goal: no teams; !grow auto-enrolls, three resources per participant,
one point per action, durationMs:120000, collective-goal target:5.

SessionSnapshot = { id, phase:'running'|'paused'|'finished', startedAt, deadlineAt,
remainingMs, updatedAt, revision, participants, scores, winner, outcome }.
participants maps viewer ids to {teamId:string|null,remaining,contributions}.
scores maps team ids to numbers, or community without teams. winner is a team id,
community, tie, or null when a cooperative deadline expires before the target;
outcome is deadline, goal, or null. Pausing freezes remainingMs; resuming creates
an updated deadline. Host persistence owns identity and restart recovery.

Session admission follows dedupe → command (including team join commands) → audience
→ phase → enrollment/resources. Joins return ACCEPTED with zero effects and never
invoke the handler. ALREADY_JOINED prevents team switching; NOT_JOINED requires a
team join; PARTICIPANT_LIMIT rejects enrollment over the cap. RESOURCE_LIMIT means
all lifetime session resources were spent, regardless of trigger.windowMs. Paused
and finished rounds return SESSION_PAUSED and SESSION_FINISHED. At exactly the
deadline the session finishes before contribution; a cooperative goal finishes on
the contribution reaching its target. Host cosmetic budgets may suppress effects
while returning ACCEPTED and preserving canonical semantic progress.

## Permission manifest

{
  sdkVersion: '0.3.0',
  capabilities: ['overlay'],              // exactly the capabilities the source uses
  trigger: {
    command: '!tomato',                   // lowercase, ^![a-z0-9_-]{1,32}$
    audience: ['viewer'],                 // any listed role may trigger; viewer = everyone
    maxPerViewer: 3,                      // 1..100 accepted actions per viewer ...
    windowMs: 60000                       // ... in any rolling window, 1000..3600000 ms
  },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 }   // 1..10 and 1..120
}

## Host admission order (scenario expectations must follow it exactly)

For each event the host returns exactly one decision code:
1. DUPLICATE — the same event id was already seen in this scenario (0 effects).
2. UNRELATED — text.trim().toLowerCase() !== command (0 effects). "!tomatoes" and
   "hi !tomato" are UNRELATED; "  !TOMATO " matches.
3. AUDIENCE — none of the event roles is listed in trigger.audience (0 effects).
4. VIEWER_LIMIT — this viewer already has maxPerViewer accepted actions with
   time > at - windowMs (0 effects). Only ACCEPTED events that emitted at least one
   effect count. An action at t=0 with windowMs=60000 stops counting at t=60000.
5. CHANNEL_LIMIT — the effects emitted in the last 60 s reached effectsPerMinute.
6. ACCEPTED — the handler ran; the step's effects count is the number it emitted.

## Scenario tests (data, not code)

Tests are an array of 3..12 scenarios. Each scenario runs in a fresh engine:
{ name, kind: 'happy'|'limit'|'role'|'negative'|'duplicate'|'window', steps: [
  { id, viewer, roles, text, at, expect, effects } ] }
- id: unique per message unless deliberately repeated to model a duplicate delivery.
- viewer: lowercase synthetic name like "alice". at: ms since scenario start, never
  decreasing. expect: a decision code above. effects: exact number expected.
For stateful scenarios an optional session subset assertion checks phase, scores,
remainingMs and participants (teamId, remaining, contributions), e.g.
`session:{scores:{red:1},participants:{alice:{remaining:2}}}`. Assertions apply after
the event; scenario clock starts at 0.
Required coverage: at least one happy path, one limit/role/window edge, and one
negative (unrelated chat does nothing).
