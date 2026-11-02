import type { DecisionCode, ExecutionDecision, SessionSnapshot } from '@riff/sdk';
import { createVirtualTimers } from './timers.js';
import { artifactSchema } from './contract.js';
import { createAdmissionState, createEngine } from './engine.js';
import {
  advanceSession,
  createSessionSnapshot,
  pauseSession,
  resumeSession,
  validateSessionSnapshot,
} from './session.js';
import {
  assertRehearsalActive,
  rehearsalHash,
  rehearsalScenarioSchema,
  REHEARSAL_CONTRACT_VERSION,
  REHEARSAL_LIMITS,
  RehearsalError,
  type RehearsalExpectation,
  type RehearsalProvenance,
  type RehearsalStep,
} from './rehearsal-contract.js';

export type RehearsalDecision = Omit<ExecutionDecision, 'session'>;
export interface RehearsalFrame {
  /** Cursor after applying this step (one-based). */
  through: number;
  key: string;
  kind: RehearsalStep['kind'];
  at: number;
  decision: RehearsalDecision | null;
  stateDigest: string;
  /**
   * Compact presentation projection of the session after this step, so a client can
   * animate a whole replay without one request per step. The full state is already
   * bound by `stateDigest`; this projection is excluded from `evidenceHash`.
   */
  summary?: RehearsalFrameSummary | null;
  /**
   * Timer fires the virtual clock delivered before this step, in due order. Present only
   * when at least one fired; part of the evidence.
   */
  timers?: RehearsalTimerFire[];
}
export interface RehearsalTimerFire {
  name: string;
  at: number;
  code: DecisionCode;
  effects: number;
}
export interface RehearsalFrameSummary {
  phase: SessionSnapshot['phase'];
  remainingMs: number;
  scores: Record<string, number>;
  winner: string | null;
}
export interface RehearsalCheck {
  id: string;
  stepKey: string;
  category: 'expectation' | 'invariant';
  kind: RehearsalExpectation['kind'] | 'quarantine' | 'consistency';
  status: 'passed' | 'failed' | 'pending';
  expected: string | number | null;
  actual: string | number | null;
  summary: string;
}
export interface RehearsalResult {
  contractVersion: typeof REHEARSAL_CONTRACT_VERSION;
  artifactId: string;
  scenarioHash: string;
  evidenceHash: string;
  seed: number;
  initialAt: number;
  provenance: RehearsalProvenance;
  through: number;
  totalSteps: number;
  status: 'passed' | 'failed' | 'incomplete';
  timeline: RehearsalFrame[];
  cursor: {
    at: number;
    session: SessionSnapshot | null;
    stateDigest: string;
    decision: RehearsalDecision | null;
  };
  checks: RehearsalCheck[];
}
export interface RunRehearsalInput {
  artifact: unknown;
  scenario: unknown;
  /** Number of applied steps. Zero is the origin; omitted means all steps. */
  through?: number;
  signal?: AbortSignal;
}
function expectedActual(
  check: RehearsalExpectation,
  decision: RehearsalDecision | null,
  session: SessionSnapshot | null,
): string | number | null {
  switch (check.kind) {
    case 'decision':
      return decision?.code ?? null;
    case 'effects':
      return decision?.effects.length ?? 0;
    case 'phase':
      return session?.phase ?? null;
    case 'score':
      return session && Object.hasOwn(session.scores, check.teamId)
        ? (session.scores[check.teamId] ?? null)
        : null;
    case 'remaining':
      return session && Object.hasOwn(session.participants, check.viewerId)
        ? (session.participants[check.viewerId]?.remaining ?? null)
        : null;
  }
}
/** Replay a bounded prefix from a fixed origin in a new private engine; never accepts live sinks. */
export async function runRehearsal(input: RunRehearsalInput): Promise<RehearsalResult> {
  assertRehearsalActive(input.signal);
  const parsed = rehearsalScenarioSchema.safeParse(input.scenario);
  if (!parsed.success)
    throw new RehearsalError(
      'INVALID_SCENARIO',
      'Invalid rehearsal scenario. Check bounds, step keys and control times.',
    );
  const scenario = parsed.data;
  const artifact = artifactSchema.parse(input.artifact);
  const through = input.through ?? scenario.steps.length;
  if (!Number.isInteger(through) || through < 0 || through > scenario.steps.length)
    throw new RehearsalError(
      'INVALID_CURSOR',
      'Cursor must count steps from zero to the scenario end.',
    );
  const definition = artifact.manifest.experience;
  if (!definition && scenario.steps.some((s) => s.kind === 'pause' || s.kind === 'resume'))
    throw new RehearsalError('INVALID_SCENARIO', 'Pause and resume require a stateful experience.');
  let session: SessionSnapshot | null = null;
  try {
    if (scenario.initialSession) {
      if (!definition) throw new Error('No experience');
      session = advanceSession(
        validateSessionSnapshot(definition, scenario.initialSession),
        scenario.initialAt,
        definition,
      );
    } else if (definition)
      session = createSessionSnapshot(definition, scenario.initialAt, 'rehearsal');
  } catch {
    throw new RehearsalError(
      'INCOMPATIBLE_SESSION',
      'Initial snapshot is incompatible with this experience or origin. Start a fresh scenario.',
    );
  }
  const admission = createAdmissionState();
  admission.lastAt = scenario.initialAt;
  // Rehearsal timers live on this scenario's virtual clock, never the live scheduler.
  const timers = createVirtualTimers(() => admission.channelId || 'rehearsal');
  const timed = artifact.manifest.capabilities.includes('timer');
  const engine = createEngine(artifact, {
    seed: scenario.seed,
    mode: 'preview',
    admission,
    timers,
    ...(session ? { session } : {}),
  });
  const stop = () => engine.stop();
  input.signal?.addEventListener('abort', stop, { once: true });
  let clock = scenario.initialAt;
  const digest = () =>
    rehearsalHash({
      at: clock,
      session,
      status: engine.status,
      admission: {
        channelId: admission.channelId,
        lastAt: admission.lastAt,
        viewers: Object.fromEntries(admission.viewers),
        effects: admission.effects,
        seen: Object.fromEntries(admission.seen),
      },
      ...(timed ? { timers: timers.entries() } : {}),
    });
  const checks: RehearsalCheck[] = scenario.expectations.map((check) => ({
    id: `expect:${check.id}`,
    stepKey: check.stepKey,
    category: 'expectation',
    kind: check.kind,
    status: 'pending',
    expected: check.value,
    actual: null,
    summary: 'Step has not been applied.',
  }));
  const timeline: RehearsalFrame[] = [];
  const summaries: (RehearsalFrameSummary | null)[] = [];
  try {
    assertRehearsalActive(input.signal);
    for (const step of scenario.steps.slice(0, through)) {
      assertRehearsalActive(input.signal);
      let decision: RehearsalDecision | null = null;
      const time = step.kind === 'chat' ? step.event.at : step.at;
      const fires = timed ? (await timers.advance(engine, time)).fires : [];
      clock = Math.max(clock, time);
      if (step.kind === 'chat') {
        const compact = await engine.dispatch(step.event);
        timers.apply(compact);
        delete compact.session;
        decision = { ...compact, reason: compact.reason.slice(0, REHEARSAL_LIMITS.summaryLength) };
      } else {
        if (definition && session) {
          session =
            step.kind === 'pause'
              ? pauseSession(session, time, definition)
              : step.kind === 'resume'
                ? resumeSession(session, time)
                : advanceSession(session, time, definition);
          engine.restoreSession(session);
        }
        // Stateless advances must also fence late chat; this admission state is private.
        admission.lastAt = time;
      }
      assertRehearsalActive(input.signal);
      session = engine.session;
      let consistent = true;
      if (session && definition) {
        try {
          validateSessionSnapshot(definition, session);
        } catch {
          consistent = false;
        }
      }
      const failed = engine.status === 'quarantined';
      checks.push(
        {
          id: `auto:${step.key}:quarantine`,
          stepKey: step.key,
          category: 'invariant',
          kind: 'quarantine',
          status: failed ? 'failed' : 'passed',
          expected: 'ready',
          actual: failed ? (decision?.code ?? 'quarantined') : 'ready',
          summary: failed ? 'Host quarantined the handler.' : 'No quarantine.',
        },
        {
          id: `auto:${step.key}:consistency`,
          stepKey: step.key,
          category: 'invariant',
          kind: 'consistency',
          status: consistent ? 'passed' : 'failed',
          expected: 'consistent',
          actual: consistent ? 'consistent' : 'inconsistent',
          summary: consistent
            ? 'Host state is consistent.'
            : 'Host state violates the experience definition.',
        },
      );
      for (const expectation of scenario.expectations.filter((c) => c.stepKey === step.key)) {
        const check = checks.find((c) => c.id === `expect:${expectation.id}`);
        if (!check) continue;
        check.actual = expectedActual(expectation, decision, session);
        check.status = check.actual === check.expected ? 'passed' : 'failed';
        check.summary =
          check.status === 'passed'
            ? 'Creator expectation matched.'
            : 'Creator expectation did not match the host outcome.';
      }
      timeline.push({
        through: timeline.length + 1,
        key: step.key,
        kind: step.kind,
        at: clock,
        decision,
        stateDigest: digest(),
        ...(fires.length
          ? {
              timers: fires.map((fire) => ({
                name: fire.name,
                at: fire.firedAt,
                code: fire.decision.code,
                effects: fire.decision.effects.length + (fire.decision.actions?.length ?? 0),
              })),
            }
          : {}),
      });
      summaries.push(
        session
          ? {
              phase: session.phase,
              remainingMs: session.remainingMs,
              scores: { ...session.scores },
              winner: session.winner,
            }
          : null,
      );
    }
    const evidence: Omit<RehearsalResult, 'evidenceHash'> = {
      contractVersion: REHEARSAL_CONTRACT_VERSION,
      artifactId: engine.artifactId,
      scenarioHash: rehearsalHash(scenario),
      seed: scenario.seed,
      initialAt: scenario.initialAt,
      provenance: scenario.provenance,
      through,
      totalSteps: scenario.steps.length,
      status: checks.some((c) => c.status === 'failed')
        ? 'failed'
        : through < scenario.steps.length
          ? 'incomplete'
          : 'passed',
      timeline,
      cursor: {
        at: clock,
        session,
        stateDigest: digest(),
        decision: timeline.at(-1)?.decision ?? null,
      },
      checks,
    };
    const result: RehearsalResult = {
      ...evidence,
      evidenceHash: rehearsalHash(evidence),
      timeline: timeline.map((frame, i) => ({ ...frame, summary: summaries[i] ?? null })),
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > REHEARSAL_LIMITS.resultBytes)
      throw new RehearsalError(
        'RESULT_LIMIT',
        'Rehearsal evidence exceeds the bounded response size. Use a smaller scenario.',
      );
    return result;
  } finally {
    input.signal?.removeEventListener('abort', stop);
    engine.stop();
  }
}
