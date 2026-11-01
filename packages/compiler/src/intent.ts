import {
  PROJECTILE_ASSETS,
  type AudienceRole,
  type ProjectileAsset,
  type ExperienceDefinition,
} from '@riff/sdk';

import { extractExperienceHints } from './experience-hints.js';
import { extractTimerHint, timerOfSource, type TimerHint } from './timer-hints.js';

/** Facts stated explicitly in the creator's words. Absent facts stay null. */
export interface IntentHints {
  command: string | null;
  maxPerViewer: number | null;
  windowMs: number | null;
  audience: AudienceRole[] | null;
  asset: ProjectileAsset | null;
}
export type IntentAspect =
  | 'command'
  | 'allowance'
  | 'window'
  | 'audience'
  | 'asset'
  | 'duration'
  | 'teams'
  | 'resource'
  | 'objective'
  | 'timer';
export interface IntentCheck {
  aspect: IntentAspect;
  label: string;
  /** What the creator said, in normalized form, or null when unstated. */
  stated: string | null;
  /** What the candidate will actually do. */
  actual: string;
  /** For edits: the active version's value. */
  previous: string | null;
  status: 'match' | 'mismatch' | 'assumed' | 'preserved' | 'changed';
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  once: 1,
  two: 2,
  twice: 2,
  three: 3,
  thrice: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};
const NUMBER = `\\b(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})\\b`;
const toNumber = (word: string) => NUMBER_WORDS[word.toLowerCase()] ?? Number(word);
const UNIT_MS: [RegExp, number][] = [
  [/^(?:s|sec|secs|second|seconds)$/i, 1000],
  [/^(?:m|min|mins|minute|minutes)$/i, 60_000],
  [/^(?:h|hr|hrs|hour|hours)$/i, 3_600_000],
];
const unitMs = (unit: string) => UNIT_MS.find(([pattern]) => pattern.test(unit))?.[1] ?? null;

