import {
  MECHANIC_LIMITS,
  type AudienceRole,
  type ExperienceDefinition,
  type ExperienceMechanics,
  type Scenario,
  type ScenarioStep,
} from '@riff/sdk';
import type { MechanicHints } from './experience-hints.js';

/*
 * Offline template support for definition version 2 mechanics. It reads only explicit,
 * bounded facts; anything it cannot place faithfully becomes `unsupported` so the creator
 * is never shown a quietly reduced rule set.
 */

export type MechanicsPlan =
  | {
      ok: true;
      mechanics: ExperienceMechanics;
      command: string;
      kind: ExperienceDefinition['objective']['kind'] | null;
      target: number | null;
    }
  | { ok: false; reason: string };

const within = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;
const title = (command: string) =>
  command.slice(1).charAt(0).toUpperCase() + command.slice(2).replace(/[-_]/g, ' ');

/** Build a bounded mechanics block from explicit hints. Example: planMechanics(hints, ...). */
export function planMechanics(input: {
  hints: MechanicHints;
  command: string | null;
  teams: ExperienceDefinition['teams'];
  kind: ExperienceDefinition['objective']['kind'] | null;
  assumptions: string[];
}): MechanicsPlan | null {
  const { hints, teams, assumptions } = input;
  if (!hints.burst && !hints.health && !hints.match && !hints.milestones.length) {
    return hints.mentioned
      ? {
          ok: false,
          reason:
            'Health, bursts, rounds or unlocks were mentioned without the exact numbers the offline compiler needs (for example "100 health", "5 different viewers within 10 seconds", "best of 3" or "at 10 points unlock !bloom").',
        }
      : null;
  }
  const fail = (reason: string): MechanicsPlan => ({ ok: false, reason });
  // A burst whose command is the only action counts the contribution itself.
  let command = input.command;
  let burstCommand = hints.burst?.command ?? null;
  if (!command && burstCommand) {
    command = burstCommand;
    burstCommand = null;
  }
  if (!command) return null;
  let kind = input.kind;
  let target: number | null = null;
  const mechanics: ExperienceMechanics = { match: null, health: null, burst: null, milestones: [] };
  if (hints.health) {
    if (teams.length < 2)
      return fail('Health pools need two or more teams, each with an explicit join command.');
    if (kind === 'collective-goal')
      return fail(
        'Health pools are a competitive rule and cannot be combined with a collective goal.',
      );
    kind = 'highest-score';
    const damage = hints.health.damage;
    if (damage === null) assumptions.push(`Each ${command} deals 1 damage to every other team.`);
    mechanics.health = {
      label: 'Health',
      max: hints.health.max,
      damage: damage ?? 1,
      heal: hints.health.heal,
    };
    if (
      !within(mechanics.health.max, MECHANIC_LIMITS.health) ||
      !within(mechanics.health.damage, MECHANIC_LIMITS.damage) ||
      (mechanics.health.heal && !within(mechanics.health.heal.amount, MECHANIC_LIMITS.heal))
    )
      return fail('Health, damage and healing must be whole numbers from 1 to 1000.');
    assumptions.push('A team at 0 health is eliminated; the last team standing wins the round.');
  }
  if (hints.burst) {
    const { participants, windowMs } = hints.burst;
    if (
      !within(participants, MECHANIC_LIMITS.burstParticipants) ||
      !within(windowMs, MECHANIC_LIMITS.burstWindowMs)
    )
      return fail('A burst needs 2 to 50 different viewers within 1 to 60 seconds.');
    const shield = hints.burst.protects && mechanics.health !== null;
    if (!kind && !shield) {
      kind = 'burst';
      target = 1;
    }
    const label = title(hints.burst.command ?? command);
    const shieldMs = shield ? (hints.shieldMs ?? 10_000) : 0;
    if (shield && hints.shieldMs === null)
      assumptions.push(`${label} blocks damage to the team for 10 seconds.`);
    const points = shield || kind === 'burst' ? 0 : 5;
    if (points) assumptions.push(`Each ${label} burst adds 5 bonus points.`);
    const limit = kind === 'burst' ? 1 : 3;
    if (kind !== 'burst') assumptions.push(`${label} can trigger up to 3 times per round.`);
    if (!within(shieldMs, MECHANIC_LIMITS.shieldMs))
      return fail('A burst shield lasts at most 60 seconds.');
    mechanics.burst = {
      command: burstCommand,
      label,
      participants,
      windowMs,
      points,
      limit,
      shieldMs,
    };
  }
  if (hints.match) {
    if (!within(hints.match.rounds, MECHANIC_LIMITS.rounds))
      return fail('A match needs 2 to 9 rounds.');
    const intermissionMs = hints.match.intermissionMs ?? 5000;
    if (hints.match.intermissionMs === null)
      assumptions.push('Rounds are separated by a 5 second break.');
    if (!within(intermissionMs, MECHANIC_LIMITS.intermissionMs))
      return fail('The break between rounds is at most 60 seconds.');
    mechanics.match = { rounds: hints.match.rounds, intermissionMs };
    assumptions.push(
      'Resources, scores and pools reset every round; a majority of round wins ends the match.',
    );
  }
  const sorted = [...hints.milestones].sort((a, b) => a.score - b.score);
  for (const [i, milestone] of sorted.entries()) {
    if (milestone.score < 1 || sorted.some((other, j) => j < i && other.score === milestone.score))
      return fail('Milestones need distinct positive point thresholds.');
    const points = milestone.points ?? 3;
    if (milestone.command && milestone.points === null)
      assumptions.push(`${milestone.command} is worth 3 points once unlocked.`);
    if (milestone.command && !within(points, MECHANIC_LIMITS.unlockPoints))
      return fail('Unlocked commands are worth 1 to 100 points.');
    mechanics.milestones.push({
      id: `tier-${i + 1}`,
      label: milestone.command ? title(milestone.command) : `Tier ${i + 1}`,
      score: milestone.score,
      unlock: milestone.command ? { command: milestone.command, points } : null,
    });
  }
  if (mechanics.milestones.length > MECHANIC_LIMITS.milestones)
    return fail('At most four milestones are supported.');
  return { ok: true, mechanics, command, kind, target };
}

