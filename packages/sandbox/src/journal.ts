import { createHash } from 'node:crypto';
import type { ChatEvent, DecisionCode, ExperienceDefinition, SessionSnapshot } from '@riff/sdk';
import { createEngine, type ExecutionEngine } from './engine.js';
import {
  advanceSession,
  createSessionSnapshot,
  pauseSession,
  resumeSession,
  sessionDefinitionSchema,
  validateSessionSnapshot,
} from './session.js';

/** Host transitions that change a round without chat input. */
export type ControlTransition = 'pause' | 'resume' | 'advance';

/**
 * One durable round transition, written in the same transaction as the state it
 * produced. `digest` fingerprints that resulting state so an audit can name the first
 * transition that does not reproduce.
 */
export type JournalEntry = { seq: number; at: number; versionId: string; digest: string } & (
  | { kind: 'start'; snapshot: SessionSnapshot }
  | { kind: 'chat'; event: ChatEvent; code: DecisionCode }
  | { kind: ControlTransition }
);

export interface SessionAudit {
  status: 'verified' | 'diverged' | 'unavailable';
  sessionId: string;
  /** Plain-language result for the console. */
  summary: string;
  entries: number;
  joins: number;
  contributions: number;
  rejections: number;
  controls: number;
  durationMs: number;
  divergence: { seq: number; kind: JournalEntry['kind']; expected: string; actual: string } | null;
  replayed: SessionSnapshot | null;
}

/** Largest journal an on-demand audit replays; longer rounds report `unavailable`. */
export const AUDIT_MAX_ENTRIES = 20_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/** Order-independent fingerprint of a snapshot. Example: sessionDigest(snapshot). */
export function sessionDigest(snapshot: SessionSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(snapshot)))
    .digest('hex')
    .slice(0, 16);
}

/** Name the pure host function that turns `before` into `after`. */
export function classifyTransition(
  before: SessionSnapshot,
  after: SessionSnapshot,
): ControlTransition {
  if (before.phase === 'running' && after.phase === 'paused') return 'pause';
  if (before.phase === 'paused' && after.phase === 'running') return 'resume';
  return 'advance';
}

/**
 * Rebuild a live round from its journal in isolated preview engines and compare every
 * intermediate state and the stored result. Preview engines have no overlay, Twitch
 * or database route, so an audit can never produce a live effect.
 */
export async function replaySessionJournal(input: {
  definition: ExperienceDefinition;
  entries: readonly JournalEntry[];
  expected: SessionSnapshot;
  artifactFor: (versionId: string) => { source: string; manifest: unknown } | null;
  signal?: AbortSignal;
}): Promise<SessionAudit> {
  const started = performance.now();
  const definition = sessionDefinitionSchema.parse(input.definition);
  const counts = { joins: 0, contributions: 0, rejections: 0, controls: 0 };
  const result = (
    status: SessionAudit['status'],
    summary: string,
    replayed: SessionSnapshot | null,
    divergence: SessionAudit['divergence'] = null,
  ): SessionAudit => ({
    status,
    sessionId: input.expected.id,
    summary,
    entries: input.entries.length,
    ...counts,
    durationMs: Math.round(performance.now() - started),
    divergence,
    replayed,
  });
  const [first] = input.entries;
  if (first?.kind !== 'start')
    return result(
      'unavailable',
      'This round started before Riff kept a round journal. Reset the session to begin an auditable round.',
      null,
    );
  if (input.entries.length > AUDIT_MAX_ENTRIES)
    return result(
      'unavailable',
      `This round has ${input.entries.length} journal entries; audits replay at most ${AUDIT_MAX_ENTRIES}.`,
      null,
    );
  const engines = new Map<string, ExecutionEngine>();
  let state: SessionSnapshot | null = null;
  try {
    for (const entry of input.entries) {
      if (input.signal?.aborted) return result('unavailable', 'The audit was cancelled.', null);
      const fail = (expected: string, actual: string) =>
        result(
          'diverged',
          `Entry ${entry.seq} (${entry.kind}) does not reproduce: expected ${expected}, replay produced ${actual}.`,
          state,
          { seq: entry.seq, kind: entry.kind, expected, actual },
        );
      if (entry.kind === 'start') {
        if (state) return fail('one round start', 'a second start');
        const fresh = createSessionSnapshot(
          definition,
          entry.snapshot.startedAt,
          entry.snapshot.id,
        );
        if (sessionDigest(fresh) !== sessionDigest(entry.snapshot))
          return fail('a fresh round', 'a pre-filled starting state');
        state = fresh;
      } else if (!state) {
        return fail('a round start', entry.kind);
      } else if (entry.kind === 'chat') {
        let engine = engines.get(entry.versionId);
        if (!engine) {
          const artifact = input.artifactFor(entry.versionId);
          if (!artifact) return fail(`version ${entry.versionId}`, 'a missing version');
          engine = createEngine(artifact, { seed: 1, mode: 'preview' });
          engines.set(entry.versionId, engine);
        }
        engine.restoreSession(state);
        const decision = await engine.dispatch(entry.event);
        if (decision.code !== entry.code) return fail(entry.code, decision.code);
        if (!engine.session) return fail('a session', 'no session');
        state = engine.session;
        const text = entry.event.text.trim().toLowerCase();
        if (decision.code === 'ACCEPTED')
          counts[
            definition.teams.some((t) => t.joinCommand === text) ? 'joins' : 'contributions'
          ]++;
        else if (decision.code !== 'UNRELATED') counts.rejections++;
      } else {
        counts.controls++;
        state =
          entry.kind === 'pause'
            ? pauseSession(state, entry.at, definition)
            : entry.kind === 'resume'
              ? resumeSession(state, entry.at)
              : advanceSession(state, entry.at, definition);
      }
      const digest = sessionDigest(state);
      if (digest !== entry.digest) return fail(`state ${entry.digest}`, `state ${digest}`);
    }
    if (!state) return result('unavailable', 'The journal has no round start.', null);
    validateSessionSnapshot(definition, state);
    const stored = sessionDigest(input.expected);
    const replayed = sessionDigest(state);
    if (stored !== replayed)
      return result(
        'diverged',
        'The journal replays cleanly but does not reproduce the stored round state.',
        state,
        {
          seq: input.entries.at(-1)?.seq ?? 0,
          kind: 'advance',
          expected: stored,
          actual: replayed,
        },
      );
    return result('verified', 'Every recorded decision and transition reproduced exactly.', state);
  } finally {
    for (const engine of engines.values()) engine.stop();
  }
}
