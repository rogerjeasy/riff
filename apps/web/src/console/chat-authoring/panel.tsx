import './panel.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { PanelCard, type Tone } from '../panel-kit.js';
import {
  CODE_STATUS_LABEL,
  chatAuthoringSchema,
  formatRemaining,
  type ChatAuthoring,
} from './contracts.js';

export interface ChatAuthoringState {
  data: ChatAuthoring | null;
  error: string;
  /** Server clock minus browser clock, so countdowns follow the host's expiry. */
  offset: number;
  apply: (raw: unknown) => void;
  reload: () => Promise<void>;
}

/** Loads chat authoring state and refreshes it whenever the studio snapshot changes. */
export function useChatAuthoring(trigger: unknown): ChatAuthoringState {
  const [data, setData] = useState<ChatAuthoring | null>(null);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const epoch = useRef(0);
  const apply = useCallback((raw: unknown) => {
    const parsed = chatAuthoringSchema.safeParse(raw);
    if (!parsed.success) {
      setError('Chat authoring status is unavailable.');
      return;
    }
    setError('');
    setOffset(parsed.data.now - Date.now());
    setData(parsed.data);
  }, []);
  const reload = useCallback(async () => {
    const mine = ++epoch.current;
    try {
      const raw = await request('GET', '/api/chat-authoring');
      if (mine === epoch.current) apply(raw);
    } catch {
      if (mine === epoch.current) setError('Chat authoring status is unavailable.');
    }
  }, [apply]);
  useEffect(() => {
    void reload();
  }, [trigger, reload]);
  return { data, error, offset, apply, reload };
}

function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const COMMANDS = [
  ['!riff create <idea>', 'Build a new interaction (8–500 characters).'],
  ['!riff edit <change>', 'Change the one interaction that is live.'],
  ['!riff approve <code>', 'Activate exactly the candidate the code names.'],
  ['!approve', 'Shortcut while exactly one code is waiting.'],
  ['!riff reject <code>', 'Discard that candidate.'],
  ['!riff status · !riff cancel', 'Check or stop the pending build.'],
] as const;

