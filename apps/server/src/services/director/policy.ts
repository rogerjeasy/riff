import type {
  DirectorEnvelope,
  DirectorFrame,
  DirectorMode,
  DirectorSettings,
  DirectorSnapshot,
} from '@riff/sdk';
import { directorEnvelopeSchema, directorSettingsSchema, DirectorError } from './contract.js';
export interface DirectorInput {
  key: string;
  viewerId: string;
  roundId: string;
  at: number;
  effects: DirectorFrame[];
}
/** Published policy thresholds; the console and README describe these exact values. */
export const DIRECTOR_LIMITS = {
  pending: 120,
  freshnessMs: 5_000,
  identities: 2_000,
  identityTtlMs: 600_000,
  participantTtlMs: 3_605_000,
  busyQueue: 8,
  busyActivity: 12,
  activityWindowMs: 10_000,
  interruptionWindowMs: 60_000,
  decisions: 50,
} as const;
/** Visible adaptation reason for each approved participation policy (console decision log). */
export const PARTICIPATION_REASON = {
  fifo: 'Arrival order kept.',
  'first-time': 'First-time participants were shown first.',
  rotation: 'Priority to viewers who haven’t had a turn yet.',
} as const;
/**
 * Why a decision was recorded. Consecutive decisions of one kind are merged so a burst
 * cannot push the creator-relevant reasons (mode changes, clears, limits) out of history.
 */
