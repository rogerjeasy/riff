/*
 * Host-reviewed viewer copy for session HUDs and the stream scoreboard (F40). Each language
 * owns whole phrases with `{name}` placeholders, so no sentence is assembled from English
 * word order. Plural-sensitive phrases carry `one`/`other` forms chosen by the locale's
 * plural rules. Creator-authored text (titles, team labels, commands, mechanic labels) is
 * inserted unchanged. The language is chosen by the host (broadcast setting, a viewer's
 * explicit `!riff help <language>` or the recipe language), never by the overlay itself.
 */

export type SessionLanguage = 'en' | 'fr' | 'es' | 'de';
export const SESSION_LANGUAGES: readonly SessionLanguage[] = ['en', 'fr', 'es', 'de'];
type Phrase = string | { one: string; other: string };

/** Engine rejection codes a viewer can meet through version 2 mechanics. */
export const MECHANICS_REASONS = [
  'ELIMINATED',
  'LOCKED',
  'HEALTH_FULL',
  'BURST_COUNTED',
  'BURST_ACTIVE',
  'BURST_LIMIT',
  'ROUND_INTERMISSION',
] as const;
export type MechanicsReason = (typeof MECHANICS_REASONS)[number];
/** Engine rejection codes a viewer can meet through version 3 formats. */
export const FORMAT_REASONS = [
  'INVALID_CHOICE',
  'ALREADY_CHOSEN',
  'CELL_TAKEN',
  'ANSWER_CLOSED',
] as const;
export type FormatReason = (typeof FORMAT_REASONS)[number];

const NB = ' ';

