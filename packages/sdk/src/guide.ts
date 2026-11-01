/**
 * The complete universe the runtime compiler sees. `SDK.md` is generated from
 * `SDK_GUIDE` and a test keeps them identical; undocumented surface must not exist.
 */
export const SDK_GUIDE = `# Riff SDK 0.4.0 — handler contract

Compatibility: existing 0.3.0 projectile artifacts retain their rolling allowance
semantics and artifact identity. 0.4.0 adds canonical host-owned sessions. 0.2.0
artifacts must be regenerated.

## Handler

Source is ONE JavaScript function expression \`(event, riff) => void | Promise<void>\`.
No imports, require, eval, Function, Date, Math.random, timers, network, filesystem or
globalThis. Loops need explicit bounds. Every invocation starts from fresh globals and
closures; nothing survives to the next event. The host has already checked the
command, the audience and every allowance before the handler runs, so a handler only
decides which effects to show.

\`event\`: { id, channelId, viewerId, roles, text, at }. roles ⊆ viewer, subscriber,
moderator, broadcaster; every chatter has \`viewer\`. text ≤ 500 chars.

\`riff.overlay.emit(effect): Promise<void>\` (capability \`overlay\`) stages one
projectile: { kind: 'projectile', asset: 'tomato' | 'star' | 'heart', x } with x a
finite number in [0, 1] (horizontal launch position). Example:
\`await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() })\`

\`riff.util.now()\` returns event.at. \`riff.util.random()\` is a seeded deterministic
number in [0, 1).

Any thrown error, invalid effect, undeclared capability, too many effects, more than
25 bridge calls, 50 ms CPU, 2 s wall time or 64 MB memory quarantines the version and
discards every effect from that event.

## Canonical stateful experiences (SDK 0.4.0)

Use sdkVersion:'0.4.0', declare capability \`session\` and an \`experience\` definition. The host interprets the
rules; generated handlers control visuals. \`riff.session.snapshot()\` returns a fresh,
deeply frozen JSON snapshot of the staged state, including the accepted contribution.
Example: \`const total = riff.session.snapshot().scores.community;\`
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
\`session:{scores:{red:1},participants:{alice:{remaining:2}}}\`. Assertions apply after
the event; scenario clock starts at 0.
Required coverage: at least one happy path, one limit/role/window edge, and one
negative (unrelated chat does nothing).

## Host transition contract

SessionTransitionPlan version 1 binds sourceArtifactId, targetArtifactId,
sourceDefinitionHash, targetDefinitionHash and migrationSourceHash, computed by the
host. Executable migration source is a separate artifact. Boundary is immediate,
round-end or stopped (already paused and remaining paused). The fixed preserve
list is identity, participants, teams, scores, contributions, phase and time;
resets is empty. Incompatible changes require explicit whole-session reset.

Migration is a bounded function expression receiving deeply frozen oldDefinition,
newDefinition, snapshot and explicit host at timestamp. It returns JSON state
(or a Promise resolving to JSON state). It has no effects, clock, randomness,
imports or capabilities. Preserve every snapshot field and increase each existing
participant's remaining resources by new perParticipant minus old perParticipant.
Keep the input revision unchanged: the host independently validates preservation
and advances revision. This contract adds no generated handler capability.

## Channel Points redemptions (SDK 0.4.0)

A Channel Points trigger sets trigger.kind:'points.redeem' and trigger.reward to the
reward title (1..45 characters, e.g. 'Hydrate'). The creator links that title to a
reward Riff created on Twitch; only that reward's redemptions reach the handler, and
chat text never matches it. trigger.command stays required as the console handle
(e.g. '!hydrate') and must not be typed by viewers. Redemptions carry no chat badges,
so trigger.audience MUST be ['viewer']; experience must be absent or null. Chat
triggers omit kind or use 'chat.command' with reward:null.
For a redemption event.kind is 'points.redeem', roles is ['viewer'] and event.text is
the viewer's sanitized input ('' when the reward asks none). Admission is the same
order as chat (DUPLICATE → UNRELATED → VIEWER_LIMIT → CHANNEL_LIMIT → ACCEPTED);
UNRELATED means a chat message reached a redemption trigger, or a redemption reached a
chat trigger. The host, not the handler, fulfils accepted redemptions and refunds
rejected ones. Scenario steps model a redemption with kind:'points.redeem' (null or
absent for chat); give a redemption step text '' unless the viewer typed input.

## Prediction proposals (SDK 0.4.0)

\`riff.predictions.propose(p): Promise<void>\` (capability \`predictions\`) asks the
creator to open a Twitch prediction: { title: 1..45 chars, outcomes: 2..10 distinct
strings of 1..25 chars, windowSeconds: 30..1800 }. At most one proposal per event; an
invalid proposal is a fault. Proposals never open, lock, resolve or cancel anything:
the creator reviews and opens them in the console, and only the creator picks the
winner. A proposal counts like an effect for the viewer allowance but emits no overlay
effect, so its scenario step expects effects:0. Example:
\`await riff.predictions.propose({ title: 'Will we win?', outcomes: ['Yes', 'No'], windowSeconds: 120 })\`
`;

