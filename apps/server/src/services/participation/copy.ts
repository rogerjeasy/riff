import {
  SESSION_LIMITS,
  type PermissionManifest,
  type ParticipationLanguage,
  type TwitchEventKind,
} from '@riff/sdk';

type Role = Exclude<PermissionManifest['trigger']['audience'][number], 'viewer'>;
type Unit = 'second' | 'minute';

/**
 * Host-reviewed sentence templates. Each language owns whole sentences (word order,
 * plurals, articles and punctuation), so no rule is assembled from English word order.
 * Creator-authored text (commands, team labels, resource names) is inserted unchanged.
 */
interface Templates {
  locale: string;
  everyone: string;
  /** Restricted audience, already pluralised and joined, e.g. "Only subscribers and moderators". */
  only: (roles: Role[]) => string;
  /** "{who}: type {command}". */
  type: (who: string, command: string) => string;
  /** "Then type {command}", used after a join line. */
  then: (command: string) => string;
  join: (who: string, teams: string) => string;
  /** Rolling stateless allowance: "{n} per viewer in any {window}". */
  rolling: (n: string, window: string) => string;
  unit: (value: number, text: string, unit: Unit) => string;
  perRound: (n: string, resource: string) => string;
  upTo: (max: number, text: string) => string;
  goal: (target: number, text: string) => string;
  highestTeam: string;
  together: string;
  free: string;
  trigger: string;
  community: string;
  goalReached: string;
  deadline: string;
  paused: string;
  running: string;
  finished: string;
}
const NB = ' ';
const list = (items: string[], and: string) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
const ROLE_ORDER: Role[] = ['subscriber', 'moderator', 'broadcaster'];
const sorted = (roles: Role[]) => ROLE_ORDER.filter((role) => roles.includes(role));