const en = {
  locale: 'en-US',
  seconds: '{n} s',
  community: 'Community',
  phaseRunning: 'Running',
  phasePaused: 'Paused',
  phaseFinished: 'Finished',
  clockLeft: '{clock} left',
  pausedClock: 'Paused · {clock} left',
  roundOver: 'Round over',
  sessionLabel: '{title} session',
  participants: '{count} / {max} participants · {per} {resource} each per round',
  viewerResource: {
    one: '{left} of {per} {resource} left · {contributions} contribution',
    other: '{left} of {per} {resource} left · {contributions} contributions',
  },
  join: '{command} joins {team}',
  rulesTeams: {
    one: '{joins}. Then {command} · {points} point per contribution.',
    other: '{joins}. Then {command} · {points} points per contribution.',
  },
  rulesTeamless: {
    one: 'Join in with {command} · {points} point per contribution.',
    other: 'Join in with {command} · {points} points per contribution.',
  },
  goalRule: {
    one: 'Reach {target} point together.',
    other: 'Reach {target} points together.',
  },
  highestRule: 'Highest team score wins.',
  lastStandingRule: 'Last team standing wins.',
  burstGoalRule: {
    one: 'Trigger {label} once to win.',
    other: 'Trigger {label} {target} times to win.',
  },
  teamsFixed: 'Teams stay fixed for this round.',
  burstRule: '{participants} different viewers using {command} within {window} trigger {label}',
  burstShieldClause: ', which blocks damage for {time}',
  burstPointsClause: { one: ' (+{points} point)', other: ' (+{points} points)' },
  healthRule: 'Each team has {max} {label}; {command} deals {damage} to every other team',
  healClause: ', {command} heals {amount}',
  eliminationRule: '. At 0 a team is eliminated.',
  milestoneRule: { one: '{score} point unlocks {label}.', other: '{score} points unlock {label}.' },
  milestoneUnlockRule: {
    one: '{score} point unlocks {label} and {command} (+{points}).',
    other: '{score} points unlock {label} and {command} (+{points}).',
  },
  matchRule: 'Best of {rounds}: every round starts fresh.',
  roundStatus: 'Round {round} of {rounds} · best of {rounds} · wins: {wins}',
  nextRound: 'Next round starts in {time}',
  healthMeter: '{side} {label}',
  healthValue: '{side} {label} {value} / {max}',
  sideEliminated: '{side} eliminated',
  burstMeter: '{side} {label} progress',
  burstUp: '{label} up · {time} left',
  burstUsed: '{label} used {used} / {limit}',
  burstProgress: '{side} {label}: {count} / {needed} different viewers',
  burstWindow: 'window {time}',
  milestones: '{side} milestones',
  tierUnlocked: 'Unlocked · {label} at {score}',
  tierLocked: 'Locked · {label} at {score}',
  outcomeLastStanding: 'Last team standing',
  outcomeBurst: '{label} triggered',
  outcomeGoal: 'Goal reached',
  outcomeTimeUp: 'Time is up',
  outcomeTie: '{outcome} · Tie',
  outcomeWinner: '{outcome} · {team} wins!',
  outcomeFinished: '{outcome} · Round finished',
  communityWins: 'Community wins!',
  matchTie: 'Match over · tie {wins}',
  matchWinner: 'Match over · {team} wins {wins}!',
  matchOver: 'Match over · {wins}',
  lineRound: 'Round {round}/{rounds}',
  lineRoundIn: 'Round {round}/{rounds} in {time}',
  lineOut: 'out',
  lineHealth: '{value}/{max} hp',
  lineBurstUp: '{label} up',
  lineBurst: '{label} {count}/{needed}',
  lineTier: 'tier {tier}',
  celebrationTie: 'Round complete · tie',
  celebrationWinner: '{team} wins!',
  celebrationEliminated: 'Last team standing · {team} wins!',
  celebrationDone: 'Round complete',
  viewerStatus: 'Why commands may be ignored',
  ELIMINATED: 'Your team is eliminated this round',
  LOCKED: {
    one: '{command} unlocks at {score} point',
    other: '{command} unlocks at {score} points',
  },
  HEALTH_FULL: '{label} is already full',
  BURST_COUNTED: 'You already count toward {label}',
  BURST_ACTIVE: '{label} is already active',
  BURST_LIMIT: '{label} is used up for this round',
  ROUND_INTERMISSION: 'Between rounds: wait for the next round',
  INVALID_CHOICE: 'Pick one of the listed choices',
  ALREADY_CHOSEN: 'You already chose for this stage',
  CELL_TAKEN: 'That cell is already painted',
  ANSWER_CLOSED: 'Answers are closed during the reveal',
  muralRule: 'Paint with {command} cell color, e.g. {example}. Colors: {colors}.',
  muralFinalRule: 'Painted cells are final.',
  muralCanvas: 'Mural, {width} by {height}: {painted} of {cells} cells painted',
  muralHidden: 'Mural hidden until the reveal · {painted} of {cells} cells painted',
  muralReveal: 'Reveal! {painted} of {cells} cells painted together',
  stageRule:
    'Vote with {command} and an option name or number, once per stage. Ties go to the first listed option.',
  stageStatus: 'Stage {stage} of {stages}: {label}',
  stageOption: {
    one: '{number}. {label} · {votes} vote',
    other: '{number}. {label} · {votes} votes',
  },
  compositionTitle: 'Our composition (shown, not played)',
  compositionPart: '{stage}: {option}',
  compositionPending: '{stage}: voting…',
  quizRule:
    'Answer with {commands}, once per question. A question is solved together when {percent}% answer correctly.',
  questionStatus: 'Question {question} of {questions}',
  answerOption: '{command} {label} · {count}',
  answersClose: 'Answers close in {time}',
  revealAnswer: 'Answer: {command} {label}',
  revealSolved: 'Solved together · {percent}% correct',
  revealMissed: 'Not solved this time · {percent}% correct',
  quizSummary: 'Solved together: {solved} of {questions}',
  linePainted: '{painted}/{cells} painted',
  lineStage: 'Stage {stage}/{stages}',
  lineQuestion: 'Q {question}/{questions}',
} satisfies Record<string, Phrase>;
export type SessionCopyKey = Exclude<keyof typeof en, 'locale'>;
type Copy = { locale: string } & Record<SessionCopyKey, Phrase>;

