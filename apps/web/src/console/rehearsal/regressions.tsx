import { useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../lib/api.js';
import type { Run, Version } from '../../lib/types.js';
import { shortHash } from '../format.js';
import type { RehearsalRun, Regression } from './contracts.js';
export type Operation = <T>(
  work: (signal: AbortSignal) => Promise<T>,
  apply: (value: T) => void,
) => Promise<void>;
interface Props {
  version: Version;
  versions: Version[];
  run: RehearsalRun | null;
  regressions: Regression[];
  busy: boolean;
  operation: Operation;
  adoptRun: (value: RehearsalRun, canPreview: boolean) => void;
  setRegressions: Dispatch<SetStateAction<Regression[]>>;
  setNotice: (text: string) => void;
  setPlaying: (value: boolean) => void;
  onRun?: ((run: Run) => void) | undefined;
}
export function RegressionPanel({
  version,
  versions,
  run,
  regressions,
  busy,
  operation,
  adoptRun,
  setRegressions,
  setNotice,
  setPlaying,
  onRun,
}: Props) {
  const [failedCheck, setFailedCheck] = useState('');
  const [side, setSide] = useState<'primary' | 'compare'>('primary');
  const [regressionName, setRegressionName] = useState('Regression case');
  const [regressionId, setRegressionId] = useState('');
  const [intent, setIntent] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const selectedResult = side === 'primary' ? run?.result : run?.comparison;
  const failures = selectedResult?.checks.filter((c) => c.status === 'failed') ?? [];
  const regression = regressions.find((g) => g.id === regressionId);
  const versionLabel = (id: string) => {
    const v = versions.find((x) => x.id === id);
    return v ? `${v.title} v${v.number}` : id;
  };
  return (
    <>
      <details>
        <summary>Reduce a failed check and save regression</summary>
        <fieldset disabled={busy} className="rehearsal-grid">
          <legend>Separate explicit actions</legend>
          <label>
            Failure side
            <select
              value={side}
              onChange={(e) => {
                setSide(e.target.value as typeof side);
                setFailedCheck('');
              }}
            >
              <option value="primary">Primary</option>
              <option value="compare" disabled={!run?.comparison}>
                Comparison
              </option>
            </select>
          </label>
          <label>
            Failed check
            <select value={failedCheck} onChange={(e) => setFailedCheck(e.target.value)}>
              <option value="">Choose an exact failure</option>
              {failures.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.id} · expected {String(c.expected)}, actual {String(c.actual)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button small"
            disabled={
              !run ||
              !failedCheck ||
              !selectedResult ||
              selectedResult.through !== selectedResult.totalSteps
            }
            onClick={() =>
              run &&
              void operation(
                (s) => api.rehearsalMinimize(run.id, side, failedCheck, s),
                (value) => {
                  adoptRun(value, false);
                  setSide('primary');
                  setNotice('Selected failure retained in a separate immutable reduced run.');
                },
              )
            }
          >
            Reduce selected failure
          </button>
          <label>
            Regression name
            <input
              value={regressionName}
              maxLength={80}
              onChange={(e) => setRegressionName(e.target.value)}
            />
          </label>
          <button
            className="button small"
            disabled={!run?.minimization || !regressionName.trim()}
            onClick={() =>
              run?.minimization &&
              void operation(
                (s) =>
                  api.rehearsalSaveRegression(
                    regressionName,
                    run.id,
                    run.minimization?.checkId ?? '',
                    s,
                  ),
                (value) => {
                  setRegressions((items) => [value, ...items]);
                  setRegressionId(value.id);
                  setReviewed(false);
                  setNotice('Regression saved. Generation remains a separate action.');
                },
              )
            }
          >
            Save regression
          </button>
        </fieldset>
        {run?.minimization && (
          <p>
            {run.minimization.removedSteps} steps removed · {run.minimization.attempts}/24 replays ·{' '}
            {run.minimization.dispatchedSteps}/2400 applied steps ·{' '}
            {run.minimization.budgetStopped ? 'Budget stopped reduction' : 'Reduction finished'} ·
            no global minimality guarantee.
          </p>
        )}
      </details>
      <details>
        <summary>Immutable regression library and repair</summary>
        <fieldset disabled={busy} className="rehearsal-grid">
          <legend>Retained private scenarios and expectations</legend>
          <label>
            Saved regression
            <select
              value={regressionId}
              onChange={(e) => {
                setRegressionId(e.target.value);
                setReviewed(false);
              }}
            >
              <option value="">Choose regression</option>
              {regressions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button small"
            disabled={!regression}
            onClick={() =>
              regression &&
              void operation(
                (s) => api.rehearsalRerun(regression.id, version.id, s),
                (value) => {
                  setPlaying(false);
                  adoptRun(value, true);
                },
              )
            }
          >
            Rerun on selected version
          </button>
          <button
            className="button small danger"
            disabled={!regression}
            onClick={() =>
              regression &&
              void operation(
                (s) => api.rehearsalDeleteRegression(regression.id, s),
                () => {
                  setRegressions((items) => items.filter((g) => g.id !== regression.id));
                  setRegressionId('');
                  setReviewed(false);
                },
              )
            }
          >
            Delete regression
          </button>
        </fieldset>
        {!regressions.length && <p>No saved regressions.</p>}
        {regression && (
          <>
            <p>
              {regression.name} · immutable origin {versionLabel(regression.originVersionId)} ·
              artifact {shortHash(regression.originArtifactId)} · {regression.scenario.steps.length}{' '}
              steps · {regression.scenario.provenance.kind}
            </p>
            <p>
              Check {regression.checkId}: expected {String(regression.failure.expected)}, observed{' '}
              {String(regression.failure.actual)}. Failed evidence{' '}
              {shortHash(regression.failedEvidenceHash)}.
            </p>
            <fieldset disabled={busy}>
              <legend>Reviewed repair request</legend>
              <label>
                Repair intent
                <textarea
                  value={intent}
                  minLength={8}
                  maxLength={1200}
                  onChange={(e) => {
                    setIntent(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed this regression and repair intent
              </label>
              <p className="note">
                Creates a candidate based on the regression origin. Independent verification,
                rehearsal and existing approval remain required.
              </p>
              <button
                className="button primary small"
                disabled={!onRun || !reviewed || intent.trim().length < 8}
                onClick={() =>
                  void operation(
                    (s) => api.rehearsalRepair(regression.id, intent.trim(), s),
                    (value) => {
                      onRun?.(value);
                      setReviewed(false);
                      setNotice(
                        'Repair candidate requested. Follow its progress in the existing authoring and evidence panel.',
                      );
                    },
                  )
                }
              >
                Generate repair candidate
              </button>
            </fieldset>
          </>
        )}
      </details>
    </>
  );
}
