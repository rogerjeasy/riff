import { ApiError } from '../../lib/api.js';
import type { DecisionCode, ExperienceDefinition } from '../../lib/types.js';
import { CODE_LABEL } from '../format.js';
import type {
  Expectation,
  RehearsalResult,
  RehearsalScenario,
  RehearsalStep,
  presets,
} from './contracts.js';

type Preset = (typeof presets)[number];
type Check = RehearsalResult['checks'][number];

/** Plain-language preset names; the host still builds every input from the manifest. */
export const PRESET_TEXT: Record<Preset, { title: string; detail: string }> = {
  proof: { title: 'Proof', detail: 'Unrelated chat, an ineligible viewer, then one real use.' },
  'crowd-burst': { title: 'Crowd burst', detail: 'Up to 40 viewers use it at the same moment.' },
  'duplicate-delivery': {
    title: 'Duplicate delivery',
    detail: 'Twitch delivers the same message twice; it must count once.',
  },
  'late-arrival': { title: 'Late arrival', detail: 'Someone shows up halfway through.' },
  exhaustion: { title: 'Run out', detail: 'One viewer keeps going past their allowance.' },
  deadline: { title: 'Deadline', detail: 'A viewer acts after time is up.' },
  burst: {
    title: 'Distinct burst',
    detail: 'Different viewers fill the burst window; a repeat viewer counts once.',
  },
  elimination: {
    title: 'Elimination',
    detail: 'One team attacks until another reaches 0 health.',
  },
  match: { title: 'Best of N', detail: 'Rounds reset at the deadline until the match ends.' },
  unlock: {
    title: 'Unlock',
    detail: 'A locked command opens once the milestone score is reached.',
  },
  paint: {
    title: 'Paint',
    detail: 'Viewers paint cells; an invalid color and a repainted cell are checked.',
  },
  stages: {
    title: 'Stages',
    detail: 'Two viewers vote in every stage; a second vote in a stage is refused.',
  },
  answers: {
    title: 'Answers',
    detail: 'Right and wrong answers per question; late answers hit the reveal window.',
  },
};

/** Mechanic presets appear only when the exact definition has that rule. */
export function presetApplies(
  preset: Preset,
  definition: ExperienceDefinition | null | undefined,
): boolean {
  const m = definition?.mechanics;
  switch (preset) {
    case 'burst':
      return Boolean(m?.burst);
    case 'elimination':
      return Boolean(m?.health);
    case 'match':
      return Boolean(m?.match);
    case 'unlock':
      return Boolean(m?.milestones.some((x) => x.unlock));
    case 'paint':
      return definition?.format?.kind === 'mural';
    case 'stages':
      return definition?.format?.kind === 'composition';
    case 'answers':
      return definition?.format?.kind === 'quiz';
    default:
      return true;
  }
}

export const timeOf = (step: RehearsalStep) => (step.kind === 'chat' ? step.event.at : step.at);