const fr: Copy = {
  locale: 'fr-FR',
  seconds: `{n}${NB}s`,
  community: 'Communauté',
  phaseRunning: 'En cours',
  phasePaused: 'En pause',
  phaseFinished: 'Terminé',
  clockLeft: 'encore {clock}',
  pausedClock: 'En pause · encore {clock}',
  roundOver: 'Manche terminée',
  sessionLabel: 'Session {title}',
  participants: '{count} / {max} participants · {per} {resource} chacun par manche',
  viewerResource: {
    one: 'Il vous reste {left} {resource} sur {per} · {contributions} contribution',
    other: 'Il vous reste {left} {resource} sur {per} · {contributions} contributions',
  },
  join: '{command} pour rejoindre {team}',
  rulesTeams: {
    one: '{joins}. Puis {command} · {points} point par contribution.',
    other: '{joins}. Puis {command} · {points} points par contribution.',
  },
  rulesTeamless: {
    one: 'Participez avec {command} · {points} point par contribution.',
    other: 'Participez avec {command} · {points} points par contribution.',
  },
  goalRule: {
    one: 'Atteignez ensemble {target} point.',
    other: 'Atteignez ensemble {target} points.',
  },
  highestRule: 'L’équipe au meilleur score gagne.',
  lastStandingRule: 'La dernière équipe en lice gagne.',
  burstGoalRule: {
    one: 'Déclenchez {label} une fois pour gagner.',
    other: 'Déclenchez {label} {target} fois pour gagner.',
  },
  teamsFixed: 'Les équipes ne changent pas pendant cette manche.',
  burstRule:
    '{participants} spectateurs différents qui utilisent {command} en {window} déclenchent {label}',
  burstShieldClause: ', qui bloque les dégâts pendant {time}',
  burstPointsClause: { one: ' (+{points} point)', other: ' (+{points} points)' },
  healthRule: `Chaque équipe a {max} de {label}${NB}; {command} inflige {damage} à chaque équipe adverse`,
  healClause: ', {command} soigne de {amount}',
  eliminationRule: '. À 0, une équipe est éliminée.',
  milestoneRule: {
    one: '{score} point débloque {label}.',
    other: '{score} points débloquent {label}.',
  },
  milestoneUnlockRule: {
    one: '{score} point débloque {label} et {command} (+{points}).',
    other: '{score} points débloquent {label} et {command} (+{points}).',
  },
  matchRule: `Au meilleur des {rounds} manches${NB}: chaque manche repart de zéro.`,
  roundStatus: `Manche {round} sur {rounds} · au meilleur des {rounds} · victoires${NB}: {wins}`,
  nextRound: 'Prochaine manche dans {time}',
  healthMeter: '{label} de {side}',
  healthValue: `{label} de {side}${NB}: {value} / {max}`,
  sideEliminated: 'Équipe {side} éliminée',
  burstMeter: 'Progression de {label} pour {side}',
  burstUp: '{label} actif · encore {time}',
  burstUsed: '{label} utilisé {used} / {limit}',
  burstProgress: `{label} pour {side}${NB}: {count} / {needed} spectateurs différents`,
  burstWindow: `fenêtre${NB}: {time}`,
  milestones: 'Paliers de {side}',
  tierUnlocked: 'Débloqué · {label} à {score}',
  tierLocked: 'Verrouillé · {label} à {score}',
  outcomeLastStanding: 'Dernière équipe en lice',
  outcomeBurst: '{label} déclenché',
  outcomeGoal: 'Objectif atteint',
  outcomeTimeUp: 'Temps écoulé',
  outcomeTie: '{outcome} · Égalité',
  outcomeWinner: `{outcome} · {team} gagne${NB}!`,
  outcomeFinished: '{outcome} · Manche terminée',
  communityWins: `La communauté gagne${NB}!`,
  matchTie: 'Fin du match · égalité {wins}',
  matchWinner: `Fin du match · {team} gagne {wins}${NB}!`,
  matchOver: 'Fin du match · {wins}',
  lineRound: 'Manche {round}/{rounds}',
  lineRoundIn: 'Manche {round}/{rounds} dans {time}',
  lineOut: 'éliminée',
  lineHealth: '{value}/{max} PV',
  lineBurstUp: '{label} actif',
  lineBurst: '{label} {count}/{needed}',
  lineTier: 'palier {tier}',
  celebrationTie: 'Manche terminée · égalité',
  celebrationWinner: `{team} gagne${NB}!`,
  celebrationEliminated: `Dernière équipe en lice · {team} gagne${NB}!`,
  celebrationDone: 'Manche terminée',
  viewerStatus: 'Pourquoi des commandes peuvent être ignorées',
  ELIMINATED: 'Votre équipe est éliminée pour cette manche',
  LOCKED: {
    one: '{command} se débloque à {score} point',
    other: '{command} se débloque à {score} points',
  },
  HEALTH_FULL: '{label} est déjà au maximum',
  BURST_COUNTED: 'Vous comptez déjà pour {label}',
  BURST_ACTIVE: '{label} est déjà actif',
  BURST_LIMIT: '{label} est épuisé pour cette manche',
  ROUND_INTERMISSION: `Entre deux manches${NB}: attendez la suivante`,
  INVALID_CHOICE: 'Choisissez une des options proposées',
  ALREADY_CHOSEN: 'Vous avez déjà choisi pour cette étape',
  CELL_TAKEN: 'Cette case est déjà peinte',
  ANSWER_CLOSED: 'Les réponses sont fermées pendant la révélation',
  muralRule: `Peignez avec {command} case couleur, p. ex. {example}. Couleurs${NB}: {colors}.`,
  muralFinalRule: 'Une case peinte est définitive.',
  muralCanvas: `Fresque de {width} sur {height}${NB}: {painted} cases peintes sur {cells}`,
  muralHidden: 'Fresque cachée jusqu’à la révélation · {painted} cases peintes sur {cells}',
  muralReveal: `Révélation${NB}! {painted} cases peintes ensemble sur {cells}`,
  stageRule:
    'Votez avec {command} et le nom ou le numéro d’une option, une fois par étape. En cas d’égalité, la première option listée l’emporte.',
  stageStatus: `Étape {stage} sur {stages}${NB}: {label}`,
  stageOption: {
    one: '{number}. {label} · {votes} vote',
    other: '{number}. {label} · {votes} votes',
  },
  compositionTitle: 'Notre composition (affichée, non jouée)',
  compositionPart: `{stage}${NB}: {option}`,
  compositionPending: `{stage}${NB}: vote en cours…`,
  quizRule: `Répondez avec {commands}, une fois par question. Une question est résolue ensemble quand {percent}${NB}% des réponses sont justes.`,
  questionStatus: 'Question {question} sur {questions}',
  answerOption: '{command} {label} · {count}',
  answersClose: 'Fin des réponses dans {time}',
  revealAnswer: `Réponse${NB}: {command} {label}`,
  revealSolved: `Résolue ensemble · {percent}${NB}% de bonnes réponses`,
  revealMissed: `Pas résolue cette fois · {percent}${NB}% de bonnes réponses`,
  quizSummary: `Résolues ensemble${NB}: {solved} sur {questions}`,
  linePainted: '{painted}/{cells} peintes',
  lineStage: 'Étape {stage}/{stages}',
  lineQuestion: 'Q {question}/{questions}',
};

