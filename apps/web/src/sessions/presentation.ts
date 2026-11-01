import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import './presentation.css';
import { appendMechanics, mechanicsOutcome, mechanicsRules } from './mechanics-hud.js';

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
        ]
      : null;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Order-independent comparison key for version 2 mechanics (null for version 1). */
function mechanicsKey(value: ExperienceDefinition['mechanics']): string | null {
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
function element(tag: 'section' | 'h3' | 'p' | 'span' | 'div', className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/** Shared, text-only HUD: both private rehearsal and OBS read the canonical definition. */
export function createSessionHud(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  options: { now?: number; viewerId?: string; label?: string } = {},
): HTMLElement {
  const hud = element('section', 'session-hud');
  // Distinct names keep landmarks unique when a rehearsal and a live round are both shown.
  hud.setAttribute('aria-label', options.label ?? `${definition.title} session`);
  hud.dataset.phase = snapshot.phase;
  const remaining =
    snapshot.phase === 'running' && snapshot.deadlineAt !== null
      ? Math.max(0, snapshot.deadlineAt - (options.now ?? snapshot.updatedAt))
      : snapshot.remainingMs;
  const seconds = Math.ceil(remaining / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const phase = { running: 'Running', paused: 'Paused', finished: 'Finished' }[snapshot.phase];
  const header = element('div', 'session-heading');
  header.append(
    element('h3', 'session-title', definition.title),
    element('span', 'session-phase', `${phase} · ${clock}`),
  );
  hud.append(header);
  const scores = element('div', 'session-scores');
  const entries = definition.teams.length
    ? definition.teams
    : [{ id: 'community', label: 'Community' }];
  for (const team of entries)
    scores.append(
      element(
        'span',
        'session-score',
        `${team.label}: ${Object.hasOwn(snapshot.scores, team.id) ? snapshot.scores[team.id] : 0}${definition.objective.target !== null ? ` / ${definition.objective.target}` : ''}`,
      ),
    );
  hud.append(scores);
  appendMechanics(hud, definition, snapshot, options.now ?? snapshot.updatedAt);
  const count = Object.keys(snapshot.participants).length;
  hud.append(
    element(
      'p',
      'session-context',
      `${count} / ${definition.maxParticipants} participants · ${definition.resource.perParticipant} ${definition.resource.name} each per round`,
    ),
  );
  if (options.viewerId && Object.hasOwn(snapshot.participants, options.viewerId)) {
    const participant = snapshot.participants[options.viewerId];
    if (participant)
      hud.append(
        element(
          'p',
          'session-resource',
          `${participant.remaining} of ${definition.resource.perParticipant} ${definition.resource.name} left · ${participant.contributions} contributions`,
        ),
      );
  }
  const joins = definition.teams
    .map((team) => `${team.joinCommand} joins ${team.label}`)
    .join(' · ');
  hud.append(
    element(
      'p',
      'session-rules',
      `${joins ? `${joins}. Then ` : 'Join in with '}${definition.contribution.command} · ${definition.contribution.points} point${definition.contribution.points === 1 ? '' : 's'} per contribution. ${definition.objective.kind === 'collective-goal' ? `Reach ${definition.objective.target} points together.` : definition.objective.kind === 'burst' ? `Trigger ${definition.mechanics?.burst?.label ?? 'the burst'} ${definition.objective.target === 1 ? 'once' : `${definition.objective.target} times`} to win.` : definition.mechanics?.health ? 'Last team standing wins.' : 'Highest team score wins.'} ${joins ? 'Teams stay fixed for this round.' : ''} ${mechanicsRules(definition)}`.trim(),
    ),
  );
  const v2Outcome = mechanicsOutcome(definition, snapshot);
  if (v2Outcome) hud.append(element('p', 'session-outcome', v2Outcome));
  else if (snapshot.phase === 'finished') {
    const winner = definition.teams.find((team) => team.id === snapshot.winner)?.label;
    const outcome =
      snapshot.outcome === 'goal'
        ? 'Goal reached · Community wins!'
        : snapshot.winner === 'tie'
          ? 'Time is up · Tie'
          : winner
            ? `Time is up · ${winner} wins!`
            : 'Time is up · Round finished';
    hud.append(element('p', 'session-outcome', outcome));
  }
  return hud;
}
