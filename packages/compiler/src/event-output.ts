import {
  SDK_VERSION,
  describeTrigger,
  eventTriggerCommand,
  type EventTrigger,
  type ProjectileAsset,
  type Scenario,
  type TwitchEventDetail,
  type TwitchEventKind,
} from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { extractEventHints, SHOUTOUT_WORDS } from './event-hints.js';
import { extractIntentHints } from './intent.js';

interface EventPlan {
  title: string;
  asset: ProjectileAsset;
  /** Effects for an event of `amount`; mirrors the generated handler exactly. */
  effects: (amount: number) => number;
  source: string;
  what: string;
  /** How the effect count scales, for the approval card. */
  scale: string;
}
const MAX_BURST = 5;
const PER_VIEWER = 5;
const WINDOW_MS = 60_000;

const burst = (asset: ProjectileAsset, size: number) =>
  `async (event, riff) => {\n  for (let i = 0; i < ${size}; i++) await riff.overlay.emit({ kind: 'projectile', asset: '${asset}', x: riff.util.random() });\n}`;

function plan(kind: TwitchEventKind, asset: ProjectileAsset | null): EventPlan {
  switch (kind) {
    case 'cheer': {
      const a = asset ?? 'star';
      return {
        title: 'Cheer Shower',
        asset: a,
        effects: (bits) => Math.min(MAX_BURST, Math.max(1, Math.floor(bits / 100))),
        source: `async (event, riff) => {\n  const n = Math.min(${MAX_BURST}, Math.max(1, Math.floor(event.twitch.amount / 100)));\n  for (let i = 0; i < n; i++) await riff.overlay.emit({ kind: 'projectile', asset: '${a}', x: riff.util.random() });\n}`,
        what: `A shower of ${a}s rains across your overlay`,
        scale: `one ${a} per 100 bits, up to ${MAX_BURST}`,
      };
    }
    case 'gift': {
      const a = asset ?? 'heart';
      return {
        title: 'Gift Hearts',
        asset: a,
        effects: (subs) => Math.min(MAX_BURST, Math.max(1, subs)),
        source: `async (event, riff) => {\n  const n = Math.min(${MAX_BURST}, Math.max(1, event.twitch.amount));\n  for (let i = 0; i < n; i++) await riff.overlay.emit({ kind: 'projectile', asset: '${a}', x: riff.util.random() });\n}`,
        what: `A ${a} for every gifted sub flies across your overlay`,
        scale: `one ${a} per gifted sub, up to ${MAX_BURST}`,
      };
    }
    case 'raid': {
      const a = asset ?? 'star';
      return {
        title: 'Raid Welcome',
        asset: a,
        effects: () => MAX_BURST,
        source: burst(a, MAX_BURST),
        what: `A welcome burst of ${MAX_BURST} ${a}s crosses your overlay`,
        scale: `${MAX_BURST} ${a}s per raid`,
      };
    }
    case 'resub':
    case 'subscribe': {
      const a = asset ?? 'heart';
      return {
        title: kind === 'resub' ? 'Resub Hearts' : 'Sub Hearts',
        asset: a,
        effects: () => 3,
        source: burst(a, 3),
        what: `Three ${a}s fly across your overlay`,
        scale: `3 ${a}s per ${kind === 'resub' ? 'resub' : 'sub'}`,
      };
    }
  }
}

const synthetic = (kind: TwitchEventKind, amount: number): TwitchEventDetail => ({
  kind,
  amount: kind === 'subscribe' ? 1 : amount,
  tier: kind === 'subscribe' || kind === 'gift' || kind === 'resub' ? '1000' : null,
  anonymous: false,
  gift: false,
});

function scenarios(trigger: EventTrigger, effects: (amount: number) => number): Scenario[] {
  const step = (
    id: string,
    viewer: string,
    twitch: TwitchEventDetail | null,
    at: number,
    expect: Scenario['steps'][number]['expect'],
    count: number,
    text = '',
  ): Scenario['steps'][number] => ({
    id,
    viewer,
    roles: ['viewer'],
    text,
    at,
    expect,
    effects: count,
    twitch,
  });
  const { kind, minimum } = trigger;
  const hit = synthetic(kind, minimum);
  const n = effects(hit.amount);
  const other = kind === 'raid' ? 'cheer' : 'raid';
  const list: Scenario[] = [
    {
      name: `A ${kind} at the threshold shows the effect`,
      kind: 'happy',
      steps: [step('e1', 'alice', hit, 0, 'ACCEPTED', n)],
    },
    {
      name: `${PER_VIEWER} per viewer in 60 seconds, then blocked; another viewer still can`,
      kind: 'limit',
      steps: [
        ...Array.from({ length: PER_VIEWER }, (_, i) =>
          step(`a${i}`, 'alice', hit, i * 10, 'ACCEPTED', n),
        ),
        step('over', 'alice', hit, PER_VIEWER * 10, 'VIEWER_LIMIT', 0),
        step('bob', 'bob', hit, PER_VIEWER * 10 + 1, 'ACCEPTED', n),
      ],
    },
    {
      name: 'Chat and other Twitch events do nothing',
      kind: 'negative',
      steps: [
        step('c1', 'alice', null, 0, 'UNRELATED', 0, 'hello chat'),
        step('c2', 'alice', synthetic(other, 1000), 1, 'UNRELATED', 0),
      ],
    },
    {
      name: 'A redelivered event is ignored',
      kind: 'duplicate',
      steps: [
        step('d1', 'alice', hit, 0, 'ACCEPTED', n),
        step('d1', 'alice', hit, 5, 'DUPLICATE', 0),
      ],
    },
  ];
  if (minimum > 1)
    list.splice(1, 0, {
      name: `Below ${minimum} does nothing`,
      kind: 'limit',
      steps: [
        step('b1', 'alice', synthetic(kind, minimum - 1), 0, 'BELOW_MINIMUM', 0),
        step('b2', 'alice', hit, 1, 'ACCEPTED', n),
      ],
    });
  return list;
}

