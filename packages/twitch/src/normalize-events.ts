import { z } from 'zod';
import { sanitizeChatText } from './normalize.js';

/** Viewer id for anonymous cheers and gifts (one shared identity, never a real account). */
export const ANONYMOUS_VIEWER_ID = 'anonymous';
/** Amount ceiling so a malformed or extreme payload cannot overflow host counters. */
export const MAX_EVENT_AMOUNT = 10_000_000;
const MAX_NAME_LENGTH = 64;

export type TwitchEventKind = 'subscribe' | 'gift' | 'resub' | 'cheer' | 'raid';
export type SubscriptionTier = '1000' | '2000' | '3000';

/** A platform event (F19) reduced to what the host and automations may see. */
export interface NormalizedTwitchEvent {
  /** EventSub envelope `message_id`: the delivery dedupe identity. */
  readonly id: string;
  readonly kind: TwitchEventKind;
  /** The broadcaster that received the event (`to_broadcaster_user_id` for raids). */
  readonly channelId: string;
  /** Acting account: subscriber, gifter, cheerer or raiding broadcaster; `anonymous` when hidden. */
  readonly viewerId: string;
  readonly viewerLogin: string | null;
  readonly viewerName: string;
  /** subscribe: 1, gift: subscriptions gifted, resub: cumulative months, cheer: bits, raid: viewers. */
  readonly amount: number;
  readonly tier: SubscriptionTier | null;
  readonly anonymous: boolean;
  /** True when a `channel.subscribe` notification is a gifted subscription. */
  readonly gift: boolean;
  /** Viewer-supplied message (cheer or resub), sanitized; empty otherwise. */
  readonly text: string;
  /** Host receive time in epoch milliseconds. */
  readonly at: number;
}

const id = z.string().min(1);
const tier = z.enum(['1000', '2000', '3000']);
const count = z.number().int().nonnegative();
// Fields per https://dev.twitch.tv/docs/eventsub/eventsub-reference/ (Channel Subscribe,
// Subscription Gift, Subscription Message, Cheer and Raid events). Unknown and unused
// fields pass through; required fields Riff reads fail closed.
const subscribeEvent = z.looseObject({
  user_id: id,
  user_login: z.string(),
  user_name: z.string(),
  broadcaster_user_id: id,
  tier,
  is_gift: z.boolean(),
});
// "Set to null if it was an anonymous subscription gift."
const giftEvent = z.looseObject({
  user_id: id.nullable(),
  user_login: z.string().nullable(),
  user_name: z.string().nullable(),
  broadcaster_user_id: id,
  total: count,
  tier,
  cumulative_total: count.nullable(),
  is_anonymous: z.boolean(),
});
const resubEvent = z.looseObject({
  user_id: id,
  user_login: z.string(),
  user_name: z.string(),
  broadcaster_user_id: id,
  tier,
  message: z.looseObject({ text: z.string() }),
  cumulative_months: count,
});
// "This is null if is_anonymous is true."
const cheerEvent = z.looseObject({
  is_anonymous: z.boolean(),
  user_id: id.nullable(),
  user_login: z.string().nullable(),
  user_name: z.string().nullable(),
  broadcaster_user_id: id,
  message: z.string(),
  bits: count,
});
const raidEvent = z.looseObject({
  from_broadcaster_user_id: id,
  from_broadcaster_user_login: z.string(),
  from_broadcaster_user_name: z.string(),
  to_broadcaster_user_id: id,
  viewers: count,
});

/** Display names are account-controlled; strip and bound them like chat text. */
function displayName(value: string | null, fallback: string): string {
  const cleaned = Array.from(sanitizeChatText(value ?? ''))
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return cleaned.length ? cleaned : fallback;
}
const amountOf = (value: number) => Math.min(MAX_EVENT_AMOUNT, Math.max(1, value));
const ANONYMOUS = { viewerId: ANONYMOUS_VIEWER_ID, viewerLogin: null, viewerName: 'Anonymous' };

function actor(
  hidden: boolean,
  userId: string | null,
  login: string | null,
  name: string | null,
): Pick<NormalizedTwitchEvent, 'viewerId' | 'viewerLogin' | 'viewerName' | 'anonymous'> {
  // Anonymous gifts/cheers never expose an account, even if a payload carried one.
  if (hidden || !userId) return { ...ANONYMOUS, anonymous: true };
  return {
    viewerId: userId,
    viewerLogin: login,
    viewerName: displayName(name, login ?? 'Someone'),
    anonymous: false,
  };
}

/**
 * Map an F19 platform event notification (`payload.event`) to a
 * {@link NormalizedTwitchEvent}. `kind` comes from the trigger table, never the payload.
 * Returns null when the payload does not parse or reports a zero gift/cheer amount.
 */
export function normalizeTwitchEvent(
  kind: TwitchEventKind,
  event: unknown,
  meta: { messageId: string; receivedAt: number },
): NormalizedTwitchEvent | null {
  if (meta.messageId.length === 0 || !Number.isFinite(meta.receivedAt)) return null;
  const common = { id: meta.messageId, kind, at: meta.receivedAt, gift: false, text: '' };
  switch (kind) {
    case 'subscribe': {
      const parsed = subscribeEvent.safeParse(event);
      if (!parsed.success) return null;
      const e = parsed.data;
      return {
        ...common,
        channelId: e.broadcaster_user_id,
        ...actor(false, e.user_id, e.user_login, e.user_name),
        amount: 1,
        tier: e.tier,
        gift: e.is_gift,
      };
    }
    case 'gift': {
      const parsed = giftEvent.safeParse(event);
      if (!parsed.success || parsed.data.total < 1) return null;
      const e = parsed.data;
      return {
        ...common,
        channelId: e.broadcaster_user_id,
        ...actor(e.is_anonymous, e.user_id, e.user_login, e.user_name),
        amount: amountOf(e.total),
        tier: e.tier,
      };
    }
    case 'resub': {
      const parsed = resubEvent.safeParse(event);
      if (!parsed.success) return null;
      const e = parsed.data;
      return {
        ...common,
        channelId: e.broadcaster_user_id,
        ...actor(false, e.user_id, e.user_login, e.user_name),
        amount: amountOf(e.cumulative_months),
        tier: e.tier,
        text: sanitizeChatText(e.message.text),
      };
    }
    case 'cheer': {
      const parsed = cheerEvent.safeParse(event);
      if (!parsed.success || parsed.data.bits < 1) return null;
      const e = parsed.data;
      return {
        ...common,
        channelId: e.broadcaster_user_id,
        ...actor(e.is_anonymous, e.user_id, e.user_login, e.user_name),
        amount: amountOf(e.bits),
        tier: null,
        text: sanitizeChatText(e.message),
      };
    }
    case 'raid': {
      const parsed = raidEvent.safeParse(event);
      if (!parsed.success) return null;
      const e = parsed.data;
      return {
        ...common,
        channelId: e.to_broadcaster_user_id,
        ...actor(
          false,
          e.from_broadcaster_user_id,
          e.from_broadcaster_user_login,
          e.from_broadcaster_user_name,
        ),
        // A raid always counts as an arrival, even when it reports zero viewers.
        amount: amountOf(e.viewers),
        tier: null,
      };
    }
  }
}
