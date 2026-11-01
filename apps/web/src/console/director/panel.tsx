import './panel.css';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import type { Version } from '../../lib/types.js';
import { PanelCard, Step, Stat, Check, Fingerprint, Segmented, type Tone } from '../panel-kit.js';
import { DirectorReplay } from './replay.js';
import {
  defaultEnvelope,
  envelopeSchema,
  stateSchema,
  envelopeProblems,
  type Envelope,
  type DirectorState,
  type Settings,
  type Decision,
} from './contracts.js';

type Action = 'draft' | 'rehearse' | 'approve' | 'control' | 'stop';
const MODES = [
  {
    value: 'balanced',
    label: 'Balanced',
    hint: 'Adapt to chat: regular when readable, calm in a burst',
  },
  {
    value: 'gameplay',
    label: 'Gameplay focus',
    hint: 'Always use the calm end of the approved ranges',
  },
  { value: 'locked', label: 'Lock current', hint: 'Freeze the current settings; caps still apply' },
] as const;
const MODE_LABEL = {
  balanced: 'Balanced',
  gameplay: 'Gameplay focus',
  locked: 'Locked',
  manual: 'Manual',
};
const SETTINGS = [
  { key: 'intervalMs', label: 'Pause between batches', unit: 'ms', step: 50 },
  { key: 'batchSize', label: 'Effects per batch', unit: '', step: 1 },
  { key: 'intensity', label: 'Visual intensity', unit: '%', step: 5 },
] as const;

