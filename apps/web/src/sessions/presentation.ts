import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import './presentation.css';
import {
  appendMechanics,
  mechanicsOutcome,
  mechanicsRules,
  objectiveRule,
  viewerReasons,
} from './mechanics-hud.js';
import { sessionText, type SessionCopyKey, type SessionLanguage } from './mechanics-copy.js';
import { appendFormat, formatOutcome, formatRules, formatViewerReasons } from './formats-hud.js';

export function sameDefinition(
  a: ExperienceDefinition | null | undefined,
  b: ExperienceDefinition | null | undefined,
): boolean {
  // Field order from JSON producers need not match; compare the public fields explicitly.
  const canonical = (value: ExperienceDefinition | null | undefined) =>
    value
      ? [
          value.version,
          value.title,
          value.durationMs,
          value.maxParticipants,
          value.teams.map((team) => [team.id, team.label, team.joinCommand]),
          value.resource.name,
          value.resource.perParticipant,
          value.contribution.command,
          value.contribution.points,
          value.objective.kind,
          value.objective.target,
          mechanicsKey(value.mechanics),
          mechanicsKey(value.format),
        ]
      : null;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Order-independent comparison key for version 2 mechanics (null for version 1). */
function mechanicsKey(
  value: ExperienceDefinition['mechanics'] | ExperienceDefinition['format'],
): string | null {
  const sorted = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(sorted)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, sorted((input as Record<string, unknown>)[key])]),
          )
        : input;
  return value ? JSON.stringify(sorted(value)) : null;
}
function element(
  tag: 'section' | 'h3' | 'p' | 'span' | 'div' | 'ul' | 'li',
  className: string,
  text?: string,
) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/** Shared, text-only HUD: both private rehearsal and OBS read the canonical definition. */
export function createSessionHud(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  options: {
    now?: number;
    viewerId?: string;
    label?: string;
    /** Reviewed viewer language (F40); creator-authored labels stay unchanged. */
    language?: SessionLanguage;
    /** Broadcast reduced motion; the CSS media query applies regardless. */
    reducedMotion?: boolean;
  } = {},
): HTMLElement {
  const language = options.language ?? 'en',
    now = options.now ?? snapshot.updatedAt;
  const t = (key: SessionCopyKey, values: Record<string, string | number> = {}, count?: number) =>
    sessionText(language, key, values, count);
  const hud = element('section', 'session-hud');
  // Distinct names keep landmarks unique when a rehearsal and a live round are both shown.
  hud.setAttribute('aria-label', options.label ?? t('sessionLabel', { title: definition.title }));
  hud.lang = language;
  hud.dataset.phase = snapshot.phase;
  if (options.reducedMotion) hud.dataset.reducedMotion = 'true';
  const remaining =
    snapshot.phase === 'running' && snapshot.deadlineAt !== null
      ? Math.max(0, snapshot.deadlineAt - now)
      : snapshot.remainingMs;
  const seconds = Math.ceil(remaining / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const phase = t(
    ({ running: 'phaseRunning', paused: 'phasePaused', finished: 'phaseFinished' } as const)[
      snapshot.phase
    ],
  );
  const header = element('div', 'session-heading');
  header.append(
    element('h3', 'session-title', definition.title),
    element('span', 'session-phase', `${phase} · ${clock}`),
  );
  hud.append(header);
  const scores = element('div', 'session-scores');
  const entries = definition.teams.length
    ? definition.teams
    : [{ id: 'community', label: t('community') }];
  for (const team of entries)
    scores.append(
      element(
        'span',
        'session-score',
        `${team.label}: ${Object.hasOwn(snapshot.scores, team.id) ? snapshot.scores[team.id] : 0}${definition.objective.target !== null ? ` / ${definition.objective.target}` : ''}`,
      ),
    );
  hud.append(scores);
  appendMechanics(hud, definition, snapshot, now, language);
  appendFormat(hud, definition, snapshot, now, language);
  const resource = {
    per: definition.resource.perParticipant,
    resource: definition.resource.name,
  };
  hud.append(
    element(
      'p',
      'session-context',
      t('participants', {
        count: Object.keys(snapshot.participants).length,
        max: definition.maxParticipants,
        ...resource,
      }),
    ),
  );
  if (options.viewerId && Object.hasOwn(snapshot.participants, options.viewerId)) {
    const participant = snapshot.participants[options.viewerId];
    if (participant)
      hud.append(
        element(
          'p',
          'session-resource',
          t(
            'viewerResource',
            { left: participant.remaining, contributions: participant.contributions, ...resource },
            participant.contributions,
          ),
        ),
      );
    const reasons = [
      ...viewerReasons(definition, snapshot, options.viewerId, now, language),
      ...formatViewerReasons(definition, snapshot, options.viewerId, now, language),
    ];
    if (reasons.length) {
      const status = element('ul', 'session-viewer-status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-label', t('viewerStatus'));
      for (const reason of reasons) status.append(element('li', 'session-viewer-reason', reason));
      hud.append(status);
    }
  }
  const joins = definition.teams
    .map((team) => t('join', { command: team.joinCommand, team: team.label }))
    .join(' · ');
  const points = definition.contribution.points;
  const command = definition.contribution.command;
  hud.append(
    element(
      'p',
      'session-rules',
      (definition.format
        ? [formatRules(definition, language)]
        : [
            joins
              ? t('rulesTeams', { joins, command, points }, points)
              : t('rulesTeamless', { command, points }, points),
            objectiveRule(definition, language),
            joins ? t('teamsFixed') : '',
            mechanicsRules(definition, language),
          ]
      )
        .filter(Boolean)
        .join(' '),
    ),
  );
  const v2Outcome =
    mechanicsOutcome(definition, snapshot, language) ??
    formatOutcome(definition, snapshot, language);
  if (v2Outcome) hud.append(element('p', 'session-outcome', v2Outcome));
  else if (snapshot.phase === 'finished') {
    const winner = definition.teams.find((team) => team.id === snapshot.winner)?.label;
    const outcome =
      snapshot.outcome === 'goal'
        ? `${t('outcomeGoal')} · ${t('communityWins')}`
        : snapshot.winner === 'tie'
          ? t('outcomeTie', { outcome: t('outcomeTimeUp') })
          : winner
            ? t('outcomeWinner', { outcome: t('outcomeTimeUp'), team: winner })
            : t('outcomeFinished', { outcome: t('outcomeTimeUp') });
    hud.append(element('p', 'session-outcome', outcome));
  }
  return hud;
}
