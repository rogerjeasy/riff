// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/console/app.js';
import { Evidence } from '../src/console/review/evidence.js';
import * as projectile from '../src/effects/projectile.js';
import { Rehearsal } from '../src/console/rehearsal/stage.js';
import { api, ApiError } from '../src/lib/api.js';
import type { Version, Run } from '../src/lib/types.js';
import type {
  RehearsalScenario,
  RehearsalRun,
  ScenarioRecord,
  Regression,
} from '../src/console/rehearsal/contracts.js';
const artifact = 'a'.repeat(64);
const version: Version = {
  id: 'v1',
  automationId: 'a1',
  number: 1,
  parentVersionId: null,
  artifactId: artifact,
  title: 'Toss',
  intent: 'Throw',
  source: '',
  manifest: {
    sdkVersion: '0.3.0',
    capabilities: ['overlay'],
    trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
  },
  tests: [],
  behavior: { when: 'chat', what: 'throw', who: 'viewer', howMuch: '3' },
  assumptions: [],
  evidence: {
    verification: {
      ok: true,
      artifactId: artifact,
      stages: [],
      findings: [],
      capabilitiesUsed: [],
      generated: [],
      host: [],
      failureReport: null,
    },
    intent: [],
  },
  origin: 'reference',
  compileRunId: null,
  status: 'candidate',
  incident: null,
  approvedAt: null,
  activatedAt: null,
  createdAt: 0,
  changes: [],
  blockers: [],
};
const scenario: RehearsalScenario = {
  version: 1,
  seed: 42,
  initialAt: 0,
  initialSession: null,
  provenance: { kind: 'synthetic' },
  steps: [
    {
      kind: 'chat',
      key: 'one',
      event: {
        id: 'e1',
        channelId: 'rehearsal',
        viewerId: 'alice',
        roles: ['viewer'],
        text: '!tomato',
        at: 0,
      },
    },
    { kind: 'advance', key: 'two', at: 1000 },
  ],
  expectations: [],
};
const saved: ScenarioRecord = {
  id: 's1',
  name: 'My scenario',
  revision: 2,
  scenario,
  createdAt: 0,
  updatedAt: 0,
};
function replay(through = 2, failed = false): RehearsalRun {
  const checks = failed
    ? [
        {
          id: 'expect:count',
          stepKey: 'one',
          category: 'expectation' as const,
          kind: 'effects' as const,
          status: 'failed' as const,
          expected: 2,
          actual: 1,
          summary: 'Expected 2 effects, observed 1',
        },
      ]
    : [];
  return {
    id: 'run1',
    scenarioId: 's1',
    scenarioRevision: 2,
    versionId: 'v1',
    artifactId: artifact,
    compareVersionId: null,
    compareArtifactId: null,
    scenario,
    result: {
      contractVersion: 1,
      artifactId: artifact,
      scenarioHash: 'b'.repeat(64),
      evidenceHash: 'c'.repeat(64),
      seed: 42,
      initialAt: 0,
      provenance: { kind: 'synthetic' },
      through,
      totalSteps: 2,
      status: failed ? 'failed' : through === 2 ? 'passed' : 'incomplete',
      timeline: [],
      cursor: { at: through * 500, session: null, stateDigest: 'd'.repeat(64), decision: null },
      checks,
    },
    comparison: null,
    differences: [],
    freshStart: false,
    minimization: null,
    createdAt: 0,
  };
}
const previewed = vi.fn();
const started = vi.fn();
beforeEach(() => {
  vi.spyOn(api, 'rehearsalScenarios').mockResolvedValue([saved]);
  vi.spyOn(api, 'rehearsalScenario').mockResolvedValue({ ...saved, revision: 3 });
  vi.spyOn(api, 'rehearsalRegressions').mockResolvedValue([]);
  vi.spyOn(api, 'rehearsalPreset').mockResolvedValue(scenario);
  vi.spyOn(api, 'rehearsalSave').mockResolvedValue(saved);
  vi.spyOn(api, 'rehearsalRun').mockImplementation(async (_id, input) => replay(input.through));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  previewed.mockReset();
  started.mockReset();
});
async function open() {
  render(
    <Rehearsal
      version={version}
      versions={[version, { ...version, id: 'v2', number: 2 }]}
      onPreviewed={previewed}
      onRun={started}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open interactive studio' }));
  await screen.findByRole('option', { name: 'My scenario · revision 2' });
  fireEvent.change(screen.getByLabelText('Saved scenario'), { target: { value: 's1' } });
}
it('loads, injects roles and expectations, saves revisions and refuses stale work without losing edits', async () => {
  await open();
  fireEvent.change(screen.getByLabelText('Viewer identity'), { target: { value: 'new-viewer' } });
  fireEvent.change(screen.getByLabelText('Injected chat'), { target: { value: '!splat' } });
  fireEvent.click(screen.getByLabelText('moderator role'));
  fireEvent.click(screen.getByRole('button', { name: 'Add chat step' }));
  expect(screen.getByText(/3 of 120 steps/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Expected effect count'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add expectation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await waitFor(() => expect(api.rehearsalSave).toHaveBeenCalled());
  const input = vi.mocked(api.rehearsalSave).mock.calls[0]?.[0];
  expect(input && 'scenario' in input && input.scenario.steps.at(-1)).toMatchObject({
    kind: 'chat',
    event: { viewerId: 'new-viewer', roles: ['viewer', 'moderator'], text: '!splat' },
  });
  expect(input && 'scenario' in input && input.scenario.expectations[0]).toMatchObject({
    kind: 'effects',
    value: 2,
  });
  vi.mocked(api.rehearsalSave).mockRejectedValue(
    new ApiError('Scenario revision changed. Reload before saving.', 409, 'STALE'),
  );
  fireEvent.change(screen.getByLabelText('Scenario name'), { target: { value: 'Keep this work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await screen.findByText(/Scenario revision changed/);
  expect((screen.getByLabelText('Scenario name') as HTMLInputElement).value).toBe('Keep this work');
  expect(previewed).not.toHaveBeenCalled();
});
it('steps, seeks, resets and marks only a full exact primary replay previewed', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Timeline cursor').getAttribute('value')).toBe('1'),
  );
  expect(previewed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Timeline cursor'), { target: { value: '2' } });
  await waitFor(() => expect(previewed).toHaveBeenCalledWith('v1'));
  fireEvent.click(screen.getByRole('button', { name: 'Reset timeline' }));
  await waitFor(() =>
    expect(api.rehearsalRun).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ through: 0 }),
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByText(/Logical time: 0 ms/)).toBeTruthy();
});
it('compares synchronized prefixes with fresh start and never grants preview credit', async () => {
  await open();
  const comparison = replay();
  comparison.compareVersionId = 'v2';
  comparison.compareArtifactId = 'e'.repeat(64);
  comparison.comparison = { ...comparison.result, artifactId: 'e'.repeat(64) };
  comparison.freshStart = true;
  comparison.differences = [
    { through: 1, key: 'one', decision: false, effects: true, state: false },
  ];
  vi.mocked(api.rehearsalRun).mockResolvedValue(comparison);
  fireEvent.change(screen.getByLabelText('Compare version'), { target: { value: 'v2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  await waitFor(() =>
    expect(api.rehearsalRun).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ compareVersionId: 'v2', freshStart: true, through: 2 }),
      expect.any(AbortSignal),
    ),
  );
  expect(previewed).not.toHaveBeenCalled();
  await screen.findByText(/1 differing frames at synchronized cursor 2/);
  expect(screen.getByText(/Not migration approval evidence/)).toBeTruthy();
});
it('ignores cancelled late responses and leaves the new timeline untouched', async () => {
  await open();
  let resolve!: (value: RehearsalRun) => void;
  vi.mocked(api.rehearsalRun).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel operation' }));
  resolve(replay());
  await waitFor(() =>
    expect(screen.getByLabelText('Timeline cursor').getAttribute('value')).toBe('0'),
  );
  expect(previewed).not.toHaveBeenCalled();
});
it('reduces a selected failed check, saves independently, reruns and requires reviewed explicit repair', async () => {
  await open();
  vi.mocked(api.rehearsalRun).mockResolvedValue(replay(2, true));
  const reduced = replay(2, true);
  reduced.minimization = {
    scenario,
    run: reduced.result,
    checkId: 'expect:count',
    failure: {
      id: 'expect:count',
      stepKey: 'one',
      category: 'expectation',
      kind: 'effects',
      expected: 2,
      actual: 1,
    },
    originalEvidenceHash: 'c'.repeat(64),
    originalStepCount: 2,
    removedSteps: 0,
    attempts: 2,
    dispatchedSteps: 4,
    budgetStopped: true,
  };
  vi.spyOn(api, 'rehearsalMinimize').mockResolvedValue(reduced);
  const regression: Regression = {
    id: 'g1',
    name: 'Pinned mismatch',
    automationId: 'a1',
    originVersionId: 'v1',
    originArtifactId: artifact,
    sourceRunId: 'run1',
    scenario,
    checkId: 'expect:count',
    failure: reduced.minimization.failure,
    failedEvidenceHash: 'c'.repeat(64),
    createdAt: 0,
  };
  vi.spyOn(api, 'rehearsalSaveRegression').mockResolvedValue(regression);
  vi.mocked(api.rehearsalRegressions).mockResolvedValue([regression]);
  vi.spyOn(api, 'rehearsalRerun').mockResolvedValue(replay());
  vi.spyOn(api, 'rehearsalDeleteRegression').mockResolvedValue({});
  const run = { id: 'compile1', stage: 'queued' } as Run;
  vi.spyOn(api, 'rehearsalRepair').mockResolvedValue(run);
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  await screen.findByText(/Expected 2 effects, observed 1/);
  fireEvent.change(screen.getByLabelText('Failed check'), { target: { value: 'expect:count' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reduce selected failure' }));
  await screen.findByText(/Budget stopped/);
  expect(api.rehearsalRepair).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Regression name'), {
    target: { value: 'Pinned mismatch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save regression' }));
  await screen.findByRole('option', { name: 'Pinned mismatch' });
  fireEvent.change(screen.getByLabelText('Saved regression'), { target: { value: 'g1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rerun on selected version' }));
  await waitFor(() => expect(api.rehearsalRerun).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Repair intent'), {
    target: { value: 'Emit two projectiles for each accepted command.' },
  });
  expect(
    (screen.getByRole('button', { name: 'Generate repair candidate' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText('I reviewed this regression and repair intent'));
  fireEvent.click(screen.getByRole('button', { name: 'Generate repair candidate' }));
  await waitFor(() => expect(started).toHaveBeenCalledWith(run));
});
it('shows the exact pinned regression set in candidate evidence', () => {
  const candidate = {
    ...version,
    evidence: {
      ...version.evidence,
      rehearsal: [
        {
          regressionId: 'deleted-but-pinned',
          originVersionId: 'v1',
          originArtifactId: artifact,
          scenarioHash: 'b'.repeat(64),
          result: replay(2, true).result,
          ok: false,
          failure: 'Pinned expectation failed',
        },
      ],
    },
  };
  render(
    <Evidence
      version={candidate}
      automation={undefined}
      panic={false}
      previewed={false}
      onApprove={async () => undefined}
      onDiscard={async () => undefined}
    />,
  );
  expect(screen.getByText('deleted-but-pinned')).toBeTruthy();
  expect(screen.getByText(/Pinned expectation failed/)).toBeTruthy();
  expect(screen.getByText(/Expected 2 effects, observed 1/)).toBeTruthy();
});
it('clears obsolete effects when seeking and rejects wrong-artifact or empty evidence', async () => {
  await open();
  const clear = vi.spyOn(projectile, 'clearStage');
  const wrong = replay();
  wrong.artifactId = 'e'.repeat(64);
  wrong.result.artifactId = wrong.artifactId;
  vi.mocked(api.rehearsalRun).mockResolvedValueOnce(wrong);
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  await screen.findByText(/Replay identity changed/);
  expect(previewed).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalled();
  const empty = replay(0);
  empty.result.totalSteps = 0;
  empty.result.status = 'passed';
  vi.mocked(api.rehearsalRun).mockResolvedValueOnce(empty);
  fireEvent.click(screen.getByRole('button', { name: 'Reset timeline' }));
  await waitFor(() => expect(api.rehearsalRun).toHaveBeenCalledTimes(2));
  expect(previewed).not.toHaveBeenCalled();
});
it('loads presets and host recordings, then saves the host selector and returned canonical inputs', async () => {
  const recording = { versionId: 'v1', sessionId: 'session1' };
  const imported = {
    ...scenario,
    provenance: {
      kind: 'sanitized-recording' as const,
      originVersionId: 'v1',
      originArtifactId: artifact,
      originSessionId: 'session1',
    },
  };
  vi.spyOn(api, 'rehearsalRecording').mockResolvedValue(imported);
  render(
    <Rehearsal
      version={version}
      versions={[version]}
      recording={recording}
      onPreviewed={previewed}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open interactive studio' }));
  await screen.findByRole('option', { name: 'My scenario · revision 2' });
  fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'crowd-burst' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load preset' }));
  await waitFor(() =>
    expect(api.rehearsalPreset).toHaveBeenCalledWith(
      'v1',
      'crowd-burst',
      42,
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Import current round' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Import current round' }));
  await screen.findByText(/Sanitized recording · pinned version/);
  vi.mocked(api.rehearsalSave).mockResolvedValueOnce({
    ...saved,
    scenario: {
      ...imported,
      steps: [...imported.steps, { kind: 'advance', key: 'newer', at: 2000 }],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await waitFor(() =>
    expect(api.rehearsalSave).toHaveBeenCalledWith(
      { name: 'My scenario', recording: { ...recording, seed: 42 } },
      undefined,
      expect.any(AbortSignal),
    ),
  );
  await screen.findByText(/3 of 120 steps/);
  expect(previewed).not.toHaveBeenCalled();
});
it('plays successive fresh prefixes and pause cancels an in-flight operation', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  await waitFor(
    () =>
      expect(api.rehearsalRun).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ through: 1 }),
        expect.any(AbortSignal),
      ),
    { timeout: 2000 },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(previewed).not.toHaveBeenCalled();
});
it('aborts version navigation so late evidence cannot mark the new artifact previewed', async () => {
  let resolve!: (value: RehearsalRun) => void;
  vi.mocked(api.rehearsalRun).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<Rehearsal version={version} versions={[version]} onPreviewed={previewed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open interactive studio' }));
  await screen.findByRole('option', { name: 'My scenario · revision 2' });
  fireEvent.change(screen.getByLabelText('Saved scenario'), { target: { value: 's1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  const signal = vi.mocked(api.rehearsalRun).mock.calls[0]?.[2];
  view.rerender(
    <Rehearsal version={{ ...version, id: 'v2' }} versions={[version]} onPreviewed={previewed} />,
  );
  expect(signal?.aborted).toBe(true);
  resolve(replay());
  await waitFor(() =>
    expect(screen.getByLabelText('Timeline cursor').getAttribute('value')).toBe('0'),
  );
  expect(previewed).not.toHaveBeenCalled();
});
it('releases the operation lock after replacing inputs with a preset or saved response', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Load preset' }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Scenario name').closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Scenario name').closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(false),
  );
  expect((screen.getByRole('button', { name: 'Next step' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
it('hands a returned repair immediately to the existing app authoring run store', async () => {
  const regression: Regression = {
    id: 'g1',
    name: 'Repair this mismatch',
    automationId: 'a1',
    originVersionId: 'v1',
    originArtifactId: artifact,
    sourceRunId: 'run1',
    scenario,
    checkId: 'expect:count',
    failure: {
      id: 'expect:count',
      stepKey: 'one',
      category: 'expectation',
      kind: 'effects',
      expected: 2,
      actual: 1,
    },
    failedEvidenceHash: 'c'.repeat(64),
    createdAt: 0,
  };
  vi.mocked(api.rehearsalRegressions).mockResolvedValue([regression]);
  const repairIntent = 'Emit two tomatoes for every accepted command.';
  const startedRun: Run = {
    id: 'durable-repair',
    intent: repairIntent,
    automationId: 'a1',
    baseVersionId: 'v1',
    stage: 'queued',
    attempt: 0,
    transport: 'offline',
    model: null,
    startedAt: 0,
    progress: [],
    result: null,
  };
  vi.spyOn(api, 'rehearsalRepair').mockResolvedValue(startedRun);
  vi.spyOn(api, 'studio').mockResolvedValue({
    panic: false,
    panicAt: null,
    overlay: { connections: 0 },
    running: [],
    lastEvent: null,
    automations: [
      {
        id: 'a1',
        title: 'Toss',
        activeVersionId: null,
        status: 'draft',
        createdAt: 0,
        updatedAt: 0,
        versions: [version],
        canRollback: false,
        session: null,
      },
    ],
    activity: [],
    compiler: { kind: 'offline', model: null },
    runs: [],
    twitch: { state: 'unconfigured', configured: false },
  });
  vi.spyOn(api, 'overlay').mockResolvedValue({ url: '/overlay?key=sample', connections: 0 });
  vi.stubGlobal(
    'WebSocket',
    class {
      close = vi.fn();
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open interactive studio' }));
  await screen.findByRole('option', { name: 'Repair this mismatch' });
  fireEvent.click(screen.getByText('Immutable regression library and repair'));
  fireEvent.change(screen.getByLabelText('Saved regression'), { target: { value: 'g1' } });
  fireEvent.change(screen.getByLabelText('Repair intent'), { target: { value: repairIntent } });
  fireEvent.click(screen.getByLabelText('I reviewed this regression and repair intent'));
  fireEvent.click(screen.getByRole('button', { name: 'Generate repair candidate' }));
  expect(await screen.findByText(`“${repairIntent}”`)).toBeTruthy();
  expect(screen.getByText('Queued')).toBeTruthy();
});
it('surfaces recording, comparison and channel capacity failures without dropping saved inputs', async () => {
  await open();
  expect(
    (screen.getByRole('button', { name: 'Import current round' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  vi.mocked(api.rehearsalRun).mockRejectedValueOnce(
    new ApiError(
      'Pinned snapshot is incompatible. Choose fresh start.',
      409,
      'INCOMPATIBLE_SESSION',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  await screen.findByText(/INCOMPATIBLE_SESSION/);
  expect(screen.getByText(/Stored revision 2/)).toBeTruthy();
  vi.mocked(api.rehearsalSave).mockRejectedValueOnce(
    new ApiError('Scenario capacity reached.', 429, 'LIMIT'),
  );
  fireEvent.change(screen.getByLabelText('Scenario name'), {
    target: { value: 'Keep my scenario' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await screen.findByText(/LIMIT: Scenario capacity reached/);
  expect((screen.getByLabelText('Scenario name') as HTMLInputElement).value).toBe(
    'Keep my scenario',
  );
});
it('labels new synthetic inputs accurately and explicitly reloads a stale saved revision', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'New scenario' }));
  expect(screen.getByText(/Provenance: synthetic ·/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Saved scenario'), { target: { value: 's1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved inputs' }));
  await screen.findByText(/Stored revision 3/);
});
it('keeps normal delivery identities distinct after save, studio reopen and reload while explicit duplication reuses identity', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'New scenario' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add chat step' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add chat step' }));
  let stored = saved;
  vi.mocked(api.rehearsalSave).mockImplementationOnce(async (input) => {
    if (!('scenario' in input)) throw new Error('Expected synthetic inputs');
    stored = { ...saved, scenario: input.scenario };
    return stored;
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await screen.findByText(/Stored revision 2/);
  expect(stored.scenario.steps.map((s) => s.key)).toEqual(['step_1', 'step_3']);
  expect(stored.scenario.steps.map((s) => (s.kind === 'chat' ? s.event.id : null))).toEqual([
    'event_step_2',
    'event_step_4',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Return to quick proof' }));
  vi.mocked(api.rehearsalScenarios).mockResolvedValue([stored]);
  fireEvent.click(screen.getByRole('button', { name: 'Open interactive studio' }));
  await screen.findByRole('option', { name: 'My scenario · revision 2' });
  fireEvent.change(screen.getByLabelText('Saved scenario'), { target: { value: 's1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add chat step' }));
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate last delivery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await waitFor(() => expect(api.rehearsalSave).toHaveBeenCalledTimes(2));
  const body = vi.mocked(api.rehearsalSave).mock.calls[1]?.[0];
  if (!body || !('scenario' in body)) throw new Error('Expected scenario save');
  const ids = body.scenario.steps.flatMap((s) => (s.kind === 'chat' ? [s.event.id] : []));
  expect(new Set(ids.slice(0, 3)).size).toBe(3);
  expect(ids[3]).toBe(ids[2]);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function openWithDeferredLibrary() {
  const scenarios = deferred<ScenarioRecord[]>();
  const regressions = deferred<Regression[]>();
  vi.mocked(api.rehearsalScenarios).mockReturnValueOnce(scenarios.promise);
  vi.mocked(api.rehearsalRegressions).mockReturnValueOnce(regressions.promise);
  render(<Rehearsal version={version} versions={[version]} onPreviewed={previewed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open interactive studio' }));
  return { scenarios, regressions };
}
async function createDuringBootstrap() {
  fireEvent.click(screen.getByRole('button', { name: 'Load preset' }));
  await screen.findByText(/2 of 120 steps/);
  fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
  await screen.findByRole('option', { name: 'My scenario · revision 2' });
}
it('preserves successfully saved scenario and regression when older bootstrap snapshots finish last', async () => {
  const bootstrap = openWithDeferredLibrary();
  await createDuringBootstrap();
  const reduced = replay(2, true);
  const failed = reduced.result.checks[0];
  if (!failed) throw new Error('Expected failure');
  reduced.minimization = {
    scenario,
    run: reduced.result,
    checkId: failed.id,
    failure: failed,
    originalEvidenceHash: 'c'.repeat(64),
    originalStepCount: 2,
    removedSteps: 0,
    attempts: 2,
    dispatchedSteps: 4,
    budgetStopped: false,
  };
  const regression: Regression = {
    id: 'g-latest',
    name: 'Retained after bootstrap',
    automationId: 'a1',
    originVersionId: 'v1',
    originArtifactId: artifact,
    sourceRunId: reduced.id,
    scenario,
    checkId: failed.id,
    failure: failed,
    failedEvidenceHash: 'c'.repeat(64),
    createdAt: 0,
  };
  vi.mocked(api.rehearsalRun).mockResolvedValue(replay(2, true));
  vi.spyOn(api, 'rehearsalMinimize').mockResolvedValue(reduced);
  vi.spyOn(api, 'rehearsalSaveRegression').mockResolvedValue(regression);
  vi.mocked(api.rehearsalRegressions).mockResolvedValue([regression]);
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  await screen.findByText(/Expected 2 effects, observed 1/);
  fireEvent.change(screen.getByLabelText('Failed check'), { target: { value: failed.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Reduce selected failure' }));
  await screen.findByText(/Reduction finished/);
  fireEvent.click(screen.getByRole('button', { name: 'Save regression' }));
  await screen.findByRole('option', { name: 'Retained after bootstrap' });
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([]);
  });
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Retained after bootstrap' })).toBeTruthy();
});
it('preserves a newer explicit library reload when initial snapshots finish afterward', async () => {
  const bootstrap = openWithDeferredLibrary();
  vi.mocked(api.rehearsalScenarios).mockResolvedValue([{ ...saved, revision: 8 }]);
  fireEvent.click(screen.getByRole('button', { name: 'Reload library' }));
  await screen.findByRole('option', { name: 'My scenario · revision 8' });
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([]);
  });
  expect(screen.getByRole('option', { name: 'My scenario · revision 8' })).toBeTruthy();
});
it('ignores an obsolete bootstrap failure after a successful scenario save', async () => {
  const bootstrap = openWithDeferredLibrary();
  await createDuringBootstrap();
  await act(async () => {
    bootstrap.scenarios.reject(new ApiError('Old library failed.', 409, 'UNAVAILABLE'));
    bootstrap.regressions.resolve([]);
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect(screen.getByText(/Saved inputs returned by the host/)).toBeTruthy();
});
function existingRegression(): Regression {
  return {
    id: 'existing-regression',
    name: 'Existing saved regression',
    automationId: 'a1',
    originVersionId: 'v1',
    originArtifactId: artifact,
    sourceRunId: 'older-run',
    scenario,
    checkId: 'expect:count',
    failure: {
      id: 'expect:count',
      stepKey: 'one',
      category: 'expectation',
      kind: 'effects',
      expected: 2,
      actual: 1,
    },
    failedEvidenceHash: 'c'.repeat(64),
    createdAt: 0,
  };
}
it('loads both untouched libraries after local typing without replacing the typed scenario name', async () => {
  const bootstrap = openWithDeferredLibrary();
  fireEvent.change(screen.getByLabelText('Scenario name'), {
    target: { value: 'My unsaved typed name' },
  });
  await act(async () => {
    bootstrap.scenarios.resolve([saved]);
    bootstrap.regressions.resolve([existingRegression()]);
  });
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Existing saved regression' })).toBeTruthy();
  expect((screen.getByLabelText('Scenario name') as HTMLInputElement).value).toBe(
    'My unsaved typed name',
  );
});
it('fills the untouched regression library after a scenario-only save while retaining the newly saved scenario', async () => {
  const bootstrap = openWithDeferredLibrary();
  await createDuringBootstrap();
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([existingRegression()]);
  });
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Existing saved regression' })).toBeTruthy();
});
it('fills pending regressions independently of a newer scenario-only library reload', async () => {
  const bootstrap = openWithDeferredLibrary();
  vi.mocked(api.rehearsalScenarios).mockResolvedValue([{ ...saved, revision: 8 }]);
  fireEvent.click(screen.getByRole('button', { name: 'Reload library' }));
  await screen.findByRole('option', { name: 'My scenario · revision 8' });
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([existingRegression()]);
  });
  expect(screen.getByRole('option', { name: 'My scenario · revision 8' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Existing saved regression' })).toBeTruthy();
});
it('loads scenarios still pending after the independent regression library has loaded and been mutated', async () => {
  const bootstrap = openWithDeferredLibrary();
  await act(async () => bootstrap.regressions.resolve([existingRegression()]));
  await screen.findByRole('option', { name: 'Existing saved regression' });
  vi.spyOn(api, 'rehearsalDeleteRegression').mockResolvedValue({});
  fireEvent.change(screen.getByLabelText('Saved regression'), {
    target: { value: 'existing-regression' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Delete regression' }));
  await waitFor(() =>
    expect(screen.queryByRole('option', { name: 'Existing saved regression' })).toBeNull(),
  );
  await act(async () => bootstrap.scenarios.resolve([saved]));
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Existing saved regression' })).toBeNull();
});
async function saveNewRegressionFromUi() {
  const reduced = replay(2, true);
  const failed = reduced.result.checks[0];
  if (!failed) throw new Error('Expected failure');
  reduced.minimization = {
    scenario,
    run: reduced.result,
    checkId: failed.id,
    failure: failed,
    originalEvidenceHash: 'c'.repeat(64),
    originalStepCount: 2,
    removedSteps: 0,
    attempts: 2,
    dispatchedSteps: 4,
    budgetStopped: false,
  };
  const added = { ...existingRegression(), id: 'gNew', name: 'New saved regression' };
  vi.mocked(api.rehearsalRun).mockResolvedValue(replay(2, true));
  vi.spyOn(api, 'rehearsalMinimize').mockResolvedValue(reduced);
  vi.spyOn(api, 'rehearsalSaveRegression').mockResolvedValue(added);
  fireEvent.click(screen.getByRole('button', { name: 'Run to end' }));
  await screen.findByText(/Expected 2 effects, observed 1/);
  fireEvent.change(screen.getByLabelText('Failed check'), { target: { value: failed.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Reduce selected failure' }));
  await screen.findByText(/Reduction finished/);
  fireEvent.click(screen.getByRole('button', { name: 'Save regression' }));
  await screen.findByRole('option', { name: added.name });
  return added;
}
it('refreshes complete same-library regressions after saving gNew before the nonempty gOld bootstrap completes', async () => {
  const bootstrap = openWithDeferredLibrary();
  await createDuringBootstrap();
  const old = { ...existingRegression(), id: 'gOld' };
  const added = { ...existingRegression(), id: 'gNew', name: 'New saved regression' };
  vi.mocked(api.rehearsalRegressions).mockResolvedValue([old, added]);
  await saveNewRegressionFromUi();
  await screen.findByRole('option', { name: old.name });
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([old]);
  });
  expect(screen.getByRole('option', { name: old.name })).toBeTruthy();
  expect(screen.getByRole('option', { name: added.name })).toBeTruthy();
});
it('refreshes complete same-library scenarios after save before a nonempty older bootstrap completes', async () => {
  const bootstrap = openWithDeferredLibrary();
  const old = { ...saved, id: 'sOld', name: 'Existing saved scenario' };
  vi.mocked(api.rehearsalScenarios).mockResolvedValue([old, saved]);
  await createDuringBootstrap();
  await screen.findByRole('option', { name: 'Existing saved scenario · revision 2' });
  await act(async () => {
    bootstrap.scenarios.resolve([old]);
    bootstrap.regressions.resolve([]);
  });
  expect(screen.getByRole('option', { name: 'Existing saved scenario · revision 2' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect((screen.getByLabelText('Scenario name') as HTMLInputElement).value).toBe('My scenario');
});
it('keeps a committed scenario and inputs on follow-up refresh failure and retries only its library', async () => {
  const bootstrap = openWithDeferredLibrary();
  vi.mocked(api.rehearsalScenarios).mockRejectedValueOnce(
    new ApiError('Read unavailable.', 409, 'UNAVAILABLE'),
  );
  await createDuringBootstrap();
  await screen.findByText(/Scenario change committed, but library refresh failed/);
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
  expect((screen.getByLabelText('Scenario name') as HTMLInputElement).value).toBe('My scenario');
  vi.mocked(api.rehearsalScenarios).mockResolvedValue([
    saved,
    { ...saved, id: 'sOld', name: 'Existing saved scenario' },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Reload library' }));
  await screen.findByRole('option', { name: 'Existing saved scenario · revision 2' });
  expect(screen.queryByText(/Scenario change committed, but library refresh failed/)).toBeNull();
  expect(api.rehearsalSave).toHaveBeenCalledTimes(1);
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([]);
  });
  expect(screen.getByRole('option', { name: 'My scenario · revision 2' })).toBeTruthy();
});
it('keeps a committed regression on refresh failure and offers an explicit complete-library retry', async () => {
  const bootstrap = openWithDeferredLibrary();
  await createDuringBootstrap();
  vi.mocked(api.rehearsalRegressions).mockRejectedValueOnce(
    new ApiError('Read unavailable.', 409, 'UNAVAILABLE'),
  );
  const added = await saveNewRegressionFromUi();
  await screen.findByText(/Regression change committed, but library refresh failed/);
  expect(screen.getByRole('option', { name: added.name })).toBeTruthy();
  vi.mocked(api.rehearsalRegressions).mockResolvedValue([existingRegression(), added]);
  fireEvent.click(screen.getByRole('button', { name: 'Reload regression library' }));
  await screen.findByRole('option', { name: 'Existing saved regression' });
  expect(screen.queryByText(/Regression change committed, but library refresh failed/)).toBeNull();
  expect(api.rehearsalSaveRegression).toHaveBeenCalledTimes(1);
  await act(async () => {
    bootstrap.scenarios.resolve([]);
    bootstrap.regressions.resolve([existingRegression()]);
  });
  expect(screen.getByRole('option', { name: added.name })).toBeTruthy();
});
