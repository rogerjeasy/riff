import './panel.css';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, request } from '../../lib/api.js';
import { PanelCard, Segmented, Tabs, type Tone } from '../panel-kit.js';
import {
  LIMITS,
  responseSchema,
  type ActivePoll,
  type FeatureName,
  type FeatureStatus,
  type TwitchFeatures,
} from './contracts.js';

const COPY: Record<FeatureName, { title: string; what: string; capability: string }> = {
  polls: {
    title: 'Twitch polls',
    what: 'Native Twitch polls viewers vote on in chat. One at a time; Affiliates and Partners only.',
    capability: 'riff.polls.start / end',
  },
  announcements: {
    title: 'Chat announcements',
    what: 'Highlighted chat messages from your account, budgeted to 6 a minute and one every 2 s.',
    capability: 'riff.chat.announce',
  },
  shoutouts: {
    title: 'Shoutouts',
    what: 'Twitch shoutout cards for channels you approve. Once every 2 min; same channel once an hour.',
    capability: 'riff.shoutout.send',
  },
};
const STATE_LABEL: Record<FeatureStatus['state'], { text: string; tone: Tone }> = {
  'not-connected': { text: 'Connect Twitch', tone: 'muted' },
  'needs-grant': { text: 'Not granted', tone: 'warn' },
  disabled: { text: 'Off in Riff', tone: 'muted' },
  checking: { text: 'Checking…', tone: 'muted' },
  ineligible: { text: 'Affiliate/Partner only', tone: 'bad' },
  ready: { text: 'Ready', tone: 'good' },
};
const KIND_LABEL = {
  'poll.start': 'Poll started',
  'poll.end': 'Poll ended',
  announce: 'Announcement',
  shoutout: 'Shoutout',
} as const;

const duration = (seconds: number) =>
  seconds < 60 ? `${seconds} s` : `${seconds / 60} min${seconds === 60 ? '' : 's'}`;
