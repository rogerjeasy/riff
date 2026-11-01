import { artifactSchema } from './contract.js';
import { runRehearsal, type RehearsalCheck, type RehearsalResult } from './rehearsal.js';
import {
  assertRehearsalActive,
  rehearsalHash,
  rehearsalScenarioSchema,
  REHEARSAL_LIMITS,
  RehearsalError,
  type RehearsalScenario,
} from './rehearsal-contract.js';

export type RehearsalFailure = Pick<
  RehearsalCheck,
  'id' | 'stepKey' | 'category' | 'kind' | 'expected' | 'actual'
>;
export interface MinimizeCounterexampleInput {
  artifact: unknown;
  scenario: unknown;
  /** Exact failed check id from an immutable full run. */
  checkId: string;
  signal?: AbortSignal;
}
export interface MinimizedCounterexample {
  scenario: RehearsalScenario;
  run: RehearsalResult;
  checkId: string;
  failure: RehearsalFailure;
  originalEvidenceHash: string;
  originalStepCount: number;
  removedSteps: number;
  /** Includes original baseline, candidate replays and final validation. */
  attempts: number;
  /** Conservatively charges every applied step, including controls in all replays. */
  dispatchedSteps: number;
  budgetStopped: boolean;
}
function identity(check: RehearsalCheck): RehearsalFailure {
  const { id, stepKey, category, kind, expected, actual } = check;
  return { id, stepKey, category, kind, expected, actual };
}
/** Bounded chunk reduction preserving the selected failure, never a global minimality claim. */
export async function minimizeCounterexample(
  input: MinimizeCounterexampleInput,
): Promise<MinimizedCounterexample> {
  assertRehearsalActive(input.signal);
  const parsed = rehearsalScenarioSchema.safeParse(input.scenario);
  if (!parsed.success)
    throw new RehearsalError('INVALID_SCENARIO', 'Invalid counterexample scenario.');
  const original = parsed.data;
  const artifact = artifactSchema.parse(input.artifact);
  const baseline = await runRehearsal({
    artifact,
    scenario: original,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const selected = baseline.checks.find((c) => c.id === input.checkId && c.status === 'failed');
  if (!selected)
    throw new RehearsalError('INVALID_CHECK', 'Select a failed check from the full rehearsal run.');
  const failure = identity(selected);
  const signature = rehearsalHash(failure);
  const reproduces = (run: RehearsalResult) =>
    run.checks.some((c) => c.status === 'failed' && rehearsalHash(identity(c)) === signature);
  let best = original;
  let attempts = 1;
  let dispatchedSteps = original.steps.length;
  let budgetStopped = false;
  let partitions = 2;
  reduction: while (best.steps.length > 1) {
    assertRehearsalActive(input.signal);
    const removable = best.steps.filter((s) => s.key !== selected.stepKey);
    if (!removable.length) break;
    const chunkSize = Math.ceil(removable.length / partitions);
    let accepted = false;
    for (let offset = 0; offset < removable.length; offset += chunkSize) {
      assertRehearsalActive(input.signal);
      const removed = new Set(removable.slice(offset, offset + chunkSize).map((s) => s.key));
      const steps = best.steps.filter((s) => !removed.has(s.key));
      const candidate: RehearsalScenario = {
        ...best,
        steps,
        expectations: best.expectations.filter((c) => !removed.has(c.stepKey)),
        provenance: { kind: 'synthetic-derivative', sourceScenarioHash: baseline.scenarioHash },
      };
      // Derivative metadata can cost more bytes than a small deletion saves.
      if (!rehearsalScenarioSchema.safeParse(candidate).success) continue;
      // Always reserve a full final validation of the current best, including controls.
      if (
        attempts + 1 >= REHEARSAL_LIMITS.minimizationReplays ||
        dispatchedSteps + steps.length + best.steps.length > REHEARSAL_LIMITS.minimizationSteps
      ) {
        budgetStopped = true;
        break reduction;
      }
      attempts++;
      dispatchedSteps += steps.length;
      const run = await runRehearsal({
        artifact,
        scenario: candidate,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (reproduces(run)) {
        best = candidate;
        partitions = 2;
        accepted = true;
        break;
      }
    }
    if (!accepted) {
      if (partitions >= removable.length) break;
      partitions = Math.min(removable.length, partitions * 2);
    }
  }
  assertRehearsalActive(input.signal);
  attempts++;
  dispatchedSteps += best.steps.length;
  const run = await runRehearsal({
    artifact,
    scenario: best,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!reproduces(run))
    throw new RehearsalError(
      'INVALID_CHECK',
      'Selected failure did not reproduce during final validation.',
    );
  return {
    scenario: best,
    run,
    checkId: input.checkId,
    failure,
    originalEvidenceHash: baseline.evidenceHash,
    originalStepCount: original.steps.length,
    removedSteps: original.steps.length - best.steps.length,
    attempts,
    dispatchedSteps,
    budgetStopped,
  };
}
