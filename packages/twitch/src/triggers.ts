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
