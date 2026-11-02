import { EVENT_TRIGGER_LIMITS, type TwitchEventKind } from '@riff/sdk';

/** "Shout out", "shoutout" or "shout them out": a request for a Twitch shoutout card. */
export const SHOUTOUT_WORDS = /\bshout ?-?outs?\b|\bshout\s+(?:them|him|her|the\s+[a-z]+)\s+out\b/i;

/** Explicit Twitch event facts in the creator's words (F19). Absent facts stay null. */
export interface EventHints {
  kind: TwitchEventKind;
  /** Stated threshold ("100+ bits", "raids of 20 or more"); null when unstated. */
  minimum: number | null;
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
const toAmount = (value: string | undefined) => {
  if (!value) return null;
  const n = Number(value.replaceAll(',', ''));
  return Number.isInteger(n) &&
    n >= EVENT_TRIGGER_LIMITS.minimum.min &&
    n <= EVENT_TRIGGER_LIMITS.minimum.max
    ? n
    : null;
};
const first = (text: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const found = toAmount(text.match(pattern)?.[1]);
    if (found !== null) return found;
  }
  return null;
};

/**
 * Deterministic detection of a Twitch event trigger. A stated `!command` always means
 * chat, so "subscribers can type !love" stays a chat interaction with an audience.
 */
export function extractEventHints(intent: string): EventHints | null {
  const text = intent.replace(/\s+/g, ' ');
  if (/![a-z0-9_-]{1,32}/i.test(text)) return null;
  if (/\bre-?sub(?:s|bed|scribes?|scribed|scriptions?)?\b/i.test(text))
    return {
      kind: 'resub',
      minimum: first(text, [
        new RegExp(`${AMOUNT}\\s*\\+?\\s*(?:or more\\s+)?months?`, 'i'),
        new RegExp(`(?:at least|over|more than)\\s+${AMOUNT}\\s+months?`, 'i'),
      ]),
    };
  if (/\bgift(?:s|ed|ing)?\b/i.test(text) && /\bsub(?:s|scriptions?)?\b/i.test(text))
    return {
      kind: 'gift',
      minimum: first(text, [
        new RegExp(`${AMOUNT}\\s*\\+?\\s*(?:or more\\s+)?(?:gift(?:ed)?\\s+)?subs?`, 'i'),
        new RegExp(`(?:at least|more than)\\s+${AMOUNT}\\s+(?:gift(?:ed)?\\s+)?subs?`, 'i'),
      ]),
    };
  if (/\b(?:cheer(?:s|ed|ing)?|bits?)\b/i.test(text))
    return {
      kind: 'cheer',
      minimum: first(text, [
        new RegExp(`${AMOUNT}\\s*\\+?\\s*(?:or more\\s+)?bits?`, 'i'),
        new RegExp(`(?:at least|over|more than)\\s+${AMOUNT}\\s+bits?`, 'i'),
        new RegExp(`cheers?\\s+${AMOUNT}`, 'i'),
      ]),
    };
  if (/\braid(?:s|ed|ing|ers?)?\b/i.test(text))
    return {
      kind: 'raid',
      minimum: first(text, [
        new RegExp(`${AMOUNT}\\s*\\+?\\s*(?:or more\\s+)?(?:viewers|raiders|people)`, 'i'),
        new RegExp(`(?:at least|over|more than)\\s+${AMOUNT}\\s+(?:viewers|raiders|people)`, 'i'),
      ]),
    };
  if (
    /\b(?:someone|somebody|anyone|a viewer|viewers?|people|they)\s+(?:subscribes?|subs)\b/i.test(
      text,
    ) ||
    /\bnew\s+sub(?:scriber|scription)?s?\b/i.test(text) ||
    /\b(?:we|i)\s+get\s+(?:a\s+)?(?:new\s+)?sub(?:scriber|scription)?\b/i.test(text) ||
    /\bsubscribes?\b/i.test(text)
  )
    return { kind: 'subscribe', minimum: null };
  return null;
}
