import {
  nextTimerSlot,
  timerLateness,
  type ExecutionEngine,
  type TimerFireEvent,
} from '@riff/sandbox';
import { TIMER_LIMITS, type ExecutionDecision } from '@riff/sdk';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { TimerRow } from '../../db/repositories/timers.js';
import { recordsAdmission } from '../live/admission.js';

/** Console projection of one pending timer; no guest data beyond the declared name. */
export interface TimerView {
  id: string;
  automationId: string;
  versionId: string;
  name: string;
  intervalMs: number;
  repeat: boolean;
  scheduledAt: number;
  createdAt: number;
  fires: number;
}
type ActivityEntry = Parameters<ChannelRepository['record']>[0];
export interface LiveTimerTarget {
  engine: Pick<ExecutionEngine, 'dispatchTimer'>;
  /** Transport channel the engine is bound to, so fires match its chat identity. */
  channelId: string;
  version: Pick<VersionRow, 'id' | 'number'>;
}
export interface TimerFire {
  row: TimerRow;
  event: TimerFireEvent;
  decision: ExecutionDecision;
  target: LiveTimerTarget;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * Persisted host scheduler for named timers. Guests only stage operations; this service
 * owns due times, restart replacement, cancellation and the restart grace policy. Fires
 * go through the live engine (admission, budgets, sandbox) with a durable dedupe id.
 */
export function createTimerScheduler(deps: {
  repo: ChannelRepository;
  record: (entry: ActivityEntry) => void;
}) {
  const { repo, record } = deps;
  const control = (
    automationId: string | null,
    versionId: string | null,
    code: string,
    message: string,
  ) =>
    record({
      at: Date.now(),
      kind: 'control',
      automationId,
      versionId,
      eventId: null,
      viewer: null,
      code,
      message,
    });
  return {
    views(automationId?: string): TimerView[] {
      return repo.timers(automationId).map((row) => ({
        id: row.id,
        automationId: row.automationId,
        versionId: row.versionId,
        name: row.name,
        intervalMs: row.intervalMs,
        repeat: row.repeat,
        scheduledAt: row.scheduledAt,
        createdAt: row.createdAt,
        fires: row.fires,
      }));
    },
    active(automationId: string) {
      return repo.timers(automationId).map((row) => row.name);
    },
    /** Apply an accepted decision's staged operations; anything else stages nothing. */
    apply(automationId: string, versionId: string, decision: ExecutionDecision) {
      if (decision.code !== 'ACCEPTED' || !decision.timers?.length || decision.at === null)
        return [];
      return repo.applyTimerOps(
        automationId,
        versionId,
        decision.timers,
        decision.at,
        decision.eventId,
      );
    },
    /**
     * Cancel pending timers. Runs after the in-memory fence, so a failed delete can only
     * leave rows that boot/resume reconciliation removes before anything fires.
     */
    cancel(automationId: string | null, reason: string, name?: string) {
      const removed = repo.cancelTimers(automationId ?? undefined, name);
      if (removed)
        control(
          automationId,
          null,
          'TIMER_CANCELLED',
          `${removed === 1 && name ? `Timer “${name}”` : `${removed} pending timer${removed === 1 ? '' : 's'}`} cancelled: ${reason}.`,
        );
      return removed;
    },
    /** Boot: keep only timers owned by the version that is live right now. */
    reconcile(live: (automationId: string) => string | null) {
      for (const row of repo.timers()) {
        if (live(row.automationId) === row.versionId) continue;
        repo.cancelTimers(row.automationId);
        control(
          row.automationId,
          row.versionId,
          'TIMER_CANCELLED',
          `Timers for an interaction that is no longer live were cancelled on restart.`,
        );
      }
    },
    /**
     * Deliver every due timer once. Fires at most `missedGraceMs` late are delivered with
     * `missed: true`; older ones are skipped and logged. Repeating timers re-arm on their
     * original cadence before the handler runs, so the handler may still cancel them.
     */
    async fireDue(
      at: number,
      target: (automationId: string) => LiveTimerTarget | undefined,
      onFire: (fire: TimerFire) => Promise<void> | void,
      valid: () => boolean,
    ) {
      for (const row of repo.dueTimers(at)) {
        if (!valid()) return;
        const live = target(row.automationId);
        if (!live || live.version.id !== row.versionId) {
          this.cancel(row.automationId, 'its version is no longer live');
          continue;
        }
        const next = row.repeat ? nextTimerSlot(row, at) : null;
        const lateness = timerLateness(row.scheduledAt, at);
        if (lateness === 'expired') {
          repo.settleTimer(row.id, next);
          control(
            row.automationId,
            row.versionId,
            'TIMER_EXPIRED',
            `Timer “${row.name}” was due ${seconds(at - row.scheduledAt)} ago, beyond the ${seconds(TIMER_LIMITS.missedGraceMs)} grace window, so it was skipped${next === null ? '' : ' and re-armed for its next slot'}.`,
          );
          continue;
        }
        const event: TimerFireEvent = {
          source: 'timer.fired',
          id: `timer:${row.id}:${row.scheduledAt}`,
          channelId: live.channelId,
          name: row.name,
          scheduledAt: row.scheduledAt,
          firedAt: at,
          missed: lateness === 'missed',
          at,
        };
        // A durable decision means this exact fire already ran before a crash.
        if (repo.hasAdmission(row.automationId, event.id)) {
          repo.settleTimer(row.id, next);
          continue;
        }
        const decision = await live.engine.dispatchTimer(event);
        if (recordsAdmission(decision.code))
          repo.recordAdmission({
            automationId: row.automationId,
            eventId: event.id,
            viewerId: `timer:${row.name}`,
            at,
            code: decision.code,
            effects: decision.effects.length + (decision.actions?.length ?? 0),
          });
        repo.settleTimer(row.id, next);
        await onFire({ row, event, decision, target: live });
      }
    },
  };
}
export type TimerScheduler = ReturnType<typeof createTimerScheduler>;
