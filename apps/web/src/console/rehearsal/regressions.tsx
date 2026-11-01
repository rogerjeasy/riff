import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../lib/api.js';
import type { Run, Version } from '../../lib/types.js';
import { ago, shortHash } from '../format.js';
import type { RehearsalRun, Regression } from './contracts.js';
import { codeLabel, describeCheck } from './labels.js';

export type Operation = <T>(
  work: (signal: AbortSignal) => Promise<T>,
  apply: (value: T) => void,
) => Promise<void>;
/** A failed check chosen from the player verdict. */
export interface FailureFocus {
  checkId: string;
  side: 'primary' | 'compare';
  n: number;
}
interface Props {
  version: Version;
  versions: Version[];
  run: RehearsalRun | null;
  regressions: Regression[];
  busy: boolean;
  operation: Operation;
  adoptRun: (value: RehearsalRun, canPreview: boolean) => void;
  commitRegressions: Dispatch<SetStateAction<Regression[]>>;
  refreshRegressions: () => Promise<void>;
  refreshError: string | null;
  refreshing: boolean;
  setNotice: (text: string) => void;
  setPlaying: (value: boolean) => void;
  onRun?: ((run: Run) => void) | undefined;
  focus?: FailureFocus | null;
}
function failureText(regression: Regression) {
  const f = regression.failure;
  const value = (v: unknown) => (f.kind === 'decision' ? codeLabel(String(v)) : String(v));
  return f.category === 'invariant'
    ? 'Host safety check failed'
    : `Expected ${value(f.expected)}, saw ${value(f.actual)}`;
}
export function RegressionPanel({
  version,
  versions,
  run,
  regressions,
  busy,
  operation,
  adoptRun,
  commitRegressions,
  refreshRegressions,
  refreshError,
  refreshing,
  setNotice,
  setPlaying,
  onRun,
  focus,
}: Props) {
  const [failedCheck, setFailedCheck] = useState('');
  const [side, setSide] = useState<'primary' | 'compare'>('primary');
  const [regressionName, setRegressionName] = useState('Regression case');
  const [regressionId, setRegressionId] = useState('');
  const [intent, setIntent] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const fix = useRef<HTMLDetailsElement>(null);
  const library = useRef<HTMLDetailsElement>(null);
  const intentField = useRef<HTMLTextAreaElement>(null);
  const selectedResult = side === 'primary' ? run?.result : run?.comparison;
  const failures = selectedResult?.checks.filter((c) => c.status === 'failed') ?? [];
  const regression = regressions.find((g) => g.id === regressionId);
  const complete = Boolean(selectedResult && selectedResult.through === selectedResult.totalSteps);
  const versionLabel = (id: string) => {
    const v = versions.find((x) => x.id === id);
    return v ? `${v.title} v${v.number}` : 'a deleted version';
  };
  useEffect(() => {
    if (!focus) return;
    setSide(focus.side);
    setFailedCheck(focus.checkId);
    setFixOpen(true);
    requestAnimationFrame(() =>
      fix.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }),
    );
  }, [focus]);
  function openRegression(id: string) {
    setRegressionId(id);
    setReviewed(false);
    setLibraryOpen(true);
    requestAnimationFrame(() => {
      library.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      intentField.current?.focus();
    });
  }
  const minimization = run?.minimization;
  return (
    <>
      <details
        className="studio-fix"
        ref={fix}
        open={fixOpen}
        onToggle={(e) => setFixOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          Fix a failure
          <span className="note"> · shrink it, keep it as a regression, ask for a repair</span>
        </summary>
        <ol className="fix-steps">
          <li data-done={Boolean(minimization) || undefined}>
            <h4>Shrink the failure</h4>
            <p className="note">
              Riff removes steps that don’t matter while the same check keeps failing.
            </p>
            <fieldset disabled={busy} className="rehearsal-grid">
              <legend className="sr-only">Separate explicit actions</legend>
              {run?.comparison && (
                <label>
                  Failure side
                  <select
                    value={side}
                    onChange={(e) => {
                      setSide(e.target.value as typeof side);
                      setFailedCheck('');
                    }}
                  >
                    <option value="primary">This version</option>
                    <option value="compare">Comparison version</option>
                  </select>
                </label>
              )}
              <label>
                Failed check
                <select value={failedCheck} onChange={(e) => setFailedCheck(e.target.value)}>
                  <option value="">
                    {failures.length ? 'Choose a failed check' : 'No failed checks yet'}
                  </option>
                  {failures.map((c) => (
                    <option value={c.id} key={c.id}>
                      {run ? describeCheck(c, run.scenario) : c.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button small primary"
                disabled={!run || !failedCheck || !complete}
                onClick={() =>
                  run &&
                  void operation(
                    (s) => api.rehearsalMinimize(run.id, side, failedCheck, s),
                    (value) => {
                      adoptRun(value, false);
                      setSide('primary');
                      const check = value.result.checks.find(
                        (c) => c.id === value.minimization?.checkId,
                      );
                      if (check && regressionName === 'Regression case')
                        setRegressionName(describeCheck(check, value.scenario).slice(0, 80));
                      setNotice(
                        'Failure shrunk. The smaller scenario is loaded in the player; save it as a regression next.',
                      );
                    },
                  )
                }
              >
                Reduce selected failure
              </button>
            </fieldset>
            {!complete && failures.length === 0 && (
              <p className="note">Run a scenario to the end; failed checks appear here.</p>
            )}
            {minimization && (
              <p className="fix-result">
                Kept {minimization.originalStepCount - minimization.removedSteps} of{' '}
                {minimization.originalStepCount} steps · {minimization.removedSteps} removed ·{' '}
                {minimization.attempts}/24 replays · {minimization.dispatchedSteps}/2400 applied
                steps ·{' '}
                {minimization.budgetStopped ? 'Budget stopped reduction' : 'Reduction finished'}.
                Not guaranteed to be the smallest possible.
              </p>
            )}
          </li>
          <li>
            <h4>Keep it as a regression</h4>
            <p className="note">
              Saved regressions are immutable. Every future edit of this interaction must pass them
              before you can approve it.
            </p>
            <fieldset disabled={busy} className="rehearsal-grid">
              <legend className="sr-only">Save the reduced failure</legend>
              <label>
                Regression name
                <input
                  value={regressionName}
                  maxLength={80}
                  onChange={(e) => setRegressionName(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="button small primary"
                disabled={!minimization || !regressionName.trim()}
                onClick={() =>
                  minimization &&
                  run &&
                  void operation(
                    (s) =>
                      api.rehearsalSaveRegression(regressionName, run.id, minimization.checkId, s),
                    (value) => {
                      commitRegressions((items) => [value, ...items]);
                      openRegression(value.id);
                      setNotice('Regression saved. Describe a repair below when you are ready.');
                    },
                  )
                }
              >
                Save regression
              </button>
            </fieldset>
          </li>
          <li>
            <h4>Ask for a repair</h4>
            <p className="note">
              Describe the fix in “Saved regressions”. Generating a repair is always a separate,
              reviewed action.
            </p>
          </li>
        </ol>
      </details>

      <details
        className="studio-regressions"
        ref={library}
        open={libraryOpen}
        onToggle={(e) => setLibraryOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          Saved regressions
          <span className="badge muted">{regressions.length}</span>
        </summary>
        <fieldset disabled={busy} className="rehearsal-grid">
          <legend className="sr-only">Retained private scenarios and expectations</legend>
          <label>
            Saved regression
            <select
              value={regressionId}
              onChange={(e) => {
                setRegressionId(e.target.value);
                setReviewed(false);
              }}
            >
              <option value="">
                {regressions.length ? 'Choose regression' : 'None saved yet'}
              </option>
              {regressions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button small"
            disabled={!regression}
            onClick={() =>
              regression &&
              void operation(
                (s) => api.rehearsalRerun(regression.id, version.id, s),
                (value) => {
                  setPlaying(false);
                  adoptRun(value, true);
                  setNotice(
                    value.result.status === 'passed'
                      ? `“${regression.name}” passes on v${version.number}.`
                      : `“${regression.name}” still fails on v${version.number}.`,
                  );
                },
              )
            }
          >
            Rerun on selected version
          </button>
          <button
            type="button"
            className="button small danger"
            disabled={!regression}
            onClick={() =>
              regression &&
              void operation(
                (s) => api.rehearsalDeleteRegression(regression.id, s),
                () => {
                  commitRegressions((items) => items.filter((g) => g.id !== regression.id));
                  setRegressionId('');
                  setReviewed(false);
                },
              )
            }
          >
            Delete regression
          </button>
          <button
            type="button"
            className="button small ghost"
            onClick={() => void refreshRegressions()}
          >
            Reload regression library
          </button>
        </fieldset>
        {refreshing && (
          <p role="status" className="note">
            Refreshing regression library…
          </p>
        )}
        {refreshError && (
          <p role="alert" className="answer bad">
            {refreshError}
          </p>
        )}
        {!regressions.length && (
          <p className="note">
            No saved regressions. Shrink a failure above to keep it as a permanent check.
          </p>
        )}
        {regression && (
          <article className="regression-card" aria-label={`Regression ${regression.name}`}>
            <h4>{regression.name}</h4>
            <p>
              <span className="badge bad">{failureText(regression)}</span>{' '}
              {regression.scenario.steps.length} step
              {regression.scenario.steps.length === 1 ? '' : 's'} · from{' '}
              {versionLabel(regression.originVersionId)} · saved {ago(regression.createdAt)}
            </p>
            <p className="note mono">
              Check {regression.checkId} · expected {String(regression.failure.expected)}, observed{' '}
              {String(regression.failure.actual)} · artifact{' '}
              {shortHash(regression.originArtifactId)} · failed evidence{' '}
              {shortHash(regression.failedEvidenceHash)} · {regression.scenario.provenance.kind}
            </p>
            <fieldset disabled={busy} className="repair-form">
              <legend>Ask Codex for a repair</legend>
              <label>
                Repair intent
                <textarea
                  ref={intentField}
                  value={intent}
                  minLength={8}
                  maxLength={1200}
                  placeholder="e.g. Allow four throws per viewer instead of three."
                  onChange={(e) => {
                    setIntent(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
              <label className="chip-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed this regression and repair intent
              </label>
              <p className="note">
                Starts a new candidate from {versionLabel(regression.originVersionId)}. It goes
                through the same tests, rehearsal and approval as any edit, and this regression must
                pass. Nothing goes live on its own.
              </p>
              <button
                type="button"
                className="button primary small"
                disabled={!onRun || !reviewed || intent.trim().length < 8}
                onClick={() =>
                  void operation(
                    (s) => api.rehearsalRepair(regression.id, intent.trim(), s),
                    (value) => {
                      onRun?.(value);
                      setReviewed(false);
                      setNotice(
                        'Repair requested. Follow it in step 2 (Test); approve it only after it passes.',
                      );
                    },
                  )
                }
              >
                Generate repair candidate
              </button>
            </fieldset>
          </article>
        )}
      </details>
    </>
  );
}
