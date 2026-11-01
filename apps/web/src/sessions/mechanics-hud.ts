import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';

/*
 * Text-first presentation of definition version 2 state for the shared session HUD and
 * the stream scoreboard. Everything is derived from host-validated canonical state; no
 * viewer text is rendered and all values are set through textContent or attributes.
 */

function node(tag: 'div' | 'p' | 'span' | 'ul' | 'li', className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
const seconds = (ms: number) => `${Math.max(0, Math.ceil(ms / 1000))} s`;
function sides(definition: ExperienceDefinition) {
  return definition.teams.length
    ? definition.teams.map((team) => ({ id: team.id, label: team.label }))
    : [{ id: 'community', label: 'Community' }];
}
/** Logical time for countdowns: frozen while paused or finished. */
function clockOf(snapshot: SessionSnapshot, now: number) {
  return snapshot.phase === 'running' ? Math.max(now, snapshot.updatedAt) : snapshot.updatedAt;
}
/** Remaining break before the next round starts, or 0 while a round is open. */
export function intermissionLeft(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  now: number,
): number {
  if (!definition.mechanics?.match || snapshot.phase === 'finished') return 0;
  const remaining =
    snapshot.phase === 'running' && snapshot.deadlineAt !== null
      ? snapshot.deadlineAt - clockOf(snapshot, now)
      : snapshot.remainingMs;
  return Math.max(0, remaining - definition.durationMs);
}
/** Distinct viewers still inside the sliding burst window at `now`. */
export function burstCount(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  side: string,
  now: number,
): { count: number; closesInMs: number | null; shieldMs: number } {
  const burst = definition.mechanics?.burst;
  const standing = snapshot.mechanics?.standings[side];
  if (!burst || !standing) return { count: 0, closesInMs: null, shieldMs: 0 };
  const at = clockOf(snapshot, now);
  const live = standing.burstWindow.filter((entry) => entry.at > at - burst.windowMs);
  const oldest = live[0];
  return {
    count: live.length,
    closesInMs: oldest ? oldest.at + burst.windowMs - at : null,
    shieldMs: standing.shieldUntil !== null ? Math.max(0, standing.shieldUntil - at) : 0,
  };
}
function meter(label: string, value: number, max: number, text: string, tone: string) {
  const wrap = node('div', `session-meter session-meter-${tone}`);
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-label', label);
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', String(max));
  wrap.setAttribute('aria-valuenow', String(Math.min(max, Math.max(0, value))));
  wrap.setAttribute('aria-valuetext', text);
  const track = node('span', 'session-meter-track');
  const fill = node('span', 'session-meter-fill');
  // Transform-only fill keeps overlay updates off the layout path.
  fill.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, value / max)) : 0})`;
  track.append(fill);
  wrap.append(node('span', 'session-meter-label', text), track);
  return wrap;
}

/** Plain-language rule summary for version 2 mechanics (empty for version 1). */
export function mechanicsRules(definition: ExperienceDefinition): string {
  const m = definition.mechanics;
  if (!m) return '';
  const parts: string[] = [];
  if (m.burst)
    parts.push(
      `${m.burst.participants} different viewers using ${m.burst.command ?? definition.contribution.command} within ${seconds(m.burst.windowMs)} trigger ${m.burst.label}${m.burst.shieldMs ? `, which blocks damage for ${seconds(m.burst.shieldMs)}` : ''}${m.burst.points ? ` (+${m.burst.points} points)` : ''}.`,
    );
  if (m.health)
    parts.push(
      `Each team has ${m.health.max} ${m.health.label.toLowerCase()}; ${definition.contribution.command} deals ${m.health.damage} to every other team${m.health.heal ? `, ${m.health.heal.command} heals ${m.health.heal.amount}` : ''}. At 0 a team is eliminated.`,
    );
  for (const milestone of m.milestones)
    parts.push(
      `${milestone.score} points unlock ${milestone.label}${milestone.unlock ? ` and ${milestone.unlock.command} (+${milestone.unlock.points})` : ''}.`,
    );
  if (m.match) parts.push(`Best of ${m.match.rounds}: every round starts fresh.`);
  return parts.join(' ');
}

/** Append round, health, burst and tier panels to a HUD container. */
export function appendMechanics(
  hud: HTMLElement,
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  now: number,
) {
  const m = definition.mechanics,
    state = snapshot.mechanics;
  if (!m || !state) return;
  const section = node('div', 'session-mechanics');
  if (m.match) {
    const wins = sides(definition)
      .map((side) => `${side.label} ${state.wins[side.id] ?? 0}`)
      .join(' · ');
    const round = node(
      'p',
      'session-round',
      `Round ${state.round} of ${m.match.rounds} · best of ${m.match.rounds} · wins: ${wins}`,
    );
    section.append(round);
    const left = intermissionLeft(definition, snapshot, now);
    if (left > 0) {
      const next = node('p', 'session-intermission', `Next round starts in ${seconds(left)}`);
      next.setAttribute('role', 'status');
      section.append(next);
    }
  }
  const list = node('div', 'session-pools');
  for (const side of sides(definition)) {
    const standing = state.standings[side.id];
    if (!standing) continue;
    const row = node('div', 'session-pool');
    row.dataset.eliminated = String(standing.eliminated);
    if (m.health && standing.health !== null)
      row.append(
        meter(
          `${side.label} ${m.health.label}`,
          standing.health,
          m.health.max,
          standing.eliminated
            ? `${side.label} eliminated`
            : `${side.label} ${m.health.label.toLowerCase()} ${standing.health} / ${m.health.max}`,
          standing.eliminated ? 'out' : standing.health * 4 <= m.health.max ? 'low' : 'health',
        ),
      );
    if (m.burst) {
      const burst = burstCount(definition, snapshot, side.id, now);
      const limitReached = standing.bursts >= m.burst.limit;
      const text =
        burst.shieldMs > 0
          ? `${m.burst.label} up · ${seconds(burst.shieldMs)} left`
          : limitReached
            ? `${m.burst.label} used ${standing.bursts} / ${m.burst.limit}`
            : `${side.label} ${m.burst.label}: ${burst.count} / ${m.burst.participants} different viewers${burst.closesInMs !== null ? ` · window ${seconds(burst.closesInMs)}` : ''}`;
      row.append(
        meter(
          `${side.label} ${m.burst.label} progress`,
          burst.shieldMs > 0 ? m.burst.participants : burst.count,
          m.burst.participants,
          text,
          burst.shieldMs > 0 ? 'shield' : 'burst',
        ),
      );
    }
    if (m.milestones.length) {
      const tiers = node('ul', 'session-tiers');
      tiers.setAttribute('aria-label', `${side.label} milestones`);
      for (const milestone of m.milestones) {
        const reached = standing.unlocked.includes(milestone.id);
        const item = node(
          'li',
          'session-tier',
          `${reached ? 'Unlocked' : 'Locked'} · ${milestone.label} at ${milestone.score}${milestone.unlock ? ` · ${milestone.unlock.command}` : ''}`,
        );
        item.dataset.reached = String(reached);
        tiers.append(item);
      }
      row.append(tiers);
    }
    if (row.childElementCount) list.append(row);
  }
  if (list.childElementCount) section.append(list);
  hud.append(section);
}

/** Outcome sentence for finished version 2 sessions; null defers to the version 1 text. */
export function mechanicsOutcome(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
): string | null {
  const m = definition.mechanics;
  if (!m || snapshot.phase !== 'finished') return null;
  const label =
    snapshot.winner === 'community'
      ? 'Community'
      : definition.teams.find((team) => team.id === snapshot.winner)?.label;
  const prefix =
    snapshot.outcome === 'elimination'
      ? 'Last team standing'
      : snapshot.outcome === 'goal'
        ? definition.objective.kind === 'burst'
          ? `${m.burst?.label ?? 'Burst'} triggered`
          : 'Goal reached'
        : 'Time is up';
  if (m.match) {
    const wins = sides(definition)
      .map((side) => snapshot.mechanics?.wins[side.id] ?? 0)
      .join('–');
    return snapshot.winner === 'tie'
      ? `Match over · tie ${wins}`
      : label
        ? `Match over · ${label} wins ${wins}!`
        : `Match over · ${wins}`;
  }
  return snapshot.winner === 'tie'
    ? `${prefix} · Tie`
    : label
      ? `${prefix} · ${label} wins!`
      : `${prefix} · Round finished`;
}

/** Compact one-line stream lines for the scene scoreboard. */
export function mechanicsLines(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  now: number,
): string[] {
  const m = definition.mechanics,
    state = snapshot.mechanics;
  if (!m || !state) return [];
  const lines: string[] = [];
  if (m.match) {
    const left = intermissionLeft(definition, snapshot, now);
    lines.push(
      left > 0
        ? `Round ${state.round}/${m.match.rounds} in ${seconds(left)}`
        : `Round ${state.round}/${m.match.rounds}`,
    );
  }
  for (const side of sides(definition)) {
    const standing = state.standings[side.id];
    if (!standing) continue;
    const parts: string[] = [];
    if (m.health && standing.health !== null)
      parts.push(standing.eliminated ? 'out' : `${standing.health}/${m.health.max} hp`);
    if (m.burst) {
      const burst = burstCount(definition, snapshot, side.id, now);
      parts.push(
        burst.shieldMs > 0
          ? `${m.burst.label} up`
          : `${m.burst.label} ${burst.count}/${m.burst.participants}`,
      );
    }
    if (m.milestones.length) parts.push(`tier ${standing.unlocked.length}`);
    if (parts.length) lines.push(`${side.label}: ${parts.join(' · ')}`);
  }
  return lines;
}
