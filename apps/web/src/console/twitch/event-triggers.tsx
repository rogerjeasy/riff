import './event-triggers.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../lib/api.js';
import type { Studio } from '../../lib/types.js';
import { PanelCard, type Tone } from '../panel-kit.js';
import { twitchTriggersSchema, type TwitchTrigger, type TwitchEventKind } from './contracts.js';

const SUBSCRIPTION: Record<TwitchTrigger['subscription'], { text: string; tone: Tone }> = {
  active: { text: 'Listening', tone: 'good' },
  pending: { text: 'Subscribing…', tone: 'muted' },
  idle: { text: 'Ready', tone: 'muted' },
  'missing-consent': { text: 'Needs consent', tone: 'warn' },
  failed: { text: 'Subscription failed', tone: 'bad' },
  revoked: { text: 'Access revoked', tone: 'bad' },
  offline: { text: 'Twitch offline', tone: 'muted' },
};
// One Twitch consent prompt covers every family that shares its scopes.
const CONSENT: Record<string, { label: string; why: string }> = {
  subscriptions: {
    label: 'Allow subscription events',
    why: 'New subs, gifted subs and resubs need permission to read your channel’s subscriptions.',
  },
  bits: { label: 'Allow cheer events', why: 'Cheers need permission to read Bits activity.' },
  raids: { label: 'Raids', why: 'Incoming raids need no extra permission.' },
};

/** Riff names an authorize link that keeps earlier consent and adds the chosen families. */
const authorizeHref = (names: readonly TwitchEventKind[]) =>
  `/auth/twitch?triggers=${encodeURIComponent(names.join(','))}`;

/**
 * F19: which Twitch event families interactions can react to, which ones live
 * interactions use, and what consent each still needs. Read-only apart from the
 * consent links, which start Twitch's own authorization screen.
 */
export function TwitchEventsPanel({ studio }: { studio: Studio }) {
  const [triggers, setTriggers] = useState<TwitchTrigger[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setLoading(true);
    void request('GET', '/api/twitch/triggers', undefined, c.signal)
      .then((raw) => {
        if (c.signal.aborted) return;
        const parsed = twitchTriggersSchema.parse(raw);
        setTriggers(parsed.triggers);
        setConfigured(parsed.configured);
        setError('');
      })
      .catch(() => {
        if (!c.signal.aborted) setError('Could not load Twitch event status.');
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
  }, []);
  // Twitch status pushes and live-library changes both change what is needed.
  const liveKey = studio.automations
    .map((a) => `${a.id}:${a.status}:${a.activeVersionId ?? ''}`)
    .join('|');
  useEffect(() => {
    load();
  }, [load, studio.twitch.state, liveKey]);
  useEffect(() => () => controller.current?.abort(), []);

  const connected = studio.twitch.state === 'connected';
  const needed = (triggers ?? []).filter((t) => t.inUse && t.missingScopes.length);
  const broken = (triggers ?? []).filter(
    (t) => t.subscription === 'failed' || t.subscription === 'revoked',
  );
  const listening = (triggers ?? []).filter((t) => t.subscription === 'active').length;
  const status: { text: string; tone: Tone } = !configured
    ? { text: 'Twitch not configured', tone: 'muted' }
    : error
      ? { text: 'Unavailable', tone: 'bad' }
      : !triggers
        ? { text: 'Checking…', tone: 'muted' }
        : needed.length
          ? { text: 'Needs consent', tone: 'warn' }
          : broken.length
            ? { text: 'Needs attention', tone: 'bad' }
            : listening
              ? { text: `${listening} listening`, tone: 'good' }
              : { text: 'Ready', tone: 'muted' };
  const groups = new Map<string, TwitchTrigger[]>();
  for (const trigger of triggers ?? [])
    if (trigger.missingScopes.length)
      groups.set(trigger.consent, [...(groups.get(trigger.consent) ?? []), trigger]);

  return (
    <PanelCard
      title="Twitch event triggers"
      subtitle="Subs, gifts, resubs, cheers and raids your interactions can react to."
      status={status}
      // Remount open when a live interaction starts needing consent, so it is never missed.
      key={needed.length ? 'attention' : 'calm'}
      defaultOpen={needed.length > 0}
    >
      <div className="twitch-events">
        <p className="panel-lead">
          Describe it naturally — “when someone cheers 100+ bits, rain stars” — and Riff listens to
          that Twitch event only while an approved interaction uses it. Rehearse any of them
          privately with a simulated event in step 3; nothing is sent to Twitch.
        </p>
        {!configured ? (
          <p className="panel-callout">
            Twitch isn’t configured on this server. Set <code>TWITCH_CLIENT_ID</code>,{' '}
            <code>TWITCH_CLIENT_SECRET</code> and <code>RIFF_SECRET</code>, then restart Riff.
          </p>
        ) : !connected && studio.twitch.state !== 'connecting' ? (
          <p className="panel-callout">
            Connect Twitch first; Riff then asks only for the permissions your interactions need.{' '}
            <a className="button small" href="/auth/twitch">
              Connect Twitch
            </a>
          </p>
        ) : null}
        {needed.length > 0 && (
          <div className="panel-callout" data-tone="warn" role="status">
            <b>A live interaction can’t hear its event yet.</b>{' '}
            {needed.map((t) => t.label.toLowerCase()).join(', ')}{' '}
            {needed.length === 1 ? 'needs' : 'need'} your consent on Twitch. Until then those events
            are not received; chat interactions keep working.
          </div>
        )}
        {error ? (
          <div className="panel-problem" role="alert">
            {error}{' '}
            <button type="button" className="button small ghost" onClick={load}>
              Try again
            </button>
          </div>
        ) : !triggers ? (
          <p className="panel-hint" aria-live="polite">
            Checking Twitch permissions…
          </p>
        ) : (
          <ul className="twitch-events-list" aria-busy={loading}>
            {triggers.map((trigger) => {
              const state = SUBSCRIPTION[trigger.subscription];
              return (
                <li key={trigger.name} className="twitch-event" data-state={trigger.subscription}>
                  <div className="twitch-event-main">
                    <span className="twitch-event-name">{trigger.label}</span>
                    <span className="twitch-event-meta">
                      <code>{trigger.eventSubType}</code> v{trigger.version} ·{' '}
                      {trigger.scopes.length ? (
                        trigger.scopes.map((scope) => <code key={scope}>{scope}</code>)
                      ) : (
                        <span>no extra permission</span>
                      )}
                    </span>
                    {trigger.message && <span className="panel-hint">{trigger.message}</span>}
                  </div>
                  <div className="twitch-event-side">
                    {trigger.inUse && <span className="pill live">In use</span>}
                    <span className={`pill ${state.tone}`}>{state.text}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {configured && groups.size > 0 && (
          <div className="twitch-events-consent">
            {[...groups.entries()].map(([consent, members]) => (
              <div key={consent} className="twitch-events-grant">
                <span className="panel-hint">{CONSENT[consent]?.why}</span>
                <a
                  className={`button small${members.some((m) => m.inUse) ? ' primary' : ''}`}
                  href={authorizeHref(members.map((m) => m.name))}
                >
                  {CONSENT[consent]?.label ?? 'Allow on Twitch'} →
                </a>
              </div>
            ))}
            <p className="panel-hint">
              Twitch shows the exact permissions before you approve. Riff keeps your existing
              consent and never asks for more than these families need.
            </p>
          </div>
        )}
      </div>
    </PanelCard>
  );
}
