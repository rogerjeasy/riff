import { z } from 'zod';
import {
  MECHANIC_LIMITS,
  SESSION_LIMITS,
  TRIGGER_LIMITS,
  type DecisionCode,
  type ExperienceDefinition,
  type ExperienceMechanics,
  type SessionMechanicsState,
  type SessionRoundResult,
  type SessionSnapshot,
  type SessionStanding,
} from '@riff/sdk';
import { formatCommands } from './formats.js';

/*
 * Definition version 2 mechanics: best-of-N matches, team health pools with elimination,
 * distinct-participant bursts and score milestones. Everything here is host-owned, pure and
 * driven only by the recorded event clock, so live play, rehearsal and journal replay
 * reproduce identical state from the same ordered inputs.
 */

const command = z.string().regex(new RegExp(TRIGGER_LIMITS.commandPattern));
const cleanText = (s: string) =>
  [...s].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const label = z.string().trim().min(1).max(SESSION_LIMITS.labelLength).refine(cleanText);
const id = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/)
  .refine((s) => !['__proto__', 'constructor', 'prototype', 'community', 'tie'].includes(s));
const int = (range: { min: number; max: number }) => z.number().int().min(range.min).max(range.max);

/** Strict bounded mechanics block. Example: mechanicsSchema.parse(definition.mechanics). */
export const mechanicsSchema = z
  .object({
    match: z
      .object({
        rounds: int(MECHANIC_LIMITS.rounds),
        intermissionMs: int(MECHANIC_LIMITS.intermissionMs),
      })
      .strict()
      .nullable(),
    health: z
      .object({
        label,
        max: int(MECHANIC_LIMITS.health),
        damage: int(MECHANIC_LIMITS.damage),
        heal: z
          .object({ command, amount: int(MECHANIC_LIMITS.heal) })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    burst: z
      .object({
        command: command.nullable(),
        label,
        participants: int(MECHANIC_LIMITS.burstParticipants),
        windowMs: int(MECHANIC_LIMITS.burstWindowMs),
        points: int(MECHANIC_LIMITS.burstPoints),
        limit: int(MECHANIC_LIMITS.burstLimit),
        shieldMs: int(MECHANIC_LIMITS.shieldMs),
      })
      .strict()
      .nullable(),
    milestones: z
      .array(
        z
          .object({
            id,
            label,
            score: z.number().int().min(1).max(SESSION_LIMITS.maxScore),
            unlock: z
              .object({ command, points: int(MECHANIC_LIMITS.unlockPoints) })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(MECHANIC_LIMITS.milestones),
  })
  .strict();

/** Every chat command a definition reacts to, in admission order. */
export function definitionCommands(d: ExperienceDefinition): string[] {
  const m = d.mechanics;
  return [
    ...d.teams.map((t) => t.joinCommand),
    d.contribution.command,
    ...(m?.health?.heal ? [m.health.heal.command] : []),
    ...(m?.burst?.command ? [m.burst.command] : []),
    ...(m?.milestones.flatMap((x) => (x.unlock ? [x.unlock.command] : [])) ?? []),
    ...formatCommands(d),
  ];
}

/** Cross-field rules for version 2. Returns creator-readable problems. */
export function mechanicsProblems(d: ExperienceDefinition): string[] {
  const m = d.mechanics;
  const problems: string[] = [];
  if (d.version !== 2) {
    if (m !== undefined) problems.push('Only version 2 definitions carry mechanics');
    if (d.objective.kind === 'burst') problems.push('Burst objectives require version 2');
    return problems;
  }
  if (!m) return ['Version 2 definitions require mechanics'];
  const commands = definitionCommands(d);
  if (new Set(commands).size !== commands.length)
    problems.push('Every join, contribution, heal, burst and unlock command must be unique');
  if (m.health && (d.teams.length < 2 || d.objective.kind === 'collective-goal'))
    problems.push('Health pools need two or more competing teams');
  if (m.burst && m.burst.participants > d.maxParticipants)
    problems.push('A burst cannot need more distinct viewers than the participant limit');
  if (m.burst && m.burst.shieldMs > 0 && !m.health)
    problems.push('A burst shield only blocks health damage');
  if (m.burst && m.burst.points === 0 && m.burst.shieldMs === 0 && d.objective.kind !== 'burst')
    problems.push('A burst must award points, raise a shield or count toward the objective');
  if (d.objective.kind === 'burst') {
    if (!m.burst) problems.push('Burst objectives require a burst rule');
    else if (d.objective.target === null || d.objective.target > m.burst.limit)
      problems.push('A burst objective target must be between 1 and the burst limit');
  }
  const scores = m.milestones.map((x) => x.score);
  if (scores.some((score, i) => i > 0 && score <= (scores[i - 1] ?? 0)))
    problems.push('Milestone scores must strictly increase');
  if (new Set(m.milestones.map((x) => x.id)).size !== m.milestones.length)
    problems.push('Milestone ids must be unique');
  // Bound the worst case so canonical scores always fit the snapshot schema.
  const perAction = Math.max(
    d.contribution.points,
    ...m.milestones.map((x) => x.unlock?.points ?? 0),
  );
  const worst =
    d.maxParticipants * d.resource.perParticipant * perAction +
    (m.burst ? m.burst.limit * m.burst.points : 0);
  if (worst > SESSION_LIMITS.maxScore) problems.push('These rules could exceed the score ceiling');
  return problems;
}

/** Score keys: team ids, or community without teams. */
export function sideKeys(d: ExperienceDefinition): string[] {
  return d.teams.length ? d.teams.map((t) => t.id) : ['community'];
}

function freshStanding(m: ExperienceMechanics): SessionStanding {
  return {
    health: m.health ? m.health.max : null,
    eliminated: false,
    contributions: 0,
    heals: 0,
    unlocks: Object.create(null) as Record<string, number>,
    bursts: 0,
    burstWindow: [],
    shieldUntil: null,
    unlocked: [],
  };
}
function dict<T>(keys: string[], value: (key: string) => T): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const key of keys) out[key] = value(key);
  return out;
}
/** Fresh round-one mechanics state. Example: createMechanicsState(definition). */
export function createMechanicsState(d: ExperienceDefinition): SessionMechanicsState | undefined {
  const m = d.mechanics;
  if (!m) return undefined;
  const keys = sideKeys(d);
  return {
    round: 1,
    wins: dict(keys, () => 0),
    history: [],
    standings: dict(keys, () => freshStanding(m)),
  };
}

const viewerKey = z.string().min(1).max(100);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function boundedDictionary<T>(schema: z.ZodType<T>, max: number) {
  return z.unknown().transform((value, ctx): Record<string, T> => {
    const result: Record<string, T> = Object.create(null);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > max
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid bounded dictionary' });
      return z.NEVER;
    }
    for (const [key, item] of Object.entries(value)) {
      const parsed = schema.safeParse(item);
      if (!key || key.length > 100 || !parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid dictionary entry', path: [key] });
        return z.NEVER;
      }
      result[key] = parsed.data;
    }
    return result;
  });
}
const count = (max: number) => z.number().int().min(0).max(max);
const standingSchema = z
  .object({
    health: z.number().int().min(0).max(MECHANIC_LIMITS.health.max).nullable(),
    eliminated: z.boolean(),
    contributions: count(SESSION_LIMITS.maxParticipants * SESSION_LIMITS.resourcePerParticipant),
    heals: count(SESSION_LIMITS.maxParticipants * SESSION_LIMITS.resourcePerParticipant),
    unlocks: boundedDictionary(
      count(SESSION_LIMITS.maxParticipants * SESSION_LIMITS.resourcePerParticipant),
      MECHANIC_LIMITS.milestones,
    ),
    bursts: count(MECHANIC_LIMITS.burstLimit.max),
    burstWindow: z
      .array(z.object({ viewerId: viewerKey, at: timestamp }).strict())
      .max(MECHANIC_LIMITS.burstParticipants.max),
    shieldUntil: timestamp.nullable(),
    unlocked: z.array(id).max(MECHANIC_LIMITS.milestones),
  })
  .strict();
const scoreDictionary = boundedDictionary(
  z.number().int().min(0).max(SESSION_LIMITS.maxScore),
  SESSION_LIMITS.maxTeams,
);
/** JSON shape of persisted mechanics state. Example: mechanicsStateSchema.parse(snapshot.mechanics). */
export const mechanicsStateSchema = z
  .object({
    round: z.number().int().min(1).max(MECHANIC_LIMITS.rounds.max),
    wins: boundedDictionary(count(MECHANIC_LIMITS.rounds.max), SESSION_LIMITS.maxTeams),
    history: z
      .array(
        z
          .object({
            round: z.number().int().min(1).max(MECHANIC_LIMITS.rounds.max),
            winner: z.string().max(32).nullable(),
            outcome: z.enum(['deadline', 'goal', 'elimination']),
            scores: scoreDictionary,
          })
          .strict(),
      )
      .max(MECHANIC_LIMITS.rounds.max),
    standings: boundedDictionary(standingSchema, SESSION_LIMITS.maxTeams),
  })
  .strict();

function highest(values: Record<string, number>, keys: string[]): string {
  const max = Math.max(...keys.map((key) => values[key] ?? 0));
  const leaders = keys.filter((key) => (values[key] ?? 0) === max);
  return leaders.length === 1 ? (leaders[0] ?? 'tie') : 'tie';
}
/** Who wins a round that ended for `outcome`, judged only from canonical state. */
export function roundWinner(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  outcome: SessionRoundResult['outcome'],
): string | null {
  const keys = sideKeys(d),
    standings = s.mechanics?.standings ?? {};
  if (outcome === 'elimination') return keys.find((key) => !standings[key]?.eliminated) ?? 'tie';
  if (d.objective.kind === 'collective-goal') return outcome === 'goal' ? 'community' : null;
  if (d.objective.kind === 'burst' && !d.teams.length)
    return outcome === 'goal' ? 'community' : null;
  if (outcome === 'goal') {
    // Burst objective with teams: the side that reached the target.
    const target = d.objective.target ?? Infinity;
    return keys.find((key) => (standings[key]?.bursts ?? 0) >= target) ?? 'tie';
  }
  if (d.mechanics?.health) {
    const standing = keys.filter((key) => !standings[key]?.eliminated);
    const health: Record<string, number> = Object.create(null);
    for (const key of standing) health[key] = standings[key]?.health ?? 0;
    return standing.length ? highest(health, standing) : 'tie';
  }
  return highest(s.scores, keys);
}
function matchWinner(d: ExperienceDefinition, wins: Record<string, number>): string | null {
  const keys = sideKeys(d);
  if (!d.teams.length) return (wins.community ?? 0) >= needed(d) ? 'community' : null;
  const best = highest(wins, keys);
  return best !== 'tie' && (wins[best] ?? 0) > 0 ? best : 'tie';
}
function needed(d: ExperienceDefinition): number {
  return Math.floor((d.mechanics?.match?.rounds ?? 1) / 2) + 1;
}
/** Round duration plus any intermission currently ahead of the round's start. */
export function maxRemainingMs(d: ExperienceDefinition): number {
  return d.durationMs + (d.mechanics?.match?.intermissionMs ?? 0);
}
/** True while the next round's intermission is running. Example: inIntermission(d, s). */
export function inIntermission(d: ExperienceDefinition, s: SessionSnapshot): boolean {
  return s.phase !== 'finished' && s.remainingMs > d.durationMs;
}

/**
 * End the current round at `at` (deadline or the deciding event). Advances a match to its
 * next round after the intermission, or finishes the session. Mutates `s`.
 */
export function endRound(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  at: number,
  outcome: SessionRoundResult['outcome'],
): void {
  const m = d.mechanics,
    state = s.mechanics;
  if (!m || !state) throw new Error('Rounds require version 2 mechanics');
  const winner = roundWinner(d, s, outcome);
  state.history.push({ round: state.round, winner, outcome, scores: { ...s.scores } });
  if (winner && winner !== 'tie' && Object.hasOwn(state.wins, winner))
    state.wins[winner] = (state.wins[winner] ?? 0) + 1;
  const decided =
    !m.match ||
    state.round >= m.match.rounds ||
    Object.values(state.wins).some((wins) => wins >= needed(d));
  if (decided) {
    s.phase = 'finished';
    s.deadlineAt = null;
    s.remainingMs = 0;
    s.outcome = outcome;
    s.winner = m.match ? matchWinner(d, state.wins) : winner;
    return;
  }
  const keys = sideKeys(d);
  state.round++;
  state.standings = dict(keys, () => freshStanding(m));
  for (const key of keys) s.scores[key] = 0;
  for (const participant of Object.values(s.participants)) {
    participant.remaining = d.resource.perParticipant;
    participant.contributions = 0;
  }
  s.deadlineAt = at + (m.match?.intermissionMs ?? 0) + d.durationMs;
  s.remainingMs = s.deadlineAt - s.updatedAt;
}

function unlockedFor(m: ExperienceMechanics, score: number): string[] {
  return m.milestones.filter((x) => score >= x.score).map((x) => x.id);
}
function scoreFrom(d: ExperienceDefinition, standing: SessionStanding): number {
  const m = d.mechanics;
  let score = standing.contributions * d.contribution.points;
  if (m?.burst) score += standing.bursts * m.burst.points;
  for (const milestone of m?.milestones ?? [])
    score += (standing.unlocks[milestone.id] ?? 0) * (milestone.unlock?.points ?? 0);
  return score;
}

/** Independent consistency checks for version 2 state. Throws on the first violation. */
export function validateMechanicsState(d: ExperienceDefinition, s: SessionSnapshot): void {
  const m = d.mechanics;
  if (!m) {
    if (s.mechanics !== undefined) throw new Error('Unexpected mechanics state');
    return;
  }
  if (!s.mechanics) throw new Error('Missing mechanics state');
  const state = mechanicsStateSchema.parse(s.mechanics);
  const keys = sideKeys(d);
  const sameKeys = (value: Record<string, unknown>) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const rounds = m.match?.rounds ?? 1;
  const finished = s.phase === 'finished';
  if (
    !sameKeys(state.wins) ||
    !sameKeys(state.standings) ||
    state.round > rounds ||
    state.history.length !== (finished ? state.round : state.round - 1) ||
    state.history.some((result, i) => result.round !== i + 1 || !sameKeys(result.scores))
  )
    throw new Error('Invalid match progress');
  for (const key of keys) {
    const wins = state.history.filter((result) => result.winner === key).length;
    if (state.wins[key] !== wins) throw new Error('Invalid match wins');
  }
  const unlockable = new Set(m.milestones.filter((x) => x.unlock).map((x) => x.id));
  const spent: Record<string, number> = Object.create(null);
  for (const participant of Object.values(s.participants)) {
    const key = participant.teamId ?? 'community';
    spent[key] = (spent[key] ?? 0) + participant.contributions;
  }
  let standingCount = 0;
  for (const key of keys) {
    const st = state.standings[key];
    if (!st) throw new Error('Missing standing');
    if (m.health) {
      if (st.health === null || st.health > m.health.max || st.eliminated !== (st.health === 0))
        throw new Error('Invalid health pool');
    } else if (st.health !== null || st.eliminated) throw new Error('Unexpected health pool');
    if (!st.eliminated) standingCount++;
    if (!m.health?.heal && st.heals) throw new Error('Unexpected heals');
    if (
      Object.entries(st.unlocks).some(
        ([mid, uses]) => !unlockable.has(mid) || (uses > 0 && !st.unlocked.includes(mid)),
      )
    )
      throw new Error('Invalid unlock use');
    const uses = Object.values(st.unlocks).reduce((a, b) => a + b, 0);
    if ((spent[key] ?? 0) !== st.contributions + st.heals + uses)
      throw new Error('Invalid side resource ledger');
    if (s.scores[key] !== scoreFrom(d, st)) throw new Error('Invalid session scores');
    if (JSON.stringify(st.unlocked) !== JSON.stringify(unlockedFor(m, s.scores[key] ?? 0)))
      throw new Error('Invalid unlocked milestones');
    const burst = m.burst;
    if (!burst) {
      if (st.bursts || st.burstWindow.length || st.shieldUntil !== null)
        throw new Error('Unexpected burst state');
    } else {
      const viewers = st.burstWindow.map((entry) => entry.viewerId);
      if (
        st.bursts > burst.limit ||
        st.burstWindow.length >= burst.participants ||
        new Set(viewers).size !== viewers.length ||
        st.burstWindow.some(
          (entry, i) =>
            entry.at > s.updatedAt ||
            entry.at < (st.burstWindow[i - 1]?.at ?? 0) ||
            !Object.hasOwn(s.participants, entry.viewerId) ||
            (s.participants[entry.viewerId]?.teamId ?? 'community') !== key,
        ) ||
        (st.shieldUntil !== null &&
          (burst.shieldMs === 0 || st.shieldUntil - burst.shieldMs > s.updatedAt))
      )
        throw new Error('Invalid burst state');
    }
  }
  const target = d.objective.target ?? Infinity;
  const decided =
    (m.health && standingCount <= 1) ||
    (d.objective.kind === 'collective-goal' && (s.scores.community ?? 0) >= target) ||
    (d.objective.kind === 'burst' &&
      keys.some((key) => (state.standings[key]?.bursts ?? 0) >= target));
  if (decided && !finished) throw new Error('Invalid session outcome');
  if (finished) {
    const last = state.history.at(-1);
    if (!last || s.outcome !== last.outcome) throw new Error('Invalid session outcome');
    if ((last.outcome === 'elimination') !== Boolean(m.health && standingCount <= 1))
      throw new Error('Invalid session outcome');
    const expected = m.match ? matchWinner(d, state.wins) : last.winner;
    if (s.winner !== expected) throw new Error('Invalid session outcome');
  } else if (s.outcome !== null || s.winner !== null) throw new Error('Invalid session outcome');
  for (const result of state.history)
    if (
      result.outcome === 'deadline' &&
      !m.health &&
      d.objective.kind === 'highest-score' &&
      result.winner !== highest(result.scores, keys)
    )
      throw new Error('Invalid round result');
}

export interface MechanicsStage {
  code: DecisionCode;
  /** Whether the generated handler runs for this accepted action. */
  invoke: boolean;
  reason?: string;
}
type Participant = SessionSnapshot['participants'][string];

/**
 * Stage one gameplay command against an already clock-advanced running snapshot.
 * Mutates `s` only when the action is accepted. Admission order after the shared
 * dedupe/command/audience/phase checks: join → intermission → enrollment → elimination
 * → action-specific limits → resources.
 */
export function stageMechanicsAction(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  event: { viewerId: string; at: number },
  action:
    | { kind: 'join'; teamId: string }
    | { kind: 'contribute' }
    | { kind: 'heal' }
    | { kind: 'burst' }
    | { kind: 'unlock'; milestoneId: string },
): MechanicsStage {
  const m = d.mechanics,
    state = s.mechanics;
  if (!m || !state) throw new Error('Mechanics require version 2 state');
  const existing: Participant | undefined = Object.hasOwn(s.participants, event.viewerId)
    ? s.participants[event.viewerId]
    : undefined;
  if (action.kind === 'join') {
    if (existing) return { code: 'ALREADY_JOINED', invoke: false };
    if (state.standings[action.teamId]?.eliminated && !inIntermission(d, s))
      return { code: 'ELIMINATED', invoke: false };
    if (Object.keys(s.participants).length >= d.maxParticipants)
      return { code: 'PARTICIPANT_LIMIT', invoke: false };
    enroll(d, s, event.viewerId, action.teamId);
    s.revision++;
    return { code: 'ACCEPTED', invoke: false };
  }
  if (inIntermission(d, s)) return { code: 'ROUND_INTERMISSION', invoke: false };
  if (!existing && d.teams.length) return { code: 'NOT_JOINED', invoke: false };
  if (!existing && Object.keys(s.participants).length >= d.maxParticipants)
    return { code: 'PARTICIPANT_LIMIT', invoke: false };
  const participant = existing ?? enroll(d, s, event.viewerId, null);
  const key = participant.teamId ?? 'community';
  const st = state.standings[key];
  if (!st) throw new Error('Missing standing');
  if (st.eliminated) {
    if (!existing) Reflect.deleteProperty(s.participants, event.viewerId);
    return { code: 'ELIMINATED', invoke: false };
  }
  const reject = (code: DecisionCode): MechanicsStage => {
    if (!existing) Reflect.deleteProperty(s.participants, event.viewerId);
    return { code, invoke: false };
  };
  let reason: string | undefined;
  const spend = () => {
    participant.remaining--;
    participant.contributions++;
  };
  switch (action.kind) {
    case 'contribute': {
      if (participant.remaining <= 0) return reject('RESOURCE_LIMIT');
      spend();
      st.contributions++;
      if (m.health)
        for (const [other, target] of Object.entries(state.standings)) {
          if (other === key || target.eliminated || target.health === null) continue;
          if (target.shieldUntil !== null && target.shieldUntil > event.at) continue;
          target.health = Math.max(0, target.health - m.health.damage);
          target.eliminated = target.health === 0;
        }
      if (m.burst && m.burst.command === null) reason = countBurst(m, st, event) ?? undefined;
      break;
    }
    case 'heal': {
      const heal = m.health?.heal;
      if (!heal || st.health === null) throw new Error('Heal requires a health rule');
      if (st.health >= (m.health?.max ?? 0)) return reject('HEALTH_FULL');
      if (participant.remaining <= 0) return reject('RESOURCE_LIMIT');
      spend();
      st.heals++;
      st.health = Math.min(m.health?.max ?? 0, st.health + heal.amount);
      break;
    }
    case 'unlock': {
      const milestone = m.milestones.find((x) => x.id === action.milestoneId);
      if (!milestone?.unlock) throw new Error('Unknown unlock');
      if (!st.unlocked.includes(milestone.id)) return reject('LOCKED');
      if (participant.remaining <= 0) return reject('RESOURCE_LIMIT');
      spend();
      st.unlocks[milestone.id] = (st.unlocks[milestone.id] ?? 0) + 1;
      break;
    }
    case 'burst': {
      const burst = m.burst;
      if (!burst) throw new Error('Burst requires a burst rule');
      if (st.bursts >= burst.limit) return reject('BURST_LIMIT');
      if (st.shieldUntil !== null && st.shieldUntil > event.at) return reject('BURST_ACTIVE');
      if (
        st.burstWindow.some(
          (entry) => entry.viewerId === event.viewerId && entry.at > event.at - burst.windowMs,
        )
      )
        return reject('BURST_COUNTED');
      reason = countBurst(m, st, event) ?? undefined;
      break;
    }
  }
  s.scores[key] = scoreFrom(d, st);
  st.unlocked = unlockedFor(m, s.scores[key] ?? 0);
  s.revision++;
  const standing = Object.values(state.standings).filter((x) => !x.eliminated).length;
  const target = d.objective.target ?? Infinity;
  if (m.health && standing <= 1) endRound(d, s, event.at, 'elimination');
  else if (d.objective.kind === 'collective-goal' && (s.scores.community ?? 0) >= target)
    endRound(d, s, event.at, 'goal');
  else if (d.objective.kind === 'burst' && st.bursts >= target) endRound(d, s, event.at, 'goal');
  return { code: 'ACCEPTED', invoke: true, ...(reason ? { reason } : {}) };
}

/** Count one distinct viewer in the side's sliding window; trigger when it fills. */
function countBurst(
  m: ExperienceMechanics,
  st: SessionStanding,
  event: { viewerId: string; at: number },
): string | null {
  const burst = m.burst;
  if (!burst || st.bursts >= burst.limit) return null;
  if (st.shieldUntil !== null && st.shieldUntil > event.at) return null;
  st.burstWindow = st.burstWindow.filter((entry) => entry.at > event.at - burst.windowMs);
  if (st.burstWindow.some((entry) => entry.viewerId === event.viewerId))
    return `Accepted; this viewer already counts toward ${burst.label}.`;
  st.burstWindow.push({ viewerId: event.viewerId, at: event.at });
  if (st.burstWindow.length < burst.participants)
    return `Accepted · ${st.burstWindow.length} of ${burst.participants} for ${burst.label}.`;
  st.burstWindow = [];
  st.bursts++;
  if (burst.shieldMs > 0) st.shieldUntil = event.at + burst.shieldMs;
  return `${burst.label} triggered by ${burst.participants} different viewers!`;
}

function enroll(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  viewerId: string,
  teamId: string | null,
): Participant {
  const participant: Participant = {
    teamId,
    remaining: d.resource.perParticipant,
    contributions: 0,
  };
  Object.defineProperty(s.participants, viewerId, {
    value: participant,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return participant;
}

/** Classify which version 2 command a chat text names. */
export function mechanicsActionFor(
  d: ExperienceDefinition,
  matches: (text: string, command: string) => boolean,
  text: string,
):
  | { kind: 'join'; teamId: string }
  | { kind: 'contribute' }
  | { kind: 'heal' }
  | { kind: 'burst' }
  | { kind: 'unlock'; milestoneId: string }
  | null {
  const m = d.mechanics;
  const team = d.teams.find((t) => matches(text, t.joinCommand));
  if (team) return { kind: 'join', teamId: team.id };
  if (matches(text, d.contribution.command)) return { kind: 'contribute' };
  if (m?.health?.heal && matches(text, m.health.heal.command)) return { kind: 'heal' };
  if (m?.burst?.command && matches(text, m.burst.command)) return { kind: 'burst' };
  const milestone = m?.milestones.find((x) => x.unlock && matches(text, x.unlock.command));
  return milestone ? { kind: 'unlock', milestoneId: milestone.id } : null;
}

/** Advance version 2 time: end every round whose deadline passed, in order. Mutates `s`. */
export function advanceMechanics(d: ExperienceDefinition, s: SessionSnapshot, at: number): void {
  let guard = 0;
  while (s.phase === 'running' && s.deadlineAt !== null && s.deadlineAt <= at) {
    if (++guard > MECHANIC_LIMITS.rounds.max + 1)
      throw new Error('Round progression did not settle');
    const deadline = s.deadlineAt;
    s.remainingMs = 0;
    endRound(d, s, deadline, 'deadline');
  }
  if (s.phase === 'running' && s.deadlineAt !== null) s.remainingMs = s.deadlineAt - at;
}
