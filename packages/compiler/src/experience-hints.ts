import type { ExperienceDefinition } from '@riff/sdk';
import { extractIntentHints } from './intent.js';

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const NUMBER = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
const numberOf = (value: string | undefined) =>
  value ? (WORDS[value.toLowerCase()] ?? Number(value)) : null;

export interface ExperienceHints {
  requested: boolean;
  command: string | null;
  durationMs: number | null;
  resourceName: string | null;
  perParticipant: number | null;
  teams: ExperienceDefinition['teams'] | null;
  teamCount: number | null;
  objective: ExperienceDefinition['objective']['kind'] | null;
  target: number | null;
}

/** Conservative, independent reading of the bounded session primitives in creator text. */
export function extractExperienceHints(intent: string): ExperienceHints {
  const text = intent.replace(/\s+/g, ' ');
  const requested =
    /\b(?:battle|teams?|cooperati(?:ve|on)|community goal|collective goal|round|session|contributions?)\b/i.test(
      text,
    );
  const cooperative =
    /\b(?:cooperati(?:ve|on)|community goal|collective goal|work together|collectively)\b/i.test(
      text,
    );
  const competitive = /\b(?:battle|highest[- ]score|teams?)\b/i.test(text);
  const teams: ExperienceDefinition['teams'] = [];
  // Explicit "Red with !red" / "join Blue using !blue" pairs are unambiguous.
  const teamPattern =
    /\b(?:join\s+)?([a-z][a-z0-9_-]{0,31})\s+(?:team\s+)?(?:with|using|via)\s+(![a-z0-9_-]{1,32})\b/gi;
  for (const match of text.matchAll(teamPattern)) {
    const label = match[1];
    const joinCommand = match[2];
    if (!label || !joinCommand) continue;
    if (['tomatoes', 'hearts', 'stars', 'contribute', 'throw'].includes(label.toLowerCase()))
      continue;
    teams.push({
      id: label.toLowerCase(),
      label: label.charAt(0).toUpperCase() + label.slice(1),
      joinCommand: joinCommand.toLowerCase(),
    });
  }
  const commands = text.match(/![a-z0-9_-]{1,32}/gi)?.map((value) => value.toLowerCase()) ?? [];
  const command =
    commands.find((value) => !teams.some((team) => team.joinCommand === value)) ?? null;
  const hints = extractIntentHints(text);
  const resourceMatch = text.match(
    new RegExp(
      `${NUMBER}\\s+(throws?|contributions?|actions?|tokens?)\\s+(?:each|per\\s+(?:participant|viewer|person|user))`,
      'i',
    ),
  );
  const participantMatch = text.match(
    new RegExp(
      `(?:each|every)\\s+(?:participant|viewer|person|user)\\s+${NUMBER}\\s+(throws?|contributions?|actions?|tokens?)`,
      'i',
    ),
  );
  const targetMatch = text.match(
    new RegExp(`(?:goal|target)(?:\\s+(?:of|is|to))?\\s+${NUMBER}`, 'i'),
  );
  const countMatch = text.match(new RegExp(`${NUMBER}\\s+teams?`, 'i'));
  const resourceName = resourceMatch?.[2] ?? participantMatch?.[2] ?? null;
  return {
    requested,
    command,
    durationMs: hints.windowMs,
    resourceName: resourceName ? resourceName.toLowerCase().replace(/s?$/, 's') : null,
    perParticipant: numberOf(resourceMatch?.[1] ?? participantMatch?.[1]) ?? hints.maxPerViewer,
    teams: teams.length ? teams : cooperative ? [] : null,
    teamCount: numberOf(countMatch?.[1]),
    objective: cooperative ? 'collective-goal' : competitive ? 'highest-score' : null,
    target: numberOf(targetMatch?.[1]),
  };
}