/** Opt-in, owner-only authoring from Twitch chat with short-lived approval codes. */
export function ChatAuthoringPanel({
  state,
  panic,
  onReview,
  notify,
}: {
  state: ChatAuthoringState;
  panic: boolean;
  onReview: (versionId: string) => void;
  notify: (message: string, kind?: 'good' | 'bad') => void;
}) {
  const { data, offset } = state;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'toggle' | 'revoke' | null>(null);
  const [error, setError] = useState('');
  const code = data?.activeCode ?? null;
  const now = useClock(Boolean(code)) + offset;
  const remaining = code ? code.expiresAt - now : 0;
  const expired = Boolean(code) && remaining <= 0;

  // Live notifications for chat-originated work, without repeating on every refresh.
  const seen = useRef<{ code: string | null; run: string | null } | null>(null);
  useEffect(() => {
    if (!data) return;
    const current = { code: data.activeCode?.id ?? null, run: data.pending?.runId ?? null };
    const previous = seen.current;
    seen.current = current;
    if (!previous) return;
    if (current.code && current.code !== previous.code)
      notify(`Chat candidate ready for review · code ${data.activeCode?.code ?? ''}`);
    else if (current.run && current.run !== previous.run && data.pending?.status === 'compiling')
      notify('You asked Riff to build from chat. Compiling…');
  }, [data, notify]);

  async function setEnabled(enabled: boolean) {
    if (!data || busy) return;
    setBusy('toggle');
    setError('');
    try {
      state.apply(
        await request('POST', '/api/chat-authoring/settings', {
          enabled,
          expectedRevision: data.revision,
        }),
      );
      setConfirming(false);
      notify(enabled ? 'In-chat authoring is on.' : 'In-chat authoring is off.');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the setting.');
      await state.reload();
    } finally {
      setBusy(null);
    }
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy('revoke');
    setError('');
    try {
      state.apply(await request('POST', `/api/chat-authoring/codes/${id}/revoke`, {}));
      notify('Approval code withdrawn. The candidate stays here for review.');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not withdraw the code.');
      await state.reload();
    } finally {
      setBusy(null);
    }
  }

  const status: { text: string; tone: Tone } = !data
    ? { text: state.error ? 'Unavailable' : 'Loading…', tone: 'muted' }
    : !data.enabled
      ? { text: 'Off', tone: 'muted' }
      : code && !expired
        ? { text: `Code ${code.code} · ${formatRemaining(remaining)}`, tone: 'live' }
        : data.pending?.status === 'compiling'
          ? { text: 'Compiling from chat', tone: 'warn' }
          : { text: 'On · owner only', tone: 'good' };
  const candidates = data ? [...data.candidates].reverse().slice(0, 5) : [];
  const used = data ? Math.min(data.limits.compilesUsed, data.limits.compilesPerWindow) : 0;

  return (
    <PanelCard
      title="Chat authoring"
      subtitle="Build and approve from your own Twitch chat with !riff create."
      status={status}
      className="chat-authoring"
    >
      {!data ? (
        <p role={state.error ? 'alert' : 'status'} className="panel-hint">
          {state.error || 'Loading chat authoring…'}
        </p>
      ) : (
        <>
          <p className="panel-lead">
            Type <code>!riff create a tomato toss with !tomato</code> in your chat. Riff compiles it
            with the same compiler, sandbox and checks as this console, puts the candidate here for
            review and posts a short approval code. Only your own broadcaster account can author or
            approve — Riff checks Twitch’s badges and account id, never display names or what a
            message claims.
          </p>

          <section className="chat-optin" aria-labelledby="chat-optin-heading">
            <div className="chat-optin-text">
              <h3 id="chat-optin-heading">Allow in-chat authoring</h3>
              <p className="panel-hint">
                {data.enabled
                  ? 'On. Turning it off withdraws any waiting code and cancels a pending chat build.'
                  : 'Off by default. Viewers and moderators can never spend generation budget.'}
              </p>
            </div>
            {data.enabled ? (
              <button
                type="button"
                className="button small ghost"
                disabled={busy !== null}
                onClick={() => void setEnabled(false)}
              >
                {busy === 'toggle' ? 'Turning off…' : 'Turn off'}
              </button>
            ) : !confirming ? (
              <button
                type="button"
                className="button small"
                disabled={busy !== null}
                onClick={() => setConfirming(true)}
              >
                Turn on…
              </button>
            ) : null}
          </section>

          {!data.enabled && confirming && (
            <div
              className="panel-callout chat-risk"
              data-tone="warn"
              role="group"
              aria-label="Confirm in-chat authoring"
            >
              <p>
                <b>Before you turn this on:</b>
              </p>
              <ul>
                <li>
                  Approval codes appear in public chat. Only you can redeem them, but anyone
                  watching sees what is about to go live.
                </li>
                <li>
                  Approving from chat skips the private rehearsal. Use it for small, low-risk
                  changes; anything that widens who can trigger it, its limits or capabilities, or
                  changes a live round’s rules must be approved here.
                </li>
                <li>
                  Each chat build spends compiler time: at most {data.limits.compilesPerWindow}{' '}
                  every {Math.round(data.limits.compileWindowMs / 60_000)} minutes, one at a time.
                </li>
                <li>Stop everything instantly invalidates every waiting code.</li>
              </ul>
              <div className="panel-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={busy !== null}
                  onClick={() => void setEnabled(true)}
                >
                  {busy === 'toggle' ? 'Turning on…' : 'I understand — turn on'}
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  onClick={() => setConfirming(false)}
                >
                  Keep it off
                </button>
              </div>
            </div>
          )}

          {data.enabled && (
            <>
              {code ? (
                <section
                  className="chat-code"
                  data-expired={expired || undefined}
                  aria-labelledby="chat-code-heading"
                >
                  <div>
                    <h3 id="chat-code-heading">
                      {expired ? 'Code expired' : 'Waiting for your approval'}
                    </h3>
                    <p className="chat-code-value">
                      <span className="sr-only">Approval code </span>
                      <code>{code.code}</code>
                    </p>
                    <p className="panel-hint">
                      {expired ? (
                        'Approve it here instead, or build it again from chat.'
                      ) : (
                        <>
                          Type <code>!riff approve {code.code}</code> in chat ·{' '}
                          <span
                            role="timer"
                            aria-label={`Expires in ${formatRemaining(remaining)}`}
                          >
                            expires in {formatRemaining(remaining)}
                          </span>
                        </>
                      )}
                    </p>
                    <div
                      className="chat-code-meter"
                      aria-hidden="true"
                      style={{
                        transform: `scaleX(${Math.max(0, Math.min(1, remaining / data.limits.codeTtlMs))})`,
                      }}
                    />
                  </div>
                  <div className="chat-code-actions">
                    <button
                      type="button"
                      className="button small"
                      onClick={() => onReview(code.versionId)}
                    >
                      Review candidate
                    </button>
                    {!expired && (
                      <button
                        type="button"
                        className="button small danger"
                        disabled={busy !== null}
                        onClick={() => void revoke(code.id)}
                      >
                        {busy === 'revoke' ? 'Withdrawing…' : 'Revoke code'}
                      </button>
                    )}
                  </div>
                </section>
              ) : data.pending?.status === 'compiling' ? (
                <p className="panel-callout chat-compiling" role="status">
                  <span className="chat-dot" aria-hidden="true" /> Compiling from chat: “
                  {data.pending.intent}”. A code appears here and in chat if it passes verification.
                </p>
              ) : (
                <p className="panel-hint" role="status">
                  No chat candidate is waiting.
                </p>
              )}

              <dl className="chat-facts">
                <div>
                  <dt>Chat builds</dt>
                  <dd>
                    {used} of {data.limits.compilesPerWindow} used in the last{' '}
                    {Math.round(data.limits.compileWindowMs / 60_000)} min
                  </dd>
                </div>
                <div>
                  <dt>Chat replies</dt>
                  <dd>
                    {data.replies.available ? (
                      'Riff replies as you with short system messages.'
                    ) : (
                      <>
                        {data.replies.reason ?? 'Unavailable.'}{' '}
                        {data.replies.reason?.includes('Reconnect') && (
                          <a href="/auth/twitch">Reconnect Twitch</a>
                        )}
                      </>
                    )}
                    {data.replies.lastError && (
                      <span className="panel-problem"> {data.replies.lastError}</span>
                    )}
                  </dd>
                </div>
                {data.lockedUntil && (
                  <div>
                    <dt>Chat approval</dt>
                    <dd className="panel-problem">
                      Paused after repeated wrong codes until{' '}
                      {new Date(data.lockedUntil - offset).toLocaleTimeString()}. Approve here
                      meanwhile.
                    </dd>
                  </div>
                )}
              </dl>
              {panic && (
                <p className="panel-callout" data-tone="warn">
                  Everything is stopped, so chat commands are ignored and no codes are issued.
                </p>
              )}
            </>
          )}

          {candidates.length > 0 && (
            <section aria-labelledby="chat-candidates-heading">
              <h4 id="chat-candidates-heading">From chat</h4>
              <ul className="chat-list">
                {candidates.map((item) => (
                  <li key={item.versionId}>
                    <span className="badge chat-badge">From chat</span>
                    <span>
                      {item.kind === 'edit' ? 'Edit' : 'New interaction'} ·{' '}
                      {new Date(item.requestedAt - offset).toLocaleTimeString()}
                    </span>
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => onReview(item.versionId)}
                    >
                      Review
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.recentCodes.length > 0 && (
            <details>
              <summary>Recent codes</summary>
              <ul className="chat-list">
                {data.recentCodes.map((item) => (
                  <li key={item.id}>
                    <code>{item.code}</code>
                    <span>{CODE_STATUS_LABEL[item.status]}</span>
                    {item.reason && <span className="panel-hint">{item.reason}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <details>
            <summary>Chat commands</summary>
            <dl className="chat-commands">
              {COMMANDS.map(([command, hint]) => (
                <div key={command}>
                  <dt>
                    <code>{command}</code>
                  </dt>
                  <dd>{hint}</dd>
                </div>
              ))}
            </dl>
          </details>
          {error && (
            <p role="alert" className="answer bad">
              {error}
            </p>
          )}
        </>
      )}
    </PanelCard>
  );
}
