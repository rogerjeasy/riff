import { HOST_LIMITS, TIMER_LIMITS, type ExecutionDecision, type TimerOp } from '@riff/sdk';
import { z } from 'zod';

export const timerNameSchema = z.string().regex(new RegExp(TIMER_LIMITS.namePattern));
export const timerDurationSchema = z
  .number()
  .int()
  .min(TIMER_LIMITS.durationMs.min)
  .max(TIMER_LIMITS.durationMs.max);
export const timerOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('start'),
      name: timerNameSchema,
      ms: timerDurationSchema,
      repeat: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal('cancel'), name: timerNameSchema }).strict(),
]);
const at = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 2 * TIMER_LIMITS.durationMs.max);
/** Normalized internal `timer.fired` event; distinct from every Twitch transport event. */
export const timerEventSchema = z
  .object({
    source: z.literal('timer.fired'),
    id: z.string().min(1).max(100),
    channelId: z.string().min(1).max(100),
    name: timerNameSchema,
    scheduledAt: at,
    firedAt: at,
    missed: z.boolean(),
    at,
  })
  .strict()
  .refine((event) => event.firedAt === event.at && event.scheduledAt <= event.at, {
    message: 'A timer fires at its delivery time, never before it is due',
  });
export type TimerFireEvent = z.infer<typeof timerEventSchema>;

/** One pending host-owned timer. Live hosts persist this; previews keep it in memory. */
export interface TimerEntry {
  name: string;
  intervalMs: number;
  repeat: boolean;
  scheduledAt: number;
  createdAt: number;
  fires: number;
}
export type TimerLateness = 'on-time' | 'missed' | 'expired';

/** Classify a delivery against the shared grace policy, identically at runtime and after boot. */
export function timerLateness(scheduledAt: number, at: number): TimerLateness {
  const late = at - scheduledAt;
  if (late > TIMER_LIMITS.missedGraceMs) return 'expired';
  return late > TIMER_LIMITS.lateToleranceMs ? 'missed' : 'on-time';
}

/** The next slot strictly after `at` on the timer's original cadence (no catch-up burst). */
export function nextTimerSlot(entry: Pick<TimerEntry, 'scheduledAt' | 'intervalMs'>, at: number) {
  if (entry.scheduledAt > at) return entry.scheduledAt;
  const skipped = Math.floor((at - entry.scheduledAt) / entry.intervalMs) + 1;
  return entry.scheduledAt + skipped * entry.intervalMs;
}

/**
 * Apply staged operations in order to a name-keyed table. Restarting a name replaces it
 * from `at`; cancelling an unknown name is a no-op. Returns the names that changed.
 */
export function applyTimerOps(
  table: Map<string, TimerEntry>,
  ops: readonly TimerOp[],
  at: number,
): string[] {
  const changed: string[] = [];
  for (const raw of ops) {
    const op = timerOpSchema.parse(raw);
    if (op.op === 'cancel') {
      if (table.delete(op.name)) changed.push(op.name);
      continue;
    }
    if (!table.has(op.name) && table.size >= TIMER_LIMITS.maxPerAutomation)
      throw new Error('Timer limit exceeded');
    table.set(op.name, {
      name: op.name,
      intervalMs: op.ms,
      repeat: op.repeat,
      scheduledAt: at + op.ms,
      createdAt: at,
      fires: 0,
    });
    changed.push(op.name);
  }
  return changed;
}

/** Engine surface needed to deliver a timer fire; avoids a circular import. */
interface TimerDispatcher {
  dispatchTimer(event: unknown): Promise<ExecutionDecision>;
}
export interface VirtualTimerFire {
  name: string;
  scheduledAt: number;
  firedAt: number;
  decision: ExecutionDecision;
}
export interface VirtualAdvance {
  fires: VirtualTimerFire[];
  /** Repeating slots skipped because one advance reached its fire bound. */
  skipped: number;
}

/**
 * Private virtual-clock timer store for previews, scenarios and rehearsal. It never
 * touches the live scheduler: a fresh store belongs to one fresh preview engine.
 */
export function createVirtualTimers(channel: string | (() => string)) {
  const channelOf = typeof channel === 'string' ? () => channel : channel;
  const table = new Map<string, TimerEntry>();
  let sequence = 0;
  return {
    active: () => [...table.keys()],
    entries: () => [...table.values()].map((entry) => ({ ...entry })),
    /** Apply an accepted decision's staged timer operations at its event time. */
    apply(decision: ExecutionDecision) {
      if (decision.code !== 'ACCEPTED' || !decision.timers?.length || decision.at === null) return;
      applyTimerOps(table, decision.timers, decision.at);
    },
    /**
     * Advance the virtual clock to `to`, firing due timers in due order. Virtual fires
     * are delivered exactly on time, so `missed` is always false here.
     */
    async advance(engine: TimerDispatcher, to: number): Promise<VirtualAdvance> {
      const fires: VirtualTimerFire[] = [];
      let skipped = 0;
      for (;;) {
        const next = [...table.values()]
          .filter((entry) => entry.scheduledAt <= to)
          .sort((a, b) => a.scheduledAt - b.scheduledAt || a.name.localeCompare(b.name))[0];
        if (!next) break;
        if (fires.length >= TIMER_LIMITS.previewFiresPerAdvance) {
          for (const entry of [...table.values()].filter((e) => e.scheduledAt <= to)) {
            if (!entry.repeat) {
              table.delete(entry.name);
              skipped++;
              continue;
            }
            const slot = nextTimerSlot(entry, to);
            skipped += Math.round((slot - entry.scheduledAt) / entry.intervalMs);
            entry.scheduledAt = slot;
          }
          break;
        }
        const scheduledAt = next.scheduledAt;
        if (next.repeat) {
          next.scheduledAt = scheduledAt + next.intervalMs;
          next.fires++;
        } else table.delete(next.name);
        const id = `timer:${next.name}:${++sequence}:${scheduledAt}`.slice(0, 100);
        const decision = await engine.dispatchTimer({
          source: 'timer.fired',
          id,
          channelId: channelOf(),
          name: next.name,
          scheduledAt,
          firedAt: scheduledAt,
          missed: false,
          at: scheduledAt,
        });
        this.apply(decision);
        fires.push({ name: next.name, scheduledAt, firedAt: scheduledAt, decision });
        if (decision.code === 'INCIDENT') {
          table.clear();
          break;
        }
        if (sequence >= HOST_LIMITS.previewEvents) break;
      }
      return { fires, skipped };
    },
  };
}
export type VirtualTimers = ReturnType<typeof createVirtualTimers>;