const clockText = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** One-second local clock for countdowns; the server stays authoritative for state. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** F21/F23: per-feature consent and eligibility, live poll results and manual actions. */
export function TwitchFeaturesPanel({ panic }: { panic: boolean }) {
  const [data, setData] = useState<TwitchFeatures | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'poll' | 'announce' | 'shoutout'>('poll');
  const alive = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const raw = await request('GET', '/api/twitch/features', undefined, signal);
      if (!alive.current) return;
      setData(responseSchema.parse(raw).features);
      setLoadError('');
    } catch {
      if (alive.current && !signal?.aborted)
        setLoadError('Could not load Twitch features. Check that Riff’s server is running.');
    }
  }, []);
  const pollActive = data?.poll?.status === 'ACTIVE';
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    // Results refresh quickly while a poll runs; otherwise a slow heartbeat keeps grants fresh.
    const timer = setInterval(() => void load(), pollActive ? 3000 : 15_000);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [load, pollActive, panic]);

  async function act(label: string, method: 'POST', url: string, body: unknown, done: string) {
    if (busy) return false;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const raw = await request(method, url, body);
      if (!alive.current) return false;
      setData(responseSchema.parse(raw).features);
      setNotice(done);
      return true;
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
      void load();
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const ready = data?.features.filter((f) => f.state === 'ready').length ?? 0;
  const status: { text: string; tone: Tone } = !data
    ? { text: loadError ? 'Unavailable' : 'Loading…', tone: loadError ? 'bad' : 'muted' }
    : data.stopped
      ? { text: 'Stopped', tone: 'bad' }
      : pollActive
        ? { text: '● Poll live', tone: 'live' }
        : !data.connected
          ? { text: 'Connect Twitch', tone: 'muted' }
          : { text: `${ready} of 3 ready`, tone: ready ? 'good' : 'warn' };
  const feature = (name: FeatureName) => data?.features.find((f) => f.feature === name);

  return (
    <PanelCard
      title="Twitch features"
      subtitle="Native polls, chat announcements and shoutouts — each granted and limited separately."
      status={status}
      className="twitch-features"
    >
      {!data ? (
        <p
          role={loadError ? 'alert' : 'status'}
          className={loadError ? 'answer bad' : 'panel-hint'}
        >
          {loadError || 'Loading Twitch features…'}
          {loadError && (
            <button type="button" className="button small ghost" onClick={() => void load()}>
              Retry
            </button>
          )}
        </p>
      ) : (
        <div className="tf-layout">
          {data.stopped && (
            <p className="panel-callout" data-tone="warn" role="status">
              Everything is stopped. Riff ended the poll it started and sends nothing to Twitch
              until you resume.
            </p>
          )}
          {!data.connected && (
            <p className="panel-callout">
              Connect Twitch from the top bar first. Each feature then asks Twitch for its own
              permission only when you grant it here.
            </p>
          )}
          <ul className="tf-features" aria-label="Feature permissions">
            {data.features.map((f) => (
              <FeatureCard
                key={f.feature}
                status={f}
                busy={busy !== null}
                onToggle={(enabled) =>
                  void act(
                    `toggle-${f.feature}`,
                    'POST',
                    '/api/twitch/features/toggle',
                    { feature: f.feature, enabled },
                    `${COPY[f.feature].title} ${enabled ? 'turned on' : 'turned off'}.`,
                  )
                }
                onRecheck={() =>
                  void act(
                    'eligibility',
                    'POST',
                    '/api/twitch/features/eligibility',
                    {},
                    'Channel eligibility checked with Twitch.',
                  )
                }
              />
            ))}
          </ul>

          <Tabs
            label="Manual Twitch actions"
            value={tab}
            onChange={setTab}
            tabs={[
              {
                value: 'poll',
                label: 'Poll',
                ...(pollActive ? { badge: <span className="badge good">live</span> } : {}),
              },
              { value: 'announce', label: 'Announcement' },
              { value: 'shoutout', label: 'Shoutout' },
            ]}
          >
            {tab === 'poll' ? (
              <PollTab
                data={data}
                status={feature('polls')}
                busy={busy}
                onStart={(body) =>
                  act('poll', 'POST', '/api/twitch/polls', body, 'Poll started on Twitch.')
                }
                onEnd={() =>
                  void act(
                    'end',
                    'POST',
                    '/api/twitch/polls/end',
                    {},
                    'Poll ended. Results stay visible on Twitch.',
                  )
                }
              />
            ) : tab === 'announce' ? (
              <AnnounceTab
                data={data}
                status={feature('announcements')}
                busy={busy}
                onSend={(body) =>
                  act('announce', 'POST', '/api/twitch/announcements', body, 'Announcement sent.')
                }
              />
            ) : (
              <ShoutoutTab
                data={data}
                status={feature('shoutouts')}
                busy={busy}
                onPolicy={(body) =>
                  act(
                    'policy',
                    'POST',
                    '/api/twitch/shoutouts/policy',
                    body,
                    'Shoutout policy saved.',
                  )
                }
                onSend={(login) =>
                  void act(
                    'shoutout',
                    'POST',
                    '/api/twitch/shoutouts',
                    { login },
                    `Shoutout sent to @${login}.`,
                  )
                }
              />
            )}
          </Tabs>
          {notice && (
            <p role="status" className="panel-callout" data-tone="good">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="answer bad">
              {error}
            </p>
          )}

          <details className="tf-howto">
            <summary>How automations use these</summary>
            <ul>
              <li>
                Describe it in plain words, e.g.{' '}
                <q>
                  When I type !nextgame, start a poll “What next?” with “Speedrun” and “Hardcore”
                  for 2 minutes.
                </q>
              </li>
              <li>
                Generated code can only <em>request</em> <code>riff.polls.start</code>,{' '}
                <code>riff.chat.announce</code> or <code>riff.shoutout.send</code>. Riff checks the
                approved manifest, the interaction’s limits, these channel budgets and Twitch’s own
                limits, in that order, before anything reaches Twitch.
              </li>
              <li>
                Polls and shoutouts can only be triggered by you or your moderators. Shoutouts go
                only to channels your policy approves. The one exception: with “Shout out raiders
                automatically” on, a raid interaction (
                <q>When we get raided, shout out the raider</q>) may use{' '}
                <code>riff.shoutout.raider()</code> for the channel that raided.
              </li>
              <li>
                Rehearsals and tests use a simulated Twitch: nothing is posted until you approve and
                go live. Stop everything ends Riff’s poll and drops queued actions.
              </li>
            </ul>
          </details>

          <section aria-labelledby="tf-history" className="tf-history">
            <h3 id="tf-history">Recent Twitch actions</h3>
            {data.history.length === 0 ? (
              <p className="panel-hint">
                Nothing sent yet. Sent, refused and failed actions appear here.
              </p>
            ) : (
              <ol>
                {data.history.slice(0, 6).map((entry) => (
                  <li key={`${entry.at}-${entry.kind}-${entry.code}`}>
                    <span
                      className={`badge ${entry.outcome === 'sent' ? 'good' : entry.outcome === 'failed' ? 'bad' : 'warn'}`}
                    >
                      {entry.outcome}
                    </span>
                    <span>
                      <b>{KIND_LABEL[entry.kind]}</b>
                      {entry.origin === 'automation'
                        ? ' · automation'
                        : entry.origin === 'panic'
                          ? ' · stop everything'
                          : ''}
                      <span className="panel-hint">
                        {' '}
                        · {new Date(entry.at).toLocaleTimeString()}
                      </span>
                      <br />
                      <span className="tf-history-message">{entry.message}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </PanelCard>
  );
}

function FeatureCard({
  status,
  busy,
  onToggle,
  onRecheck,
}: {
  status: FeatureStatus;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRecheck: () => void;
}) {
  const copy = COPY[status.feature];
  const label = STATE_LABEL[status.state];
  const headingId = useId();
  const granted = !['not-connected', 'needs-grant'].includes(status.state);
  return (
    <li className="tf-feature" aria-labelledby={headingId} data-state={status.state}>
      <div className="tf-feature-head">
        <h3 id={headingId}>{copy.title}</h3>
        <span className={`badge ${label.tone}`}>{label.text}</span>
      </div>
      <p className="panel-hint">{copy.what}</p>
      {status.state !== 'ready' && <p className="tf-feature-message">{status.message}</p>}
      <p className="tf-scope">
        Twitch permission <code>{status.scope}</code>
      </p>
      <div className="panel-actions">
        {status.state === 'needs-grant' && (
          <a className="button small primary" href={`/auth/twitch?feature=${status.feature}`}>
            Grant on Twitch →
          </a>
        )}
        {granted && (
          <label className="panel-checkbox tf-switch">
            <input
              type="checkbox"
              role="switch"
              checked={status.state !== 'disabled'}
              disabled={busy}
              onChange={(e) => onToggle(e.target.checked)}
            />
            <span>Use in Riff</span>
          </label>
        )}
        {status.feature === 'polls' && ['ineligible', 'checking'].includes(status.state) && (
          <button type="button" className="button small ghost" disabled={busy} onClick={onRecheck}>
            Check eligibility
          </button>
        )}
      </div>
      <p className="panel-hint">
        Automations: <code>{copy.capability}</code>
        {status.usedBy.length > 0 && (
          <>
            {' '}
            · used by{' '}
            {status.usedBy.map((u, i) => (
              <span key={u.automationId}>
                {i > 0 && ', '}
                {u.title}
                {u.live && <span className="sr-only"> (live)</span>}
                {u.live && (
                  <span className="tf-live" aria-hidden="true">
                    ●
                  </span>
                )}
              </span>
            ))}
          </>
        )}
      </p>
    </li>
  );
}

function Blocked({ status, stopped }: { status: FeatureStatus | undefined; stopped: boolean }) {
  if (stopped)
    return (
      <p className="panel-callout" data-tone="warn">
        Stopped. Resume the channel to send Twitch actions.
      </p>
    );
  if (!status || status.state === 'ready') return null;
  return (
    <p className="panel-callout" data-tone="warn">
      {status.message}
    </p>
  );
}

function Counter({ value, max }: { value: string; max: number }) {
  const used = [...value].length;
  return (
    <span className="tf-counter" data-over={used > max || undefined} aria-live="polite">
      {used}/{max}
    </span>
  );
}

function PollTab({
  data,
  status,
  busy,
  onStart,
  onEnd,
}: {
  data: TwitchFeatures;
  status: FeatureStatus | undefined;
  busy: string | null;
  onStart: (body: {
    title: string;
    choices: string[];
    durationSeconds: number;
  }) => Promise<boolean>;
  onEnd: () => void;
}) {
  const [title, setTitle] = useState('');
  const [choices, setChoices] = useState(['', '']);
  const [seconds, setSeconds] = useState(120);
  const poll = data.poll;
  if (poll && (poll.status === 'ACTIVE' || (poll.endedAt ?? 0) > Date.now() - 5 * 60_000))
    return (
      <div className="tf-tab">
        <PollResults poll={poll} />
        {poll.status === 'ACTIVE' && (
          <div className="panel-actions">
            <button
              type="button"
              className="button"
              disabled={busy !== null || data.stopped}
              onClick={onEnd}
            >
              {busy === 'end' ? 'Ending…' : 'End poll now'}
            </button>
            <span className="panel-hint">Ending early keeps the results visible on Twitch.</span>
          </div>
        )}
      </div>
    );
  const trimmed = choices.map((c) => c.trim()).filter(Boolean);
  const duplicate = new Set(trimmed.map((c) => c.toLowerCase())).size !== trimmed.length;
  const problem = !title.trim()
    ? 'Write the poll question.'
    : [...title.trim()].length > LIMITS.pollTitle
      ? `Keep the question to ${LIMITS.pollTitle} characters.`
      : trimmed.length < LIMITS.choices.min
        ? 'Add at least two choices.'
        : trimmed.some((c) => [...c].length > LIMITS.pollChoice)
          ? `Keep each choice to ${LIMITS.pollChoice} characters.`
          : duplicate
            ? 'Choices must be different.'
            : null;
  const unavailable = data.stopped || status?.state !== 'ready';
  return (
    <form
      className="tf-tab"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || unavailable) return;
        void onStart({ title: title.trim(), choices: trimmed, durationSeconds: seconds }).then(
          (ok) => {
            if (ok) {
              setTitle('');
              setChoices(['', '']);
            }
          },
        );
      }}
    >
      <Blocked status={status} stopped={data.stopped} />
      <fieldset disabled={unavailable || busy !== null} className="tf-fields">
        <legend className="sr-only">Start a Twitch poll</legend>
        <label>
          <span className="tf-label-row">
            Question <Counter value={title} max={LIMITS.pollTitle} />
          </span>
          <input
            value={title}
            maxLength={LIMITS.pollTitle * 2}
            placeholder="What should we play next?"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="tf-choices" role="group" aria-label="Choices">
          {choices.map((choice, i) => (
            <div className="tf-choice" key={i}>
              <label>
                <span className="tf-label-row">
                  Choice {i + 1} <Counter value={choice} max={LIMITS.pollChoice} />
                </span>
                <input
                  value={choice}
                  maxLength={LIMITS.pollChoice * 2}
                  onChange={(e) =>
                    setChoices(choices.map((c, j) => (j === i ? e.target.value : c)))
                  }
                />
              </label>
              {choices.length > LIMITS.choices.min && (
                <button
                  type="button"
                  className="button small ghost"
                  aria-label={`Remove choice ${i + 1}`}
                  onClick={() => setChoices(choices.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {choices.length < LIMITS.choices.max && (
            <button
              type="button"
              className="button small ghost tf-add"
              onClick={() => setChoices([...choices, ''])}
            >
              + Add choice
            </button>
          )}
        </div>
        <label className="tf-duration">
          Runs for
          <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
            {LIMITS.durations.map((d) => (
              <option key={d} value={d}>
                {duration(d)}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <div className="panel-actions">
        <button className="button primary" disabled={unavailable || !!problem || busy !== null}>
          {busy === 'poll' ? 'Starting…' : 'Start poll on Twitch'}
        </button>
        <span className="panel-hint">
          {problem && !unavailable
            ? problem
            : `${data.budgets.polls.used} of ${data.budgets.polls.limit} polls used this hour.`}
        </span>
      </div>
    </form>
  );
}

function PollResults({ poll }: { poll: ActivePoll }) {
  const active = poll.status === 'ACTIVE';
  const now = useNow(active);
  const total = poll.choices.reduce((sum, c) => sum + c.votes, 0);
  const leader = Math.max(0, ...poll.choices.map((c) => c.votes));
  return (
    <section className="tf-poll" aria-labelledby="tf-poll-title">
      <div className="tf-feature-head">
        <h3 id="tf-poll-title">{poll.title}</h3>
        <span className={`badge ${active ? 'good' : 'muted'}`}>
          {active ? `Live · ${clockText(poll.endsAt - now)} left` : 'Ended'}
        </span>
      </div>
      <ul className="tf-bars" aria-label="Results">
        {poll.choices.map((choice) => {
          const share = total ? Math.round((choice.votes / total) * 100) : 0;
          return (
            <li key={choice.id} data-leading={(total > 0 && choice.votes === leader) || undefined}>
              <span className="tf-bar-label">
                <b>{choice.title}</b>
                <span>
                  {choice.votes} vote{choice.votes === 1 ? '' : 's'} · {share}%
                </span>
              </span>
              <span className="tf-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${share / 100})` }} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="panel-hint">
        {total} vote{total === 1 ? '' : 's'} · started by{' '}
        {poll.origin === 'automation' ? 'an automation' : 'you'} · updated{' '}
        {new Date(poll.refreshedAt).toLocaleTimeString()}
      </p>
    </section>
  );
}

function AnnounceTab({
  data,
  status,
  busy,
  onSend,
}: {
  data: TwitchFeatures;
  status: FeatureStatus | undefined;
  busy: string | null;
  onSend: (body: { message: string; color: string }) => Promise<boolean>;
}) {
  const [message, setMessage] = useState('');
  const [color, setColor] = useState<'primary' | 'blue' | 'green' | 'orange' | 'purple'>('primary');
  const now = useNow(true);
  const budget = data.budgets.announcements;
  const wait = budget.availableAt && budget.availableAt > now ? budget.availableAt - now : 0;
  const unavailable = data.stopped || status?.state !== 'ready';
  const over = [...message.trim()].length > LIMITS.announcement;
  const exhausted = budget.used >= budget.limit;
  return (
    <form
      className="tf-tab"
      onSubmit={(e) => {
        e.preventDefault();
        if (unavailable || over || !message.trim()) return;
        void onSend({ message: message.trim(), color }).then((ok) => ok && setMessage(''));
      }}
    >
      <Blocked status={status} stopped={data.stopped} />
      <fieldset disabled={unavailable || busy !== null} className="tf-fields">
        <legend className="sr-only">Send a chat announcement</legend>
        <label>
          <span className="tf-label-row">
            Announcement <Counter value={message.trim()} max={LIMITS.announcement} />
          </span>
          <textarea
            rows={3}
            value={message}
            aria-invalid={over || undefined}
            placeholder="Round two starts now — type !throw to join!"
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <div className="tf-color">
          <span className="tf-group-label">Highlight</span>
          <Segmented
            label="Announcement color"
            value={color}
            onChange={setColor}
            options={[
              { value: 'primary', label: 'Channel color' },
              { value: 'blue', label: 'Blue' },
              { value: 'green', label: 'Green' },
              { value: 'orange', label: 'Orange' },
              { value: 'purple', label: 'Purple' },
            ]}
          />
        </div>
      </fieldset>
      <div className="panel-actions">
        <button
          className="button primary"
          disabled={unavailable || over || !message.trim() || busy !== null || exhausted || !!wait}
        >
          {busy === 'announce' ? 'Sending…' : 'Send announcement'}
        </button>
        <span className="panel-hint">
          {exhausted
            ? 'Channel budget used up for this minute.'
            : wait
              ? `Twitch allows one every 2 s — ready in ${Math.ceil(wait / 1000)} s.`
              : `${budget.used} of ${budget.limit} used this minute (all interactions combined).`}
        </span>
      </div>
    </form>
  );
}

function ShoutoutTab({
  data,
  status,
  busy,
  onPolicy,
  onSend,
}: {
  data: TwitchFeatures;
  status: FeatureStatus | undefined;
  busy: string | null;
  onPolicy: (body: { mode: string; logins: string[]; autoRaid: boolean }) => Promise<boolean>;
  onSend: (login: string) => void;
}) {
  const policy = data.shoutout;
  const [mode, setMode] = useState(policy.mode);
  const [logins, setLogins] = useState(policy.allowlist.map((c) => c.login).join(', '));
  const [autoRaid, setAutoRaid] = useState(policy.autoRaid);
  const saved = `${policy.mode}|${policy.allowlist.map((c) => c.login).join(',')}|${policy.autoRaid}`;
  useEffect(() => {
    setMode(policy.mode);
    setLogins(policy.allowlist.map((c) => c.login).join(', '));
    setAutoRaid(policy.autoRaid);
    // Only re-seed the editor when the saved policy itself changes.
  }, [saved]);
  const parsed = logins
    .split(/[\s,]+/)
    .map((l) => l.replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);
  const invalid = parsed.filter((l) => !LIMITS.login.test(l));
  // Turning shoutouts off also withdraws the automatic raid consent (the server enforces it).
  const automatic = mode !== 'off' && autoRaid;
  const dirty = `${mode}|${parsed.join(',')}|${automatic}` !== saved;
  const targets =
    policy.mode === 'allowlist'
      ? policy.allowlist.map((c) => ({ login: c.login, label: c.displayName }))
      : policy.mode === 'raiders'
        ? policy.raiders.map((r) => ({ login: r.login, label: `${r.displayName} (raided)` }))
        : [];
  const [target, setTarget] = useState('');
  const now = useNow(true);
  const wait = policy.availableAt && policy.availableAt > now ? policy.availableAt - now : 0;
  const unavailable = data.stopped || status?.state !== 'ready';
  const chosen = targets.some((t) => t.login === target) ? target : (targets[0]?.login ?? '');
  return (
    <div className="tf-tab">
      <Blocked status={status} stopped={data.stopped} />
      <form
        className="tf-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid.length || !dirty) return;
          void onPolicy({ mode, logins: mode === 'allowlist' ? parsed : [], autoRaid: automatic });
        }}
      >
        <fieldset disabled={busy !== null || !data.connected}>
          <legend>Who may receive a shoutout</legend>
          <Segmented
            label="Shoutout policy"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'off', label: 'Nobody', hint: 'Shoutouts are refused' },
              { value: 'allowlist', label: 'Approved channels' },
              {
                value: 'raiders',
                label: 'Raiders only',
                hint: 'Channels that raided in the last hour',
              },
            ]}
          />
          {mode === 'allowlist' && (
            <label className="tf-logins">
              Approved channels (Twitch logins, comma separated, up to 25)
              <input
                value={logins}
                aria-invalid={invalid.length > 0 || undefined}
                placeholder="twitchdev, friendlystreamer"
                onChange={(e) => setLogins(e.target.value)}
              />
              {invalid.length > 0 && (
                <span className="panel-problem">Not a valid login: {invalid.join(', ')}</span>
              )}
            </label>
          )}
          <p className="panel-hint">
            {mode === 'raiders'
              ? 'Only channels Riff saw raid you in the last hour. Raid tracking needs the incoming-raid trigger; until then this list stays empty.'
              : mode === 'allowlist'
                ? 'Riff checks each login with Twitch and stores the channel id. Automations cannot shout out anyone else.'
                : 'Nobody can receive a shoutout from Riff, manually or from an automation.'}
          </p>
          <label className="tf-auto-raid">
            <input
              type="checkbox"
              checked={automatic}
              disabled={mode === 'off'}
              onChange={(e) => setAutoRaid(e.target.checked)}
            />{' '}
            Shout out raiders automatically
          </label>
          <p className="panel-hint" id="tf-auto-raid-hint">
            {mode === 'off'
              ? 'Choose who may receive a shoutout first; automatic raid shoutouts stay off while shoutouts are off.'
              : 'When on, an approved interaction triggered by an incoming raid may shout out the channel that just raided you, and only that channel. Riff takes the target from Twitch’s raid notification, never from chat or generated code. Twitch’s limits still apply (one shoutout every 2 minutes, the same channel once an hour), as do Riff’s 10 shoutouts an hour and Stop everything. Off by default.'}
          </p>
          <div className="panel-actions">
            <button className="button" disabled={!dirty || invalid.length > 0}>
              {busy === 'policy' ? 'Saving…' : 'Save policy'}
            </button>
          </div>
        </fieldset>
      </form>
      <form
        className="tf-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen && !unavailable && !wait) onSend(chosen);
        }}
      >
        <fieldset disabled={unavailable || busy !== null || targets.length === 0}>
          <legend>Send a shoutout now</legend>
          {targets.length === 0 ? (
            <p className="panel-hint">Save an approved channel first.</p>
          ) : (
            <label>
              Channel
              <select value={chosen} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.login} value={t.login}>
                    {t.label} (@{t.login})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="panel-actions">
            <button className="button primary" disabled={!chosen || !!wait}>
              {busy === 'shoutout' ? 'Sending…' : 'Send shoutout'}
            </button>
            <span className="panel-hint">
              {wait
                ? `Twitch cooldown — next shoutout in ${clockText(wait)}.`
                : 'You must be live with at least one viewer. The same channel can receive one an hour.'}
            </span>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