const es: Copy = {
  locale: 'es-ES',
  seconds: '{n} s',
  community: 'Comunidad',
  phaseRunning: 'En juego',
  phasePaused: 'En pausa',
  phaseFinished: 'Terminado',
  clockLeft: 'quedan {clock}',
  pausedClock: 'En pausa · quedan {clock}',
  roundOver: 'Ronda terminada',
  sessionLabel: 'Sesión {title}',
  participants: '{count} / {max} participantes · {per} {resource} por persona y ronda',
  viewerResource: {
    one: 'Te quedan {left} de {per} {resource} · {contributions} aportación',
    other: 'Te quedan {left} de {per} {resource} · {contributions} aportaciones',
  },
  join: '{command} para unirte a {team}',
  rulesTeams: {
    one: '{joins}. Luego {command} · {points} punto por aportación.',
    other: '{joins}. Luego {command} · {points} puntos por aportación.',
  },
  rulesTeamless: {
    one: 'Participa con {command} · {points} punto por aportación.',
    other: 'Participa con {command} · {points} puntos por aportación.',
  },
  goalRule: {
    one: 'Llegad entre todos a {target} punto.',
    other: 'Llegad entre todos a {target} puntos.',
  },
  highestRule: 'Gana el equipo con más puntos.',
  lastStandingRule: 'Gana el último equipo en pie.',
  burstGoalRule: {
    one: 'Activa {label} una vez para ganar.',
    other: 'Activa {label} {target} veces para ganar.',
  },
  teamsFixed: 'Los equipos no cambian durante esta ronda.',
  burstRule: '{participants} espectadores distintos que usen {command} en {window} activan {label}',
  burstShieldClause: ', que bloquea el daño durante {time}',
  burstPointsClause: { one: ' (+{points} punto)', other: ' (+{points} puntos)' },
  healthRule: 'Cada equipo tiene {max} de {label}; {command} quita {damage} a cada equipo rival',
  healClause: ', {command} cura {amount}',
  eliminationRule: '. Con 0, un equipo queda eliminado.',
  milestoneRule: {
    one: 'Con {score} punto se desbloquea {label}.',
    other: 'Con {score} puntos se desbloquea {label}.',
  },
  milestoneUnlockRule: {
    one: 'Con {score} punto se desbloquean {label} y {command} (+{points}).',
    other: 'Con {score} puntos se desbloquean {label} y {command} (+{points}).',
  },
  matchRule: 'Al mejor de {rounds} rondas: cada ronda empieza de cero.',
  roundStatus: 'Ronda {round} de {rounds} · al mejor de {rounds} · victorias: {wins}',
  nextRound: 'La siguiente ronda empieza en {time}',
  healthMeter: '{label} de {side}',
  healthValue: '{label} de {side}: {value} / {max}',
  sideEliminated: 'Equipo {side} eliminado',
  burstMeter: 'Progreso de {label} de {side}',
  burstUp: '{label} activo · quedan {time}',
  burstUsed: '{label} usado {used} / {limit}',
  burstProgress: '{label} de {side}: {count} / {needed} espectadores distintos',
  burstWindow: 'ventana: {time}',
  milestones: 'Hitos de {side}',
  tierUnlocked: 'Desbloqueado · {label} con {score}',
  tierLocked: 'Bloqueado · {label} con {score}',
  outcomeLastStanding: 'Último equipo en pie',
  outcomeBurst: '{label} activado',
  outcomeGoal: 'Objetivo alcanzado',
  outcomeTimeUp: 'Se acabó el tiempo',
  outcomeTie: '{outcome} · Empate',
  outcomeWinner: '{outcome} · ¡Gana {team}!',
  outcomeFinished: '{outcome} · Ronda terminada',
  communityWins: '¡Gana la comunidad!',
  matchTie: 'Fin del partido · empate {wins}',
  matchWinner: 'Fin del partido · ¡Gana {team} {wins}!',
  matchOver: 'Fin del partido · {wins}',
  lineRound: 'Ronda {round}/{rounds}',
  lineRoundIn: 'Ronda {round}/{rounds} en {time}',
  lineOut: 'eliminado',
  lineHealth: '{value}/{max} PS',
  lineBurstUp: '{label} activo',
  lineBurst: '{label} {count}/{needed}',
  lineTier: 'nivel {tier}',
  celebrationTie: 'Ronda terminada · empate',
  celebrationWinner: '¡Gana {team}!',
  celebrationEliminated: 'Último equipo en pie · ¡Gana {team}!',
  celebrationDone: 'Ronda terminada',
  viewerStatus: 'Por qué se pueden ignorar comandos',
  ELIMINATED: 'Tu equipo está eliminado en esta ronda',
  LOCKED: {
    one: '{command} se desbloquea al llegar a {score} punto',
    other: '{command} se desbloquea al llegar a {score} puntos',
  },
  HEALTH_FULL: '{label} ya está al máximo',
  BURST_COUNTED: 'Ya cuentas para {label}',
  BURST_ACTIVE: '{label} ya está activo',
  BURST_LIMIT: '{label} está agotado en esta ronda',
  ROUND_INTERMISSION: 'Entre rondas: espera a la siguiente',
  INVALID_CHOICE: 'Elige una de las opciones indicadas',
  ALREADY_CHOSEN: 'Ya elegiste en esta etapa',
  CELL_TAKEN: 'Esa casilla ya está pintada',
  ANSWER_CLOSED: 'Las respuestas están cerradas durante la revelación',
  muralRule: 'Pinta con {command} casilla color, p. ej. {example}. Colores: {colors}.',
  muralFinalRule: 'Las casillas pintadas son definitivas.',
  muralCanvas: 'Mural de {width} por {height}: {painted} de {cells} casillas pintadas',
  muralHidden: 'Mural oculto hasta la revelación · {painted} de {cells} casillas pintadas',
  muralReveal: '¡Revelación! {painted} de {cells} casillas pintadas entre todos',
  stageRule:
    'Vota con {command} y el nombre o número de una opción, una vez por etapa. Los empates se los lleva la primera opción de la lista.',
  stageStatus: 'Etapa {stage} de {stages}: {label}',
  stageOption: {
    one: '{number}. {label} · {votes} voto',
    other: '{number}. {label} · {votes} votos',
  },
  compositionTitle: 'Nuestra composición (se muestra, no suena)',
  compositionPart: '{stage}: {option}',
  compositionPending: '{stage}: votando…',
  quizRule:
    'Responde con {commands}, una vez por pregunta. Una pregunta se resuelve entre todos cuando el {percent} % acierta.',
  questionStatus: 'Pregunta {question} de {questions}',
  answerOption: '{command} {label} · {count}',
  answersClose: 'Las respuestas se cierran en {time}',
  revealAnswer: 'Respuesta: {command} {label}',
  revealSolved: 'Resuelta entre todos · {percent} % de aciertos',
  revealMissed: 'No resuelta esta vez · {percent} % de aciertos',
  quizSummary: 'Resueltas entre todos: {solved} de {questions}',
  linePainted: '{painted}/{cells} pintadas',
  lineStage: 'Etapa {stage}/{stages}',
  lineQuestion: 'P {question}/{questions}',
};

