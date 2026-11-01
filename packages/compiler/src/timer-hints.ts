/** Explicit named-timer facts in creator text and candidate source; no guessing. */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};
const UNITS: [RegExp, number][] = [
  [/^(?:s|sec|secs|seconds?)$/i, 1000],
  [/^(?:m|min|mins|minutes?)$/i, 60_000],
  [/^(?:h|hr|hrs|hours?)$/i, 3_600_000],
];
const AMOUNT = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const UNIT = '(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)';

const COUNT = new RegExp(
  `^(?:\\d+|once|twice|thrice|times?|${Object.keys(NUMBER_WORDS)
    .filter((word) => word !== 'a' && word !== 'an')
    .join('|')})[,.]?$`,
  'i',
);

export interface TimerHint {
  repeat: boolean;
  ms: number;
}

const toMs = (amount: string | undefined, unit: string) => {
  const value = amount ? (NUMBER_WORDS[amount.toLowerCase()] ?? Number(amount)) : 1;
  const scale = UNITS.find(([pattern]) => pattern.test(unit))?.[1];
  return scale && Number.isFinite(value) ? Math.round(value * scale) : null;
};

/**
 * Explicit host-timer phrasing only: "every N minutes" (repeating) or "in/after N
 * seconds" (one-shot). Rolling-window allowances ("3 per 60 seconds") never match.
 */
export function extractTimerHint(intent: string): TimerHint | null {
  const text = intent.replace(/\s+/g, ' ');
  // "once every 30 seconds" or "3 in 60 seconds" counts actions in a window: not a timer.
  const counted = (match: RegExpMatchArray) =>
    text
      .slice(0, match.index ?? 0)
      .trim()
      .split(' ')
      .slice(-3)
      .some((word) => COUNT.test(word));
  const every =
    text.match(new RegExp(`\\bevery\\s+${AMOUNT}[ -]?${UNIT}\\b`, 'i')) ??
    text.match(new RegExp(`\\bevery\\s+()${UNIT}\\b`, 'i'));
  if (every?.[2] && !counted(every)) {
    const ms = toMs(every[1] || undefined, every[2]);
    if (ms !== null) return { repeat: true, ms };
  }
  const once = text.match(new RegExp(`\\b(?:in|after)\\s+${AMOUNT}[ -]?${UNIT}\\b`, 'i'));
  if (once?.[1] && once[2] && !counted(once)) {
    const ms = toMs(once[1], once[2]);
    if (ms !== null) return { repeat: false, ms };
  }
  return null;
}

/** The interval a candidate's source schedules, for intent checks. */
export function timerOfSource(source: string): TimerHint | null {
  const call = source.match(/riff\.timer\.start\(\s*['"][^'"]+['"]\s*,\s*(\d+)\s*(,[^)]*)?\)/);
  if (!call?.[1]) return null;
  return { ms: Number(call[1]), repeat: /repeat\s*:\s*true/.test(call[2] ?? '') };
}
