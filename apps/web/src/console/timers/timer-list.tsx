import './timers.css';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type { TimerView } from '../../lib/types.js';
import { formatDuration } from '../format.js';

/** "4:05" style countdown; hours are spelled out so long reminders stay readable. */
export function formatCountdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * Pending host-owned timers for one live interaction. The countdown is derived locally
 * from the persisted due time; the host decides when a timer actually fires.
 */
export function TimerList(props: {
  automationId: string;
  title: string;
  timers: TimerView[];
  command: string;
  live: boolean;
  stopped: boolean;
  notify: (message: string, kind?: 'good' | 'bad') => void;
  now?: () => number;
}) {
  const clock = props.now ?? Date.now;
  const [now, setNow] = useState(clock);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!props.timers.length) return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(timer);
  }, [props.timers.length, clock]);
  const cancel = async (name: string) => {
    setBusy(name);
    try {
      await api.cancelTimer(props.automationId, name);
      props.notify(`Cancelled timer “${name}”. It will not fire.`);
    } catch (error) {
      props.notify(
        error instanceof ApiError ? error.message : 'Could not cancel the timer. Try again.',
        'bad',
      );
    } finally {
      setBusy(null);
    }
  };
  const headingId = `timers-${props.automationId}`;
  return (
    <section className="timer-list" aria-labelledby={headingId}>
      <h4 id={headingId}>
        Timers <span className="timer-count">{props.timers.length || 'none'} pending</span>
      </h4>
      {props.timers.length === 0 ? (
        <p className="timer-empty">
          {props.stopped
            ? 'Stopped. Pending timers were cancelled and will not come back on resume.'
            : props.live
              ? `No timer is pending. Typing ${props.command} in chat starts one.`
              : 'Paused. Timers were cancelled; they start again only from chat once live.'}
        </p>
      ) : (
        <ul>
          {props.timers.map((timer) => {
            const remaining = timer.scheduledAt - now;
            const due = remaining <= 0;
            return (
              <li key={timer.id} className="timer-row" data-due={due || undefined}>
                <span className="timer-name mono">{timer.name}</span>
                <span className="timer-when">
                  {due ? (
                    <span>Due now</span>
                  ) : (
                    <>
                      <span className="sr-only">Fires in </span>
                      <time
                        className="timer-clock mono"
                        dateTime={new Date(timer.scheduledAt).toISOString()}
                      >
                        {formatCountdown(remaining)}
                      </time>
                    </>
                  )}
                </span>
                <span className={`pill ${timer.repeat ? 'live' : 'muted'}`}>
                  {timer.repeat
                    ? `Repeats every ${formatDuration(timer.intervalMs)}`
                    : `Once · ${formatDuration(timer.intervalMs)}`}
                </span>
                {timer.repeat && timer.fires > 0 && (
                  <span className="timer-fires">
                    fired {timer.fires} time{timer.fires === 1 ? '' : 's'}
                  </span>
                )}
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy !== null}
                  aria-label={`Cancel timer ${timer.name} of ${props.title}`}
                  onClick={() => void cancel(timer.name)}
                >
                  {busy === timer.name ? 'Cancelling…' : 'Cancel'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
