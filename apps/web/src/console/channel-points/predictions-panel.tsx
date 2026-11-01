import './channel-points.css';
import { useEffect, useId, useRef, useState } from 'react';
import { PanelCard, type Tone } from '../panel-kit.js';
import {
  accessProblem,
  predictionsSchema,
  type Prediction,
  type PredictionRequest,
  type PredictionsState,
} from './contracts.js';
import { useFeature } from './use-feature.js';

type Mutate = (key: string, url: string, body?: unknown) => Promise<boolean>;
const STATUS: Record<Prediction['status'], [string, Tone]> = {
  ACTIVE: ['Open for predictions', 'live'],
  LOCKED: ['Locked — choose the outcome', 'warn'],
  RESOLVED: ['Resolved', 'good'],
  CANCELED: ['Canceled · refunded', 'muted'],
};

/** Seconds left in the voting window, ticking once a second while open. */
function useRemaining(prediction: Prediction | null) {
  const [now, setNow] = useState(() => Date.now());
  const open = prediction?.status === 'ACTIVE';
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  if (!prediction || !open) return null;
  const end = Date.parse(prediction.createdAt) + prediction.windowSeconds * 1000;
  return Number.isFinite(end) ? Math.max(0, Math.round((end - now) / 1000)) : null;
}

/**
 * F22 Predictions. Automations can only propose; you open, lock, resolve or cancel here,
 * and every settlement asks for explicit confirmation.
 */