/** One-line summary for the collapsed card. */
function summary(state: DirectorState | null): { text: string; tone: Tone } {
  if (!state) return { text: 'Loading…', tone: 'muted' };
  if (state.enabled) return { text: `Adapting · ${MODE_LABEL[state.mode]}`, tone: 'good' };
  if (state.approved) return { text: 'Approved · stopped', tone: 'warn' };
  const evidence = state.draft?.evidence;
  if (evidence?.passed && evidence.digest === state.draft?.digest)
    return { text: 'Ready to approve', tone: 'private' };
  if (state.draft) return { text: 'Draft · not tested', tone: 'muted' };
  return { text: 'Not set up', tone: 'muted' };
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
const settingsLine = (s: Settings) =>
  `every ${seconds(s.intervalMs)} · ${s.batchSize} ${s.batchSize === 1 ? 'effect' : 'effects'} · ${s.intensity}%`;

export function DirectorPanel({ versions, panic }: { versions: Version[]; panic: boolean }) {
  const [state, setState] = useState<DirectorState | null>(null);
  const [envelope, setEnvelope] = useState<Envelope>(defaultEnvelope);
  const [versionId, setVersionId] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<Settings | null>(null);
  const epoch = useRef(0),
    mounted = useRef(true),
    inflight = useRef(false),
    initialized = useRef(false),
    mutating = useRef(false),
    selectionInitialized = useRef(false);
  const draft = state?.draft ?? null;
  const evidence = draft?.evidence ?? null;
  const approved = state?.approved ?? null;
  const testable = versions.filter((v) => v.artifactId && v.evidence?.verification.ok);

  useEffect(() => {
    if (!state || !versions.length || selectionInitialized.current) return;
    const tested = state.draft?.evidence?.versionId;
    const initial =
      versions.find((version) => version.id === tested) ??
      versions.find((version) => version.evidence?.verification.ok);
    if (initial) {
      setVersionId(initial.id);
      selectionInitialized.current = true;
    }
  }, [state, versions]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const poll = async () => {
      if (inflight.current || mutating.current) return;
      const current = epoch.current;
      inflight.current = true;
      try {
        const next = z
          .object({ state: stateSchema })
          .parse(await request('GET', '/api/director', undefined, controller.signal)).state;
        if (mounted.current && current === epoch.current) {
          setState(next);
          if (!initialized.current) {
            setEnvelope(next.draft?.envelope ?? defaultEnvelope);
            initialized.current = true;
          }
        }
      } catch (e) {
        if (mounted.current && !controller.signal.aborted && current === epoch.current)
          setError(e instanceof Error ? e.message : 'Director unavailable');
      } finally {
        inflight.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      mounted.current = false;
      epoch.current++;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  async function mutate(action: Action, body: unknown) {
    const current = ++epoch.current;
    mutating.current = true;
    setBusy(action);
    setError('');
    try {
      const next = z
        .object({ state: stateSchema })
        .parse(await request('POST', `/api/director/${action}`, body)).state;
      if (mounted.current && epoch.current === current) setState(next);
    } catch (e) {
      if (mounted.current && epoch.current === current)
        setError(e instanceof Error ? e.message : 'Director request failed');
    } finally {
      if (mounted.current && epoch.current === current) {
        mutating.current = false;
        setBusy(null);
      }
    }
  }

  const problems = envelopeProblems(envelope);
  const valid = envelopeSchema.safeParse(envelope).success && !problems.length;
  const dirty = JSON.stringify(envelope) !== JSON.stringify(draft?.envelope);
  const tested = !!evidence && evidence.digest === draft?.digest;
  const approvedCurrent = !!approved && approved.digest === draft?.digest;
  const approveBlocker = panic
    ? 'Resume from the emergency stop before approving.'
    : dirty
      ? 'Save your edits and stress-test them first.'
      : !tested
        ? 'Run the private stress test for this exact draft.'
        : !evidence.passed
          ? 'The stress test did not pass; adjust the ranges and test again.'
          : evidence.versionId !== versionId
            ? 'The evidence is for a different version. Test the selected version.'
            : approvedCurrent
              ? 'This exact draft is already approved.'
              : null;
  const runBlocker = !draft
    ? 'Save a draft first.'
    : dirty
      ? 'Save your edits first; the test always uses the saved draft.'
      : !versionId
        ? 'Choose a version to test.'
        : null;
  const manualSettings = manual ?? state?.settings ?? null;
  const manualProblem =
    approved && manualSettings
      ? SETTINGS.find(
          ({ key }) =>
            !Number.isInteger(manualSettings[key]) ||
            manualSettings[key] < approved.envelope[key].min ||
            manualSettings[key] > approved.envelope[key].max,
        )
      : undefined;
  const control = (action: 'balanced' | 'gameplay' | 'locked' | 'manual') =>
    void mutate('control', {
      expectedRevision: state?.revision,
      action,
      ...(action === 'manual' ? { settings: manualSettings } : {}),
    });
  const stopButton = (
    <button
      type="button"
      className="button small danger director-stop"
      disabled={busy === 'stop'}
      onClick={() => void mutate('stop', {})}
    >
      Stop director cosmetics immediately
    </button>
  );
  /** "Quiet chat" and "burst" ends of each approved range, in the order the policy uses them. */
  const ends = {
    intervalMs: { quiet: 'min', burst: 'max' },
    batchSize: { quiet: 'max', burst: 'min' },
    intensity: { quiet: 'max', burst: 'min' },
  } as const;
  const setBound = (key: (typeof SETTINGS)[number]['key'], bound: 'min' | 'max', value: number) =>
    setEnvelope({ ...envelope, [key]: { ...envelope[key], [bound]: value } });
  const telemetry = state?.telemetry;

  return (
    <PanelCard
      title="Adaptive director"
      subtitle="Keeps chat bursts readable on stream. Scores, resources and rules never change."
      status={summary(state)}
      actions={state?.enabled ? stopButton : null}
      className="director-panel"
    >
      <p className="panel-lead">
        When chat floods, the director paces <em>cosmetic</em> effects inside ranges you approve:
        fewer, calmer effects during a burst, livelier ones when chat is quiet. Every accepted
        action still counts. Protected screen areas stay in the visual canvas; rule changes go
        through Describe and version review.
      </p>

      <ol className="panel-steps">
        <Step
          title="Set the ranges"
          done={!!draft && !dirty}
          current={!draft || dirty}
          aside={
            <span className="panel-hint">
              {dirty ? (
                <b className="director-unsaved">Unsaved edits</b>
              ) : draft ? (
                <>
                  Saved draft <Fingerprint value={draft.digest} label="Draft digest" />
                </>
              ) : (
                'Nothing saved yet'
              )}
            </span>
          }
        >
          <form
            className="director-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && state)
                void mutate('draft', { expectedRevision: state.revision, envelope });
            }}
          >
            <fieldset disabled={!!busy || !state}>
              <legend className="sr-only">Draft presentation ranges</legend>
              <div className="director-ranges" role="table" aria-label="Presentation ranges">
                <div role="row" className="director-range-head">
                  <span role="columnheader">Setting</span>
                  <span role="columnheader">
                    Quiet chat <small>regular</small>
                  </span>
                  <span role="columnheader">
                    During a burst <small>calm</small>
                  </span>
                </div>
                {SETTINGS.map(({ key, label, unit, step }) => (
                  <div role="row" key={key} className="director-range-row">
                    <span role="rowheader">
                      {label}
                      {unit && <small> ({unit})</small>}
                    </span>
                    {(['quiet', 'burst'] as const).map((end) => {
                      const bound = ends[key][end];
                      return (
                        <span role="cell" key={end}>
                          <input
                            type="number"
                            inputMode="numeric"
                            aria-label={`${label} ${end === 'quiet' ? 'in quiet chat' : 'during a burst'}`}
                            aria-invalid={problems.some((p) => p.key === key) || undefined}
                            step={step}
                            min={key === 'intervalMs' ? 250 : key === 'batchSize' ? 1 : 25}
                            max={key === 'intervalMs' ? 2000 : key === 'batchSize' ? 6 : 100}
                            value={Number.isNaN(envelope[key][bound]) ? '' : envelope[key][bound]}
                            onChange={(e) => setBound(key, bound, e.target.valueAsNumber)}
                          />
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="panel-grid director-extra">
                <label>
                  Interruptions per minute
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="60"
                    value={
                      Number.isNaN(envelope.interruptionsPerMinute)
                        ? ''
                        : envelope.interruptionsPerMinute
                    }
                    onChange={(e) =>
                      setEnvelope({ ...envelope, interruptionsPerMinute: e.target.valueAsNumber })
                    }
                  />
                  <span className="panel-hint">
                    Most batches shown in any rolling minute (1–60).
                  </span>
                </label>
                <div className="director-order">
                  <span className="director-label" id="director-order-label">
                    Who is shown first in a batch
                  </span>
                  <Segmented
                    label="Who is shown first in a batch"
                    value={envelope.participation}
                    options={[
                      { value: 'first-time', label: 'First-timers first' },
                      { value: 'fifo', label: 'Arrival order' },
                    ]}
                    onChange={(participation) => setEnvelope({ ...envelope, participation })}
                  />
                  <span className="panel-hint">
                    {envelope.participation === 'first-time'
                      ? 'A viewer’s first action this round gets visual priority.'
                      : 'Effects appear in the order they were accepted.'}
                  </span>
                </div>
              </div>
              {problems.length > 0 && (
                <ul className="panel-problem director-problems" role="alert">
                  {problems.map((p) => (
                    <li key={p.message}>{p.message}</li>
                  ))}
                </ul>
              )}
              <div className="panel-actions">
                <button className="button" disabled={!valid || !dirty}>
                  {busy === 'draft' ? 'Saving…' : 'Save draft only'}
                </button>
                {dirty && draft && (
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => setEnvelope(draft.envelope)}
                  >
                    Discard edits
                  </button>
                )}
                <span className="panel-hint">
                  Saving never changes what is live. Approval does.
                </span>
              </div>
            </fieldset>
          </form>
        </Step>

        <Step
          title="Stress-test privately"
          done={tested && !dirty && !!evidence?.passed}
          current={!!draft && !dirty && !tested}
          aside={<span className="pill private">Never on stream</span>}
        >
          <div className="panel-actions director-run">
            <label className="director-version">
              Stress-test version
              <select
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                disabled={!!busy}
              >
                <option value="">Choose version</option>
                {testable.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title} v{v.number}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              disabled={!!busy || !!runBlocker}
              onClick={() =>
                void mutate('rehearse', { expectedRevision: state?.revision, versionId })
              }
            >
              {busy === 'rehearse' ? 'Running 40-viewer burst…' : 'Run private synthetic burst'}
            </button>
            <span className="panel-hint">
              {runBlocker ??
                'Replays a 40-viewer crowd burst twice in the sandbox, then runs the director on the results.'}
            </span>
          </div>
          {evidence && (
            <div className="panel-surface director-evidence" aria-label="Stress-test evidence">
              <div className="director-evidence-head">
                <h4>Private synthetic evidence</h4>
                <span className={`badge ${evidence.passed ? 'good' : 'bad'}`}>
                  {evidence.passed ? 'Passed' : 'Failed'}
                </span>
                {!tested && <span className="badge warn">For an older draft</span>}
              </div>
              <div className="director-evidence-grid">
                <DirectorReplay evidence={evidence} />
                <div className="director-evidence-facts">
                  <dl className="panel-stats">
                    <Stat
                      label="Accepted actions"
                      value={evidence.accepted}
                      hint="All still score"
                    />
                    <Stat label="Blocked" value={evidence.blocked} hint="By the game’s own rules" />
                    <Stat
                      label="Effects shown"
                      value={evidence.telemetry.presented}
                      tone="good"
                      hint={`in ${evidence.samples.length} ${evidence.samples.length === 1 ? 'batch' : 'batches'}`}
                    />
                    <Stat
                      label="Merged"
                      value={evidence.telemetry.coalesced}
                      hint="Cosmetic only"
                    />
                    <Stat
                      label="Expired"
                      value={evidence.telemetry.expired}
                      hint="Waited over 5 s"
                    />
                  </dl>
                  <ul className="panel-checks">
                    <Check ok={evidence.stateDigest === evidence.replayStateDigest}>
                      Gameplay state identical across two independent sandbox runs
                    </Check>
                    <Check
                      ok={
                        evidence.telemetry.offered ===
                        evidence.telemetry.presented +
                          evidence.telemetry.coalesced +
                          evidence.telemetry.expired +
                          evidence.telemetry.cleared +
                          evidence.telemetry.pending
                      }
                    >
                      Every effect accounted for: shown, merged, expired or cleared
                    </Check>
                  </ul>
                  <p className="panel-hint">
                    {Object.keys(evidence.scores).length
                      ? `Final scores: ${Object.entries(evidence.scores)
                          .map(([name, score]) => `${name}: ${score}`)
                          .join(', ')} · ${evidence.contributions} contributions`
                      : 'This interaction keeps no scores; every accepted action is still counted above.'}
                  </p>
                </div>
              </div>
              <details>
                <summary>
                  Why the director changed pace ({evidence.telemetry.decisions.length})
                </summary>
                <Decisions decisions={evidence.telemetry.decisions} />
              </details>
            </div>
          )}
        </Step>

        <Step
          title="Approve the exact tested ranges"
          done={approvedCurrent}
          current={tested && !dirty && !!evidence?.passed && !approvedCurrent}
        >
          {approvedCurrent ? (
            <p className="panel-callout" data-tone="good">
              This exact draft is approved
              {state?.enabled ? ' and adapting live.' : '. Pick a mode below to resume adapting.'}
            </p>
          ) : (
            <div className="panel-actions">
              <button
                className="button primary"
                disabled={!!busy || !!approveBlocker || !evidence}
                onClick={() =>
                  void mutate('approve', {
                    expectedRevision: state?.revision,
                    digest: draft?.digest,
                    evidenceHash: evidence?.hash,
                  })
                }
              >
                {busy === 'approve' ? 'Approving…' : 'Approve exact tested envelope'}
              </button>
              <span className="panel-hint">
                {approveBlocker ??
                  'Approval binds these ranges to this evidence and starts adapting immediately.'}
              </span>
            </div>
          )}
        </Step>
      </ol>

      <section className="panel-surface director-live" aria-labelledby="director-live-heading">
        <div className="director-live-head">
          <div>
            <h3 id="director-live-heading">Approved live controls</h3>
            <p className="panel-hint">
              {approved ? (
                <>
                  Approved <Fingerprint value={approved.digest} label="Approved digest" /> ·{' '}
                  {new Date(approved.approvedAt).toLocaleString()}
                </>
              ) : (
                'Approve a tested envelope to unlock live controls.'
              )}
            </p>
          </div>
          {!state?.enabled && stopButton}
        </div>
        {approved && (
          <div className="director-approved">
            <ApprovedRange
              label="Quiet chat"
              settings={{
                intervalMs: approved.envelope.intervalMs.min,
                batchSize: approved.envelope.batchSize.max,
                intensity: approved.envelope.intensity.max,
              }}
            />
            <ApprovedRange
              label="During a burst"
              settings={{
                intervalMs: approved.envelope.intervalMs.max,
                batchSize: approved.envelope.batchSize.min,
                intensity: approved.envelope.intensity.min,
              }}
            />
            <p className="panel-hint">
              At most {approved.envelope.interruptionsPerMinute} interruptions per minute ·{' '}
              {approved.envelope.participation === 'fifo' ? 'arrival order' : 'first-timers first'}
            </p>
          </div>
        )}
        <fieldset disabled={!!busy || !approved || panic} className="director-controls">
          <legend className="sr-only">Approved live controls</legend>
          {!state?.enabled && approved && (
            <p className="panel-callout" data-tone="warn">
              Presentation is stopped. Effects still score but are not shown until you pick a mode.
            </p>
          )}
          <div className="panel-actions">
            <Segmented
              label="Director mode"
              value={state?.enabled && state.mode !== 'manual' ? state.mode : null}
              options={MODES}
              disabled={!!busy || !approved || panic}
              onChange={(mode) => control(mode)}
            />
            <span className="panel-hint">
              {state?.enabled
                ? (MODES.find((m) => m.value === state.mode)?.hint ??
                  'Manual settings inside the approved ranges.')
                : 'Choosing a mode starts adapting.'}
            </span>
          </div>
          {approved && (
            <details className="director-manual">
              <summary>Manual override</summary>
              <div className="panel-grid">
                {SETTINGS.map(({ key, label, unit, step }) => (
                  <label key={key}>
                    {label}
                    {unit && ` (${unit})`}
                    <input
                      type="number"
                      inputMode="numeric"
                      aria-label={`Manual ${label}`}
                      step={step}
                      min={approved.envelope[key].min}
                      max={approved.envelope[key].max}
                      value={
                        manualSettings && !Number.isNaN(manualSettings[key])
                          ? manualSettings[key]
                          : ''
                      }
                      aria-invalid={manualProblem?.key === key || undefined}
                      onChange={(e) =>
                        manualSettings &&
                        setManual({ ...manualSettings, [key]: e.target.valueAsNumber })
                      }
                    />
                    <span className="panel-hint">
                      Approved {approved.envelope[key].min}–{approved.envelope[key].max}
                    </span>
                  </label>
                ))}
              </div>
              <div className="panel-actions">
                <button
                  type="button"
                  className="button"
                  disabled={!manualSettings || !!manualProblem}
                  onClick={() => control('manual')}
                >
                  Apply manual override
                </button>
                {manualProblem && (
                  <span className="panel-problem">
                    {manualProblem.label} must stay inside the approved range.
                  </span>
                )}
              </div>
            </details>
          )}
        </fieldset>
        {state?.settings && telemetry && (
          <div className="director-now" aria-live="polite">
            <p>
              <b>{state.enabled ? MODE_LABEL[state.mode] : 'Stopped'}</b> ·{' '}
              {settingsLine(state.settings)}
            </p>
            <div
              className="director-queue"
              role="meter"
              aria-label="Queued effects"
              aria-valuemin={0}
              aria-valuemax={120}
              aria-valuenow={telemetry.pending}
            >
              <span style={{ width: `${(telemetry.pending / 120) * 100}%` }} />
            </div>
            <p className="panel-hint">
              {telemetry.pending} queued · {telemetry.accepted} accepted · {telemetry.presented}{' '}
              shown · {telemetry.coalesced} merged · {telemetry.expired} expired ·{' '}
              {telemetry.cleared} cleared
            </p>
            {telemetry.decisions.at(-1) && (
              <p className="director-reason">{telemetry.decisions.at(-1)?.reason}</p>
            )}
          </div>
        )}
        {telemetry && (
          <details>
            <summary>Decision history ({telemetry.decisions.length})</summary>
            <Decisions decisions={telemetry.decisions} />
          </details>
        )}
        <p className="panel-hint">
          The emergency stop in the header still stops every interaction, not just cosmetics.
        </p>
      </section>

      {!!state?.history.length && (
        <details className="director-history">
          <summary>Envelope history ({state.history.length})</summary>
          <ol className="director-history-list">
            {[...state.history].reverse().map((item) => (
              <li key={item.revision}>
                <span>
                  <b>Revision {item.revision}</b>{' '}
                  <Fingerprint value={item.digest} label="Envelope digest" />
                  {item.revision === approved?.revision && (
                    <span className="badge good">Approved</span>
                  )}
                  {item.revision === draft?.revision && <span className="badge">Draft</span>}
                </span>
                <span className="panel-hint">
                  {item.envelope.intervalMs.min}–{item.envelope.intervalMs.max} ms ·{' '}
                  {item.envelope.batchSize.min}–{item.envelope.batchSize.max} effects ·{' '}
                  {item.envelope.intensity.min}–{item.envelope.intensity.max}%
                </span>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={!!busy || item.revision === draft?.revision}
                  onClick={() => {
                    setEnvelope(item.envelope);
                    void mutate('draft', {
                      expectedRevision: state.revision,
                      envelope: item.envelope,
                    });
                  }}
                >
                  Restore as new draft
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {busy && busy !== 'stop' && (
        <p role="status" className="panel-hint">
          Updating director…
        </p>
      )}
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
    </PanelCard>
  );
}

function ApprovedRange({ label, settings }: { label: string; settings: Settings }) {
  return (
    <div className="director-end">
      <span>{label}</span>
      <b>{settingsLine(settings)}</b>
    </div>
  );
}

/** Rehearsal clocks start at 0; live decisions carry wall-clock milliseconds. */
const when = (at: number) => (at > 1e11 ? new Date(at).toLocaleTimeString() : seconds(at));
function Decisions({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length) return <p className="panel-hint">No decisions yet.</p>;
  return (
    <ol className="panel-timeline">
      {[...decisions].reverse().map((decision, index) => (
        <li key={`${decision.at}-${index}`}>
          <time>{when(decision.at)}</time>
          <span>
            {decision.reason}
            <small>
              {settingsLine(decision.settings)} · {decision.pending} queued · {decision.activity}{' '}
              recent
            </small>
          </span>
        </li>
      ))}
    </ol>
  );
}
