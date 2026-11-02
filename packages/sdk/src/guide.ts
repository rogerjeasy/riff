/**
 * The complete universe the runtime compiler sees. `SDK.md` is generated from
 * `SDK_GUIDE` and a test keeps them identical; undocumented surface must not exist.
 */
export const SDK_GUIDE = `# Riff SDK 0.4.0 — handler contract

Compatibility: existing 0.3.0 projectile artifacts retain their rolling allowance
semantics and artifact identity. 0.4.0 adds canonical host-owned sessions and,
additively, the native Twitch capabilities polls, chat.announce and shoutout; existing
0.4.0 artifacts keep their identity and behavior. 0.2.0 artifacts must be regenerated.
Experience definition version 2 (additive, same SDK 0.4.0 bridge) adds declarative
mechanics; version 1 definitions, snapshots and identities are unchanged and never
carry a mechanics key.

## Handler

Source is ONE JavaScript function expression \`(event, riff) => void | Promise<void>\`.
No imports, require, eval, Function, Date, Math.random, setTimeout/setInterval, network,
filesystem or globalThis; delays use host-owned named timers (capability \`timer\`).
Loops need explicit bounds. Every invocation starts from fresh globals and closures;
nothing survives to the next event. The host has already checked the command, the
audience and every allowance before the handler runs, so a handler only decides which
effects to show.

\`event\`: { id, channelId, viewerId, roles, text, at, twitch }. roles ⊆ viewer, subscriber,
moderator, broadcaster; every chatter has \`viewer\`. text ≤ 500 chars. twitch is null for
chat messages and set only for Twitch event triggers (see below).

\`riff.overlay.emit(effect): Promise<void>\` (capability \`overlay\`) stages one
projectile: { kind: 'projectile', asset: 'tomato' | 'star' | 'heart', x } with x a
finite number in [0, 1] (horizontal launch position). Example:
\`await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() })\`

\`riff.util.now()\` returns event.at. \`riff.util.random()\` is a seeded deterministic
number in [0, 1).

## Named timers (capability \`timer\`)

\`riff.timer.start(name, ms, options?): Promise<void>\` queues a host-owned timer;
\`riff.timer.cancel(name): Promise<void>\` queues its cancellation (unknown names are
ignored). name matches ^[a-z][a-z0-9_-]{0,31}$; ms is an integer 5000..3600000;
options is { repeat?: boolean }. Starting an existing name REPLACES it: the countdown
restarts from now with the new ms/repeat. At most 10 distinct names may be pending per
automation; starting an 11th faults. Timer calls are bridge calls and apply only when
the handler succeeds; they never block or return data. Timers belong to the approved
version: pause, panic, rollback, a new version or an incident cancels every pending timer.
Timers are not available inside stateful experiences (round deadlines are host-owned).

When a timer is due the host runs the SAME handler with an internal event
\`{ source: 'timer.fired', id, channelId, name, scheduledAt, firedAt, missed, at }\`
(chat events have no source field). It skips command, audience and per-viewer checks
but still enforces effectsPerEvent, effectsPerMinute and the channel budget. missed is
true when the fire arrives over 2 s late (for example after a restart); fires overdue by
more than 30 s are skipped and logged, never replayed. A repeating timer re-arms on its
original cadence before the handler runs, so the handler may still cancel it. Example:
\`if (event.source === 'timer.fired') { await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: 0.5 }); return; }
await riff.timer.start('celebrate', 60000);\`
A chat event counts against the viewer allowance when it emitted an effect OR queued a
timer call.

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

## Version 2 mechanics (definition version 2)

Set version:2 and mechanics = { match, health, burst, milestones } (null or [] when
unused). Every rule is host-owned and declarative; handlers only read
snapshot.mechanics. Example: \`const tier = riff.session.snapshot().mechanics.standings.community.unlocked.length;\`
objective.kind may also be 'burst' (target = triggers needed, at most burst.limit).

- burst: { command: string|null, label, participants: 2..50, windowMs: 1000..60000,
  points: 0..100, limit: 1..20, shieldMs: 0..60000 }. A burst fills when \`participants\`
  DIFFERENT viewers of one side act within a sliding windowMs measured on event.at;
  entries older than at - windowMs no longer count. command:null counts accepted
  contributions (a repeat viewer is accepted but counts once); a command is a
  resource-free action: BURST_COUNTED (viewer already in the window), BURST_ACTIVE
  (shield running), BURST_LIMIT (limit reached this round). A trigger clears the window,
  adds points to that side and raises a shield until at + shieldMs (needs health).
- health: { label, max: 1..1000, damage: 1..1000, heal: {command, amount}|null } needs
  two or more teams and highest-score. Each contribution damages every other standing,
  unshielded team. 0 health eliminates that team: its players and new joiners get
  ELIMINATED. The last team standing wins the round (outcome 'elimination'); at the
  deadline the standing team with most health wins. Heal spends one resource and is
  HEALTH_FULL at max.
- match: { rounds: 2..9, intermissionMs: 0..60000 } is best of N. Ending a round (deadline,
  goal, burst objective or elimination) records history and wins; a majority of round
  wins or the last round finishes the match (winner = most wins, tie when level).
  Otherwise the next round starts after the intermission with fresh resources,
  scores, pools and bursts; teams stay. Actions during the break get
  ROUND_INTERMISSION; joins are allowed. remainingMs includes the break.
- milestones: up to 4 { id, label, score, unlock: {command, points}|null } with
  strictly increasing scores. Reaching a round score unlocks the tier for that side;
  unlock commands are LOCKED before it and then spend one resource for points.
Every join, contribution, heal, burst and unlock command must be unique.

snapshot.mechanics = { round, wins, history: [{round, winner, outcome, scores}],
standings: { [team id | community]: { health, eliminated, contributions, heals, unlocks,
bursts, burstWindow: [{viewerId, at}], shieldUntil, unlocked } } }. participant
contributions count every resource-spending action. Admission after phase checks:
join → intermission → enrollment → elimination → action limits → resources.
Scenario session assertions may also check round, winner, wins and
standings {health, eliminated, bursts, tier}.

## Native Twitch actions (SDK 0.4.0)

These calls only STAGE a request and resolve immediately (Promise<void>). The host
validates it, applies your manifest limits, the channel budget and Twitch's documented
caps, then performs it itself; previews and tests use a simulated sink and never reach
Twitch. Each staged action counts as one effect for effectsPerEvent, effectsPerMinute
and viewer allowances. At most 2 native actions per event, at most one poll call and
one shoutout per event. They require sdkVersion:'0.4.0'. Invalid requests quarantine.

\`riff.polls.start({ title, choices, durationSeconds }): Promise<void>\` (capability \`polls\`)
starts a Twitch poll: title 1..60 characters, 2..5 unique choices of 1..25 characters,
durationSeconds 15..1800. \`riff.polls.end(): Promise<void>\` ends the poll Riff started.
The channel must be an Affiliate or Partner and runs one poll at a time; the host
reports refusals in the console. Example:
\`await riff.polls.start({ title: 'Next challenge?', choices: ['Speedrun', 'Hardcore'], durationSeconds: 120 })\`

\`riff.chat.announce({ message, color? }): Promise<void>\` (capability \`chat.announce\`)
posts a highlighted chat announcement: message 1..500 characters without control
characters; color is blue, green, orange, purple or primary (default). Example:
\`await riff.chat.announce({ message: 'Round two starts now!', color: 'purple' })\`

\`riff.shoutout.send({ login }): Promise<void>\` (capability \`shoutout\`) shouts out a
channel by lowercase login ^[a-z0-9_]{1,25}$. The creator's shoutout policy decides
which channels are allowed (an approved list, or recent raiders only); anything else is
refused by the host. Twitch allows one shoutout every 2 minutes and the same channel
once an hour. Example: \`await riff.shoutout.send({ login: 'twitchdev' })\`

\`riff.shoutout.raider(): Promise<void>\` (capability \`shoutout\`) shouts out the
broadcaster who raided in THIS event. It takes no argument: the host binds the target
from the raid event, so it works only for trigger.kind 'twitch.event' with event.kind
'raid' (any other trigger faults). Raid-triggered handlers may not call
riff.shoutout.send. The creator must turn on automatic raid shoutouts in Twitch
features; the same Twitch cooldowns, channel budget and consent apply. Example:
\`await riff.shoutout.raider()\`

Manifests declaring \`polls\` or \`shoutout\` must restrict trigger.audience to moderator
and/or broadcaster; the one exception is a 'raid' twitch.event trigger (audience
['viewer']) using \`shoutout\` for riff.shoutout.raider(). \`chat.announce\` may use any audience; keep effectsPerMinute low
(the host channel budget is 6 announcements per minute across all interactions).

## Twitch event triggers (subs, gifts, resubs, cheers, raids)

Instead of a chat command, a projectile interaction may run on ONE Twitch event kind.
Set trigger.kind = 'twitch.event', trigger.event = { kind, minimum } and
trigger.command = '@' + kind (a reserved token chat can never match); reward is null.
event.kind is subscribe | gift | resub | cheer | raid. experience must be null and
audience must be ['viewer']. minimum is an integer 1..1000000 compared with
event.twitch.amount; use 1 when no threshold is stated.

event.twitch = { kind, amount, tier, anonymous, gift }:
- subscribe: a new (not resub) subscription; amount 1; gift true when gifted.
- gift: one gift of amount subscriptions; anonymous true for anonymous gifts.
- resub: amount is cumulative months; text is the resub message.
- cheer: amount is bits; text is the cheer message; anonymous cheers allowed.
- raid: amount is the raid's viewer count; viewerId is the raiding channel.
tier is '1000' | '2000' | '3000' for subscribe/gift/resub, otherwise null.
Anonymous cheers and gifts use viewerId 'anonymous' and share one allowance.
Viewer-supplied text is control-stripped and capped at 500 characters.

Event admission order: DUPLICATE → UNRELATED (chat text, or a different event kind) →
BELOW_MINIMUM (amount < minimum, 0 effects) → VIEWER_LIMIT → CHANNEL_LIMIT → ACCEPTED.
Chat-command and Channel Points interactions return UNRELATED for every Twitch event.
Example: \`async (event, riff) => { const n = Math.min(10, Math.ceil(event.twitch.amount / 100)); for (let i = 0; i < n; i++) await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: riff.util.random() }); }\`

Event scenario steps set twitch to the synthetic event and text to '' (or a message);
chat steps set twitch:null. Event steps are synthetic rehearsal inputs, never
Twitch transport events. Example step: { id:'c1', viewer:'alice', roles:['viewer'],
text:'', at:0, twitch:{kind:'cheer',amount:100,tier:null,anonymous:false,gift:false},
expect:'ACCEPTED', effects:1, session:null }. Cover a happy event, a BELOW_MINIMUM
(when minimum > 1) or VIEWER_LIMIT edge, and a negative: ordinary chat is UNRELATED.

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

## Trigger kinds (one trigger, one source)

trigger.kind is the single discriminator; each kind admits only its own source:
- 'chat.command' (the default when kind is omitted): chat text equal to command.
  reward and event are null or absent.
- 'points.redeem': a linked Channel Points redemption. reward is the reward title
  (required), command is a console handle viewers never type, event is null.
- 'twitch.event': one Twitch event kind. event = { kind, minimum } (required), command
  is '@' + event.kind, reward is null.
Any other combination (a reward on a chat or event trigger, an event on a chat or
redemption trigger, a missing reward or event) is rejected. Redemption and event
triggers use audience ['viewer'] and no experience, because they carry no chat roles.

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
Timer scenarios run on a virtual clock. Before each step, every timer due at or before
step.at fires first. An optional \`timers:{fired,effects}\` assertion on a step checks how
many fires ran since the previous step and the effects they emitted, e.g. a step
\`{ id:'later', viewer:'alice', roles:['viewer'], text:'hello chat', at:60000,
expect:'UNRELATED', effects:0, timers:{fired:1,effects:3} }\`. Use timers:null otherwise.

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
so trigger.audience MUST be ['viewer']; experience must be absent or null; event is
null. Chat triggers omit kind or use 'chat.command' with reward:null and event:null.
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
  export interface ExperienceMechanics {
    match: { rounds: number; intermissionMs: number } | null;
    health: { label: string; max: number; damage: number; heal: { command: string; amount: number } | null } | null;
    burst: { command: string | null; label: string; participants: number; windowMs: number; points: number; limit: number; shieldMs: number } | null;
    milestones: { id: string; label: string; score: number; unlock: { command: string; points: number } | null }[];
  }
  export interface ExperienceDefinition {
    version: 1 | 2; title: string; durationMs: number; maxParticipants: number;
    teams: { id: string; label: string; joinCommand: string }[];
    resource: { name: string; perParticipant: number };
    contribution: { command: string; points: number };
    objective: { kind: 'highest-score' | 'collective-goal' | 'burst'; target: number | null };
    mechanics?: ExperienceMechanics;
  }
  export interface SessionParticipant { teamId: string | null; remaining: number; contributions: number }
  export interface SessionStanding {
    health: number | null; eliminated: boolean; contributions: number; heals: number;
    unlocks: Record<string, number>; bursts: number; burstWindow: { viewerId: string; at: number }[];
    shieldUntil: number | null; unlocked: string[];
  }
  export interface SessionMechanicsState {
    round: number; wins: Record<string, number>; standings: Record<string, SessionStanding>;
    history: { round: number; winner: string | null; outcome: 'deadline' | 'goal' | 'elimination'; scores: Record<string, number> }[];
  }
  export interface SessionSnapshot {
    id: string; phase: 'running' | 'paused' | 'finished'; startedAt: number;
    deadlineAt: number | null; remainingMs: number; updatedAt: number; revision: number;
    participants: Record<string, SessionParticipant>; scores: Record<string, number>;
    winner: string | null; outcome: 'deadline' | 'goal' | 'elimination' | null;
    mechanics?: SessionMechanicsState;
  }
  export type AudienceRole = 'viewer' | 'subscriber' | 'moderator' | 'broadcaster';
  export interface TwitchEventDetail { kind: 'subscribe' | 'gift' | 'resub' | 'cheer' | 'raid'; amount: number; tier: '1000' | '2000' | '3000' | null; anonymous: boolean; gift: boolean }
  export interface ChatEvent { id: string; channelId: string; viewerId: string; roles: AudienceRole[]; text: string; at: number; kind?: 'points.redeem'; twitch?: TwitchEventDetail | null }
  export interface PredictionProposal { title: string; outcomes: string[]; windowSeconds: number }
  export interface ProjectileEffect { kind: 'projectile'; asset: 'tomato' | 'star' | 'heart'; x: number }
  /** Internal host timer event; chat events have no source field. */
  export interface TimerEvent { source: 'timer.fired'; id: string; channelId: string; name: string; scheduledAt: number; firedAt: number; missed: boolean; at: number }
  export interface Riff {
    /** Read deeply frozen staged state. Example: riff.session.snapshot().scores.community. */
    session: { snapshot(): Readonly<SessionSnapshot> };
    overlay: { emit(effect: ProjectileEffect): Promise<void> };
    /** Host-owned named timers. Example: await riff.timer.start('celebrate', 60000, { repeat: false }). */
    timer: { start(name: string, ms: number, options?: { repeat?: boolean }): Promise<void>; cancel(name: string): Promise<void> };
    /** Ask the creator to open a prediction; never opens or settles one. */
    predictions: { propose(proposal: PredictionProposal): Promise<void> };
    /** Stage a host-validated Twitch poll. Example: await riff.polls.start({title:'Next?',choices:['A','B'],durationSeconds:60}). */
    polls: { start(poll: { title: string; choices: string[]; durationSeconds: number }): Promise<void>; end(): Promise<void> };
    /** Stage a budgeted announcement. Example: await riff.chat.announce({message:'Go!',color:'purple'}). */
    chat: { announce(a: { message: string; color?: 'blue' | 'green' | 'orange' | 'purple' | 'primary' }): Promise<void> };
    /** Stage a shoutout to a creator-approved channel. Example: await riff.shoutout.send({login:'twitchdev'}). raider() shouts out this raid's broadcaster (raid event triggers only). */
    shoutout: { send(target: { login: string }): Promise<void>; raider(): Promise<void> };
    util: { now(): number; random(): number };
  }
  export type Handler = (event: ChatEvent | TimerEvent, riff: Riff) => void | Promise<void>;
}
`;