const de: Copy = {
  locale: 'de-DE',
  seconds: '{n} s',
  community: 'Gemeinschaft',
  phaseRunning: 'Läuft',
  phasePaused: 'Pausiert',
  phaseFinished: 'Beendet',
  clockLeft: 'noch {clock}',
  pausedClock: 'Pausiert · noch {clock}',
  roundOver: 'Runde beendet',
  sessionLabel: 'Sitzung {title}',
  participants: '{count} / {max} Teilnehmende · je {per} {resource} pro Runde',
  viewerResource: {
    one: 'Noch {left} von {per} {resource} · {contributions} Beitrag',
    other: 'Noch {left} von {per} {resource} · {contributions} Beiträge',
  },
  join: '{command} bringt dich zu {team}',
  rulesTeams: {
    one: '{joins}. Dann {command} · {points} Punkt pro Beitrag.',
    other: '{joins}. Dann {command} · {points} Punkte pro Beitrag.',
  },
  rulesTeamless: {
    one: 'Mach mit: {command} · {points} Punkt pro Beitrag.',
    other: 'Mach mit: {command} · {points} Punkte pro Beitrag.',
  },
  goalRule: {
    one: 'Erreicht gemeinsam {target} Punkt.',
    other: 'Erreicht gemeinsam {target} Punkte.',
  },
  highestRule: 'Das Team mit den meisten Punkten gewinnt.',
  lastStandingRule: 'Das letzte verbleibende Team gewinnt.',
  burstGoalRule: {
    one: 'Löse {label} einmal aus, um zu gewinnen.',
    other: 'Löse {label} {target}-mal aus, um zu gewinnen.',
  },
  teamsFixed: 'Die Teams bleiben in dieser Runde fest.',
  burstRule:
    '{participants} verschiedene Zuschauer, die innerhalb von {window} {command} nutzen, lösen {label} aus',
  burstShieldClause: ', das {time} lang Schaden blockt',
  burstPointsClause: { one: ' (+{points} Punkt)', other: ' (+{points} Punkte)' },
  healthRule: 'Jedes Team hat {max} {label}; {command} zieht jedem anderen Team {damage} ab',
  healClause: ', {command} heilt um {amount}',
  eliminationRule: '. Bei 0 scheidet ein Team aus.',
  milestoneRule: {
    one: '{score} Punkt schaltet {label} frei.',
    other: '{score} Punkte schalten {label} frei.',
  },
  milestoneUnlockRule: {
    one: '{score} Punkt schaltet {label} und {command} (+{points}) frei.',
    other: '{score} Punkte schalten {label} und {command} (+{points}) frei.',
  },
  matchRule: 'Best of {rounds}: Jede Runde beginnt von vorn.',
  roundStatus: 'Runde {round} von {rounds} · Best of {rounds} · Siege: {wins}',
  nextRound: 'Nächste Runde startet in {time}',
  healthMeter: '{side}: {label}',
  healthValue: '{side}: {label} {value} / {max}',
  sideEliminated: 'Team {side} ist ausgeschieden',
  burstMeter: '{side}: Fortschritt {label}',
  burstUp: '{label} aktiv · noch {time}',
  burstUsed: '{label} genutzt {used} / {limit}',
  burstProgress: '{side}: {label} {count} / {needed} verschiedene Zuschauer',
  burstWindow: 'Fenster: {time}',
  milestones: 'Meilensteine von {side}',
  tierUnlocked: 'Freigeschaltet · {label} ab {score}',
  tierLocked: 'Gesperrt · {label} ab {score}',
  outcomeLastStanding: 'Letztes Team im Spiel',
  outcomeBurst: '{label} ausgelöst',
  outcomeGoal: 'Ziel erreicht',
  outcomeTimeUp: 'Zeit abgelaufen',
  outcomeTie: '{outcome} · Unentschieden',
  outcomeWinner: '{outcome} · {team} gewinnt!',
  outcomeFinished: '{outcome} · Runde beendet',
  communityWins: 'Die Gemeinschaft gewinnt!',
  matchTie: 'Match vorbei · Unentschieden {wins}',
  matchWinner: 'Match vorbei · {team} gewinnt {wins}!',
  matchOver: 'Match vorbei · {wins}',
  lineRound: 'Runde {round}/{rounds}',
  lineRoundIn: 'Runde {round}/{rounds} in {time}',
  lineOut: 'raus',
  lineHealth: '{value}/{max} LP',
  lineBurstUp: '{label} aktiv',
  lineBurst: '{label} {count}/{needed}',
  lineTier: 'Stufe {tier}',
  celebrationTie: 'Runde beendet · Unentschieden',
  celebrationWinner: '{team} gewinnt!',
  celebrationEliminated: 'Letztes Team im Spiel · {team} gewinnt!',
  celebrationDone: 'Runde beendet',
  viewerStatus: 'Warum Befehle ignoriert werden können',
  ELIMINATED: 'Dein Team ist in dieser Runde ausgeschieden',
  LOCKED: {
    one: '{command} wird ab {score} Punkt freigeschaltet',
    other: '{command} wird ab {score} Punkten freigeschaltet',
  },
  HEALTH_FULL: '{label} ist bereits voll',
  BURST_COUNTED: 'Du zählst schon für {label}',
  BURST_ACTIVE: '{label} ist schon aktiv',
  BURST_LIMIT: '{label} ist für diese Runde aufgebraucht',
  ROUND_INTERMISSION: 'Zwischen den Runden: Warte auf die nächste Runde',
  INVALID_CHOICE: 'Wähle eine der angezeigten Optionen',
  ALREADY_CHOSEN: 'Du hast für diese Etappe schon gewählt',
  CELL_TAKEN: 'Dieses Feld ist schon bemalt',
  ANSWER_CLOSED: 'Während der Auflösung sind Antworten geschlossen',
  muralRule: 'Male mit {command} Feld Farbe, z. B. {example}. Farben: {colors}.',
  muralFinalRule: 'Bemalte Felder bleiben endgültig.',
  muralCanvas: 'Wandbild, {width} mal {height}: {painted} von {cells} Feldern bemalt',
  muralHidden: 'Wandbild bis zur Enthüllung verborgen · {painted} von {cells} Feldern bemalt',
  muralReveal: 'Enthüllung! {painted} von {cells} Feldern gemeinsam bemalt',
  stageRule:
    'Stimme mit {command} und dem Namen oder der Nummer einer Option ab, einmal pro Etappe. Bei Gleichstand gewinnt die zuerst genannte Option.',
  stageStatus: 'Etappe {stage} von {stages}: {label}',
  stageOption: {
    one: '{number}. {label} · {votes} Stimme',
    other: '{number}. {label} · {votes} Stimmen',
  },
  compositionTitle: 'Unsere Komposition (angezeigt, nicht abgespielt)',
  compositionPart: '{stage}: {option}',
  compositionPending: '{stage}: Abstimmung läuft…',
  quizRule:
    'Antworte mit {commands}, einmal pro Frage. Eine Frage gilt gemeinsam als gelöst, wenn {percent} % richtig antworten.',
  questionStatus: 'Frage {question} von {questions}',
  answerOption: '{command} {label} · {count}',
  answersClose: 'Antworten schließen in {time}',
  revealAnswer: 'Antwort: {command} {label}',
  revealSolved: 'Gemeinsam gelöst · {percent} % richtig',
  revealMissed: 'Diesmal nicht gelöst · {percent} % richtig',
  quizSummary: 'Gemeinsam gelöst: {solved} von {questions}',
  linePainted: '{painted}/{cells} bemalt',
  lineStage: 'Etappe {stage}/{stages}',
  lineQuestion: 'F {question}/{questions}',
};