/** Handler that shows a brighter asset once a tier unlocks; state stays host-owned. */
export function mechanicsSource(asset: string, tiers: boolean) {
  return tiers
    ? `async (event, riff) => {\n  const s = riff.session.snapshot();\n  const tier = Math.max(0, ...Object.values(s.mechanics.standings).map((side) => side.unlocked.length));\n  await riff.overlay.emit({ kind: 'projectile', asset: tier > 0 ? 'star' : '${asset}', x: s.revision % 2 === 0 ? 0.25 : 0.75 });\n}`
    : `async (event, riff) => {\n  const snapshot = riff.session.snapshot();\n  await riff.overlay.emit({ kind: 'projectile', asset: '${asset}', x: snapshot.revision % 2 === 0 ? 0.25 : 0.75 });\n}`;
}

/** Plain-language mechanics summary for the approval card. */
export function describeMechanics(d: ExperienceDefinition): string {
  const m = d.mechanics;
  if (!m) return '';
  const parts: string[] = [];
  if (m.burst)
    parts.push(
      `${m.burst.participants} different viewers using ${m.burst.command ?? d.contribution.command} within ${m.burst.windowMs / 1000} s trigger ${m.burst.label}`,
    );
  if (m.health)
    parts.push(
      `teams have ${m.health.max} ${m.health.label.toLowerCase()}; each ${d.contribution.command} deals ${m.health.damage}${m.health.heal ? `; ${m.health.heal.command} heals ${m.health.heal.amount}` : ''}; 0 eliminates`,
    );
  if (m.match) parts.push(`best of ${m.match.rounds} rounds`);
  for (const x of m.milestones)
    parts.push(`${x.score} points unlock ${x.unlock ? x.unlock.command : x.label}`);
  return parts.join('; ');
}

