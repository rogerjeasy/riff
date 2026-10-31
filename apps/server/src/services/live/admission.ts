import { createAdmissionState, type AdmissionState } from '@riff/sandbox';
import { HOST_LIMITS, TRIGGER_LIMITS, type DecisionCode } from '@riff/sdk';
import type { AdmissionRow } from '../../db/repositories/admission.js';

/** Longest span any counter looks back: the widest rolling window or the dedupe window. */
export const ADMISSION_RETENTION_MS = Math.max(
  TRIGGER_LIMITS.windowMs.max,
  HOST_LIMITS.dedupeWindowMs,
);
const CHANNEL_WINDOW_MS = 60_000;
// Decisions that never matched the interaction or never reached admission carry no
// allowance, budget or identity worth keeping.
const UNRECORDED: ReadonlySet<DecisionCode> = new Set([
  'UNRELATED',
  'INVALID_EVENT',
  'STOPPED',
  'DISABLED',
  'DUPLICATE',
  'CAPACITY',
]);
export const recordsAdmission = (code: DecisionCode) => !UNRECORDED.has(code);

/**
 * Rebuild one interaction's host counters exactly as the engine maintains them:
 * seen identities in arrival order, accepted actions per viewer, and emitted effects.
 */
export function restoreAdmission(
  rows: readonly AdmissionRow[],
  automationId: string,
): AdmissionState {
  const state = createAdmissionState();
  for (const row of rows) {
    if (row.automationId !== automationId) continue;
    state.lastAt = Math.max(state.lastAt, row.at);
    state.seen.set(row.eventId, row.at);
    if (row.code !== 'ACCEPTED' || row.effects === 0) continue;
    const history = state.viewers.get(row.viewerId) ?? [];
    history.push(row.at);
    state.viewers.set(row.viewerId, history);
    for (let i = 0; i < row.effects; i++) state.effects.push(row.at);
  }
  return state;
}

/** Effects every interaction on the channel emitted in the last minute. */
export function restoreChannelEffects(rows: readonly AdmissionRow[], now: number): number[] {
  return rows.flatMap((row) =>
    row.code === 'ACCEPTED' && row.at > now - CHANNEL_WINDOW_MS
      ? Array.from({ length: row.effects }, () => row.at)
      : [],
  );
}
