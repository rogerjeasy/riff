import { z } from 'zod';

export type ChatRole = 'viewer' | 'subscriber' | 'moderator' | 'broadcaster';

/** A `channel.chat.message` event reduced to what the host and automations may see. */
export interface NormalizedChatMessage {
  /** EventSub envelope `message_id`: the delivery dedupe identity. */
  readonly id: string;
  /** `broadcaster_user_id` of the channel whose chat received the message. */
  readonly channelId: string;
  /** `chatter_user_id`. */
  readonly viewerId: string;
  /** Original chat identity; Shared Chat echoes never become local authority. */
  readonly sourceChannelId: string;
  readonly sourceMessageId: string;
  readonly viewerLogin: string;
  readonly viewerName: string;
  /** Derived only from the badge set; every chatter is at least a viewer. */
  readonly roles: readonly ChatRole[];
  /** Plain text with control characters removed, capped to {@link MAX_CHAT_TEXT_LENGTH}. */
  readonly text: string;
  /** Host receive time in epoch milliseconds. */
  readonly at: number;
}

/** AGENTS §4: viewer-supplied text is capped at 500 characters. */
export const MAX_CHAT_TEXT_LENGTH = 500;

const id = z.string().min(1);

// Fields per https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event.
// Only the fields Riff reads are required; unknown and unused fields pass through.
const chatMessageEvent = z.looseObject({
  broadcaster_user_id: id,
  message_id: id.optional(),
  source_broadcaster_user_id: id.nullish(),
  source_message_id: id.nullish(),
  chatter_user_id: id,
  chatter_user_login: z.string(),
  chatter_user_name: z.string(),
  message: z.looseObject({ text: z.string() }),
  badges: z.array(z.looseObject({ set_id: z.string(), id: z.string(), info: z.string() })),
});

// Badge set ids, all present in Helix GET /chat/badges/global
// (fixtures/helix.get-global-chat-badges.json). `founder` replaces `subscriber` for a
// channel's first subscribers and, per https://help.twitch.tv/s/article/founders-badge,
// "will display in chat only if you are a current subscriber to the channel".
export const BADGE_ROLES: Readonly<Record<string, Exclude<ChatRole, 'viewer'>>> = {
  broadcaster: 'broadcaster',
  moderator: 'moderator',
  subscriber: 'subscriber',
  founder: 'subscriber',
};

const ROLE_ORDER: readonly ChatRole[] = ['viewer', 'subscriber', 'moderator', 'broadcaster'];

/** Remove C0 control characters and DEL, then cap by code points (never splitting a surrogate pair). */
export function sanitizeChatText(text: string): string {
  let cleaned = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) continue;
    cleaned += char;
  }
  return Array.from(cleaned).slice(0, MAX_CHAT_TEXT_LENGTH).join('');
}

/**
 * Map a `channel.chat.message` event (the `payload.event` object) to a
 * {@link NormalizedChatMessage}. Returns null for anything that does not parse.
 */
export function normalizeChatMessage(
  event: unknown,
  meta: { messageId: string; receivedAt: number },
): NormalizedChatMessage | null {
  if (meta.messageId.length === 0 || !Number.isFinite(meta.receivedAt)) return null;
  const parsed = chatMessageEvent.safeParse(event);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (Boolean(data.source_broadcaster_user_id) !== Boolean(data.source_message_id)) return null;
  const granted = new Set<ChatRole>(['viewer']);
  for (const badge of data.badges) {
    const role = Object.hasOwn(BADGE_ROLES, badge.set_id) ? BADGE_ROLES[badge.set_id] : undefined;
    if (role) granted.add(role);
  }
  return {
    id: meta.messageId,
    channelId: data.broadcaster_user_id,
    sourceChannelId: data.source_broadcaster_user_id ?? data.broadcaster_user_id,
    sourceMessageId: data.source_message_id ?? data.message_id ?? meta.messageId,
    viewerId: data.chatter_user_id,
    viewerLogin: data.chatter_user_login,
    viewerName: data.chatter_user_name,
    roles: ROLE_ORDER.filter((role) => granted.has(role)),
    text: sanitizeChatText(data.message.text),
    at: meta.receivedAt,
  };
}

/** A `channel.channel_points_custom_reward_redemption.add` event as the host may see it. */
export interface NormalizedRedemption {
  /** Redemption id: the durable identity, also used by Update Redemption Status. */
  readonly id: string;
  /** EventSub envelope `message_id`. */
  readonly deliveryId: string;
  readonly channelId: string;
  readonly viewerId: string;
  readonly viewerLogin: string;
  readonly viewerName: string;
  readonly rewardId: string;
  readonly rewardTitle: string;
  readonly rewardCost: number;
  /** `user_input`, sanitized like chat text; empty when the reward takes no input. */
  readonly text: string;
  readonly status: 'unknown' | 'unfulfilled' | 'fulfilled' | 'canceled';
  readonly redeemedAt: string;
  /** Host receive time in epoch milliseconds. */
  readonly at: number;
}

// Fields per the EventSub reference "Channel Points Custom Reward Redemption Add Event"
// (https://dev.twitch.tv/docs/eventsub/eventsub-reference/).
const redemptionEvent = z.looseObject({
  id,
  broadcaster_user_id: id,
  user_id: id,
  user_login: z.string(),
  user_name: z.string(),
  user_input: z.string(),
  status: z.enum(['unknown', 'unfulfilled', 'fulfilled', 'canceled']),
  reward: z.looseObject({ id, title: z.string(), cost: z.number().int() }),
  redeemed_at: z.string(),
});

/** Map a redemption event (the `payload.event` object); null for anything that does not parse. */
export function normalizeRedemption(
  event: unknown,
  meta: { messageId: string; receivedAt: number },
): NormalizedRedemption | null {
  if (meta.messageId.length === 0 || !Number.isFinite(meta.receivedAt)) return null;
  const parsed = redemptionEvent.safeParse(event);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    id: data.id,
    deliveryId: meta.messageId,
    channelId: data.broadcaster_user_id,
    viewerId: data.user_id,
    viewerLogin: data.user_login,
    viewerName: data.user_name,
    rewardId: data.reward.id,
    rewardTitle: data.reward.title,
    rewardCost: data.reward.cost,
    text: sanitizeChatText(data.user_input),
    status: data.status,
    redeemedAt: data.redeemed_at,
    at: meta.receivedAt,
  };
}
