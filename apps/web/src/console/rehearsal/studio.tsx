import type { Scene } from '../../scenes/schema.js';
import { usePrivateLibrary } from './library.js';
import { InputEditor, type ExpectationDraft } from './input-editor.js';
import { Player } from './timeline.js';
import { RegressionPanel, type FailureFocus } from './regressions.js';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { Run, Version } from '../../lib/types.js';
import { clearStage } from '../../effects/projectile.js';
import { shortHash } from '../format.js';
import {
  presets,
  scenarioSchema,
  type RehearsalRun,
  type RehearsalScenario,
  type Regression,
  type ScenarioRecord,
} from './contracts.js';
import { PRESET_TEXT, friendlyError, presetApplies } from './labels.js';

export interface StudioProps {
  instructions?: string[] | undefined;
  scene?: Scene | undefined;
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
/** Client-side playback over frames the host already replayed once: ≤600 ms a step, ~15 s total. */
const stepMs = (total: number) =>
  Math.max(120, Math.min(600, Math.floor(15_000 / Math.max(1, total))));
/** Dragging the cursor shows frames immediately and asks for exact state once it settles. */
const SCRUB_MS = 180;

/** Each request owns an epoch, abort signal and immutable version/revision context. */
export function InteractiveStudio({
  version,
  instructions,
  scene,
  versions,
  recording,
  onPreviewed,
  onRun,
}: StudioProps) {
  const [scenario, setScenario] = useState(blank);
  const [saved, setSaved] = useState<ScenarioRecord | null>(null);
  const [dirty, setDirty] = useState(true);
  const [name, setName] = useState('My scenario');
  const {
    items: library,
    commit: commitScenarios,
    refresh: refreshScenarios,
    refreshError: scenarioRefreshError,
    refreshing: scenariosRefreshing,
  } = usePrivateLibrary<ScenarioRecord>(api.rehearsalScenarios, 'Scenario');
  const {
    items: regressions,
    commit: commitRegressions,
    refresh: refreshRegressions,
    refreshError: regressionRefreshError,
    refreshing: regressionsRefreshing,
  } = usePrivateLibrary<Regression>(api.rehearsalRegressions, 'Regression');
  const [sourceRun, setSourceRun] = useState<RehearsalRun | null>(null);
  const [run, setRun] = useState<RehearsalRun | null>(null);
  /** The latest complete replay for the current exact identity; drives playback and the step list. */
  const [trace, setTrace] = useState<{ key: string; run: RehearsalRun } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [compare, setCompare] = useState('');
  const [freshStart, setFreshStart] = useState(true);
  const [preset, setPreset] = useState<(typeof presets)[number]>('proof');
  const [draft, setDraft] = useState<ExpectationDraft | null>(null);
  const [focus, setFocus] = useState<FailureFocus | null>(null);
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const scrub = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primaryStage = useRef<HTMLDivElement>(null);
  const compareStage = useRef<HTMLDivElement>(null);
  const identity =
    saved && !dirty
      ? `${saved.id}:${saved.revision}:${version.id}:${version.artifactId}:${compare}:${freshStart}`
      : null;
  const total = scenario.steps.length;
  const full =
    trace &&
    trace.key === identity &&
    trace.run.result.timeline.length === total &&
    (!trace.run.comparison || trace.run.comparison.timeline.length === total)
      ? trace.run
      : null;

  function clearEffects() {
    for (const node of [primaryStage.current, compareStage.current]) if (node) clearStage(node);
  }
  function stopScrub() {
    if (scrub.current) clearTimeout(scrub.current);
    scrub.current = null;
  }
  function cancel() {
    stopScrub();
    epoch.current++;
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setPlaying(false);
    clearEffects();
  }
  useEffect(
    () => () => {
      stopScrub();
      epoch.current++;
      request.current?.abort();
    },
    [],
  );
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
        setError(friendlyError(cause));
      }
    } finally {
      if (own === epoch.current && !c.signal.aborted) setBusy(false);
    }
  }
  function invalidate() {
    stopScrub();
    setBusy(false);
    epoch.current++;
    request.current?.abort();
    setRun(null);
    setTrace(null);
    setCursor(0);
    setPlaying(false);
    setFocus(null);
    clearEffects();
  }
  function edit(next: RehearsalScenario) {
    invalidate();
    setScenario({ ...next, provenance: { kind: 'synthetic' } });
    setDirty(true);
  }
  function load(record: ScenarioRecord) {
    invalidate();
    setSaved(record);
    setScenario(record.scenario);
    setName(record.name);
    setDirty(false);
    setSourceRun(null);
    setError(null);
  }
  function unsaved(next: RehearsalScenario) {
    invalidate();
    setSaved(null);
    setScenario(next);
    setDirty(true);
    setSourceRun(null);
    setError(null);
  }
  const validation = scenarioSchema.safeParse(scenario);
  function save(then?: (record: ScenarioRecord) => void) {
    if (!validation.success) return;
    void operation(
      (signal) =>
        api.rehearsalSave(
          {
            name,
            scenario: { ...scenario, provenance: { kind: 'synthetic' } },
            ...(sourceRun ? { sourceRunId: sourceRun.id } : {}),
          },
          saved ?? undefined,
          signal,
        ),
      (record) => {
        load(record);
        commitScenarios((items) => [record, ...items.filter((x) => x.id !== record.id)]);
        setNotice(
          then
            ? 'Inputs saved. Replaying privately…'
            : 'Saved. Earlier replay results were cleared.',
        );
        then?.(record);
      },
    );
  }
  function credit(value: RehearsalRun, canPreview: boolean) {
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
  function acceptRun(value: RehearsalRun, canPreview: boolean) {
    setRun(value);
    setCursor(value.result.through);
    clearEffects();
    credit(value, canPreview);
  }
  /**
   * Replays exactly `through` steps in a fresh private engine. `record` lets a save chain
   * straight into a run; `startPlayback` keeps the cursor and only fetches the full trace.
   */
  function seek(
    through: number,
    options: { record?: ScenarioRecord; startPlayback?: boolean } = {},
  ) {
    const record = options.record ?? (dirty ? null : saved);
    if (!record) return;
    stopScrub();
    const steps = record.scenario.steps.length;
    const key = `${record.id}:${record.revision}:${version.id}:${version.artifactId}:${compare}:${freshStart}`;
    if (!options.startPlayback) clearEffects();
    void operation(
      (signal) =>
        api.rehearsalRun(
          record.id,
          {
            expectedRevision: record.revision,
            versionId: version.id,
            through,
            ...(compare ? { compareVersionId: compare, freshStart } : {}),
          },
          signal,
        ),
      (value) => {
        // A response for another revision/version is never usable as current evidence.
        if (
          value.scenarioId !== record.id ||
          value.scenarioRevision !== record.revision ||
          value.versionId !== version.id ||
          value.artifactId !== version.artifactId ||
          value.result.through !== through ||
          value.result.totalSteps !== steps ||
          value.compareVersionId !== (compare || null)
        ) {
          setPlaying(false);
          setError('Replay identity changed. Reload the scenario before continuing.');
          return;
        }
        if (through === steps) setTrace({ key, run: value });
        if (options.startPlayback) {
          credit(value, !compare);
          setPlaying(true);
          return;
        }
        acceptRun(value, !compare);
        if (through >= steps) setPlaying(false);
      },
    );
  }
  /** Move to a cursor: instant from the cached full replay at the end, otherwise one exact replay. */
  function goTo(through: number) {
    setPlaying(false);
    if (full && through === total) {
      stopScrub();
      acceptRun(full, false);
      return;
    }
    seek(through);
  }
  function scrubTo(through: number) {
    setPlaying(false);
    setCursor(through);
    clearEffects();
    stopScrub();
    scrub.current = setTimeout(() => goTo(through), SCRUB_MS);
  }
  const canRun = Boolean(validation.success && total > 0 && name.trim() && !busy);
  /** Unsaved inputs are saved first so every replay binds an exact stored revision. */
  function runFrom(through: number, startPlayback = false) {
    if (!dirty && saved) {
      if (startPlayback) seek(total, { startPlayback: true });
      else goTo(through);
    } else
      save((record) =>
        startPlayback
          ? seek(record.scenario.steps.length, { record, startPlayback: true })
          : seek(Math.min(through, record.scenario.steps.length), { record }),
      );
  }
  function play() {
    if (cursor >= total) {
      clearEffects();
      setCursor(0);
    }
    if (full) setPlaying(true);
    else runFrom(total, true);
  }
  function pause() {
    if (busy) return cancel();
    setPlaying(false);
    // Frames carry outcomes and scores; fetch the complete state for the paused step.
    if (full && cursor > 0 && cursor < total) seek(cursor);
  }
  useEffect(() => {
    if (!playing || busy) return;
    if (cursor >= total) {
      setPlaying(false);
      if (full) setRun(full);
      return;
    }
    const timer = setTimeout(
      () => {
        if (!full) return seek(cursor + 1);
        const next = cursor + 1;
        setCursor(next);
        if (next === total) {
          setRun(full);
          setPlaying(false);
        }
      },
      full ? stepMs(total) : 450,
    );
    return () => clearTimeout(timer);
  });
  function adoptRun(value: RehearsalRun, canPreview: boolean) {
    setScenario(value.scenario);
    setSaved(null);
    setDirty(true);
    setSourceRun(value);
    setTrace(null);
    acceptRun(value, canPreview);
  }
  function importRound() {
    if (!recording) return;
    void operation(
      (s) =>
        api.rehearsalSave({ name, recording: { ...recording, seed: scenario.seed } }, undefined, s),
      (record) => {
        load(record);
        commitScenarios((items) => [record, ...items.filter((x) => x.id !== record.id)]);
        setNotice('Recording imported and saved. Edits derive from this pinned capture.');
      },
    );
  }
  const provenance =
    dirty &&
    scenario.provenance.kind === 'synthetic' &&
    (sourceRun || (saved && saved.scenario.provenance.kind !== 'synthetic'))
      ? 'synthetic derivative (on save)'
      : scenario.provenance.kind;
  const origin =
    scenario.provenance.kind === 'sanitized-recording'
      ? 'Recorded round'
      : provenance === 'synthetic'
        ? 'Synthetic'
        : 'Edited copy';
  return (
    <div className="interactive-studio" aria-label="Interactive rehearsal studio">
      <fieldset disabled={busy} className="studio-bar">
        <legend className="sr-only">Scenario</legend>
        <label className="studio-pick">
          Saved scenario
          <select
            value={saved?.id ?? ''}
            onChange={(e) => {
              const item = library.find((x) => x.id === e.target.value);
              if (item) load(item);
            }}
          >
            {/* A placeholder, not a choice: loading inputs is the only action here. */}
            <option value="" disabled>
              {library.length ? 'Choose saved inputs' : 'No saved scenarios yet'}
            </option>
            {library.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · revision {s.revision}
              </option>
            ))}
          </select>
        </label>
        <label className="studio-name">
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
        <div className="studio-save">
          <span className={`save-state ${dirty ? 'dirty' : 'clean'}`} role="status">
            {dirty
              ? saved
                ? 'Unsaved changes'
                : 'Not saved yet'
              : `Saved · revision ${saved?.revision ?? 0}`}
          </span>
          <button
            type="button"
            className={`button small ${dirty ? 'primary' : ''}`}
            disabled={!dirty || !name.trim() || !validation.success}
            onClick={() => save()}
          >
            Save scenario
          </button>
          <button type="button" className="button small ghost" onClick={() => unsaved(blank())}>
            New scenario
          </button>
          <details className="studio-more">
            <summary aria-label="More scenario actions">•••</summary>
            <div className="studio-menu">
              <button
                type="button"
                className="button small ghost"
                onClick={() => void refreshScenarios()}
              >
                Reload library
              </button>
              <button
                type="button"
                className="button small ghost"
                disabled={!saved}
                onClick={() =>
                  saved && void operation((signal) => api.rehearsalScenario(saved.id, signal), load)
                }
              >
                Reload saved inputs
              </button>
              <button
                type="button"
                className="button small danger"
                disabled={!saved}
                onClick={() =>
                  saved &&
                  void operation(
                    (s) => api.rehearsalDeleteScenario(saved.id, saved.revision, s),
                    () => {
                      commitScenarios((items) => items.filter((x) => x.id !== saved.id));
                      unsaved(scenario);
                      setNotice('Scenario deleted. Saved regressions stay in the library.');
                    },
                  )
                }
              >
                Delete scenario
              </button>
            </div>
          </details>
        </div>
      </fieldset>
      {scenariosRefreshing && (
        <p role="status" className="note">
          Refreshing scenario library…
        </p>
      )}
      {scenarioRefreshError && (
        <p role="alert" className="answer bad">
          {scenarioRefreshError}
        </p>
      )}

      <fieldset disabled={busy} className="studio-start">
        <legend>Start from</legend>
        <label>
          Preset
          <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
            {presets
              .filter((p) => presetApplies(p, version.manifest.experience))
              .map((p) => (
                <option key={p} value={p}>
                  {PRESET_TEXT[p].title}
                </option>
              ))}
          </select>
        </label>
        <p className="note preset-detail">{PRESET_TEXT[preset].detail}</p>
        <button
          type="button"
          className="button small"
          disabled={!validation.success}
          onClick={() =>
            void operation(
              (s) => api.rehearsalPreset(version.id, preset, scenario.seed, s),
              (value) => {
                unsaved(value);
                setNotice(
                  `${PRESET_TEXT[preset].title} loaded with ${value.steps.length} steps. Press Play to watch it.`,
                );
              },
            )
          }
        >
          Load preset
        </button>
        <span className="start-or" aria-hidden="true">
          or
        </span>
        <button
          type="button"
          className="button small"
          disabled={!recording || !name.trim()}
          title={
            recording
              ? 'Saves an anonymized copy of the live round as a new scenario'
              : 'Available while a single-version round is running live'
          }
          onClick={importRound}
        >
          Import and save current round
        </button>
      </fieldset>
      {scenario.provenance.kind === 'sanitized-recording' && (
        <p className="note provenance-note">
          <span className="badge muted">Recorded</span> Sanitized recording · pinned version{' '}
          {scenario.provenance.originVersionId} · private session{' '}
          {scenario.provenance.originSessionId}. Viewer names are anonymized; cosmetic positions can
          differ from the live round.
        </p>
      )}

      <Player
        instructions={instructions}
        scene={scene}
        version={version}
        versions={versions}
        scenario={scenario}
        run={run}
        full={full}
        compare={compare}
        freshStart={freshStart}
        busy={busy}
        canRun={canRun}
        dirty={dirty || !saved}
        cursor={cursor}
        playing={playing}
        origin={origin}
        setCompare={(value) => {
          invalidate();
          setCompare(value);
        }}
        setFreshStart={(value) => {
          invalidate();
          setFreshStart(value);
        }}
        goTo={(through) => (dirty || !saved ? runFrom(through) : goTo(through))}
        scrubTo={scrubTo}
        play={play}
        pause={pause}
        cancel={cancel}
        primaryStage={primaryStage}
        compareStage={compareStage}
        onExpect={setDraft}
        onFix={(value) => setFocus({ ...value, n: Date.now() })}
      />

      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="answer good">
          {notice}
        </p>
      )}

      <InputEditor
        scenario={scenario}
        version={version}
        busy={busy}
        edit={edit}
        onError={setError}
        draft={draft}
      />

      <RegressionPanel
        version={version}
        versions={versions}
        run={run}
        regressions={regressions}
        busy={busy}
        operation={operation}
        adoptRun={adoptRun}
        commitRegressions={commitRegressions}
        refreshRegressions={refreshRegressions}
        refreshError={regressionRefreshError}
        refreshing={regressionsRefreshing}
        setNotice={setNotice}
        setPlaying={setPlaying}
        onRun={onRun}
        focus={focus}
      />

      <details className="studio-advanced">
        <summary>Advanced · seed, origin and evidence</summary>
        <fieldset disabled={busy} className="rehearsal-grid">
          <legend className="sr-only">Deterministic replay settings</legend>
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
          {scenario.initialSession && (
            <button
              type="button"
              className="button small"
              onClick={() => edit({ ...scenario, initialSession: null })}
            >
              Use fresh origin instead of snapshot
            </button>
          )}
        </fieldset>
        <p className="note">
          {saved ? `Stored revision ${saved.revision}` : 'Unsaved scenario'} ·{' '}
          {dirty ? 'Save inputs before replay' : 'Saved exact inputs'} · Provenance: {provenance} ·{' '}
          {scenario.initialSession ? 'Pinned initial snapshot' : 'Fresh start at logical origin'} ·{' '}
          {total} of 120 steps · {scenario.expectations.length} of 20 expectations.
        </p>
        <p className="note">
          Exact version {version.number} · artifact {shortHash(version.artifactId)}. Each replay
          starts a fresh isolated engine from the origin, so the same inputs and seed always give
          the same outcome. Nothing here reaches your stream or Twitch.
        </p>
        {!recording && (
          <p className="note">
            Current-round import needs a live round running on a single version.
          </p>
        )}
      </details>
      {!validation.success && (
        <p role="alert" className="answer bad">
          Invalid scenario: {validation.error.issues[0]?.message}
        </p>
      )}
    </div>
  );
}
