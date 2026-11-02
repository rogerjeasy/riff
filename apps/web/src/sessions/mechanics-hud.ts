import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import {
  mechanicsReason,
  sessionSeconds,
  sessionText,
  type SessionLanguage,
} from './mechanics-copy.js';

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
function sides(definition: ExperienceDefinition, language: SessionLanguage) {
  return definition.teams.length
    ? definition.teams.map((team) => ({ id: team.id, label: team.label }))
    : [{ id: 'community', label: sessionText(language, 'community') }];
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
type Key = Parameters<typeof sessionText>[1];
type Values = Record<string, string | number>;
const translator =
  (language: SessionLanguage) =>
  (key: Key, values: Values = {}, count?: number) =>
    sessionText(language, key, values, count);

/** Translated objective sentence for any definition version (shared by the HUD rules). */
export function objectiveRule(definition: ExperienceDefinition, language: SessionLanguage) {
  const target = definition.objective.target ?? 0;
  if (definition.objective.kind === 'collective-goal')
    return sessionText(language, 'goalRule', { target }, target);
  if (definition.objective.kind === 'burst')
    return sessionText(
      language,
      'burstGoalRule',
      { label: definition.mechanics?.burst?.label ?? '', target },
      target,
    );
  return sessionText(language, definition.mechanics?.health ? 'lastStandingRule' : 'highestRule');
}

/** Plain-language rule summary for version 2 mechanics (empty for version 1). */
export function mechanicsRules(
  definition: ExperienceDefinition,
  language: SessionLanguage = 'en',
): string {
  const m = definition.mechanics;
  if (!m) return '';
  const t = translator(language);
  const time = (ms: number) => sessionSeconds(language, ms);
  const parts: string[] = [];
  if (m.burst)
    parts.push(
      t('burstRule', {
        participants: m.burst.participants,
        command: m.burst.command ?? definition.contribution.command,
        window: time(m.burst.windowMs),
        label: m.burst.label,
      }) +
        (m.burst.shieldMs ? t('burstShieldClause', { time: time(m.burst.shieldMs) }) : '') +
        (m.burst.points ? t('burstPointsClause', { points: m.burst.points }, m.burst.points) : '') +
        '.',
    );
  if (m.health)
    parts.push(
      t('healthRule', {
        max: m.health.max,
        label: m.health.label,
        command: definition.contribution.command,
        damage: m.health.damage,
      }) +
        (m.health.heal
          ? t('healClause', { command: m.health.heal.command, amount: m.health.heal.amount })
          : '') +
        t('eliminationRule'),
    );
  for (const milestone of m.milestones)
    parts.push(
      milestone.unlock
        ? t(
            'milestoneUnlockRule',
            {
              score: milestone.score,
              label: milestone.label,
              command: milestone.unlock.command,
              points: milestone.unlock.points,
            },
            milestone.score,
          )
        : t('milestoneRule', { score: milestone.score, label: milestone.label }, milestone.score),
    );
  if (m.match) parts.push(t('matchRule', { rounds: m.match.rounds }));
  return parts.join(' ');
}

/** Append round, health, burst and tier panels to a HUD container. */
export function appendMechanics(
  hud: HTMLElement,
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  now: number,
  language: SessionLanguage = 'en',
) {
  const m = definition.mechanics,
    state = snapshot.mechanics;
  if (!m || !state) return;
  const t = translator(language);
  const time = (ms: number) => sessionSeconds(language, ms);
  const section = node('div', 'session-mechanics');
  if (m.match) {
    const wins = sides(definition, language)
      .map((side) => `${side.label} ${state.wins[side.id] ?? 0}`)
      .join(' · ');
    section.append(
      node(
        'p',
        'session-round',
        t('roundStatus', { round: state.round, rounds: m.match.rounds, wins }),
      ),
    );
    const left = intermissionLeft(definition, snapshot, now);
    if (left > 0) {
      const next = node('p', 'session-intermission', t('nextRound', { time: time(left) }));
      next.setAttribute('role', 'status');
      section.append(next);
    }
  }
  const list = node('div', 'session-pools');
  for (const side of sides(definition, language)) {
    const standing = state.standings[side.id];
    if (!standing) continue;
    const row = node('div', 'session-pool');
    row.dataset.eliminated = String(standing.eliminated);
    if (m.health && standing.health !== null)
      row.append(
        meter(
          t('healthMeter', { side: side.label, label: m.health.label }),
          standing.health,
          m.health.max,
          standing.eliminated
            ? t('sideEliminated', { side: side.label })
            : t('healthValue', {
                side: side.label,
                label: m.health.label,
                value: standing.health,
                max: m.health.max,
              }),
          standing.eliminated ? 'out' : standing.health * 4 <= m.health.max ? 'low' : 'health',
        ),
      );
    if (m.burst) {
      const burst = burstCount(definition, snapshot, side.id, now);
      const text =
        burst.shieldMs > 0
          ? t('burstUp', { label: m.burst.label, time: time(burst.shieldMs) })
          : standing.bursts >= m.burst.limit
            ? t('burstUsed', { label: m.burst.label, used: standing.bursts, limit: m.burst.limit })
            : t('burstProgress', {
                side: side.label,
                label: m.burst.label,
                count: burst.count,
                needed: m.burst.participants,
              }) +
              (burst.closesInMs !== null
                ? ` · ${t('burstWindow', { time: time(burst.closesInMs) })}`
                : '');
      row.append(
        meter(
          t('burstMeter', { side: side.label, label: m.burst.label }),
          burst.shieldMs > 0 ? m.burst.participants : burst.count,
          m.burst.participants,
          text,
          burst.shieldMs > 0 ? 'shield' : 'burst',
        ),
      );
    }
    if (m.milestones.length) {
      const tiers = node('ul', 'session-tiers');
      tiers.setAttribute('aria-label', t('milestones', { side: side.label }));
      for (const milestone of m.milestones) {
        const reached = standing.unlocked.includes(milestone.id);
        const item = node(
          'li',
          'session-tier',
          t(reached ? 'tierUnlocked' : 'tierLocked', {
            label: milestone.label,
            score: milestone.score,
          }) + (milestone.unlock ? ` · ${milestone.unlock.command}` : ''),
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

/**
 * Translated reasons why the engine would currently refuse some of this viewer's version 2
 * commands, derived from the same canonical state the engine admits against.
 */
export function viewerReasons(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  viewerId: string,
  now: number,
  language: SessionLanguage = 'en',
): string[] {
  const m = definition.mechanics,
    state = snapshot.mechanics;
  if (!m || !state || snapshot.phase !== 'running') return [];
  if (intermissionLeft(definition, snapshot, now) > 0)
    return [mechanicsReason(language, 'ROUND_INTERMISSION')];
  const participant = Object.hasOwn(snapshot.participants, viewerId)
    ? snapshot.participants[viewerId]
    : undefined;
  if (!participant) return [];
  const side = participant.teamId ?? 'community';
  const standing = state.standings[side];
  if (!standing) return [];
  if (standing.eliminated) return [mechanicsReason(language, 'ELIMINATED')];
  const reasons: string[] = [];
  const burst = m.burst;
  if (burst) {
    const live = burstCount(definition, snapshot, side, now);
    const at = clockOf(snapshot, now);
    if (live.shieldMs > 0)
      reasons.push(mechanicsReason(language, 'BURST_ACTIVE', { label: burst.label }));
    else if (standing.bursts >= burst.limit)
      reasons.push(mechanicsReason(language, 'BURST_LIMIT', { label: burst.label }));
    else if (
      standing.burstWindow.some(
        (entry) => entry.viewerId === viewerId && entry.at > at - burst.windowMs,
      )
    )
      reasons.push(mechanicsReason(language, 'BURST_COUNTED', { label: burst.label }));
  }
  if (m.health?.heal && standing.health !== null && standing.health >= m.health.max)
    reasons.push(mechanicsReason(language, 'HEALTH_FULL', { label: m.health.label }));
  for (const milestone of m.milestones)
    if (milestone.unlock && !standing.unlocked.includes(milestone.id))
      reasons.push(
        mechanicsReason(language, 'LOCKED', {
          command: milestone.unlock.command,
          score: milestone.score,
        }),
      );
  return reasons;
}

/** Outcome sentence for finished version 2 sessions; null defers to the version 1 text. */
export function mechanicsOutcome(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  language: SessionLanguage = 'en',
): string | null {
  const m = definition.mechanics;
  if (!m || snapshot.phase !== 'finished') return null;
  const t = translator(language);
  const label =
    snapshot.winner === 'community'
      ? t('community')
      : definition.teams.find((team) => team.id === snapshot.winner)?.label;
  // Elimination is its own outcome, never a generic finished round.
  const outcome =
    snapshot.outcome === 'elimination'
      ? t('outcomeLastStanding')
      : snapshot.outcome === 'goal'
        ? definition.objective.kind === 'burst'
          ? t('outcomeBurst', { label: m.burst?.label ?? 'Burst' })
          : t('outcomeGoal')
        : t('outcomeTimeUp');
  if (m.match) {
    const wins = sides(definition, language)
      .map((side) => snapshot.mechanics?.wins[side.id] ?? 0)
      .join('–');
    return snapshot.winner === 'tie'
      ? t('matchTie', { wins })
      : label
        ? t('matchWinner', { team: label, wins })
        : t('matchOver', { wins });
  }
  return snapshot.winner === 'tie'
    ? t('outcomeTie', { outcome })
    : label
      ? t('outcomeWinner', { outcome, team: label })
      : t('outcomeFinished', { outcome });
}

/** Compact one-line stream lines for the scene scoreboard. */
export function mechanicsLines(
  definition: ExperienceDefinition,
  snapshot: SessionSnapshot,
  now: number,
  language: SessionLanguage = 'en',
): string[] {
  const m = definition.mechanics,
    state = snapshot.mechanics;
  if (!m || !state) return [];
  const t = translator(language);
  const lines: string[] = [];
  if (m.match) {
    const left = intermissionLeft(definition, snapshot, now);
    const round = { round: state.round, rounds: m.match.rounds };
    lines.push(
      left > 0
        ? t('lineRoundIn', { ...round, time: sessionSeconds(language, left) })
        : t('lineRound', round),
    );
  }
  for (const side of sides(definition, language)) {
    const standing = state.standings[side.id];
    if (!standing) continue;
    const parts: string[] = [];
    if (m.health && standing.health !== null)
      parts.push(
        standing.eliminated
          ? t('lineOut')
          : t('lineHealth', { value: standing.health, max: m.health.max }),
      );
    if (m.burst) {
      const burst = burstCount(definition, snapshot, side.id, now);
      parts.push(
        burst.shieldMs > 0
          ? t('lineBurstUp', { label: m.burst.label })
          : t('lineBurst', {
              label: m.burst.label,
              count: burst.count,
              needed: m.burst.participants,
            }),
      );
    }
    if (m.milestones.length) parts.push(t('lineTier', { tier: standing.unlocked.length }));
    if (parts.length) lines.push(`${side.label}: ${parts.join(' · ')}`);
  }
  return lines;
}