export const RIFF_DTS = `declare module 'riff' {
  export interface ExperienceDefinition {
    version: 1; title: string; durationMs: number; maxParticipants: number;
    teams: { id: string; label: string; joinCommand: string }[];
    resource: { name: string; perParticipant: number };
    contribution: { command: string; points: number };
    objective: { kind: 'highest-score' | 'collective-goal'; target: number | null };
  }
  export interface SessionParticipant { teamId: string | null; remaining: number; contributions: number }
  export interface SessionSnapshot {
    id: string; phase: 'running' | 'paused' | 'finished'; startedAt: number;
    deadlineAt: number | null; remainingMs: number; updatedAt: number; revision: number;
    participants: Record<string, SessionParticipant>; scores: Record<string, number>;
    winner: string | null; outcome: 'deadline' | 'goal' | null;
  }
  export type AudienceRole = 'viewer' | 'subscriber' | 'moderator' | 'broadcaster';
  export interface ChatEvent { id: string; channelId: string; viewerId: string; roles: AudienceRole[]; text: string; at: number; kind?: 'points.redeem' }
  export interface PredictionProposal { title: string; outcomes: string[]; windowSeconds: number }
  export interface ProjectileEffect { kind: 'projectile'; asset: 'tomato' | 'star' | 'heart'; x: number }
  export interface Riff {
    /** Read deeply frozen staged state. Example: riff.session.snapshot().scores.community. */
    session: { snapshot(): Readonly<SessionSnapshot> };
    overlay: { emit(effect: ProjectileEffect): Promise<void> };
    /** Ask the creator to open a prediction; never opens or settles one. */
    predictions: { propose(proposal: PredictionProposal): Promise<void> };
    util: { now(): number; random(): number };
  }
  export type Handler = (event: ChatEvent, riff: Riff) => void | Promise<void>;
}
`;

export const RIFF_TEST_DTS = `declare module 'riff/test' {
  export type DecisionCode = 'ACCEPTED' | 'UNRELATED' | 'AUDIENCE' | 'VIEWER_LIMIT' | 'CHANNEL_LIMIT' | 'DUPLICATE' | 'NOT_JOINED' | 'RESOURCE_LIMIT' | 'SESSION_PAUSED' | 'SESSION_FINISHED' | 'ALREADY_JOINED' | 'PARTICIPANT_LIMIT';
  export interface SessionAssertion { phase?: import('riff').SessionSnapshot['phase']; scores?: Record<string,number>; remainingMs?: number; participants?: Record<string,Partial<import('riff').SessionParticipant>> }
  export interface ScenarioStep { id: string; viewer: string; roles: import('riff').AudienceRole[]; text: string; at: number; expect: DecisionCode; effects: number; session?: SessionAssertion | null; kind?: 'points.redeem' | null }
  export interface Scenario { name: string; kind: 'happy' | 'limit' | 'role' | 'negative' | 'duplicate' | 'window'; steps: ScenarioStep[] }
}
`;

export interface CuratedExample {
  name: string;
  intent: string;
  title: string;
  source: string;
  manifest: {
    sdkVersion: '0.3.0';
    capabilities: 'overlay'[];
    trigger: {
      command: string;
      audience: ('viewer' | 'subscriber' | 'moderator' | 'broadcaster')[];
      maxPerViewer: number;
      windowMs: number;
    };
    limits: { effectsPerEvent: number; effectsPerMinute: number };
  };
}

/** Idiomatic, minimal, verified examples. Codex imitates them. */
export const EXAMPLES: readonly CuratedExample[] = [
  {
    name: 'tomato-toss',
    title: 'Tomato Toss',
    intent:
      'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.',
    source:
      "async (event, riff) => {\n  await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() });\n}",
    manifest: {
      sdkVersion: '0.3.0',
      capabilities: ['overlay'],
      trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60_000 },
      limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
    },
  },
  {
    name: 'heart-burst',
    title: 'Heart Burst',
    intent: 'Subscribers can type !love to send a burst of three hearts, once every 30 seconds.',
    source:
      "async (event, riff) => {\n  const center = riff.util.random();\n  for (let i = 0; i < 3; i++) {\n    const x = Math.min(1, Math.max(0, center + (i - 1) * 0.08));\n    await riff.overlay.emit({ kind: 'projectile', asset: 'heart', x });\n  }\n}",
    manifest: {
      sdkVersion: '0.3.0',
      capabilities: ['overlay'],
      trigger: {
        command: '!love',
        audience: ['subscriber', 'moderator', 'broadcaster'],
        maxPerViewer: 1,
        windowMs: 30_000,
      },
      limits: { effectsPerEvent: 3, effectsPerMinute: 90 },
    },
  },
];
