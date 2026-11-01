import type { RecipePackage, RecipePresentation, RecipeProfile } from '@riff/sdk';

type Language = RecipeProfile['language'];
const EVERYONE: Record<Language, string> = {
  en: 'Everyone',
  fr: 'Tout le monde',
  es: 'Todos',
  de: 'Alle',
};
const TYPE_COMMAND: Record<Language, (who: string, command: string) => string> = {
  en: (who, command) => `${who}: type ${command}`,
  fr: (who, command) => `${who} : tapez ${command}`,
  es: (who, command) => `${who}: escribe ${command}`,
  de: (who, command) => `${who}: schreibe ${command}`,
};
const JOIN_TEAM: Record<Language, string> = {
  en: 'Join a team',
  fr: 'Rejoignez une équipe',
  es: 'Únete a un equipo',
  de: 'Team beitreten',
};
const PER_ROUND: Record<Language, string> = {
  en: 'per round',
  fr: 'par manche',
  es: 'por ronda',
  de: 'pro Runde',
};
const TEAMS_PER_LINE = 4;
const MAX_LINES = 4;
const MAX_LINE_LENGTH = 200;

/** Translated on-stream guidance for an installed recipe, from the recipient's profile. */
export function presentationFor(
  profile: Pick<RecipeProfile, 'language' | 'reducedMotion' | 'displayName'>,
  manifest: RecipePackage['manifest'],
): RecipePresentation {
  const { language, displayName } = profile;
  const { trigger, experience } = manifest;
  const who = trigger.audience.includes('viewer')
    ? EVERYONE[language]
    : trigger.audience.join(', ');
  const lines = experience
    ? [`${displayName} · ${experience.title}`]
    : [
        `${displayName} · ${TYPE_COMMAND[language](who, trigger.command)} · ${trigger.maxPerViewer} / ${trigger.windowMs / 1000}s`,
      ];
  if (experience) {
    for (let start = 0; start < experience.teams.length; start += TEAMS_PER_LINE)
      lines.push(
        `${JOIN_TEAM[language]}: ${experience.teams
          .slice(start, start + TEAMS_PER_LINE)
          .map((team) => team.joinCommand)
          .join(' / ')}`,
      );
    lines.push(
      `${experience.contribution.command} · ${experience.resource.perParticipant} ${experience.resource.name} ${PER_ROUND[language]}`,
    );
  }
  return {
    language,
    reducedMotion: profile.reducedMotion,
    instructions: lines.slice(0, MAX_LINES).map((line) => line.slice(0, MAX_LINE_LENGTH)),
  };
}

/** The adaptation request given to the compiler. Facts come first so its parser reads them. */
export function adaptationIntent(profile: RecipeProfile) {
  const audience = profile.audience.includes('viewer')
    ? 'Everyone can use it.'
    : `Only ${profile.audience.map((role) => `${role}s`).join(' and ')} can use it.`;
  return [
    `Use command ${profile.command}.`,
    audience,
    `Allow at most ${profile.maxPerViewer} per viewer per ${profile.windowMs / 1000} seconds.`,
    `This adapts a public recipe for the channel named “${profile.displayName}”.`,
    'Preserve the source license and semantics except these explicit changes.',
  ].join(' ');
}
