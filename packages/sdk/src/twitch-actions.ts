/**
 * Native Twitch side effects (F21 polls and announcements, F23 shoutouts). Guest code
 * only stages a request; the host validates it, checks automation limits, the channel
 * budget and Twitch's documented hard caps, and performs the call itself. Previews and
 * rehearsals route every action to a simulated sink and never reach Twitch.
 */
export const TWITCH_ACTION_CAPABILITIES = ['polls', 'chat.announce', 'shoutout'] as const;
export type TwitchActionCapability = (typeof TWITCH_ACTION_CAPABILITIES)[number];
export const ANNOUNCEMENT_COLORS = ['blue', 'green', 'orange', 'purple', 'primary'] as const;
export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number];

/**
 * Policy ceilings. Request bounds mirror the Twitch reference (Create Poll: question ≤ 60,
 * 2–5 choices ≤ 25, 15–1800 s; Send Chat Announcement: ≤ 500 characters, one every 2 s;
 * Send a Shoutout: once every 2 minutes, same channel once every 60 minutes). Channel
 * budgets are Riff's own, stricter limits enforced host-side regardless of manifests.
 */
export const TWITCH_ACTION_LIMITS = Object.freeze({
  /** Native actions one handler invocation may stage (each also counts as an effect). */
  perEvent: 2,
  poll: {
    titleLength: 60,
    choiceLength: 25,
    choices: { min: 2, max: 5 },
    durationSeconds: { min: 15, max: 1800 },
  },
  announcement: { messageLength: 500, minIntervalMs: 2000 },
  shoutout: {
    /** Twitch login syntax as accepted by Riff; resolved only against the creator's policy. */
    loginPattern: '^[a-z0-9_]{1,25}$',
    globalCooldownMs: 2 * 60_000,
    sameTargetCooldownMs: 60 * 60_000,
  },
  /** Host channel budgets across every automation and manual action. */
  channel: { announcementsPerMinute: 6, pollsPerHour: 12, shoutoutsPerHour: 10 },
  /** Audiences allowed to trigger polls and shoutouts; announcements follow the manifest. */
  privilegedAudience: ['moderator', 'broadcaster'] as const,
});

export interface PollRequest {
  title: string;
  choices: string[];
  durationSeconds: number;
}
export interface AnnouncementRequest {
  message: string;
  color?: AnnouncementColor | undefined;
}
export interface ShoutoutRequest {
  /** Lowercase Twitch login; must be approved by the creator's shoutout policy. */
  login: string;
}

/** One staged native Twitch action, recorded on the decision that produced it. */
export type TwitchAction =
  | ({ kind: 'poll.start' } & PollRequest)
  | { kind: 'poll.end' }
  | { kind: 'announce'; message: string; color: AnnouncementColor }
  | { kind: 'shoutout'; login: string };

/** Capability that authorizes an action kind. */
export const ACTION_CAPABILITY: Readonly<Record<TwitchAction['kind'], TwitchActionCapability>> =
  Object.freeze({
    'poll.start': 'polls',
    'poll.end': 'polls',
    announce: 'chat.announce',
    shoutout: 'shoutout',
  });