/** Logical scenario time, relative to its origin: 0:03.2 */
export function logicalClock(ms: number) {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

export function stepTitle(step: RehearsalStep) {
  switch (step.kind) {
    case 'chat':
      return `${step.event.viewerId}: ${step.event.text}`;
    case 'advance':
      return 'Clock moves forward';
    case 'pause':
      return 'Round paused';
    case 'resume':
      return 'Round resumed';
  }
}

/** Stateful experiences accept joins as well as throws, so “Thrown” would mislead there. */
export const codeLabel = (code: string | null | undefined, stateful = false) =>
  !code
    ? 'No decision'
    : code === 'ACCEPTED' && stateful
      ? 'Accepted'
      : (CODE_LABEL[code as DecisionCode] ?? code);

function valueText(kind: Check['kind'] | Expectation['kind'], value: unknown) {
  if (value === null || value === undefined) return 'nothing';
  if (kind === 'decision') return codeLabel(String(value));
  if (kind === 'effects') return `${value} effect${value === 1 ? '' : 's'}`;
  if (kind === 'phase') return String(value);
  if (kind === 'remaining') return `${value} left`;
  if (kind === 'score') return `${value} points`;
  return String(value);
}

/**
 * “Step 4 should give Thrown — it gave Resources spent.” Steps are located through the
 * scenario's inputs or, for stored evidence without inputs, the replay's own frames.
 */
export function describeCheck(check: Check, source: RehearsalScenario | RehearsalResult) {
  const keys = 'steps' in source ? source.steps : source.timeline;
  const index = keys.findIndex((s) => s.key === check.stepKey);
  const where = index >= 0 ? `Step ${index + 1}` : 'A removed step';
  if (check.category === 'invariant')
    return check.status === 'failed'
      ? `${where}: ${check.kind === 'quarantine' ? 'the host quarantined the handler' : 'host state broke the experience rules'}.`
      : `${where}: host safety check passed.`;
  const expected = valueText(check.kind, check.expected);
  if (check.status === 'pending') return `${where} should give ${expected} — not reached yet.`;
  const actual = valueText(check.kind, check.actual);
  return check.status === 'passed'
    ? `${where} gave ${expected}, as expected.`
    : `${where} should give ${expected} — it gave ${actual}.`;
}

export function describeExpectation(check: Expectation, scenario: RehearsalScenario) {
  const index = scenario.steps.findIndex((s) => s.key === check.stepKey);
  const subject =
    check.kind === 'score'
      ? ` for ${check.teamId}`
      : check.kind === 'remaining'
        ? ` for ${check.viewerId}`
        : '';
  const what =
    check.kind === 'decision'
      ? 'outcome'
      : check.kind === 'effects'
        ? 'effects'
        : check.kind === 'phase'
          ? 'round phase'
          : check.kind === 'score'
            ? 'score'
            : 'resources';
  return `Step ${index + 1} ${what}${subject}: ${valueText(check.kind, check.value)}`;
}

export interface Verdict {
  tone: 'good' | 'bad' | 'muted';
  title: string;
  failures: Check[];
  expectations: { passed: number; total: number };
  safety: { passed: number; total: number };
}

export function verdict(result: RehearsalResult): Verdict {
  const expectations = result.checks.filter((c) => c.category === 'expectation');
  const safety = result.checks.filter((c) => c.category === 'invariant');
  const failures = result.checks.filter((c) => c.status === 'failed');
  const count = (list: Check[]) => ({
    passed: list.filter((c) => c.status === 'passed').length,
    total: list.length,
  });
  const done = result.through === result.totalSteps;
  return {
    tone: failures.length ? 'bad' : done ? 'good' : 'muted',
    title: failures.length
      ? `${failures.length} check${failures.length === 1 ? '' : 's'} failed`
      : !done
        ? `Step ${result.through} of ${result.totalSteps} · run to the end to check everything`
        : expectations.length
          ? expectations.length === 1
            ? 'Expectation met'
            : `All ${expectations.length} expectations met`
          : 'Ran cleanly · no expectations set yet',
    failures,
    expectations: count(expectations),
    safety: count(safety),
  };
}

const FRIENDLY: Record<string, string> = {
  BUSY: 'Another rehearsal is still running. Wait a moment, then try again.',
  STALE:
    'This scenario was changed elsewhere. Choose “Reload saved inputs” to get the latest copy.',
  LIMIT: 'The private library is full. Delete a scenario or regression first.',
  TIMEOUT: 'The rehearsal took longer than 60 seconds and was stopped. Try fewer steps.',
  RESULT_LIMIT: 'The replay result is too large. Try fewer steps or viewers.',
  INCOMPATIBLE_SESSION:
    'The recorded starting state does not fit this version. Use a fresh start instead.',
  INVALID_CHECK: 'Choose a failed check from a run that reached the last step.',
  NOT_FOUND: 'That item no longer exists. Reload the library.',
};

/** Host messages are already safe; known codes get an actionable next step. */
export function friendlyError(cause: unknown) {
  if (!(cause instanceof ApiError))
    return 'The private rehearsal could not run. Your inputs are unchanged.';
  return (cause.code && FRIENDLY[cause.code]) || cause.message;
}
