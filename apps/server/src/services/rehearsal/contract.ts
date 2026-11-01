import type {
  MinimizedCounterexample,
  RehearsalFailure,
  RehearsalResult,
  RehearsalScenario,
} from '@riff/sandbox';
export interface ScenarioRecord {
  id: string;
  name: string;
  revision: number;
  scenario: RehearsalScenario;
  createdAt: number;
  updatedAt: number;
}
export interface Difference {
  through: number;
  key: string;
  decision: boolean;
  effects: boolean;
  state: boolean;
}
export interface RunRecord {
  id: string;
  scenarioId: string | null;
  scenarioRevision: number | null;
  versionId: string;
  artifactId: string;
  compareVersionId: string | null;
  compareArtifactId: string | null;
  scenario: RehearsalScenario;
  result: RehearsalResult;
  comparison: RehearsalResult | null;
  differences: Difference[];
  freshStart: boolean;
  minimization: MinimizedCounterexample | null;
  createdAt: number;
}
export interface RegressionRecord {
  id: string;
  name: string;
  automationId: string;
  originVersionId: string;
  originArtifactId: string;
  sourceRunId: string;
  scenario: RehearsalScenario;
  checkId: string;
  failure: RehearsalFailure;
  failedEvidenceHash: string;
  createdAt: number;
}
export interface RegressionEvidence {
  regressionId: string;
  originVersionId: string;
  originArtifactId: string;
  scenarioHash: string;
  result: RehearsalResult | null;
  ok: boolean;
  failure: string | null;
}
export class RehearsalServiceError extends Error {
  constructor(
    readonly code:
      | 'INVALID'
      | 'NOT_FOUND'
      | 'STALE'
      | 'INCOMPATIBLE_SESSION'
      | 'INVALID_CHECK'
      | 'BUSY'
      | 'LIMIT'
      | 'ABORTED'
      | 'TIMEOUT'
      | 'UNAVAILABLE'
      | 'RESULT_LIMIT',
  ) {
    super(
      {
        INVALID: 'Invalid rehearsal input.',
        NOT_FOUND: 'That rehearsal item is unavailable.',
        STALE: 'The scenario changed. Refresh before running or editing.',
        INCOMPATIBLE_SESSION: 'The initial session is incompatible. Try a fresh start.',
        INVALID_CHECK: 'Choose a failed check from a complete run.',
        BUSY: 'A rehearsal operation is already running for this channel.',
        LIMIT: 'The private rehearsal library is full. Delete an item first.',
        ABORTED: 'Rehearsal was cancelled.',
        TIMEOUT: 'Rehearsal exceeded its time limit.',
        UNAVAILABLE: 'That recording or rehearsal evidence is unavailable.',
        RESULT_LIMIT: 'Rehearsal evidence exceeds the result limit.',
      }[code],
    );
  }
}