type Kind = 'regular' | 'calm' | 'gameplay' | 'creator' | 'batch' | 'limit' | 'expired' | 'clear';
/** Deterministic presentation only: no gameplay state, credentials, destinations or wall clock. */
export function createDirectorPolicy(raw: DirectorEnvelope) {
  const envelope = directorEnvelopeSchema.parse(raw);
  let mode: DirectorMode = 'balanced';
  const regular = () => ({
    intervalMs: envelope.intervalMs.min,
    batchSize: envelope.batchSize.max,
    intensity: envelope.intensity.max,
  });
  const calm = () => ({
    intervalMs: envelope.intervalMs.max,
    batchSize: envelope.batchSize.min,
    intensity: envelope.intensity.min,
  });
  let settings: DirectorSettings = regular();
  let clock = 0,
    lastBatch = 0;
  let pending: { frame: DirectorFrame; at: number; first: boolean; viewer: string }[] = [];
  // Insertion-ordered maps: the oldest identity is evicted first when memory is full.
  const seen = new Map<string, number>(),
    participants = new Map<string, number>(),
    // Rotation memory: viewer id -> clock of their last presented turn (bounded, oldest evicted).
    turns = new Map<string, number>();
  let activity: number[] = [],
    interruptions: number[] = [];
  const counters = { accepted: 0, offered: 0, presented: 0, coalesced: 0, expired: 0, cleared: 0 };
  const decisions: DirectorSnapshot['decisions'] = [];
  let lastKind: Kind | null = null,
    adaptKind: Kind | null = null,
    limitReported = false;
  const batch = { batches: 0, presented: 0, coalesced: 0 };
  let expiredRun = 0;
  const sameSettings = (a: DirectorSettings, b: DirectorSettings) =>
    a.intervalMs === b.intervalMs && a.batchSize === b.batchSize && a.intensity === b.intensity;
  /** Append a decision, or refresh the latest one when it describes the same ongoing situation. */
  function record(kind: Kind, reason: string, merge = false) {
    const last = decisions.at(-1);
    const entry = {
      at: clock,
      reason,
      settings: { ...settings },
      pending: pending.length,
      activity: activity.length,
    };
    if (merge && last && lastKind === kind && sameSettings(last.settings, settings)) {
      decisions[decisions.length - 1] = { ...entry, at: last.at };
      return;
    }
    if (kind !== 'batch') Object.assign(batch, { batches: 0, presented: 0, coalesced: 0 });
    if (kind !== 'expired') expiredRun = 0;
    decisions.push(entry);
    lastKind = kind;
    if (decisions.length > DIRECTOR_LIMITS.decisions) decisions.shift();
  }
  function remember(map: Map<string, number>, key: string, ttl: number) {
    for (const [k, t] of map) {
      if (t > clock - ttl && map.size < DIRECTOR_LIMITS.identities) break;
      map.delete(k);
    }
    map.set(key, clock);
  }
  /**
   * Opportunity rotation: each contested slot goes to the pending viewer whose last turn is
   * oldest (never shown first). Ties keep arrival order, so replay is exact. A viewer picked
   * for this batch goes to the back, so a batch spreads across distinct viewers. Only
   * presentation order changes; accepted gameplay was already counted before enqueue.
   */
  function rotate(slots: number) {
    const rank = (viewer: string, picked: Set<string>) =>
      picked.has(viewer) ? Infinity : (turns.get(viewer) ?? -1);
    let rest = pending;
    const chosen: typeof pending = [];
    const picked = new Set<string>();
    while (chosen.length < slots && rest.length) {
      // reduce keeps the earliest arrival on equal rank, so ties stay in arrival order.
      const next = rest.reduce((best, p) =>
        rank(p.viewer, picked) < rank(best.viewer, picked) ? p : best,
      );
      chosen.push(next);
      picked.add(next.viewer);
      rest = rest.filter((p) => p !== next);
    }
    for (const viewer of picked) {
      turns.delete(viewer);
      remember(turns, viewer, DIRECTOR_LIMITS.participantTtlMs);
    }
    return chosen;
  }
  function advance(at: number) {
    if (!Number.isSafeInteger(at) || at < 0)
      throw new DirectorError('INVALID', 'Invalid director clock.');
    clock = Math.max(clock, at);
    activity = activity.filter((t) => t > clock - DIRECTOR_LIMITS.activityWindowMs);
    interruptions = interruptions.filter((t) => t > clock - DIRECTOR_LIMITS.interruptionWindowMs);
    const fresh = pending.filter((p) => p.at >= clock - DIRECTOR_LIMITS.freshnessMs);
    if (fresh.length < pending.length) {
      const stale = pending.length - fresh.length;
      counters.expired += stale;
      expiredRun += stale;
      pending = fresh;
      record(
        'expired',
        `${expiredRun} queued ${expiredRun === 1 ? 'effect' : 'effects'} waited longer than 5 s and expired. Accepted gameplay is unchanged.`,
        true,
      );
    }
  }
  function adapt() {
    if (mode === 'locked' || mode === 'manual') return;
    const busy =
      pending.length >= DIRECTOR_LIMITS.busyQueue ||
      activity.length >= DIRECTOR_LIMITS.busyActivity;
    const kind: Kind = mode === 'gameplay' ? 'gameplay' : busy ? 'calm' : 'regular';
    settings = kind === 'regular' ? regular() : calm();
    const reason =
      kind === 'gameplay'
        ? 'Gameplay focus: the approved calm settings keep attention on play.'
        : kind === 'calm'
          ? `Burst detected: ${activity.length} accepted actions in 10 s and ${pending.length} queued effects. Switched to the approved calm settings.`
          : 'Chat is readable. Using the approved regular settings.';
    if (kind !== adaptKind) {
      adaptKind = kind;
      record(kind, reason);
    } else if (lastKind === kind) record(kind, reason, true);
  }
  return {
    enqueue(input: DirectorInput) {
      advance(input.at);
      if (seen.has(input.key)) return;
      remember(seen, input.key, DIRECTOR_LIMITS.identityTtlMs);
      counters.accepted++;
      counters.offered += input.effects.length;
      if (activity.length < DIRECTOR_LIMITS.identities) activity.push(clock);
      const participant = JSON.stringify([input.roundId, input.viewerId]);
      const first = !participants.has(participant);
      if (first) remember(participants, participant, DIRECTOR_LIMITS.participantTtlMs);
      for (const [index, frame] of input.effects.entries()) {
        if (pending.length >= DIRECTOR_LIMITS.pending) {
          counters.coalesced++;
          continue;
        }
        pending.push({
          frame: structuredClone(frame),
          at: clock,
          first: first && index === 0,
          viewer: input.viewerId,
        });
      }
      adapt();
    },
    tick(at: number): DirectorFrame[] {
      advance(at);
      adapt();
      if (!pending.length || clock - lastBatch < settings.intervalMs) return [];
      if (interruptions.length >= envelope.interruptionsPerMinute) {
        if (!limitReported) {
          limitReported = true;
          record(
            'limit',
            `The approved limit of ${envelope.interruptionsPerMinute} interruptions per minute is reached; queued effects wait or expire. Gameplay remains counted.`,
          );
        }
        return [];
      }
      limitReported = false;
      if (envelope.participation === 'first-time')
        pending.sort((a, b) => Number(b.first) - Number(a.first));
      const chosen =
        envelope.participation === 'rotation'
          ? rotate(settings.batchSize)
          : pending.slice(0, settings.batchSize);
      const coalesced = pending.length - chosen.length;
      counters.coalesced += coalesced;
      counters.presented += chosen.length;
      interruptions.push(clock);
      lastBatch = clock;
      pending = [];
      if (lastKind !== 'batch') Object.assign(batch, { batches: 0, presented: 0, coalesced: 0 });
      batch.batches++;
      batch.presented += chosen.length;
      batch.coalesced += coalesced;
      record(
        'batch',
        `Showed ${batch.presented} ${batch.presented === 1 ? 'effect' : 'effects'} in ${batch.batches} ${batch.batches === 1 ? 'batch' : 'batches'} and merged ${batch.coalesced} extra. ${PARTICIPATION_REASON[envelope.participation]} Gameplay is unchanged.`,
        true,
      );
      return chosen.map((p) => ({ ...p.frame, intensity: settings.intensity }));
    },
    configure(next: DirectorMode, override?: DirectorSettings) {
      if (next === 'manual') {
        const result = directorSettingsSchema.safeParse(override);
        if (
          !result.success ||
          !Object.entries(result.data).every(([key, value]) => {
            const limit = envelope[key as keyof DirectorSettings];
            return value >= limit.min && value <= limit.max;
          })
        )
          throw new DirectorError(
            'BLOCKED',
            'These settings need a new envelope review. Competitive rule changes use behavior review.',
          );
        settings = result.data;
      }
      mode = next;
      adaptKind = null;
      adapt();
      record(
        'creator',
        next === 'locked'
          ? 'Creator locked the current settings; approved caps still apply.'
          : next === 'manual'
            ? 'Creator chose manual settings inside the approved ranges.'
            : next === 'gameplay'
              ? 'Creator chose gameplay focus.'
              : 'Creator chose balanced adaptation.',
      );
    },
    clear(reason: string, at: number) {
      advance(at);
      counters.cleared += pending.length;
      pending = [];
      record('clear', reason);
    },
    pendingIds() {
      return pending.map((p) => p.frame.id);
    },
    pendingCount() {
      return pending.length;
    },
    settings(): DirectorSettings {
      return { ...settings };
    },
    discard(count: number, reason: string) {
      const n = Math.min(counters.presented, Math.max(0, Math.floor(count)));
      counters.presented -= n;
      counters.cleared += n;
      record('clear', reason);
    },
    snapshot(): DirectorSnapshot {
      return structuredClone({ mode, settings, ...counters, pending: pending.length, decisions });
    },
  };
}
export type DirectorPolicy = ReturnType<typeof createDirectorPolicy>;