export const RIFF_TEST_DTS = `declare module 'riff/test' {
  export type DecisionCode = 'ACCEPTED' | 'UNRELATED' | 'AUDIENCE' | 'VIEWER_LIMIT' | 'CHANNEL_LIMIT' | 'DUPLICATE' | 'NOT_JOINED' | 'RESOURCE_LIMIT' | 'SESSION_PAUSED' | 'SESSION_FINISHED' | 'ALREADY_JOINED' | 'PARTICIPANT_LIMIT' | 'ELIMINATED' | 'LOCKED' | 'HEALTH_FULL' | 'BURST_COUNTED' | 'BURST_ACTIVE' | 'BURST_LIMIT' | 'ROUND_INTERMISSION' | 'BELOW_MINIMUM';
  export interface SessionAssertion { phase?: import('riff').SessionSnapshot['phase']; scores?: Record<string,number>; remainingMs?: number; participants?: Record<string,Partial<import('riff').SessionParticipant>>; round?: number; winner?: string | null; wins?: Record<string,number>; standings?: Record<string,{ health?: number | null; eliminated?: boolean; bursts?: number; tier?: number }> }
  export interface TimerAssertion { fired: number; effects: number }
  export interface ScenarioStep { id: string; viewer: string; roles: import('riff').AudienceRole[]; text: string; at: number; expect: DecisionCode; effects: number; session?: SessionAssertion | null; timers?: TimerAssertion | null; kind?: 'points.redeem' | null; twitch?: import('riff').TwitchEventDetail | null }
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
