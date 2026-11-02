/**
 * Twitch platform event triggers (F19). Dependency-free names and bounds shared by the
 * compiler contract, the sandbox admission path and the server's EventSub routing.
 * Each kind maps to exactly one EventSub subscription type/version in
 * `packages/twitch/src/triggers.ts`; a downstream test keeps the two sets equal.
 */
export const TWITCH_EVENT_KINDS = ['subscribe', 'gift', 'resub', 'cheer', 'raid'] as const;
export type TwitchEventKind = (typeof TWITCH_EVENT_KINDS)[number];

/** Subscription tiers as Twitch reports them (`1000`, `2000`, `3000`). */
export const SUBSCRIPTION_TIERS = ['1000', '2000', '3000'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

/**
 * What `event.amount` counts for each kind. The host compares it with
 * `trigger.event.minimum` before any guest code runs.
 */
export const TWITCH_EVENT_AMOUNT: Readonly<Record<TwitchEventKind, string>> = Object.freeze({
  subscribe: 'always 1 (one new subscription)',
  gift: 'subscriptions gifted in this gift',
  resub: 'cumulative months subscribed',
  cheer: 'bits cheered',
  raid: 'viewers in the raid',
});

/** Bounds for event triggers; amounts above `amountMax` are clamped by normalization. */
export const EVENT_TRIGGER_LIMITS = Object.freeze({
  minimum: { min: 1, max: 1_000_000 },
  amountMax: 10_000_000,
});

/** The normalized platform-event detail a handler sees on `event.twitch`. */
export interface TwitchEventDetail {
  kind: TwitchEventKind;
  /** See {@link TWITCH_EVENT_AMOUNT}. Always a positive integer. */
  amount: number;
  /** Subscription tier for subscribe/gift/resub; null for cheer and raid. */
  tier: SubscriptionTier | null;
  /** True for anonymous cheers and gifts; the viewer id is then `anonymous`. */
  anonymous: boolean;
  /** True when a subscribe event is a gifted subscription. */
  gift: boolean;
}

/** Manifest event trigger: run on this Twitch event when `amount >= minimum`. */
export interface EventTrigger {
  kind: TwitchEventKind;
  minimum: number;
}

/** Viewer id the host uses for anonymous cheers and gifts. */
export const ANONYMOUS_VIEWER_ID = 'anonymous';

/**
 * `twitch.event` manifests set `trigger.command` to this reserved, non-chat token so
 * every existing command consumer keeps a stable identifier. Chat text never matches
 * it. Example: eventTriggerCommand('cheer') === '@cheer'.
 */
export function eventTriggerCommand(kind: TwitchEventKind): `@${TwitchEventKind}` {
  return `@${kind}`;
}

/** Pattern accepted for reserved event commands. */
export const EVENT_COMMAND_PATTERN = `^@(?:${TWITCH_EVENT_KINDS.join('|')})$`;

const EVENT_PHRASE: Readonly<Record<TwitchEventKind, (minimum: number) => string>> = {
  subscribe: () => 'Someone subscribes',
  gift: (n) => (n > 1 ? `Someone gifts ${n}+ subs` : 'Someone gifts subs'),
  resub: (n) => (n > 1 ? `Someone resubscribes for ${n}+ months` : 'Someone resubscribes'),
  cheer: (n) => `Someone cheers ${n}+ bits`,
  raid: (n) => (n > 1 ? `A raid of ${n}+ viewers arrives` : 'A raid arrives'),
};

/**
 * Plain-language trigger description for any manifest trigger, keyed on `trigger.kind`.
 * Example: describeTrigger({ kind: 'twitch.event', command: '@cheer', event: { kind: 'cheer', minimum: 100 } })
 * returns 'Someone cheers 100+ bits'.
 */
export function describeTrigger(trigger: {
  kind?: 'chat.command' | 'points.redeem' | 'twitch.event' | undefined;
  command: string;
  reward?: string | null | undefined;
  event?: EventTrigger | null | undefined;
}): string {
  if (trigger.kind === 'twitch.event' && trigger.event)
    return EVENT_PHRASE[trigger.event.kind](trigger.event.minimum);
  if (trigger.kind === 'points.redeem') return `Someone redeems “${trigger.reward ?? ''}”`;
  return `Someone types ${trigger.command} in chat`;
}