export const copy: Record<ParticipationLanguage, Templates> = {
  en: {
    locale: 'en-US',
    everyone: 'Everyone',
    only: (roles) =>
      `Only ${list(
        sorted(roles).map(
          (r) =>
            ({
              subscriber: 'subscribers',
              moderator: 'moderators',
              broadcaster: 'the broadcaster',
            })[r],
        ),
        'and',
      )}`,
    type: (who, command) => `${who}: type ${command}`,
    then: (command) => `Then type ${command}`,
    join: (who, teams) => `${who} · Join a team: ${teams}`,
    rolling: (n, window) => `${n} per viewer in any ${window}`,
    unit: (value, text, unit) => `${text} ${unit}${value === 1 ? '' : 's'}`,
    perRound: (n, resource) => `${n} ${resource} per player per round`,
    upTo: (max, text) => `Up to ${text} player${max === 1 ? '' : 's'}`,
    goal: (target, text) => `Goal: ${text} point${target === 1 ? '' : 's'} together`,
    highestTeam: 'Highest team score wins',
    together: 'Score as many points together as possible',
    free: 'Free: trigger the on-stream effect from chat',
    trigger: 'Trigger the on-stream effect from chat',
    community: 'Community',
    goalReached: 'Goal reached',
    deadline: 'Round ended',
    paused: 'Paused',
    running: 'Playing',
    finished: 'Finished',
  },
  fr: {
    locale: 'fr-FR',
    everyone: 'Tout le monde',
    only: (roles) =>
      `Réservé ${list(
        sorted(roles).map(
          (r) =>
            ({
              subscriber: 'aux abonnés',
              moderator: 'aux modérateurs',
              broadcaster: 'au créateur',
            })[r],
        ),
        'et',
      )}`,
    type: (who, command) => `${who}${NB}: tapez ${command}`,
    then: (command) => `Puis tapez ${command}`,
    join: (who, teams) => `${who} · Rejoignez une équipe${NB}: ${teams}`,
    rolling: (n, window) => `${n} par spectateur sur toute période de ${window}`,
    // French keeps the singular below 2 (1,5 seconde).
    unit: (value, text, unit) =>
      `${text} ${unit === 'second' ? 'seconde' : 'minute'}${value < 2 ? '' : 's'}`,
    perRound: (n, resource) => `${n} ${resource} par joueur et par manche`,
    upTo: (max, text) => `Jusqu’à ${text} joueur${max < 2 ? '' : 's'}`,
    goal: (target, text) => `Objectif${NB}: ${text} point${target < 2 ? '' : 's'} ensemble`,
    highestTeam: 'L’équipe au meilleur score gagne',
    together: 'Marquez ensemble un maximum de points',
    free: `Gratuit${NB}: déclenchez l’effet à l’écran depuis le chat`,
    trigger: 'Déclenchez l’effet à l’écran depuis le chat',
    community: 'Communauté',
    goalReached: 'Objectif atteint',
    deadline: 'Manche terminée',
    paused: 'En pause',
    running: 'En cours',
    finished: 'Terminé',
  },
  es: {
    locale: 'es-ES',
    everyone: 'Todos',
    only: (roles) =>
      `Solo ${list(
        sorted(roles).map(
          (r) =>
            ({ subscriber: 'suscriptores', moderator: 'moderadores', broadcaster: 'el creador' })[
              r
            ],
        ),
        'y',
      )}`,
    type: (who, command) => `${who}: escribe ${command}`,
    then: (command) => `Luego escribe ${command}`,
    join: (who, teams) => `${who} · Únete a un equipo: ${teams}`,
    rolling: (n, window) => `${n} por espectador en cualquier periodo de ${window}`,
    unit: (value, text, unit) =>
      `${text} ${unit === 'second' ? 'segundo' : 'minuto'}${value === 1 ? '' : 's'}`,
    perRound: (n, resource) => `${n} ${resource} por jugador y ronda`,
    upTo: (max, text) => `Hasta ${text} jugador${max === 1 ? '' : 'es'}`,
    goal: (target, text) => `Objetivo: ${text} punto${target === 1 ? '' : 's'} entre todos`,
    highestTeam: 'Gana el equipo con más puntos',
    together: 'Suma con todos el máximo de puntos posible',
    free: 'Gratis: activa el efecto en pantalla desde el chat',
    trigger: 'Activa el efecto en pantalla desde el chat',
    community: 'Comunidad',
    goalReached: 'Objetivo alcanzado',
    deadline: 'Ronda terminada',
    paused: 'En pausa',
    running: 'En juego',
    finished: 'Terminado',
  },
  de: {
    locale: 'de-DE',
    everyone: 'Alle',
    only: (roles) =>
      `Nur ${list(
        sorted(roles).map(
          (r) =>
            ({ subscriber: 'Abonnenten', moderator: 'Moderatoren', broadcaster: 'der Streamer' })[
              r
            ],
        ),
        'und',
      )}`,
    type: (who, command) => `${who}: schreibe ${command}`,
    then: (command) => `Dann schreibe ${command}`,
    join: (who, teams) => `${who} · Tritt einem Team bei: ${teams}`,
    rolling: (n, window) => `${n} pro Zuschauer in jedem Zeitraum von ${window}`,
    unit: (value, text, unit) =>
      `${text} ${unit === 'second' ? 'Sekunde' : 'Minute'}${value === 1 ? '' : 'n'}`,
    perRound: (n, resource) => `${n} ${resource} pro Person und Runde`,
    upTo: (max, text) => `Bis zu ${text} Person${max === 1 ? '' : 'en'}`,
    goal: (target, text) => `Ziel: ${text} Punkt${target === 1 ? '' : 'e'} gemeinsam`,
    highestTeam: 'Das Team mit den meisten Punkten gewinnt',
    together: 'Sammle mit allen so viele Punkte wie möglich',
    free: 'Kostenlos: Löse den Effekt im Stream über den Chat aus',
    trigger: 'Löse den Effekt im Stream über den Chat aus',
    community: 'Gemeinschaft',
    goalReached: 'Ziel erreicht',
    deadline: 'Runde beendet',
    paused: 'Pausiert',
    running: 'Läuft',
    finished: 'Beendet',
  },
};

const MAX_LINE = 200;
const TEAMS_PER_LINE = 4;

/** Translated wording of a phase or session outcome. */
export function phaseCopy(
  language: ParticipationLanguage,
  key: 'running' | 'paused' | 'finished' | 'goal' | 'deadline',
) {
  const c = copy[language];
  return key === 'goal' ? c.goalReached : c[key];
}

/** Public, truthful rule text for an approved manifest in one reviewed language. */
/** F19: localized guidance for Twitch event triggers; viewers cannot type these. */
const EVENT_COPY: Record<
  ParticipationLanguage,
  Record<TwitchEventKind, (minimum: number, n: string) => string>
