import './event-triggers.css';
import { useEffect, useId, useState } from 'react';
import {
  EVENT_COPY,
  syntheticEvent,
  type TwitchEventDetail,
  type TwitchEventKind,
} from './contracts.js';

/**
 * Private rehearsal controls for an F19 event trigger. Every input it produces is a
 * labeled synthetic event for the preview engine; nothing is sent to Twitch.
 */
export function TwitchEventSimulator({
  kind,
  minimum,
  viewerName,
  disabled,
  onSend,
}: {
  kind: TwitchEventKind;
  minimum: number;
  viewerName: string;
  disabled: boolean;
  onSend: (detail: TwitchEventDetail) => void;
}) {
  const copy = EVENT_COPY[kind];
  const start = Math.max(minimum, copy.sample);
  const [amount, setAmount] = useState(String(start));
  const [anonymous, setAnonymous] = useState(false);
  useEffect(() => setAmount(String(Math.max(minimum, EVENT_COPY[kind].sample))), [kind, minimum]);
  const amountId = useId();
  const hintId = useId();
  const value = Number(amount);
  const valid = kind === 'subscribe' || (Number.isInteger(value) && value >= 1);
  const canHide = kind === 'cheer' || kind === 'gift';
  const send = (n: number) => onSend(syntheticEvent(kind, n, canHide && anonymous));

  return (
    <fieldset className="twitch-sim" disabled={disabled} aria-describedby={hintId}>
      <legend>
        Simulate a {copy.noun}
        <span className="pill private">Synthetic</span>
      </legend>
      <p id={hintId} className="note">
        A made-up {copy.noun} for this private rehearsal, sent as{' '}
        {canHide && anonymous ? 'an anonymous viewer' : viewerName}. Nothing reaches Twitch or your
        stream.
      </p>
      <div className="twitch-sim-row">
        {kind !== 'subscribe' && (
          <label htmlFor={amountId}>
            <span>{copy.unit[0]?.toUpperCase() + copy.unit.slice(1)}</span>
            <input
              id={amountId}
              type="number"
              inputMode="numeric"
              min={1}
              max={10_000_000}
              step={1}
              value={amount}
              aria-invalid={!valid}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        )}
        {canHide && (
          <label className="twitch-sim-check">
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            <span>Anonymous</span>
          </label>
        )}
        <button
          type="button"
          className="button primary small"
          disabled={!valid}
          onClick={() => send(value)}
        >
          Send synthetic {copy.noun}
        </button>
      </div>
      {kind !== 'subscribe' && minimum > 1 && (
        <div className="twitch-sim-row" role="group" aria-label="Threshold checks">
          <button type="button" className="button small ghost" onClick={() => send(minimum)}>
            At minimum ({minimum} {copy.unit})
          </button>
          <button type="button" className="button small ghost" onClick={() => send(minimum - 1)}>
            Just below ({minimum - 1})
          </button>
        </div>
      )}
      {!valid && (
        <p className="panel-problem" role="alert">
          Enter a whole number of {copy.unit}, 1 or more.
        </p>
      )}
    </fieldset>
  );
}