export const SESSION_COPY: Record<SessionLanguage, Copy> = { en, fr, es, de };

export function isSessionLanguage(value: unknown): value is SessionLanguage {
  return typeof value === 'string' && (SESSION_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Fill one reviewed phrase. Numbers are formatted for the locale; `count` picks the plural
 * form. Placeholder values are inserted as plain text (callers render via textContent).
 */
export function sessionText(
  language: SessionLanguage,
  key: SessionCopyKey,
  values: Record<string, string | number> = {},
  count?: number,
): string {
  const copy = SESSION_COPY[language] ?? SESSION_COPY.en;
  const phrase = copy[key];
  const template =
    typeof phrase === 'string'
      ? phrase
      : new Intl.PluralRules(copy.locale).select(count ?? 0) === 'one'
        ? phrase.one
        : phrase.other;
  const format = new Intl.NumberFormat(copy.locale);
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : typeof value === 'number' ? format.format(value) : value;
  });
}

/** Rounded-up seconds in the language's short unit ("10 s", "10 s" with a French NBSP). */
export function sessionSeconds(language: SessionLanguage, ms: number): string {
  return sessionText(language, 'seconds', { n: Math.max(0, Math.ceil(ms / 1000)) });
}

/** Viewer-facing explanation for a version 2 rejection code. */
export function mechanicsReason(
  language: SessionLanguage,
  code: MechanicsReason,
  values: { label?: string; command?: string; score?: number } = {},
): string {
  return sessionText(language, code, values, values.score);
}