> = {
  en: {
    subscribe: () => 'Subscribe to the channel',
    gift: (m, n) => (m > 1 ? `Gift ${n}+ subs` : 'Gift subs'),
    resub: (m, n) => (m > 1 ? `Share a resub of ${n}+ months` : 'Share your resub'),
    cheer: (_m, n) => `Cheer ${n}+ bits`,
    raid: (m, n) => (m > 1 ? `Raid with ${n}+ viewers` : 'Raid the channel'),
  },
  fr: {
    subscribe: () => 'Abonnez-vous à la chaîne',
    gift: (m, n) => (m > 1 ? `Offrez ${n}+ abonnements` : 'Offrez des abonnements'),
    resub: (m, n) =>
      m > 1 ? `Partagez ${n}+ mois de réabonnement` : 'Partagez votre réabonnement',
    cheer: (_m, n) => `Encouragez avec ${n}+ bits`,
    raid: (m, n) => (m > 1 ? `Lancez un raid de ${n}+ spectateurs` : 'Lancez un raid'),
  },
  es: {
    subscribe: () => 'Suscríbete al canal',
    gift: (m, n) => (m > 1 ? `Regala ${n}+ suscripciones` : 'Regala suscripciones'),
    resub: (m, n) => (m > 1 ? `Comparte ${n}+ meses de suscripción` : 'Comparte tu renovación'),
    cheer: (_m, n) => `Anima con ${n}+ bits`,
    raid: (m, n) => (m > 1 ? `Haz un raid con ${n}+ espectadores` : 'Haz un raid'),
  },
  de: {
    subscribe: () => 'Abonniere den Kanal',
    gift: (m, n) => (m > 1 ? `Verschenke ${n}+ Abos` : 'Verschenke Abos'),
    resub: (m, n) => (m > 1 ? `Teile ${n}+ Abo-Monate` : 'Teile dein Abo-Jubiläum'),
    cheer: (_m, n) => `Cheere ${n}+ Bits`,
    raid: (m, n) => (m > 1 ? `Raide mit ${n}+ Zuschauern` : 'Starte einen Raid'),
  },
};

export function ruleCopy(manifest: PermissionManifest, language: ParticipationLanguage) {
  const c = copy[language],
    t = manifest.trigger,
    e = manifest.experience,
    number = (value: number) => new Intl.NumberFormat(c.locale).format(value);
  const everyone = t.audience.includes('viewer');
  const who = everyone ? c.everyone : c.only(t.audience.filter((r): r is Role => r !== 'viewer'));
  const window = () => {
    const minutes = t.windowMs % 60000 === 0 && t.windowMs >= 120000;
    const value = minutes ? t.windowMs / 60000 : t.windowMs / 1000;
    return c.unit(value, number(value), minutes ? 'minute' : 'second');
  };
  const instructions: string[] = [];
  if (t.kind === 'twitch.event') {
    instructions.push(
      `${EVENT_COPY[language][t.event.kind](t.event.minimum, number(t.event.minimum))} · ${c.rolling(number(t.maxPerViewer), window())}`,
    );
    return { instructions: bounded(instructions), objective: c.free };
  }
  if (!e) {
    instructions.push(`${c.type(who, t.command)} · ${c.rolling(number(t.maxPerViewer), window())}`);
    return { instructions: bounded(instructions), objective: everyone ? c.free : c.trigger };
  }
  for (let i = 0; i < e.teams.length; i += TEAMS_PER_LINE) {
    const teams = e.teams.slice(i, i + TEAMS_PER_LINE);
    const line = c.join(who, teams.map((team) => `${team.label} ${team.joinCommand}`).join(' / '));
    // Keep executable commands whole; long creator labels are available with scores.
    instructions.push(
      line.length <= MAX_LINE
        ? line
        : c.join(who, teams.map((team) => team.joinCommand).join(' / ')),
    );
  }
  const contribution = [
    e.teams.length ? c.then(e.contribution.command) : c.type(who, e.contribution.command),
    c.perRound(number(e.resource.perParticipant), e.resource.name),
    ...(e.maxParticipants < SESSION_LIMITS.maxParticipants
      ? [c.upTo(e.maxParticipants, number(e.maxParticipants))]
      : []),
  ].join(' · ');
  instructions.push(contribution);
  const objective =
    e.objective.kind === 'collective-goal' && e.objective.target !== null
      ? c.goal(e.objective.target, number(e.objective.target))
      : e.teams.length
        ? c.highestTeam
        : c.together;
  return { instructions: bounded(instructions), objective };
}
function bounded(lines: string[]) {
  return lines.map((line) => line.slice(0, MAX_LINE)).slice(0, 3);
}
