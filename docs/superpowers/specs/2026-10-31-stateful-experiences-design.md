# Generated stateful experiences

Implements F31 across the existing authoring, verification, preview, approval, live
and overlay workflow. Reference: Tomato Battle, plus a cooperative Community Goal.
The owner requested the complete feature following the proposed scope.

## Approach and contracts

Choose a canonical declarative experience definition coupled to the generated handler.
The host interprets bounded participant/resource/round/scoring primitives; the handler
controls effects and may read a frozen session snapshot, never mutate resources or
scores directly. This provides a common state engine for competitive and cooperative
formats. Rejected alternatives: hidden guest globals cannot survive replay/restart;
a hardcoded game outside verification would bypass Riff's central contract.

SDK 0.4.0 adds an optional `experience?: ExperienceDefinition | null` manifest field
and `session` capability. Preserve existing 0.3.0 projectile artifacts. Do not change
legacy artifact identity unnecessarily. Add separate SESSION_LIMITS constants.

Exact public types (SDK exports, browser mirrors):

```typescript
interface ExperienceDefinition {
  version: 1;
  title: string;
  durationMs: number; // 1000..3600000
  maxParticipants: number; // 1..256
  teams: { id: string; label: string; joinCommand: string }[]; // 0..8, unique ids/commands
  resource: { name: string; perParticipant: number }; // bounded name, 1..100
  contribution: { command: string; points: number }; // 1..100 points/action
  objective: { kind: 'highest-score' | 'collective-goal'; target: number | null };
}
interface SessionParticipant {
  teamId: string | null;
  remaining: number;
  contributions: number;
}
interface SessionSnapshot {
  id: string;
  phase: 'running' | 'paused' | 'finished';
  startedAt: number;
  deadlineAt: number | null;
  remainingMs: number;
  updatedAt: number;
  revision: number;
  participants: Record<string, SessionParticipant>;
  scores: Record<string, number>; // team ids, or 'community' without teams
  winner: string | null; // team id, 'community', or 'tie'
  outcome: 'deadline' | 'goal' | null;
}
```

Manifest trigger.command equals experience.contribution.command; join commands are
additional normalized chat commands. Experience admission uses one lifetime resource
allowance per participant per session (not a renewing rolling window). Existing
non-experience admission retains rolling semantics. Audience applies to joins too.
Teams cannot be changed after joining. No-team experiences auto-enroll on contribution.
At timestamp >= deadline the round finishes before accepting a contribution. A goal
finishes immediately when reached. Late joins are allowed up to the participant cap.
Prototype-like viewer ids must be handled safely. No state is stored in guest globals.

Sandbox exports createSessionSnapshot(definition, at, id='preview'),
advanceSession(snapshot, at), pauseSession(snapshot, at), resumeSession(snapshot, at),
and sessionDefinitionSchema/sessionSnapshotSchema. Helpers are pure and clone inputs.
EngineOptions adds session?: SessionSnapshot. ExecutionDecision adds optional
session?: SessionSnapshot (only stateful decisions). ExecutionEngine adds
get session(): SessionSnapshot | null and restoreSession(snapshot): void (validate).
Generated handler reads riff.session.snapshot() returning a frozen JSON snapshot;
requires declared `session`. State/resource changes are staged and committed only
when guest execution succeeds. Join accepts without invoking an effect handler.
Decision codes add NOT_JOINED, RESOURCE_LIMIT, SESSION_PAUSED, SESSION_FINISHED,
ALREADY_JOINED, PARTICIPANT_LIMIT. Session gameplay admission is independent of
cosmetic channel budgets: valid contributions survive suppressed visual effects.
Generated scenario steps optionally assert session phase/scores/remaining/resources;
the independent host suite derives session tests from the manifest, including duplicate,
resource, audience, deadline, cooperative goal, and isolation cases.

## Durability and controls

New SQLite tables: experience_sessions (one per automation; current id/snapshot,
definition JSON, version identity), session_events (unique automation + event identity (including across reset),
ordered input and decision evidence), session_outbox (effects admitted with the state
transaction and version/session fences). Repository methods scoped to channel.
Serialized runtime execution clones the committed snapshot before each event. A single
transaction commits snapshot, dedupe/evidence and outbox with revision and active-version
checks. On failure restore the committed snapshot; no live effects escape. Persist
semantic progress even when cosmetic effects are suppressed.

Timers are host-owned. Deadlines continue through downtime; startup transactionally
finishes an expired session, otherwise resumes it. Pause freezes remaining time;
resume establishes a new deadline. Panic fences in memory first, clears overlay and
pauses sessions; restart honors persisted panic. A reset requires explicit confirmation
and creates a new session id. Duplicate identity must not count twice within an interaction
across restart and reset, including when the overlay was disconnected.

Compatible version changes (identical definition) preserve current progress; changed
definitions are rejected unless creator explicitly consents to reset. No migration
language is introduced (F32 remains a later feature). Stop/reset/version changes fence
old queued effects. Cosmetic outbox delivery is at most once, not a promise of reliable
external exactly-once delivery. Persist dispatch intent before sending, discard stale
or expired cosmetic effects, and resync authoritative HUD on reconnect.

## Wire and UI

GET /api/studio automations include `session: SessionSnapshot | null`. Preview decisions
include session snapshots and PreviewResult includes final `session` if applicable.
New POST /api/automations/:id/session/reset requires `{confirm:true}`. Existing
approve/rollback accepts optional resetSession boolean (default false). Live overlay
adds versioned message `{v:1,type:'sessions',payload:{sessions:[{automationId,title,
definition,snapshot}]}}`. HUD accepts validated text/numbers, never arbitrary HTML.
Panic/watchdog/rotation clear stale HUD. Reconnecting overlays receive current snapshot.

Console offers Tomato Battle and Community Goal example intents, session summaries,
resource/phase evidence, join/contribute preview controls, time advancement, live
scores/countdown, pause/resume and confirmed reset. Keep existing Tomato Toss path.
Use canonical definition for preview and overlay presentation. Reduced motion applies.

## Acceptance

Team battle: join two teams, spend exactly three throws, block fourth; scores sum all
concurrent accepted contributions; duplicates don't score twice; late joins see rules;
end at exact deadline, report tie/winner. Cooperative goal: auto-enroll participants,
aggregate contributions, finish early at target. Both generated via the same pipeline.
Restart keeps score/resources and event identity; pause/panic freezes time; stale or
incompatible version changes require reset consent; reset fences in-flight work.
Replay identical seed/input produces identical state, outcomes and effects without any
live writes. Source faults and database failures discard all staged transitions.
