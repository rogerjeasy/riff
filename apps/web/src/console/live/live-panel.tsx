import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type { Activity, Automation, Studio, Version } from '../../lib/types.js';
import { SessionHud } from '../sessions/session-hud.js';
import { RoundAudit } from '../sessions/round-audit.js';
import { TimerList } from '../timers/timer-list.js';
import { ago, approvalLine, approverLabel, audienceLabel, formatWindow, tone } from '../format.js';

const STATUS_LABEL: Record<Automation['status'], string> = {
  live: 'Live',
  paused: 'Paused',
  draft: 'Not live yet',
};

export function LivePanel(props: {
  studio: Studio;
  selectedVersionId: string | null;
  onSelect: (version: Version) => void;
  onEdit: (version: Version) => void;
  notify: (message: string, kind?: 'good' | 'bad') => void;
}) {
  const { studio } = props;
  // A draft whose every version was discarded was never live and has nothing left to
  // show or approve; listing it would read as a second "Not live yet" interaction.
  const shownAutomations = studio.automations.filter(
    (a) => a.status !== 'draft' || a.versions.some((v) => v.status !== 'discarded'),
  );
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      props.notify(success);
    } catch (error) {
      props.notify(
        error instanceof ApiError ? error.message : 'That did not work. Try again.',
        'bad',
      );
    }
  };
  return (
    <section className="card live" aria-labelledby="live-heading">
      <header className="card-head">
        <div>
          <p className="step-label">
            <span>5</span> Play · live
          </p>
          <h2 id="live-heading">Your interactions</h2>
        </div>
      </header>
      {shownAutomations.length === 0 ? (
        <p className="empty">
          Nothing yet. Describe your first interaction — it stays private until you approve it.
        </p>
      ) : (
        <ul className="library">
          {shownAutomations.map((automation) => {
            const active = automation.versions.find((v) => v.id === automation.activeVersionId);
            const shown = active ?? automation.versions[0];
            const t = shown?.manifest.trigger;
            const previous = automation.versions.find(
              (v) =>
                v.id !== active?.id &&
                v.approvedAt !== null &&
                v.evidence.verification.ok &&
                !v.incident &&
                v.blockers.length === 0 &&
                (v.status === 'superseded' || v.status === 'approved'),
            );
            const quarantined = active?.status === 'quarantined';
            return (
              <li
                key={automation.id}
                className="interaction"
                data-status={quarantined ? 'quarantined' : automation.status}
              >
                <div className="interaction-head">
                  <h3>{automation.title}</h3>
                  <span
                    className={`pill ${automation.status === 'live' && !studio.panic ? 'good' : quarantined ? 'bad' : 'muted'}`}
                  >
                    {studio.panic && automation.status === 'live'
                      ? 'Stopped'
                      : quarantined
                        ? 'Quarantined'
                        : STATUS_LABEL[automation.status]}
                    {active ? ` · v${active.number}` : ''}
                  </span>
                </div>
                {t && !shown?.manifest.experience && (
                  <p className="instruction">
                    Type <b>{t.command}</b> · {audienceLabel(t.audience)} · {t.maxPerViewer} per{' '}
                    {formatWindow(t.windowMs)}
                  </p>
                )}
                {active?.manifest.capabilities.includes('timer') && t && (
                  <TimerList
                    automationId={automation.id}
                    title={automation.title}
                    timers={automation.timers ?? []}
                    command={t.command}
                    live={automation.status === 'live' && !quarantined}
                    stopped={studio.panic}
                    notify={props.notify}
                  />
                )}
                {automation.session && active?.manifest.experience && (
                  <>
                    <SessionHud
                      definition={active.manifest.experience}
                      snapshot={automation.session}
                      label={`${automation.title} live session`}
                    />
                    <RoundAudit
                      automationId={automation.id}
                      definition={active.manifest.experience}
                      session={automation.session}
                    />
                  </>
                )}
                <div className="row-actions">
                  {automation.status === 'live' && (
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() =>
                        void act(
                          () => api.automation(automation.id, 'pause'),
                          `Paused ${automation.title}.`,
                        )
                      }
                    >
                      Pause
                    </button>
                  )}
                  {automation.status === 'paused' && active?.status === 'active' && (
                    <button
                      type="button"
                      className="button small"
                      onClick={() =>
                        void act(
                          () => api.automation(automation.id, 'resume'),
                          `${automation.title} is live again.`,
                        )
                      }
                    >
                      Resume
                    </button>
                  )}
                  {automation.canRollback && (
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={studio.panic || Boolean(automation.session && !previous)}
                      title={
                        automation.session
                          ? 'Opens a private review: keep current progress or start a fresh round'
                          : undefined
                      }
                      onClick={() => {
                        if (automation.session && previous) props.onSelect(previous);
                        else
                          void act(
                            () => api.automation(automation.id, 'rollback'),
                            'Rolled back to the previous approved version.',
                          );
                      }}
                    >
                      {automation.session
                        ? `Review rollback to v${previous?.number ?? '?'}…`
                        : 'Roll back'}
                    </button>
                  )}
                  {automation.session && (
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => setConfirmReset(automation.id)}
                      disabled={studio.panic}
                    >
                      Reset session…
                    </button>
                  )}
                  {shown && (
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => props.onEdit(shown)}
                    >
                      Edit
                    </button>
                  )}
                </div>
                {(automation.transitions ?? [])
                  .filter((t) => t.status === 'pending')
                  .map((t) => (
                    <div className="pending-transition" key={t.id} role="status">
                      <span className="pill warn">Scheduled</span>
                      <p>
                        <b>{versionName(automation.versions, t.targetVersionId)}</b> takes over when
                        this round ends. Everyone keeps their progress.
                      </p>
                      <button
                        type="button"
                        className="button small ghost"
                        onClick={() =>
                          void act(() => api.cancelTransition(t.id), 'Pending change cancelled.')
                        }
                      >
                        Cancel pending change
                      </button>
                    </div>
                  ))}
                {confirmReset === automation.id && (
                  <div
                    className="session-reset-confirm"
                    role="group"
                    aria-label="Confirm session reset"
                  >
                    <p>
                      Reset this session? Current scores, participant resources and progress will be
                      cleared. A new round starts.
                    </p>
                    <button
                      type="button"
                      className="button small"
                      disabled={studio.panic}
                      onClick={() => {
                        setConfirmReset(null);
                        void act(
                          () => api.resetSession(automation.id),
                          'Session reset. A new round has started.',
                        );
                      }}
                    >
                      Confirm reset session
                    </button>
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => setConfirmReset(null)}
                    >
                      Cancel reset
                    </button>
                  </div>
                )}
                <ol className="history" aria-label={`${automation.title} versions`}>
                  {automation.versions
                    .filter((v) => v.status !== 'discarded')
                    .slice(0, 6)
                    .map((version) => (
                      <li key={version.id}>
                        <button
                          type="button"
                          aria-current={props.selectedVersionId === version.id}
                          onClick={() => props.onSelect(version)}
                        >
                          <span className="mono">v{version.number}</span>
                          <span className={`dot ${version.status}`} aria-hidden="true" />
                          <span>{version.status === 'active' ? 'live' : version.status}</span>
                          <span
                            className="muted"
                            title={
                              version.approvedAt !== null
                                ? approvalLine(version.approvedBy, version.approvedAt)
                                : undefined
                            }
                          >
                            {version.origin === 'codex' ? 'Codex' : version.origin} ·{' '}
                            {ago(version.createdAt)}
                            {version.approvedAt !== null && approverLabel(version.approvedBy) && (
                              <> · approved by {approverLabel(version.approvedBy)}</>
                            )}
                            {automation.transitions?.some(
                              (t) => t.status === 'applied' && t.targetVersionId === version.id,
                            ) && (
                              <span
                                className="badge good kept"
                                title="Activated without resetting the round"
                              >
                                kept progress
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
      <OverlaySetup connections={studio.overlay.connections} notify={props.notify} />
      <TwitchSetup studio={studio} notify={props.notify} />
    </section>
  );
}

const versionName = (versions: Version[], id: string) => {
  const n = versions.find((v) => v.id === id)?.number;
  return n === undefined ? 'The approved version' : `v${n}`;
};

function OverlaySetup(props: {
  connections: number;
  notify: (m: string, k?: 'good' | 'bad') => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    void api.overlay().then(
      (o) => setUrl(o.url),
      () => setUrl(null),
    );
  }, []);
  const masked = url
    ? url.replace(/key=([^&]+)/, (_m, key: string) => `key=${revealed ? key : '•'.repeat(10)}`)
    : 'Loading…';
  return (
    <div className="setup">
      <h3>
        OBS browser source{' '}
        <span className={`pill ${props.connections ? 'good' : 'muted'}`}>
          {props.connections ? `${props.connections} connected` : 'not connected'}
        </span>
      </h3>
      <p className="mono url" aria-label="Overlay URL">
        {masked}
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button small"
          disabled={!url}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(url ?? '')
              .then(() => props.notify('Overlay URL copied. Add it as a 1920×1080 browser source.'))
          }
        >
          Copy URL
        </button>
        <button type="button" className="button small ghost" onClick={() => setRevealed((r) => !r)}>
          {revealed ? 'Hide key' : 'Show key'}
        </button>
        <button
          type="button"
          className="button small ghost"
          onClick={() =>
            void api
              .testOverlay()
              .then((r) =>
                props.notify(
                  r.delivered
                    ? `Test frame shown on ${r.delivered} overlay${r.delivered > 1 ? 's' : ''}.`
                    : 'No overlay is connected yet.',
                  r.delivered ? 'good' : 'bad',
                ),
              )
          }
        >
          Send test frame
        </button>
        <button
          type="button"
          className="button small ghost"
          onClick={() =>
            void api.rotateOverlay().then((r) => {
              setUrl(r.url);
              props.notify('New key created. Old overlay links stopped working.');
            })
          }
        >
          Rotate key
        </button>
        {url && (
          <a className="button small ghost" href={url} target="_blank" rel="noreferrer">
            Open overlay ↗
          </a>
        )}
      </div>
    </div>
  );
}

function TwitchSetup({
  studio,
  notify,
}: {
  studio: Studio;
  notify: (m: string, k?: 'good' | 'bad') => void;
}) {
  const t = studio.twitch;
  const login = 'login' in t ? t.login : null;
  return (
    <div className="setup">
      <h3>
        Twitch chat
        <span
          className={`pill ${t.state === 'connected' ? 'good' : t.state === 'error' ? 'bad' : 'muted'}`}
        >
          {t.state === 'connected' ? `@${login}` : t.state}
        </span>
      </h3>
      {t.state === 'unconfigured' && (
        <p className="note">
          Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and RIFF_SECRET, with redirect URL
          http://localhost:8787/auth/twitch/callback in your Twitch app. Riff reads chat through
          EventSub with only the user:read:chat scope.
        </p>
      )}
      {t.state === 'error' && <p className="note bad">{t.message}</p>}
      {t.state === 'connected' && (
        <p className="note">
          Listening to chat over EventSub. Mods and you can type <b>!riff panic</b> to stop
          everything.
        </p>
      )}
      <div className="row-actions">
        {(t.state === 'disconnected' || t.state === 'error') && (
          <a className="button small" href="/auth/twitch">
            Connect Twitch
          </a>
        )}
        {t.state !== 'unconfigured' && t.state !== 'disconnected' && (
          <button
            type="button"
            className="button small ghost"
            onClick={() => void api.disconnectTwitch().then(() => notify('Twitch disconnected.'))}
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<Activity['source']['kind'], string> = {
  chat: 'Chat',
  timer: 'Timer',
  redemption: 'Channel Points',
  twitch: 'Twitch event',
  console: 'Console',
  system: 'Riff',
};
const OUTCOME_LABEL: Record<Activity['outcome'], string> = {
  accepted: 'Accepted',
  blocked: 'Blocked',
  incident: 'Incident',
  info: 'Update',
};
type ActivityFilter = 'all' | 'blocked' | 'incidents';
const matches = (entry: Activity, filter: ActivityFilter) =>
  filter === 'all' ||
  (filter === 'blocked' ? entry.outcome === 'blocked' : entry.outcome === 'incident');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * F16: each entry names its source, the exact interaction version (selectable for review),
 * the outcome with a plain-language reason, and allowed vs. blocked effects when known.
 */
export function ActivityFeed({
  activity,
  selectedVersionId = null,
  onSelectVersion,
}: {
  activity: Activity[];
  selectedVersionId?: string | null;
  onSelectVersion?: (versionId: string) => void;
}) {
  const [, tick] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  const recent = activity.slice(0, 40);
  const counts = {
    all: recent.length,
    blocked: recent.filter((e) => e.outcome === 'blocked').length,
    incidents: recent.filter((e) => e.outcome === 'incident').length,
  };
  const shown = recent.filter((entry) => matches(entry, filter)).slice(0, 25);
  return (
    <section className="card activity" aria-labelledby="activity-heading">
      <header className="card-head">
        <h2 id="activity-heading">Activity</h2>
        {recent.length > 0 && (
          <div className="segmented activity-filter" role="group" aria-label="Show activity">
            {(
              [
                ['all', 'All'],
                ['blocked', 'Blocked'],
                ['incidents', 'Incidents'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label} <span className="count">{counts[value]}</span>
              </button>
            ))}
          </div>
        )}
      </header>
      {recent.length === 0 ? (
        <p className="empty">Live decisions, approvals and incidents appear here as they happen.</p>
      ) : shown.length === 0 ? (
        <p className="empty">
          {filter === 'blocked'
            ? 'Nothing was blocked recently.'
            : 'No incidents recently. Riff records one whenever it stops an interaction.'}
        </p>
      ) : (
        <ol className="feed activity-feed" aria-live="polite">
          {shown.map((entry) => {
            const label = entry.interaction
              ? `${entry.interaction.title}${entry.interaction.number === null ? '' : ` v${entry.interaction.number}`}`
              : null;
            const { versionId } = entry;
            return (
              <li key={entry.id} data-kind={entry.kind} data-outcome={entry.outcome}>
                <span
                  className={`badge ${entry.outcome === 'incident' ? 'bad' : tone(entry.code)}`}
                >
                  {entry.code ?? entry.kind}
                </span>
                <div className="feed-body">
                  <p className="feed-cause">
                    <span className={`feed-outcome ${entry.outcome}`}>
                      {OUTCOME_LABEL[entry.outcome]}
                    </span>
                    <span className="feed-source">
                      {SOURCE_LABEL[entry.source.kind]} · {entry.source.label}
                    </span>
                    {label &&
                      (versionId && onSelectVersion ? (
                        <button
                          type="button"
                          className="feed-version"
                          aria-current={selectedVersionId === versionId}
                          aria-label={`Review ${label}`}
                          onClick={() => onSelectVersion(versionId)}
                        >
                          {label}
                        </button>
                      ) : (
                        <span className="feed-version static">{label}</span>
                      ))}
                  </p>
                  <p className="feed-message">
                    {entry.reason && entry.outcome !== 'incident' ? (
                      <>
                        <span className="sr-only">Reason: </span>
                        {entry.reason}
                      </>
                    ) : (
                      entry.message
                    )}
                  </p>
                  {entry.effects && (
                    <p className="feed-effects">
                      <span className="good">
                        {plural(entry.effects.allowed, 'effect')} allowed
                      </span>
                      {' · '}
                      <span className={entry.effects.blocked ? 'bad' : 'muted'}>
                        {entry.effects.blocked} blocked
                      </span>
                    </p>
                  )}
                </div>
                <time className="muted" dateTime={new Date(entry.at).toISOString()}>
                  {ago(entry.at)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