export function PredictionsPanel() {
  const { state, loadError, error, busy, mutate } = useFeature(
    '/api/predictions',
    predictionsSchema,
  );
  const problem = state ? accessProblem(state, 'Predictions') : null;
  const proposals = state?.requests.filter((r) => r.status === 'proposed') ?? [];
  const current = state?.current ?? null;
  const running = current?.status === 'ACTIVE' || current?.status === 'LOCKED';
  const status: { text: string; tone: Tone } = !state
    ? { text: loadError ? 'Unavailable' : 'Loading…', tone: loadError ? 'bad' : 'muted' }
    : problem
      ? { text: state.connected ? 'Needs setup' : 'Not connected', tone: 'muted' }
      : running && current
        ? { text: STATUS[current.status][0].split(' —')[0] ?? '', tone: STATUS[current.status][1] }
        : proposals.length
          ? { text: `${proposals.length} proposed`, tone: 'warn' }
          : { text: 'None running', tone: 'muted' };
  return (
    <PanelCard
      title="Predictions"
      subtitle="Interactions may propose a prediction. Only you open it, and only you choose the outcome."
      status={status}
      className="predict-panel"
    >
      {!state ? (
        <p className="panel-hint" role={loadError ? 'alert' : 'status'}>
          {loadError || 'Loading Predictions…'}
        </p>
      ) : (
        <div className="points-layout">
          {problem ? (
            <div className="panel-callout" data-tone="warn">
              <p>{problem.text}</p>
              {problem.action && (
                <p>
                  <a
                    className="button small"
                    href={problem.action === 'connect' ? '/auth/twitch' : state.consent.url}
                  >
                    {problem.action === 'connect' ? 'Connect Twitch' : 'Allow Predictions access'}
                  </a>{' '}
                  <span className="panel-hint">
                    Twitch asks you to approve <code>channel:manage:predictions</code>.
                  </span>
                </p>
              )}
            </div>
          ) : (
            <p className="panel-lead">
              Generated code can suggest a question and outcomes; it can never open, lock, resolve
              or cancel. Stopping Riff locks an open prediction so no more points are wagered — you
              still decide how it ends.
            </p>
          )}
          {state.lastError && <p className="panel-problem">{state.lastError}</p>}
          {!problem && (
            <>
              <div className="points-meta">
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy !== null}
                  onClick={() => void mutate('refresh', '/api/predictions/refresh')}
                >
                  {busy === 'refresh' ? 'Checking…' : 'Check with Twitch'}
                </button>
              </div>
              {current && <Current prediction={current} mutate={mutate} busy={busy} />}
              <Proposals
                proposals={proposals}
                blocked={running || state.panicked}
                mutate={mutate}
                busy={busy}
              />
              {!running && <NewPrediction state={state} mutate={mutate} busy={busy} />}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
    </PanelCard>
  );
}

function Current({
  prediction,
  mutate,
  busy,
}: {
  prediction: Prediction;
  mutate: Mutate;
  busy: string | null;
}) {
  const name = useId();
  const remaining = useRemaining(prediction);
  const [winner, setWinner] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'lock' | 'resolve' | 'cancel' | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);
  useEffect(() => {
    setConfirm(null);
    setWinner(null);
  }, [prediction.id, prediction.status]);
  const running = prediction.status === 'ACTIVE' || prediction.status === 'LOCKED';
  const total = prediction.outcomes.reduce((sum, o) => sum + o.channelPoints, 0);
  const chosen = prediction.outcomes.find((o) => o.id === winner);
  const [label, tone] = STATUS[prediction.status];
  const end = (action: 'lock' | 'resolve' | 'cancel') =>
    void mutate(`end-${action}`, '/api/predictions/end', {
      action,
      predictionId: prediction.id,
      confirm: true,
      ...(action === 'resolve' && winner ? { winningOutcomeId: winner } : {}),
    });
  return (
    <section className="predict-card" aria-labelledby={`${name}-title`}>
      <div className="predict-card-head">
        <div>
          <b id={`${name}-title`}>{prediction.title}</b>
          <span className="panel-hint">
            {remaining !== null
              ? remaining > 0
                ? ` ${remaining}s left to predict`
                : ' Window closed — lock or resolve'
              : ` ${prediction.windowSeconds}s window`}
            {total > 0 ? ` · ${total.toLocaleString()} points wagered` : ''}
          </span>
        </div>
        <span className={`pill ${tone}`}>{label}</span>
      </div>
      <fieldset disabled={!running || busy !== null}>
        <legend className="points-label">
          {running ? 'Winning outcome (only you decide)' : 'Outcomes'}
        </legend>
        <ul className="predict-outcomes">
          {prediction.outcomes.map((outcome) => {
            const share = total ? Math.round((outcome.channelPoints / total) * 100) : 0;
            return (
              <li key={outcome.id}>
                <label
                  className="predict-outcome"
                  data-selected={winner === outcome.id}
                  data-winner={prediction.winningOutcomeId === outcome.id}
                >
                  {running ? (
                    <input
                      type="radio"
                      name={name}
                      value={outcome.id}
                      checked={winner === outcome.id}
                      onChange={() => setWinner(outcome.id)}
                    />
                  ) : (
                    <span aria-hidden="true">
                      {prediction.winningOutcomeId === outcome.id ? '✓' : '·'}
                    </span>
                  )}
                  <span>
                    {outcome.title}
                    {prediction.winningOutcomeId === outcome.id && (
                      <span className="sr-only"> (winner)</span>
                    )}
                  </span>
                  <span className="panel-hint">
                    {outcome.users} {outcome.users === 1 ? 'viewer' : 'viewers'} · {share}%
                  </span>
                  <span className="predict-bar" aria-hidden="true">
                    <span style={{ width: `${share}%` }} />
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {running && (
        <div className="panel-actions">
          {!confirm ? (
            <>
              <button
                type="button"
                className="button small go"
                disabled={!winner || busy !== null}
                title={winner ? undefined : 'Choose the winning outcome first'}
                onClick={() => setConfirm('resolve')}
              >
                Resolve…
              </button>
              {prediction.status === 'ACTIVE' && (
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy !== null}
                  onClick={() => setConfirm('lock')}
                >
                  Lock…
                </button>
              )}
              <button
                type="button"
                className="button small ghost"
                disabled={busy !== null}
                onClick={() => setConfirm('cancel')}
              >
                Cancel and refund…
              </button>
            </>
          ) : (
            <span className="predict-confirm" role="group" aria-label="Confirm prediction action">
              <span>
                {confirm === 'resolve'
                  ? `Pay out to “${chosen?.title ?? ''}”? Twitch distributes the points; this cannot be undone.`
                  : confirm === 'lock'
                    ? 'Lock now? Viewers can no longer predict; you still choose the outcome.'
                    : 'Cancel and refund every viewer’s points? This cannot be undone.'}
              </span>
              <button
                ref={confirmRef}
                type="button"
                className={`button small ${confirm === 'resolve' ? 'go' : confirm === 'cancel' ? 'stop' : ''}`}
                disabled={busy !== null}
                onClick={() => end(confirm)}
              >
                {busy === `end-${confirm}`
                  ? 'Sending…'
                  : confirm === 'resolve'
                    ? 'Confirm winner'
                    : confirm === 'lock'
                      ? 'Confirm lock'
                      : 'Confirm refund'}
              </button>
              <button type="button" className="button small ghost" onClick={() => setConfirm(null)}>
                Go back
              </button>
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Proposals({
  proposals,
  blocked,
  mutate,
  busy,
}: {
  proposals: PredictionRequest[];
  blocked: boolean;
  mutate: Mutate;
  busy: string | null;
}) {
  return (
    <section className="points-section" aria-labelledby="predict-proposals-heading">
      <h3 id="predict-proposals-heading">Proposed by interactions</h3>
      {!proposals.length ? (
        <p className="panel-hint">
          Nothing proposed. An approved interaction with prediction permission can suggest one;
          suggestions expire after 10 minutes.
        </p>
      ) : (
        <ul className="predict-requests" aria-live="polite">
          {proposals.map((p) => (
            <li key={p.id} className="predict-card">
              <div className="predict-card-head">
                <div>
                  <b>{p.title}</b>
                  <span className="panel-hint">
                    {p.outcomes.join(' · ')} · {p.windowSeconds}s · from{' '}
                    {p.automationTitle ?? 'an interaction'}
                  </span>
                </div>
                <span className="pill warn">Waiting for you</span>
              </div>
              <div className="panel-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={blocked || busy !== null}
                  onClick={() =>
                    void mutate(`open-${p.id}`, `/api/predictions/proposals/${p.id}/open`)
                  }
                >
                  {busy === `open-${p.id}` ? 'Opening on Twitch…' : 'Open this prediction'}
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void mutate(`dismiss-${p.id}`, `/api/predictions/proposals/${p.id}/dismiss`)
                  }
                >
                  Dismiss
                </button>
                {blocked && (
                  <span className="panel-hint">
                    End the current prediction (or resume Riff) to open another.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewPrediction({
  state,
  mutate,
  busy,
}: {
  state: PredictionsState;
  mutate: Mutate;
  busy: string | null;
}) {
  const id = useId();
  const { limits } = state;
  const [title, setTitle] = useState('');
  const [outcomes, setOutcomes] = useState(['Yes', 'No']);
  const [windowSeconds, setWindowSeconds] = useState('120');
  const trimmed = outcomes.map((o) => o.trim());
  const valid =
    title.trim().length > 0 &&
    Array.from(title.trim()).length <= limits.titleLength &&
    trimmed.every((o) => o.length > 0 && Array.from(o).length <= limits.outcomeLength) &&
    new Set(trimmed.map((o) => o.toLowerCase())).size === trimmed.length &&
    Number(windowSeconds) >= limits.windowSeconds.min &&
    Number(windowSeconds) <= limits.windowSeconds.max;
  return (
    <section className="points-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Open a prediction yourself</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void mutate('create', '/api/predictions', {
            title: title.trim(),
            outcomes: trimmed,
            windowSeconds: Number(windowSeconds),
          }).then((ok) => ok && setTitle(''));
        }}
      >
        <fieldset disabled={busy !== null || state.panicked} className="points-form">
          <legend className="sr-only">New prediction</legend>
          <div className="predict-grid">
            <label htmlFor={`${id}-title`}>
              Question{' '}
              <span className="panel-hint">
                ({Array.from(title).length}/{limits.titleLength})
              </span>
            </label>
            <input
              id={`${id}-title`}
              required
              maxLength={limits.titleLength}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Will we beat the boss?"
            />
            <span className="points-label" id={`${id}-outcomes`}>
              Outcomes
            </span>
            <div className="predict-outcome-fields" role="group" aria-labelledby={`${id}-outcomes`}>
              {outcomes.map((outcome, index) => (
                <div key={index}>
                  <input
                    aria-label={`Outcome ${index + 1}`}
                    required
                    maxLength={limits.outcomeLength}
                    value={outcome}
                    onChange={(e) =>
                      setOutcomes(outcomes.map((o, i) => (i === index ? e.target.value : o)))
                    }
                  />
                  {outcomes.length > limits.outcomes.min && (
                    <button
                      type="button"
                      className="button small ghost"
                      aria-label={`Remove outcome ${index + 1}`}
                      onClick={() => setOutcomes(outcomes.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {outcomes.length < limits.outcomes.max && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => setOutcomes([...outcomes, ''])}
                >
                  + Add outcome
                </button>
              )}
            </div>
            <label htmlFor={`${id}-window`}>
              Voting window <span className="panel-hint">(seconds)</span>
            </label>
            <input
              id={`${id}-window`}
              type="number"
              inputMode="numeric"
              min={limits.windowSeconds.min}
              max={limits.windowSeconds.max}
              required
              value={windowSeconds}
              onChange={(e) => setWindowSeconds(e.target.value)}
            />
          </div>
          <div className="panel-actions">
            <button className="button" disabled={!valid}>
              {busy === 'create' ? 'Opening on Twitch…' : 'Open prediction'}
            </button>
            <span className="panel-hint">
              {state.panicked
                ? 'Resume Riff to open predictions.'
                : `Questions up to ${limits.titleLength} characters, ${limits.outcomes.min}–${limits.outcomes.max} distinct outcomes, ${limits.windowSeconds.min}–${limits.windowSeconds.max} s. One prediction runs at a time.`}
            </span>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
