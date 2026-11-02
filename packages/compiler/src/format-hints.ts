import type { ExperienceFormat } from '@riff/sdk';

/** Which version 3 format a request names, if any. */
export function formatKindOf(intent: string): ExperienceFormat['kind'] | null {
  if (/\b(?:mural|pixel art|pixel canvas|paint (?:a|the) (?:canvas|grid|picture))\b/i.test(intent))
    return 'mural';
  if (/\bcompos\w*\b/i.test(intent) && /\b(?:song|music|track|melody)\b/i.test(intent))
    return 'composition';
  if (/\b(?:quiz|trivia)\b/i.test(intent)) return 'quiz';
  return null;
}