/** Generated scenarios for version 2 templates; the host suite checks state independently. */
export function mechanicScenarios(d: ExperienceDefinition, audience: AudienceRole[]): Scenario[] {
  const m = d.mechanics;
  if (!m) return [];
  const roles: AudienceRole[] = audience.includes('viewer')
    ? ['viewer']
    : [audience[0] ?? 'broadcaster', 'viewer'];
  const s = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: ScenarioStep['expect'],
    effects: number,
    session?: ScenarioStep['session'],
  ): ScenarioStep => ({
    id,
    viewer,
    roles,
    text,
    at,
    expect,
    effects,
    ...(session ? { session } : {}),
  });
  const command = d.contribution.command;
  const teamA = d.teams[0],
    teamB = d.teams[1];
  const join = (viewer: string, id: string, team = teamA, at = 0): ScenarioStep[] =>
    team ? [s(id, viewer, team.joinCommand, at, 'ACCEPTED', 0)] : [];
  const oneHitEnds = m.health !== null && m.health.damage >= m.health.max;
  const list: Scenario[] = [
    {
      name: 'An action is accepted and shows one effect',
      kind: 'happy',
      steps: [...join('alice', 'join'), s('first', 'alice', command, 1, 'ACCEPTED', 1)],
    },
    {
      name: 'Ordinary chat does not act',
      kind: 'negative',
      steps: [s('unrelated', 'alice', 'hello chat', 0, 'UNRELATED', 0)],
    },
    {
      name: 'Redelivered actions never count twice',
      kind: 'duplicate',
      steps: [
        ...join('alice', 'join'),
        s('same', 'alice', command, 1, 'ACCEPTED', 1),
        s('same', 'alice', command, 2, 'DUPLICATE', 0),
      ],
    },
    {
      name: m.match ? 'The deadline starts the next round' : 'The exact deadline ends the round',
      kind: 'limit',
      steps: [
        ...join('alice', 'join'),
        m.match
          ? s(
              'deadline',
              'alice',
              command,
              d.durationMs,
              m.match.intermissionMs > 0 ? 'ROUND_INTERMISSION' : 'ACCEPTED',
              m.match.intermissionMs > 0 ? 0 : 1,
              { phase: 'running' },
            )
          : s('deadline', 'alice', command, d.durationMs, 'SESSION_FINISHED', 0, {
              phase: 'finished',
            }),
      ],
    },
  ];
  const burst = m.burst;
  const countedEndsEarly =
    burst?.command === null &&
    ((m.health !== null && m.health.max <= m.health.damage * burst.participants) ||
      (d.objective.kind === 'collective-goal' &&
        d.contribution.points * burst.participants >= (d.objective.target ?? Infinity)));
  if (burst && burst.participants <= 10 && !countedEndsEarly) {
    const text = burst.command ?? command;
    const steps: ScenarioStep[] = [];
    for (let i = 0; i < burst.participants; i++) steps.push(...join(`viewer${i}`, `join${i}`));
    for (let i = 0; i < burst.participants; i++) {
      const last = i === burst.participants - 1;
      if (last && burst.command) steps.push(s('again', 'viewer0', text, i + 1, 'BURST_COUNTED', 0));
      steps.push(
        s(
          `burst${i}`,
          `viewer${i}`,
          text,
          i + 2,
          'ACCEPTED',
          1,
          last && d.objective.kind === 'burst' && !m.match ? { phase: 'finished' } : undefined,
        ),
      );
    }
    list.push({
      name: `${burst.label} needs ${burst.participants} different viewers`,
      kind: 'happy',
      steps,
    });
  }
  if (m.health?.heal && teamA && teamB && !oneHitEnds)
    list.push({
      name: 'Healing at full health is rejected without spending',
      kind: 'limit',
      steps: [
        ...join('bob', 'join', teamB),
        s('full', 'bob', m.health.heal.command, 1, 'HEALTH_FULL', 0),
        ...join('alice', 'join-red', teamA, 1),
        s('hit', 'alice', command, 2, 'ACCEPTED', 1),
        s('heal', 'bob', m.health.heal.command, 3, 'ACCEPTED', 1),
      ],
    });
  const locked = m.milestones.find((x) => x.unlock);
  if (locked?.unlock)
    list.push({
      name: `${locked.unlock.command} stays locked until ${locked.score} points`,
      kind: 'role',
      steps: [
        ...join('alice', 'join'),
        s('locked', 'alice', locked.unlock.command, 1, 'LOCKED', 0),
      ],
    });
  return list;
}