/**
 * Deterministic offline candidate for F19 event intents such as "when someone cheers
 * 100+ bits, rain confetti" or "when we get raided, show a welcome banner". Riff has
 * only projectile effects, so confetti and banners become clearly stated bursts.
 */
export function compileEventOffline(request: CompileRequest): CompileOutput | null {
  const base = request.base?.manifest as
    { trigger?: { kind?: string; event?: EventTrigger | null } } | undefined;
  const hints = extractEventHints(request.intent);
  const previous = base?.trigger?.kind === 'twitch.event' ? (base.trigger.event ?? null) : null;
  if (!hints && !(previous && !extractIntentHints(request.intent).command)) return null;
  const kind = hints?.kind ?? previous?.kind;
  if (!kind) return null;
  const assumptions: string[] = [];
  let minimum = hints?.minimum ?? (previous?.kind === kind ? previous.minimum : null);
  if (minimum === null) {
    minimum = 1;
    if (kind !== 'subscribe') assumptions.push(`Every ${kind} counts; no minimum was stated.`);
  }
  if (kind === 'subscribe') minimum = 1;
  const stated = extractIntentHints(request.intent).asset;
  const p = plan(kind, stated);
  const confetti = /\bconfetti\b/i.test(request.intent);
  const banner = /\b(?:banner|sign|text|words?)\b/i.test(request.intent);
  if (confetti)
    assumptions.push(`Riff has no confetti effect yet; a shower of ${p.asset}s stands in for it.`);
  if (banner)
    assumptions.push(
      `Riff cannot draw text banners yet; a burst of ${p.asset}s welcomes them instead.`,
    );
  if (!stated && !confetti && !banner) assumptions.push(`Shows ${p.asset}s.`);
  assumptions.push(`Up to ${PER_VIEWER} reactions per account in any 60 seconds.`);
  if (kind === 'cheer' || kind === 'gift')
    assumptions.push('Anonymous cheers and gifts share one allowance.');
  // F23: only raids may shout out, and only the raiding channel the host binds.
  const shoutout = kind === 'raid' && SHOUTOUT_WORDS.test(request.intent);
  if (shoutout) {
    p.title = 'Raid Shoutout';
    p.source = p.source.replace('{\n', '{\n  await riff.shoutout.raider();\n');
    const effects = p.effects;
    p.effects = (amount) => effects(amount) + 1;
    p.what = `Twitch shows a shoutout card for the raiding channel, and ${p.what.charAt(0).toLowerCase()}${p.what.slice(1)}`;
    p.scale = `one shoutout and ${p.scale}`;
    assumptions.push(
      'Turn on “Shout out raiders automatically” in Twitch features; until then the welcome burst still plays and the shoutout is refused.',
      'Twitch allows one shoutout every 2 minutes and the same channel once an hour.',
    );
  }
  const trigger: EventTrigger = { kind, minimum };
  const when = describeTrigger({
    kind: 'twitch.event',
    command: eventTriggerCommand(kind),
    event: trigger,
  });
  const perEvent = MAX_BURST;
  return {
    kind: 'candidate',
    title: request.base?.title ?? p.title,
    // "Twitch" stays capitalized; other plans start with an ordinary word.
    summary: `${when}: ${shoutout ? p.what : p.what.toLowerCase()}.`,
    question: null,
    choices: [],
    unsupportedReason: null,
    alternative: null,
    source: p.source,
    migrationSource: null,
    manifest: {
      sdkVersion: SDK_VERSION,
      experience: null,
      capabilities: shoutout ? ['overlay', 'shoutout'] : ['overlay'],
      trigger: {
        command: eventTriggerCommand(kind),
        audience: ['viewer'],
        maxPerViewer: PER_VIEWER,
        windowMs: WINDOW_MS,
        kind: 'twitch.event',
        event: trigger,
      },
      limits: {
        effectsPerEvent:
          kind === 'subscribe' || kind === 'resub' ? 3 : perEvent + (shoutout ? 1 : 0),
        effectsPerMinute: 60,
      },
    },
    tests: scenarios(trigger, p.effects),
    behavior: {
      when,
      what: p.what,
      who: kind === 'raid' ? 'Any channel that raids you' : 'Anyone on Twitch who does it',
      howMuch: `${p.scale}; up to ${PER_VIEWER} per account in any 60 seconds`,
    },
    assumptions: assumptions.slice(0, 8),
  };
}
