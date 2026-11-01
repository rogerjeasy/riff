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
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
};
const NUMBER =
  '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)';
const NOUN =
  '(throws?|tomatoes|hearts?|stars?|contributions?|actions?|tokens?|turns?|attempts?|tries|votes?)';
const WHO = '(?:participant|viewer|person|user|player|chatter|one)';
const NOT_A_TEAM = new Set(['the', 'a', 'an', 'team', 'teams', 'either', 'one', 'side']);
const numberOf = (value: string | undefined) =>
  value ? (WORDS[value.toLowerCase()] ?? Number(value)) : null;

export interface ExperienceHints {
  requested: boolean;
  command: string | null;
  durationMs: number | null;
  resourceName: string | null;
  perParticipant: number | null;
  additionalResources: number | null;
  teams: ExperienceDefinition['teams'] | null;
  /** Team names stated without join commands, e.g. "join red or blue". */
  teamNames: string[] | null;
  teamCount: number | null;
  objective: ExperienceDefinition['objective']['kind'] | null;
  target: number | null;
  /** Version 2 mechanics stated explicitly; null fields were not mentioned. */
  mechanics: MechanicHints;
}
export interface MechanicHints {
  /** True when the text names any version 2 primitive, even one that was not fully parsed. */
  mentioned: boolean;
  burst: {
    participants: number;
    windowMs: number;
    command: string | null;
    protects: boolean;
  } | null;
  health: {
    max: number;
    damage: number | null;
    heal: { command: string; amount: number } | null;
  } | null;
  match: { rounds: number; intermissionMs: number | null } | null;
  milestones: { score: number; command: string | null; points: number | null }[];
  shieldMs: number | null;
}
const SECONDS = '(?:s|secs?|seconds?)';
const PEOPLE =
  '(?:different|distinct|unique|separate)\\s+(?:viewers|people|chatters|players|teammates|participants|members)';
/** Read version 2 primitives conservatively; anything ambiguous stays null. */
export function extractMechanicHints(intent: string): { hints: MechanicHints; rest: string } {
  let rest = intent.replace(/\s+/g, ' ');
  const take = (pattern: RegExp) => {
    const match = rest.match(pattern);
    if (match) rest = rest.replace(match[0], ' ');
    return match;
  };
  const mentioned =
    /\b(?:health|hp|damage|heal\w*|eliminat\w*|unlock\w*|milestones?|tiers?|best of|rounds|different (?:viewers|people|chatters|players|teammates))\b/i.test(
      rest,
    );
  const burstMatch = take(
    new RegExp(
      `${NUMBER}\\s+${PEOPLE}\\s+(?:all\\s+)?(?:type|use|send|say|typing|using|sending)?\\s*(![a-z0-9_-]{1,32})?\\s*(?:within|in|inside)\\s+(?:the\\s+same\\s+)?${NUMBER}\\s*${SECONDS}`,
      'i',
    ),
  );
  const shieldFor = take(
    new RegExp(`(?:protects?|shields?)\\s+(?:\\w+\\s+){0,3}?for\\s+${NUMBER}\\s*${SECONDS}`, 'i'),
  );
  const healthMatch = take(new RegExp(`${NUMBER}\\s+(?:health|hp|hit points)\\b`, 'i'));
  const damageMatch = take(new RegExp(`${NUMBER}\\s+damage\\b`, 'i'));
  const healMatch =
    take(new RegExp(`(![a-z0-9_-]{1,32})\\s+(?:heals|restores|repairs)\\s+${NUMBER}`, 'i')) ??
    take(
      new RegExp(
        `heals?\\s+${NUMBER}\\s+(?:health|hp)?\\s*(?:with|using|via)\\s+(![a-z0-9_-]{1,32})`,
        'i',
      ),
    );
  const bestOf = take(new RegExp(`best\\s+of\\s+${NUMBER}(?:\\s+rounds?)?`, 'i'));
  const roundsMatch = bestOf ? null : take(new RegExp(`${NUMBER}\\s+rounds\\b`, 'i'));
  const breakMatch = take(
    new RegExp(
      `${NUMBER}\\s*-?${SECONDS}\\s+(?:break|intermission|pause)\\s+between\\s+rounds`,
      'i',
    ),
  );
  const milestones: MechanicHints['milestones'] = [];
  const unlockPattern = new RegExp(
    `(?:at|reach(?:es|ing)?|after)\\s+${NUMBER}\\s+points?\\s*,?\\s*(?:to\\s+)?unlocks?\\s+(?:a\\s+|the\\s+)?(?:(![a-z0-9_-]{1,32})|(?:bigger|stronger|new|next)\\s+(?:effect\\s+)?tier)(?:\\s+(?:worth|for|that\\s+scores?)\\s+${NUMBER}\\s+points?)?`,
    'gi',
  );
  for (const match of rest.matchAll(unlockPattern))
    milestones.push({
      score: numberOf(match[1]) ?? 0,
      command: match[2]?.toLowerCase() ?? null,
      points: numberOf(match[3]),
    });
  rest = rest.replace(unlockPattern, ' ');
  const healCommand = healMatch
    ? healMatch[1]?.startsWith('!')
      ? healMatch[1]
      : healMatch[2]
    : null;
  const healAmount = healMatch
    ? numberOf(healMatch[1]?.startsWith('!') ? healMatch[2] : healMatch[1])
    : null;
  return {
    rest,
    hints: {
      mentioned,
      burst: burstMatch
        ? {
            participants: numberOf(burstMatch[1]) ?? 0,
            command: burstMatch[2]?.toLowerCase() ?? null,
            windowMs: (numberOf(burstMatch[3]) ?? 0) * 1000,
            protects: /\b(?:protects?|shields?|blocks?)\b/i.test(intent),
          }
        : null,
      health: healthMatch
        ? {
            max: numberOf(healthMatch[1]) ?? 0,
            damage: numberOf(damageMatch?.[1]),
            heal:
              healCommand && healAmount !== null
                ? { command: healCommand.toLowerCase(), amount: healAmount }
                : null,
          }
        : null,
      match:
        bestOf || roundsMatch
          ? {
              rounds: numberOf((bestOf ?? roundsMatch)?.[1]) ?? 0,
              intermissionMs: breakMatch ? (numberOf(breakMatch[1]) ?? 0) * 1000 : null,
            }
          : null,
      milestones,
      shieldMs: shieldFor ? (numberOf(shieldFor[1]) ?? 0) * 1000 : null,
    },
  };
}

