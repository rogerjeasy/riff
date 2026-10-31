/**
 * The complete universe the runtime compiler sees. `SDK.md` is generated from
 * `SDK_GUIDE` and a test keeps them identical; undocumented surface must not exist.
 */
export const SDK_GUIDE = `# Riff SDK 0.3.0 — handler contract

Compatibility: 0.2.0 artifacts must be regenerated. 0.3.0 adds live execution, the
\`heart\` asset, case-insensitive commands and declarative scenario tests.

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
Required coverage: at least one happy path, one limit/role/window edge, and one
negative (unrelated chat does nothing).
`;

export const RIFF_DTS = `declare module 'riff' {
  export type AudienceRole = 'viewer' | 'subscriber' | 'moderator' | 'broadcaster';
  export interface ChatEvent { id: string; channelId: string; viewerId: string; roles: AudienceRole[]; text: string; at: number }
  export interface ProjectileEffect { kind: 'projectile'; asset: 'tomato' | 'star' | 'heart'; x: number }
  export interface Riff {
    overlay: { emit(effect: ProjectileEffect): Promise<void> };
    util: { now(): number; random(): number };
  }
  export type Handler = (event: ChatEvent, riff: Riff) => void | Promise<void>;
}
`;

export const RIFF_TEST_DTS = `declare module 'riff/test' {
  export type DecisionCode = 'ACCEPTED' | 'UNRELATED' | 'AUDIENCE' | 'VIEWER_LIMIT' | 'CHANNEL_LIMIT' | 'DUPLICATE';
  export interface ScenarioStep { id: string; viewer: string; roles: import('riff').AudienceRole[]; text: string; at: number; expect: DecisionCode; effects: number }
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
