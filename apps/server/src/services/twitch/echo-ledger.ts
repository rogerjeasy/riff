import { sanitizeChatText } from '@riff/twitch';

/**
 * F11 bot-loop suppression. Riff posts host replies (Send Chat Message) and chat
 * announcements (Send Chat Announcement) with the broadcaster's user token, so Twitch can
 * deliver that output back over `channel.chat.message` as a broadcaster-badged line. An
 * echo must never dispatch an automation or a `!riff` command.
 *
 * Identification, per the docs:
 * - Send Chat Message returns `data[].message_id` ("The message id for the message that
 *   was sent"); the `channel.chat.message` event carries `message_id` ("A UUID that
 *   identifies the message"). https://dev.twitch.tv/docs/api/reference/#send-chat-message
 * - Send Chat Announcement answers "204 No Content" with "Response Body None", so there is
 *   no id. https://dev.twitch.tv/docs/api/reference/#send-chat-announcement
 *   The documented `message_type` values (text, channel_points_highlighted,
 *   channel_points_sub_only, user_intro, power_ups_message_effect,
 *   power_ups_gigantified_emote) include no announcement type; Twitch documents
 *   announcements as `channel.chat.notification` with `notice_type: "announcement"`.
 *   https://dev.twitch.tv/docs/eventsub/eventsub-reference/
 *   A plain chat line with the same text was observed in production (2026-11-02), so an
 *   announcement is remembered as a short-lived text fingerprint and consumed once.
 *
 * Every entry is also fingerprinted, so an echo still matches if its id ever differs.
 * The ledger is bounded in time ({@link ECHO_WINDOW_MS}) and size ({@link ECHO_LEDGER_MAX}
 * per channel); only lines whose chatter is the broadcaster (the sender Riff uses) match.
 */
export const ECHO_WINDOW_MS = 30_000;
export const ECHO_LEDGER_MAX = 64;

export type EchoOrigin = 'chat-message' | 'announcement';
export interface EchoMatch {
  origin: EchoOrigin;
  by: 'message-id' | 'fingerprint';
}
interface Entry {
  channelId: string;
  origin: EchoOrigin;
  fingerprint: string;
  messageId: string | null;
  at: number;
}

/** Same sanitizing as incoming chat, then whitespace runs collapsed and trimmed. */
export function echoFingerprint(text: string): string {
  return sanitizeChatText(text.replace(/\s+/gu, ' ')).replace(/\s+/gu, ' ').trim().normalize();
}

export function createEchoLedger(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let entries: Entry[] = [];
  const prune = () => {
    const cutoff = now() - ECHO_WINDOW_MS;
    entries = entries.filter((entry) => entry.at >= cutoff);
  };
  const remove = (entry: Entry) => {
    entries = entries.filter((candidate) => candidate !== entry);
  };
  return {
    /**
     * Record output before the Helix call: the echo can arrive over EventSub before the
     * HTTP response does. Attach the returned id once known; cancel when Twitch reports
     * the message as not sent. Ambiguous failures keep the entry (fail closed).
     */
    sending(channelId: string, text: string, origin: EchoOrigin) {
      prune();
      const entry: Entry = {
        channelId,
        origin,
        fingerprint: echoFingerprint(text),
        messageId: null,
        at: now(),
      };
      entries.push(entry);
      const mine = entries.filter((candidate) => candidate.channelId === channelId);
      for (const evicted of mine.slice(0, Math.max(0, mine.length - ECHO_LEDGER_MAX)))
        remove(evicted);
      return {
        sent(messageId: string) {
          entry.messageId = messageId;
        },
        cancel() {
          remove(entry);
        },
      };
    },
    /** Consume and describe the ledger entry this incoming line echoes, if any. */
    match(line: {
      channelId: string;
      chatterId: string;
      messageId: string;
      text: string;
    }): EchoMatch | null {
      prune();
      if (line.chatterId !== line.channelId) return null;
      const mine = entries.filter((entry) => entry.channelId === line.channelId);
      const byId = mine.find(
        (entry) => entry.messageId !== null && entry.messageId === line.messageId,
      );
      if (byId) {
        remove(byId);
        return { origin: byId.origin, by: 'message-id' };
      }
      const fingerprint = echoFingerprint(line.text);
      const byText = mine.find((entry) => entry.fingerprint === fingerprint);
      if (!byText) return null;
      remove(byText);
      return { origin: byText.origin, by: 'fingerprint' };
    },
    size(): number {
      prune();
      return entries.length;
    },
  };
}
export type EchoLedger = ReturnType<typeof createEchoLedger>;
