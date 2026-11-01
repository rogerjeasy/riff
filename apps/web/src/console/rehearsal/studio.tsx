import { InputEditor } from './input-editor.js';
import { Timeline } from './timeline.js';
import { RegressionPanel } from './regressions.js';
import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type { Run, Version } from '../../lib/types.js';
import { clearStage, launch } from '../../effects/projectile.js';
import { shortHash } from '../format.js';
import {
  presets,
  scenarioSchema,
  type RehearsalRun,
  type RehearsalScenario,
  type Regression,
  type ScenarioRecord,
} from './contracts.js';

export interface StudioProps {
  version: Version;
  versions: Version[];
  recording?: { versionId: string; sessionId: string } | null | undefined;
  onPreviewed: (id: string) => void;
  onRun?: ((run: Run) => void) | undefined;
}
const blank = (): RehearsalScenario => ({
  version: 1,
  seed: 42,
  initialAt: 0,
  initialSession: null,
  steps: [],
  expectations: [],
  provenance: { kind: 'synthetic' },
});
/** Each request owns an epoch, abort signal and immutable version/revision context. */
export function InteractiveStudio({
  version,
  versions,
  recording,
  onPreviewed,
  onRun,
}: StudioProps) {
  const [scenario, setScenario] = useState(blank);
  const [saved, setSaved] = useState<ScenarioRecord | null>(null);
  const [dirty, setDirty] = useState(true);
  const [name, setName] = useState('My scenario');
  const [library, setLibrary] = useState<ScenarioRecord[]>([]);
  const [regressions, setRegressions] = useState<Regression[]>([]);
  const [recordingSelector, setRecordingSelector] = useState<StudioProps['recording']>(null);
  const [run, setRun] = useState<RehearsalRun | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [compare, setCompare] = useState('');
  const [freshStart, setFreshStart] = useState(true);
  const [preset, setPreset] = useState<(typeof presets)[number]>('proof');
  const epoch = useRef(0);
  const scenarioGeneration = useRef(0);
  const regressionGeneration = useRef(0);
  // All library snapshots and mutations publish through their own freshness boundary.
  function publishScenarios(update: SetStateAction<ScenarioRecord[]>) {
    scenarioGeneration.current++;
    setLibrary(update);
  }
  function publishRegressions(update: SetStateAction<Regression[]>) {
    regressionGeneration.current++;
    setRegressions(update);
  }
  const request = useRef<AbortController | null>(null);
  const primaryStage = useRef<HTMLDivElement>(null);
  const compareStage = useRef<HTMLDivElement>(null);
  function clearEffects() {
    for (const node of [primaryStage.current, compareStage.current]) if (node) clearStage(node);
  }
  function cancel() {
    epoch.current++;
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setPlaying(false);
    clearEffects();
  }
  useEffect(() => {
    const c = new AbortController();
    const scenariosAtStart = scenarioGeneration.current;
    const regressionsAtStart = regressionGeneration.current;
    const errorEpoch = epoch.current;
    void api
      .rehearsalScenarios(c.signal)
      .then((items) => {
        if (!c.signal.aborted && scenarioGeneration.current === scenariosAtStart)
          publishScenarios(items);
      })
      .catch((cause) => {
        if (
          !c.signal.aborted &&
          scenarioGeneration.current === scenariosAtStart &&
          epoch.current === errorEpoch
        )
          setError(
            cause instanceof ApiError
              ? cause.message
              : 'The private scenario library could not load.',
          );
      });
    void api
      .rehearsalRegressions(c.signal)
      .then((items) => {
        if (!c.signal.aborted && regressionGeneration.current === regressionsAtStart)
          publishRegressions(items);
      })
      .catch((cause) => {
        if (
          !c.signal.aborted &&
          regressionGeneration.current === regressionsAtStart &&
          epoch.current === errorEpoch
        )
          setError(
            cause instanceof ApiError
              ? cause.message
              : 'The private regression library could not load.',
          );
      });
    return () => {
      c.abort();
      epoch.current++;
      request.current?.abort();
    };
  }, []);
  async function operation<T>(
    work: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
  ) {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    const own = ++epoch.current;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const value = await work(c.signal);
      if (!c.signal.aborted && own === epoch.current) apply(value);
    } catch (cause) {
      if (!c.signal.aborted && own === epoch.current) {
        setPlaying(false);
        setError(
          cause instanceof ApiError
            ? `${cause.code ? cause.code + ': ' : ''}${cause.message}`
            : 'The private operation failed. Your inputs are preserved.',
        );
      }
    } finally {
      if (own === epoch.current && !c.signal.aborted) setBusy(false);
    }
  }
  function invalidate() {
    setBusy(false);
    epoch.current++;
    request.current?.abort();
    setRun(null);
    setCursor(0);
    setPlaying(false);
    clearEffects();
  }
  function edit(next: RehearsalScenario) {
    invalidate();
    setScenario({ ...next, provenance: { kind: 'synthetic' } });
    setDirty(true);
    setRecordingSelector(null);
  }
  function load(record: ScenarioRecord) {
    invalidate();
    setSaved(record);
    setScenario(record.scenario);
    setName(record.name);
    setDirty(false);
    setRecordingSelector(null);
    setError(null);
  }
  function unsaved(next: RehearsalScenario, selector: StudioProps['recording'] = null) {
    invalidate();
    setSaved(null);
    setScenario(next);
    setDirty(true);
    setRecordingSelector(selector);
    setError(null);
  }
  const validation = scenarioSchema.safeParse(scenario);
  function save() {
    if (!validation.success) return;
    void operation(
      (signal) =>
        api.rehearsalSave(
          recordingSelector
            ? { name, recording: { ...recordingSelector, seed: scenario.seed } }
            : { name, scenario: { ...scenario, provenance: { kind: 'synthetic' } } },
          saved ?? undefined,
          signal,
        ),
      (record) => {
        load(record);
        publishScenarios((items) => [record, ...items.filter((x) => x.id !== record.id)]);
        setNotice('Saved inputs returned by the host; previous evidence cleared.');
      },
    );
  }
  function animate(result: RehearsalRun['result'], node: HTMLDivElement | null) {
    if (!node || result.through === 0) return;
    for (const effect of result.cursor.decision?.effects ?? [])
      launch(node, {
        asset: effect.asset,
        x: effect.x,
        reducedMotion:
          typeof matchMedia === 'function' &&
          matchMedia('(prefers-reduced-motion: reduce)').matches,
        label: result.cursor.decision?.viewerId ?? null,
      });
  }
  function acceptRun(value: RehearsalRun, canPreview: boolean) {
    setRun(value);
    setCursor(value.result.through);
    clearEffects();
    animate(value.result, primaryStage.current);
    if (value.comparison) animate(value.comparison, compareStage.current);
    const r = value.result;
    if (
      canPreview &&
      !value.comparison &&
      !value.compareVersionId &&
      value.versionId === version.id &&
      value.artifactId === version.artifactId &&
      r.artifactId === version.artifactId &&
      r.totalSteps > 0 &&
      r.through === r.totalSteps &&
      r.totalSteps === value.scenario.steps.length &&
      r.status === 'passed' &&
      r.checks.every((c) => c.status === 'passed')
    )
      onPreviewed(version.id);
  }
  function seek(through: number) {
    if (!saved || dirty) return;
    clearEffects();
    void operation(
      (signal) =>
        api.rehearsalRun(
          saved.id,
          {
            expectedRevision: saved.revision,
            versionId: version.id,
            through,
            ...(compare ? { compareVersionId: compare, freshStart } : {}),
          },
          signal,
        ),
      (value) => {
        // A response for another revision/version is never usable as current evidence.
        if (
          value.scenarioId !== saved.id ||
          value.scenarioRevision !== saved.revision ||
          value.versionId !== version.id ||
          value.artifactId !== version.artifactId ||
          value.result.through !== through ||
          value.result.totalSteps !== scenario.steps.length ||
          value.compareVersionId !== (compare || null)
        ) {
          setPlaying(false);
          setError('Replay identity changed. Reload the scenario before continuing.');
          return;
        }
        acceptRun(value, !compare);
        if (through >= scenario.steps.length) setPlaying(false);
      },
    );
  }
  useEffect(() => {
    if (!playing || busy) return;
    if (cursor >= scenario.steps.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => seek(cursor + 1), 450);
    return () => clearTimeout(timer);
  });
  const ready = Boolean(saved && !dirty && validation.success && !busy);
  function adoptRun(value: RehearsalRun, canPreview: boolean) {
    setScenario(value.scenario);
    setSaved(null);
    setDirty(true);
    setRecordingSelector(null);
    acceptRun(value, canPreview);
  }
  return (
    <div className="interactive-studio" aria-label="Interactive rehearsal studio">
      <p className="note">
        Private rehearsal · exact version {version.number} · artifact{' '}
        {shortHash(version.artifactId)}. Each cursor starts a fresh isolated engine. No live
        effects.
      </p>
      <div className="rehearsal-grid">
        <label>
          Saved scenario
          <select
            value={saved?.id ?? ''}
            disabled={busy}
            onChange={(e) => {
              const item = library.find((x) => x.id === e.target.value);
              if (item) load(item);
            }}
          >
            <option value="">Choose saved inputs</option>
            {library.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · revision {s.revision}
              </option>
            ))}
          </select>
        </label>
        <button className="button small" disabled={busy} onClick={() => unsaved(blank())}>
          New scenario
        </button>
        <button
          className="button small"
          disabled={busy}
          onClick={() => void operation((s) => api.rehearsalScenarios(s), publishScenarios)}
        >
          Reload library
        </button>
        <button
          className="button small"
          disabled={busy || !saved}
          onClick={() =>
            saved && void operation((signal) => api.rehearsalScenario(saved.id, signal), load)
          }
        >
          Reload saved inputs
        </button>
      </div>
      <fieldset disabled={busy} className="rehearsal-grid">
        <legend>Scenario inputs</legend>
        <label>
          Scenario name
          <input
            value={name}
            maxLength={80}
            onChange={(e) => {
              invalidate();
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          Seed
          <input
            type="number"
            min={1}
            max={4294967295}
            value={scenario.seed}
            onChange={(e) => edit({ ...scenario, seed: Number(e.target.value) })}
          />
        </label>
        <label>
          Logical origin (ms)
          <input
            type="number"
            min={0}
            value={scenario.initialAt}
            onChange={(e) => edit({ ...scenario, initialAt: Number(e.target.value) })}
          />
        </label>
        <label>
          Preset
          <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
            {presets.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <button
          className="button small"
          disabled={!validation.success}
          onClick={() =>
            void operation(
              (s) => api.rehearsalPreset(version.id, preset, scenario.seed, s),
              (value) => unsaved(value),
            )
          }
        >
          Load preset
        </button>
        <button
          className="button small"
          disabled={!recording}
          onClick={() =>
            recording &&
            void operation(
              (s) =>
                api.rehearsalRecording(recording.versionId, recording.sessionId, scenario.seed, s),
              (value) => unsaved(value, recording),
            )
          }
        >
          Import current round
        </button>
        <button
          className="button primary small"
          disabled={!dirty || !name.trim() || !validation.success}
          onClick={save}
        >
          Save scenario
        </button>
        <button
          className="button small danger"
          disabled={!saved}
          onClick={() =>
            saved &&
            void operation(
              (s) => api.rehearsalDeleteScenario(saved.id, saved.revision, s),
              () => {
                publishScenarios((items) => items.filter((x) => x.id !== saved.id));
                unsaved(scenario);
                setNotice('Scenario deleted. Retained regressions remain in the library.');
              },
            )
          }
        >
          Delete scenario
        </button>
      </fieldset>
      <p className="note">
        {saved ? `Stored revision ${saved.revision}` : 'Unsaved scenario'} ·{' '}
        {dirty ? 'Save inputs before replay' : 'Saved exact inputs'} · Provenance:{' '}
        {recordingSelector
          ? 'sanitized-recording (host import)'
          : dirty && saved && saved.scenario.provenance.kind !== 'synthetic'
            ? 'synthetic derivative (on save)'
            : scenario.provenance.kind}{' '}
        · {scenario.initialSession ? 'Pinned initial snapshot' : 'Fresh start at logical origin'} ·{' '}
        {scenario.steps.length} of 120 steps · {scenario.expectations.length} of 20 expectations.
      </p>
      {!recording && (
        <p className="note">
          Current-round recording unavailable: select a version with an active single-version round.
        </p>
      )}
      {scenario.provenance.kind === 'sanitized-recording' && (
        <p className="note">
          Sanitized recording · pinned version {scenario.provenance.originVersionId} · private
          session {scenario.provenance.originSessionId}. Cosmetic coordinates may differ from the
          live journal.
        </p>
      )}
      {scenario.initialSession && (
        <button
          className="button small"
          disabled={busy}
          onClick={() => edit({ ...scenario, initialSession: null })}
        >
          Use fresh origin instead of snapshot
        </button>
      )}
      {!validation.success && (
        <p role="alert">Invalid scenario: {validation.error.issues[0]?.message}</p>
      )}
      <InputEditor
        scenario={scenario}
        version={version}
        busy={busy}
        edit={edit}
        onError={setError}
      />
      <Timeline
        version={version}
        versions={versions}
        scenario={scenario}
        run={run}
        compare={compare}
        freshStart={freshStart}
        busy={busy}
        ready={ready}
        cursor={cursor}
        playing={playing}
        setCompare={setCompare}
        setFreshStart={setFreshStart}
        invalidate={invalidate}
        seek={seek}
        cancel={cancel}
        setPlaying={setPlaying}
        primaryStage={primaryStage}
        compareStage={compareStage}
      />
      <RegressionPanel
        version={version}
        versions={versions}
        run={run}
        regressions={regressions}
        busy={busy}
        operation={operation}
        adoptRun={adoptRun}
        publishRegressions={publishRegressions}
        setNotice={setNotice}
        setPlaying={setPlaying}
        onRun={onRun}
      />
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="answer">
          {notice}
        </p>
      )}
    </div>
  );
}
