/**
 * The single source of EventSub subscription types and versions (AGENTS §2.4).
 * When Twitch deprecates a version, change it here only.
 */
export interface TriggerDefinition {
  /** EventSub subscription type name. */
  readonly type: string;
  /** EventSub subscription type version. */
  readonly version: string;
  /** Official documentation page for this type and version. */
  readonly docs: string;
  /** Scopes the user access token must carry to create the subscription over WebSockets. */
  readonly scopes: readonly string[];
  /** Sourced example payload under `packages/twitch/fixtures/`. */
  readonly fixture: string;
  /** Condition fields, each set to the connected broadcaster's user id. */
  readonly condition: readonly ('broadcaster_user_id' | 'user_id' | 'to_broadcaster_user_id')[];
  /** Documented optional condition filters Riff deliberately leaves unset. */
  readonly optionalCondition?: readonly string[];
  /** Consent family the creator grants in one step (shared by every trigger with the same scopes). */
  readonly consent: 'chat' | 'subscriptions' | 'bits' | 'raids' | 'channel-points';
  /** Creator-facing name for the console. */
  readonly label: string;
}

export const TRIGGERS = {
  'chat.message': {
    type: 'channel.chat.message',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage',
    // Docs: "Requires user:read:chat scope from the chatting user." Over WebSockets
    // only user access tokens are accepted, so the app-token scopes do not apply.
    scopes: ['user:read:chat'],
    fixture: 'channel.chat.message.json',
    condition: ['broadcaster_user_id', 'user_id'],
    consent: 'chat',
    label: 'Chat messages',
  },
  // F19 platform event triggers. Keys equal the SDK's TWITCH_EVENT_KINDS. Versions,
  // scopes and conditions checked against the subscription types page on 2026-11-01.
  subscribe: {
    type: 'channel.subscribe',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelsubscribe',
    // Docs: "Must have channel:read:subscriptions scope." Excludes resubscribes.
    scopes: ['channel:read:subscriptions'],
    fixture: 'channel.subscribe.json',
    condition: ['broadcaster_user_id'],
    consent: 'subscriptions',
    label: 'New subscriptions',
  },
  gift: {
    type: 'channel.subscription.gift',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelsubscriptiongift',
    scopes: ['channel:read:subscriptions'],
    fixture: 'channel.subscription.gift.json',
    condition: ['broadcaster_user_id'],
    consent: 'subscriptions',
    label: 'Gifted subscriptions',
  },
  resub: {
    type: 'channel.subscription.message',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelsubscriptionmessage',
    scopes: ['channel:read:subscriptions'],
    fixture: 'channel.subscription.message.json',
    condition: ['broadcaster_user_id'],
    consent: 'subscriptions',
    label: 'Resubscription messages',
  },
  cheer: {
    type: 'channel.cheer',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelcheer',
    // Docs: "Must have bits:read scope."
    scopes: ['bits:read'],
    fixture: 'channel.cheer.json',
    condition: ['broadcaster_user_id'],
    consent: 'bits',
    label: 'Cheers (Bits)',
  },
  raid: {
    type: 'channel.raid',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelraid',
    // Docs: "No authorization required." Set exactly one of from_/to_broadcaster_user_id;
    // incoming raids use to_broadcaster_user_id.
    scopes: [],
    fixture: 'channel.raid.json',
    condition: ['to_broadcaster_user_id'],
    consent: 'raids',
    label: 'Incoming raids',
  },
  'points.redeem': {
    type: 'channel.channel_points_custom_reward_redemption.add',
    version: '1',
    docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchannel_points_custom_reward_redemptionadd',
    // Docs: "Must have channel:read:redemptions or channel:manage:redemptions scope."
    // Riff manages its own rewards and redemption status, so it requests the manage scope.
    scopes: ['channel:manage:redemptions'],
    fixture: 'channel.channel_points_custom_reward_redemption.add.json',
    condition: ['broadcaster_user_id'],
    // Docs: reward_id is optional; Riff receives every reward and routes linked ones itself.
    optionalCondition: ['reward_id'],
    // Granted from the Channel Points panel (`?features=channel-points`), not `?triggers=`.
    consent: 'channel-points',
    label: 'Channel Points redemptions',
  },
} as const satisfies Record<string, TriggerDefinition>;

export type TriggerName = keyof typeof TRIGGERS;

/** Resolve a delivered subscription type/version back to a Riff trigger name. */
export function triggerForSubscription(type: string, version: string): TriggerName | null {
  for (const [name, trigger] of Object.entries(TRIGGERS) as [TriggerName, TriggerDefinition][]) {
    if (trigger.type === type && trigger.version === version) return name;
  }
  return null;
}

/**
 * F19 platform event trigger names: every trigger except chat and the F22 Channel Points
 * redemption, which has its own consent, subscription and settlement path.
 */
export type EventTriggerName = Exclude<TriggerName, 'chat.message' | 'points.redeem'>;
export const EVENT_TRIGGER_NAMES = (Object.keys(TRIGGERS) as TriggerName[]).filter(
  (name): name is EventTriggerName => name !== 'chat.message' && name !== 'points.redeem',
);

/** Build the subscription condition for the connected broadcaster. */
export function triggerCondition(name: TriggerName, broadcasterId: string): Record<string, string> {
  return Object.fromEntries(TRIGGERS[name].condition.map((field) => [field, broadcasterId]));
}

/** Union of the scopes the named triggers need, in first-seen order. */
export function scopesForTriggers(names: readonly TriggerName[]): string[] {
  return [...new Set(names.flatMap((name) => TRIGGERS[name].scopes))];
}

/** Scopes a token still lacks for a trigger. Empty means consent is complete. */
export function missingScopes(name: TriggerName, granted: readonly string[]): string[] {
  return TRIGGERS[name].scopes.filter((scope) => !granted.includes(scope));
}