/** Conservative, independent reading of the bounded session primitives in creator text. */
export function extractExperienceHints(intent: string): ExperienceHints {
  // Mechanic phrases ("within 10 seconds") must not be read as round facts.
  const { hints: mechanics, rest } = extractMechanicHints(intent);
  const text = rest.replace(/\s+/g, ' ');
  const requested =
    mechanics.mentioned ||
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
    if (
      [
        'tomatoes',
        'hearts',
        'stars',
        'contribute',
        'throw',
        'battle',
        'game',
        'round',
        'goal',
        'session',
      ].includes(label.toLowerCase())
    )
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
  // "3 throws each", "each gets three throws", "every viewer has 3 hearts", "hearts, three each".
  const resourcePatterns = [
    `${NUMBER}\\s+${NOUN}\\s+(?:each|apiece|per\\s+${WHO})`,
    `(?:each|every)\\s+${WHO}\\s+${NUMBER}\\s+${NOUN}`,
    `(?:each|every\\s+${WHO})\\s+(?:gets?|has|have|receives?|can\\s+(?:make|use|throw|send))\\s+${NUMBER}\\s+${NOUN}`,
  ];
  let perParticipant: number | null = null;
  let resourceName: string | null = null;
  for (const pattern of resourcePatterns) {
    const match = text.match(new RegExp(pattern, 'i'));
    if (match) {
      [perParticipant, resourceName] = [numberOf(match[1]), match[2] ?? null];
      break;
    }
  }
  const additional = text.match(
    new RegExp(`${NUMBER}\\s+(?:additional|more|extra)\\s+${NOUN}`, 'i'),
  );
  const additionalResources = numberOf(additional?.[1]);
  const trailing = text.match(
    new RegExp(`${NOUN}\\s*,?\\s+${NUMBER}\\s+(?:each|apiece|per\\s+${WHO})`, 'i'),
  );
  if (perParticipant === null && trailing)
    [perParticipant, resourceName] = [numberOf(trailing[2]), trailing[1] ?? null];
  const targetMatch =
    text.match(new RegExp(`(?:goal|target)(?:\\s+(?:of|is|to))?\\s+${NUMBER}`, 'i')) ??
    // Only cooperative goals have a points target; "first to 10" is not a supported battle rule.
    (cooperative
      ? text.match(new RegExp(`(?:at|reach(?:es|ing)?|hits?|to)\\s+${NUMBER}\\s+points`, 'i'))
      : null);
  const teamNames = teams.length ? null : statedTeamNames(text);
  const countMatch = text.match(new RegExp(`${NUMBER}\\s+teams?`, 'i'));
  return {
    requested,
    command,
    durationMs: hints.windowMs,
    resourceName: resourceName ? resourceName.toLowerCase().replace(/s?$/, 's') : null,
    perParticipant: additionalResources === null ? (perParticipant ?? hints.maxPerViewer) : null,
    additionalResources,
    teams: teams.length ? teams : cooperative ? [] : null,
    teamNames,
    teamCount: numberOf(countMatch?.[1]),
    objective: cooperative ? 'collective-goal' : competitive ? 'highest-score' : null,
    target: numberOf(targetMatch?.[1]),
    mechanics,
  };
}

/** "join red or blue", "teams red and blue", "red vs blue", "red and blue teams". */
function statedTeamNames(text: string): string[] | null {
  const name = '(?:team\\s+)?([a-z][a-z0-9_-]{0,31})';
  const patterns = [
    `\\bjoin\\s+(?:either\\s+)?(?:the\\s+)?${name}((?:\\s*,\\s*${name})*)\\s*,?\\s+(?:or|and)\\s+${name}`,
    `\\bteams?\\s+${name}((?:\\s*,\\s*${name})*)\\s*,?\\s+(?:and|or|vs\\.?|versus)\\s+${name}`,
    `\\b${name}((?:\\s*,\\s*${name})*)\\s*,?\\s+(?:vs\\.?|versus)\\s+${name}`,
    `\\b${name}((?:\\s*,\\s*${name})*)\\s*,?\\s+(?:and|or)\\s+${name}\\s+teams\\b`,
  ];
  for (const pattern of patterns) {
    const match = text.match(new RegExp(pattern, 'i'));
    if (!match) continue;
    const middle = (match[2] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^team\s+/i, ''))
      .filter(Boolean);
    const names = [match[1], ...middle, match[match.length - 1]]
      .filter((value): value is string => !!value)
      .map((value) => value.toLowerCase());
    if (names.length >= 2 && names.every((value) => !NOT_A_TEAM.has(value)))
      return [...new Set(names)];
  }
  return null;
}
