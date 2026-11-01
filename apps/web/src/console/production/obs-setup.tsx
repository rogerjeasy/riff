import { useState } from 'react';
import { Check, Fingerprint } from '../panel-kit.js';
import type { ProductionState } from './contracts.js';

const STAGES = [
  { status: 'review', label: 'Review' },
  { status: 'test', label: 'Test frame' },
  { status: 'live', label: 'Live overlay' },
] as const;

/** Reviewed placement of Riff's own browser source: review → labeled test frame → live. */
export function ObsSetup({
  state,
  busy,
  panic,
  mutate,
}: {
  state: ProductionState;
  busy: boolean;
  panic: boolean;
  mutate: (path: string, body: unknown) => Promise<boolean>;
}) {
  const review = state.obsReview;
  const [sceneName, setScene] = useState(review?.sceneName ?? '');
  const [inputName, setName] = useState(review?.inputName ?? 'Riff audience overlay');
  const [width, setWidth] = useState(review?.width ?? 1920);
  const [height, setHeight] = useState(review?.height ?? 1080);
  const [visibleFor, setVisibleFor] = useState<string | null>(null);
  const connected = state.connections.obs.status === 'connected';
  // Confirmation is bound to the exact review and stage, never reset by a later effect.
  const visibleKey = review ? `${review.digest}:${review.status}` : null;
  const visible = visibleFor !== null && visibleFor === visibleKey;
  const same =
    !!review &&
    review.sceneName === sceneName &&
    review.inputName === inputName &&
    review.width === width &&
    review.height === height;
  // A live overlay has completed every step.
  const stage = !review
    ? -1
    : review.status === 'live'
      ? STAGES.length
      : STAGES.findIndex((s) => s.status === review.status);
  const blocked = busy || panic || !connected;
  const reason = panic
    ? 'Resume from the emergency stop first.'
    : !connected
      ? 'Connect OBS above to choose a scene.'
      : null;

  return (
    <section className="production-section" aria-labelledby="production-obs-heading">
      <div className="production-section-head">
        <div>
          <h3 id="production-obs-heading">Place Riff in OBS</h3>
          <p className="panel-hint">
            Riff only creates or updates its own browser source in the scene you choose. Every other
            source stays untouched.
          </p>
        </div>
        {review && review.status !== 'rolled-back' && (
          <ol className="production-stepper" aria-label="OBS setup progress">
            {STAGES.map((s, i) => (
              <li
                key={s.status}
                data-state={i < stage ? 'done' : i === stage ? 'current' : 'todo'}
                aria-current={i === stage ? 'step' : undefined}
              >
                {s.label}
              </li>
            ))}
          </ol>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void mutate('obs/review', { sceneName, inputName, width, height });
        }}
      >
        <fieldset disabled={blocked}>
          <legend className="sr-only">Selected target</legend>
          <div className="panel-grid">
            <label>
              OBS scene
              <select required value={sceneName} onChange={(e) => setScene(e.target.value)}>
                <option value="">Choose discovered scene</option>
                {state.connections.obs.scenes.map((scene) => (
                  <option key={scene}>{scene}</option>
                ))}
              </select>
            </label>
            <label>
              Riff source name
              <input
                required
                maxLength={120}
                value={inputName}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Width (px)
              <input
                type="number"
                inputMode="numeric"
                min={320}
                max={3840}
                value={Number.isNaN(width) ? '' : width}
                onChange={(e) => setWidth(e.target.valueAsNumber)}
              />
            </label>
            <label>
              Height (px)
              <input
                type="number"
                inputMode="numeric"
                min={240}
                max={2160}
                value={Number.isNaN(height) ? '' : height}
                onChange={(e) => setHeight(e.target.valueAsNumber)}
              />
            </label>
          </div>
          <div className="panel-actions">
            <button
              className="button"
              disabled={!sceneName || (same && review?.status !== 'rolled-back')}
            >
              Review overlay setup
            </button>
            <span className="panel-hint">
              {reason ??
                (same
                  ? 'This target is already reviewed below.'
                  : 'Reviewing changes nothing in OBS.')}
            </span>
          </div>
        </fieldset>
      </form>

      {review && (
        <section className="panel-surface production-review" aria-label="Reviewed source change">
          <div className="production-section-head">
            <h4>
              {review.operation === 'create' ? 'Create' : 'Update'} “{review.inputName}” in “
              {review.sceneName}”
            </h4>
            <span className="panel-hint">
              Review <Fingerprint value={review.digest} label="Setup review" />
            </span>
          </div>
          <ul className="panel-checks">
            <Check ok>
              Browser source · {review.width} × {review.height}
              {review.before &&
                ` (was ${review.before.width ?? '?'} × ${review.before.height ?? '?'}; original kept privately for rollback)`}
            </Check>
            <Check ok>Shows a labeled test frame first — never live gameplay as a test</Check>
            <Check ok>Rollback restores only this change, after checking OBS still matches</Check>
          </ul>
          {!same && review.status !== 'rolled-back' && (
            <p className="panel-callout" data-tone="warn">
              The form above no longer matches this review. Review it again before continuing.
            </p>
          )}
          {review.status === 'review' && (
            <div className="panel-actions">
              <button
                type="button"
                className="button primary"
                disabled={blocked || !same}
                onClick={() => void mutate('obs/apply', { digest: review.digest })}
              >
                Apply reviewed test frame
              </button>
              <span className="panel-hint">
                OBS will show “OBS SETUP TEST · NOT LIVE GAMEPLAY”.
              </span>
            </div>
          )}
          {review.status === 'test' && (
            <>
              <label className="panel-checkbox">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => setVisibleFor(e.target.checked ? visibleKey : null)}
                />
                <span>I can see the Riff test frame in the selected OBS scene.</span>
              </label>
              <div className="panel-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={blocked || !same || !visible}
                  onClick={() => void mutate('obs/confirm', { digest: review.digest })}
                >
                  Enable reviewed live overlay
                </button>
                <a
                  className="button ghost"
                  href="/production-test"
                  target="_blank"
                  rel="noreferrer"
                >
                  Preview test frame ↗
                </a>
              </div>
            </>
          )}
          {review.status === 'live' && (
            <p className="panel-callout" data-tone="good">
              The live Riff overlay is in “{review.sceneName}”. Effects reach it only from approved
              interactions.
            </p>
          )}
          {review.status === 'rolled-back' && (
            <p className="panel-callout">
              This setup was rolled back. Review a new target to start again.
            </p>
          )}
          {(review.status === 'test' || review.status === 'live') && (
            <div className="panel-actions">
              <button
                type="button"
                className="button small ghost"
                disabled={blocked}
                onClick={() => void mutate('obs/rollback', { digest: review.digest })}
              >
                Roll back this source setup
              </button>
              <span className="panel-hint">
                Changes made directly in OBS since then need a new review instead.
              </span>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