/** Deterministic extraction of explicit facts. It never guesses; it only reads. */
export function extractIntentHints(intent: string): IntentHints {
  const text = intent.replace(/\s+/g, ' ');
  const command = text.match(/!([a-z0-9_-]{1,32})/i)?.[1]?.toLowerCase() ?? null;

  let windowMs: number | null = null;
  const words = Object.keys(NUMBER_WORDS).join('|');
  const duration =
    text.match(/\b(\d+(?:\.\d+)?)\s?-?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i) ??
    text.match(new RegExp(`\\b(${words})[ -](seconds?|secs?|minutes?|mins?|hours?|hrs?)\\b`, 'i'));
  if (duration?.[1] && duration[2]) {
    const unit = unitMs(duration[2]);
    if (unit) windowMs = Math.round(toNumber(duration[1]) * unit);
  } else {
    const unit = text.match(/\b(?:per|a|an|each|every)\s+(minute|hour|second)\b/i)?.[1];
    if (unit) windowMs = unitMs(unit);
  }

  let maxPerViewer: number | null = null;
  const allowance =
    text.match(
      new RegExp(
        `${NUMBER}\\s+(?:\\w+\\s+){0,2}?(?:per|each|every|a|an)\\s+(?:person|viewer|user|chatter|sub|subscriber|mod|moderator|people|one|${NUMBER}|seconds?|minutes?|hours?|min|rolling)`,
        'i',
      ),
    ) ??
    text.match(
      new RegExp(`(?:limit(?:ed)? to|at most|up to|max(?:imum)?(?: of)?)\\s+${NUMBER}`, 'i'),
    ) ??
    text.match(new RegExp(`\\b(once|twice|thrice)\\b`, 'i'));
  if (allowance?.[1]) {
    const value = toNumber(allowance[1]);
    if (Number.isInteger(value) && value > 0) maxPerViewer = value;
  }

  let audience: AudienceRole[] | null = null;
  if (
    /\b(?:subs|subscribers?)\b(?!\s+(?:also|too))/i.test(text) &&
    /\b(?:only|just|can|may|let)\b/i.test(text)
  )
    audience = ['subscriber'];
  if (/\b(?:mods|moderators?)\b/i.test(text) && /\bonly\b/i.test(text))
    audience = audience ? [...audience, 'moderator'] : ['moderator'];
  if (/\b(?:everyone(?![’']s)|anyone|all viewers|any viewer|whole chat)\b/i.test(text))
    audience = ['viewer'];
  else if (!audience && /\bviewers?\b/i.test(text)) audience = ['viewer'];

  let asset: ProjectileAsset | null = null;
  for (const candidate of PROJECTILE_ASSETS)
    if (new RegExp(`\\b${candidate}(?:e?s)?\\b`, 'i').test(text)) {
      asset = candidate;
      break;
    }
  return { command, maxPerViewer, windowMs, audience, asset };
}

export interface ManifestView {
  experience?: ExperienceDefinition | null;
  trigger: { command: string; audience: AudienceRole[]; maxPerViewer: number; windowMs: number };
}
export const describeWindow = (ms: number) =>
  ms % 3_600_000 === 0
    ? `${ms / 3_600_000} h`
    : ms % 60_000 === 0
      ? `${ms / 60_000} min`
      : `${ms / 1000} s`;
export const describeAudience = (roles: AudienceRole[]) =>
  roles.includes('viewer') ? 'everyone' : roles.map((role) => `${role}s`).join(', ');
export const describeTimer = (timer: TimerHint) =>
  `${timer.repeat ? 'every' : 'once after'} ${describeWindow(timer.ms)}`;
const sameAudience = (stated: AudienceRole[], actual: AudienceRole[]) =>
  stated.includes('viewer')
    ? actual.includes('viewer')
    : !actual.includes('viewer') && stated.every((role) => actual.includes(role));

/**
 * Compare explicit facts in the request with what will actually run. Unstated facts are
 * "assumed" for new interactions and must be "preserved" (or flagged) for edits.
 */
export function checkIntent(
  intent: string,
  candidate: { manifest: ManifestView; source: string },
  previous?: { manifest: ManifestView; source: string } | null,
): IntentCheck[] {
  const hints = extractIntentHints(intent);
  const sessionHints = extractExperienceHints(intent);
  if (sessionHints.additionalResources !== null && previous?.manifest.experience)
    sessionHints.perParticipant =
      previous.manifest.experience.resource.perParticipant + sessionHints.additionalResources;
  const experience = candidate.manifest.experience;
  const oldExperience = previous?.manifest.experience;
  const sessionRequest = sessionHints.requested || !!experience || !!oldExperience;
  if (sessionRequest) {
    hints.command = sessionHints.command?.slice(1) ?? hints.command;
    hints.maxPerViewer = sessionHints.perParticipant;
    hints.windowMs = null;
  }
  // "Every 10 minutes" or "in 60 seconds" names a host timer, never a rolling allowance.
  const statedTimer = extractTimerHint(intent);
  const actualTimer = timerOfSource(candidate.source);
  const previousTimer = previous ? timerOfSource(previous.source) : null;
  const timerRequest = !sessionRequest && (!!statedTimer || !!actualTimer || !!previousTimer);
  if (timerRequest && statedTimer && hints.windowMs === statedTimer.ms) hints.windowMs = null;
  const t = candidate.manifest.trigger;
  const p = previous?.manifest.trigger;
  const assetOf = (source: string) =>
    PROJECTILE_ASSETS.find(
      (asset) => source.includes(`'${asset}'`) || source.includes(`"${asset}"`),
    ) ?? null;
  const actualAsset = assetOf(candidate.source);
  const previousAsset = previous ? assetOf(previous.source) : null;
  const rows: [IntentAspect, string, string | null, string, string | null, boolean][] = [
    [
      'command',
      'Command',
      hints.command && `!${hints.command}`,
      t.command,
      p?.command ?? null,
      hints.command ? `!${hints.command}` === t.command : true,
    ],
    [
      'allowance',
      'Per-viewer allowance',
      hints.maxPerViewer?.toString() ?? null,
      String(t.maxPerViewer),
      p ? String(p.maxPerViewer) : null,
      hints.maxPerViewer ? hints.maxPerViewer === t.maxPerViewer : true,
    ],
    [
      'window',
      'Rolling window',
      hints.windowMs ? describeWindow(hints.windowMs) : null,
      describeWindow(t.windowMs),
      p ? describeWindow(p.windowMs) : null,
      hints.windowMs ? hints.windowMs === t.windowMs : true,
    ],
    [
      'audience',
      'Who can trigger it',
      hints.audience ? describeAudience(hints.audience) : null,
      describeAudience(t.audience),
      p ? describeAudience(p.audience) : null,
      hints.audience ? sameAudience(hints.audience, t.audience) : true,
    ],
    [
      'asset',
      'What appears',
      hints.asset,
      actualAsset ?? 'custom',
      previousAsset,
      hints.asset ? hints.asset === actualAsset : true,
    ],
  ];
  if (timerRequest)
    rows.push([
      'timer',
      'Named timer',
      statedTimer ? describeTimer(statedTimer) : null,
      actualTimer ? describeTimer(actualTimer) : 'no timer',
      previous ? (previousTimer ? describeTimer(previousTimer) : 'no timer') : null,
      statedTimer
        ? !!actualTimer &&
          actualTimer.ms === statedTimer.ms &&
          actualTimer.repeat === statedTimer.repeat
        : true,
    ]);
  if (sessionRequest) {
    // Rolling windows are not gameplay resources; compare canonical session facts instead.
    rows.splice(
      rows.findIndex(([aspect]) => aspect === 'window'),
      1,
    );
    const teamText = (teams: ExperienceDefinition['teams']) =>
      teams.length
        ? teams.map((team) => `${team.id} (${team.joinCommand})`).join(', ')
        : 'no teams';
    const resourceText = (definition: ExperienceDefinition) =>
      `${definition.resource.perParticipant} ${definition.resource.name} per participant per round`;
    const objectiveText = (definition: ExperienceDefinition) =>
      `${definition.objective.kind}${definition.objective.target === null ? '' : `: ${definition.objective.target}`}`;
    const statedTeams =
      sessionHints.teams !== null
        ? teamText(sessionHints.teams)
        : sessionHints.teamNames !== null
          ? sessionHints.teamNames.join(', ')
          : sessionHints.teamCount !== null
            ? `${sessionHints.teamCount} teams`
            : null;
    // Names without commands ("join red or blue") match ids or labels in any order.
    const sameNames = (names: string[], teams: ExperienceDefinition['teams']) =>
      names.length === teams.length &&
      names.every((name) =>
        teams.some((team) => team.id === name || team.label.toLowerCase() === name),
      );
    rows.push(
      [
        'duration',
        'Round duration',
        sessionHints.durationMs === null ? null : describeWindow(sessionHints.durationMs),
        experience ? describeWindow(experience.durationMs) : 'no session',
        oldExperience ? describeWindow(oldExperience.durationMs) : null,
        !!experience &&
          (sessionHints.durationMs === null || sessionHints.durationMs === experience.durationMs),
      ],
      [
        'teams',
        'Teams and join commands',
        statedTeams,
        experience ? teamText(experience.teams) : 'no session',
        oldExperience ? teamText(oldExperience.teams) : null,
        !!experience &&
          (sessionHints.teams === null ||
            teamText(sessionHints.teams) === teamText(experience.teams)) &&
          (sessionHints.teamNames === null ||
            sameNames(sessionHints.teamNames, experience.teams)) &&
          (sessionHints.teamCount === null || sessionHints.teamCount === experience.teams.length),
      ],
      [
        'resource',
        'Session resource allowance',
        sessionHints.perParticipant === null && sessionHints.resourceName === null
          ? null
          : `${sessionHints.perParticipant ?? '?'} ${sessionHints.resourceName ?? 'actions'} per participant per round`,
        experience ? resourceText(experience) : 'no session',
        oldExperience ? resourceText(oldExperience) : null,
        !!experience &&
          (sessionHints.perParticipant === null ||
            sessionHints.perParticipant === experience.resource.perParticipant) &&
          (sessionHints.resourceName === null ||
            sessionHints.resourceName === experience.resource.name),
      ],
      [
        'objective',
        'Session objective',
        sessionHints.objective === null && sessionHints.target === null
          ? null
          : `${sessionHints.objective ?? 'goal'}${sessionHints.target === null ? '' : `: ${sessionHints.target}`}`,
        experience ? objectiveText(experience) : 'no session',
        oldExperience ? objectiveText(oldExperience) : null,
        !!experience &&
          (sessionHints.objective === null ||
            sessionHints.objective === experience.objective.kind) &&
          (sessionHints.target === null || sessionHints.target === experience.objective.target),
      ],
    );
  }
  return rows.map(([aspect, label, stated, actual, before, agrees]) => ({
    aspect,
    label,
    stated,
    actual,
    previous: before,
    status:
      stated !== null
        ? agrees
          ? 'match'
          : 'mismatch'
        : previous
          ? before === actual
            ? 'preserved'
            : 'changed'
          : 'assumed',
  }));
}
