import { useId, useState } from 'react';
import type { ProductionState } from './contracts.js';

type Kind = 'obs' | 'streamerbot' | 'firebot';
interface Tool {
  name: string;
  short: string;
  url: string;
  endpoint: string;
  secret: string;
  hint: string;
  found: string;
  consent: string;
}
const TOOL: Record<Kind, Tool> = {
  obs: {
    name: 'OBS Studio',
    short: 'OBS',
    url: 'ws://127.0.0.1:4455',
    endpoint: 'WebSocket endpoint',
    secret: 'Server password',
    hint: 'Found in OBS → Tools → WebSocket Server Settings. Authentication must be on.',
    found: 'scenes',
    consent: 'Allow Riff to list scenes (read-only). Nothing changes yet.',
  },
  streamerbot: {
    name: 'Streamer.bot',
    short: 'Streamer.bot',
    url: 'ws://127.0.0.1:8080',
    endpoint: 'WebSocket endpoint',
    secret: 'Server password',
    hint: 'Found in Streamer.bot → Servers/Clients → WebSocket Server. Authentication must be on.',
    found: 'actions',
    consent: 'Allow Riff to list actions (read-only). Nothing changes yet.',
  },
  firebot: {
    name: 'Firebot',
    short: 'Firebot',
    url: 'http://127.0.0.1:7472',
    endpoint: 'Firebot address',
    secret: 'Riff event key',
    hint: 'Firebot’s local API has no password, so only local or private-network addresses work. Put this same key in each “Send Custom WebSocket Event” as riff.key; Riff ignores Firebot events without it and never stores it.',
    found: 'preset lists and variables',
    consent:
      'Allow Riff to list preset effect lists, custom variables and commands (read-only). Nothing runs yet.',
  },
};
/** A random URL-safe key for authenticating Firebot events (never sent anywhere but Riff). */
function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const TONE = {
  connected: 'good',
  connecting: 'warn',
  error: 'bad',
  disconnected: 'muted',
} as const;
const LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  error: 'Needs attention',
  disconnected: 'Not connected',
} as const;

/** One production tool: authenticate with explicit discovery consent, or revoke access. */
export function Connector({
  kind,
  state,
  busy,
  panic,
  mutate,
}: {
  kind: Kind;
  state: ProductionState;
  busy: boolean;
  panic: boolean;
  mutate: (path: string, body: unknown) => Promise<boolean>;
}) {
  const tool = TOOL[kind];
  const ids = useId();
  const connection = state.connections[kind];
  const [url, setUrl] = useState(connection.url ?? tool.url);
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const connected = connection.status === 'connected';
  const found = kind === 'obs' ? connection.scenes.length : connection.actions.length;
  const firebot = kind === 'firebot';
  const keyTooShort = firebot && password.length > 0 && password.length < 12;
  const blocker = panic
    ? 'Resume from the emergency stop to connect.'
    : !state.configured
      ? 'Set RIFF_SECRET on the server first; passwords are never stored unencrypted.'
      : null;
  return (
    <article
      className="production-connector"
      aria-label={tool.name}
      data-status={connection.status}
    >
      <header>
        <h3>{tool.name}</h3>
        <span className={`badge ${TONE[connection.status]}`}>{LABEL[connection.status]}</span>
      </header>
      {connected ? (
        <>
          <p className="panel-hint">
            <code>{connection.url}</code> · discovered {found} {tool.found}
            {connection.commands ? ` · ${connection.commands.length} commands` : ''}
          </p>
          {connection.reason && <p className="panel-hint">{connection.reason}</p>}
          <button
            type="button"
            className="button small ghost"
            disabled={busy}
            onClick={() => void mutate('disconnect', { kind })}
          >
            Disconnect {tool.short} and revoke access
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setWorking(true);
            void mutate('connect', { kind, url, password, discover: true }).finally(() => {
              setPassword('');
              setWorking(false);
            });
          }}
        >
          <fieldset disabled={busy || !!blocker}>
            <legend className="sr-only">Connect {tool.name}</legend>
            <label>
              {tool.endpoint}
              <input
                required
                type="url"
                inputMode="url"
                spellCheck={false}
                value={url}
                maxLength={300}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <div className="production-field">
              <label htmlFor={`${ids}-secret`}>{tool.secret}</label>
              <span className={firebot ? 'production-key' : undefined}>
                <input
                  id={`${ids}-secret`}
                  required
                  type={firebot ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  minLength={firebot ? 12 : undefined}
                  value={password}
                  maxLength={500}
                  aria-invalid={keyTooShort || undefined}
                  aria-describedby={`${ids}-hint`}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {firebot && (
                  <button
                    type="button"
                    className="button small ghost"
                    onClick={() => setPassword(generateKey())}
                  >
                    Generate key
                  </button>
                )}
              </span>
              <span id={`${ids}-hint`} className={keyTooShort ? 'panel-problem' : 'panel-hint'}>
                {keyTooShort ? 'Use at least 12 characters. ' : ''}
                {tool.hint}
              </span>
            </div>
            <label className="panel-checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>{tool.consent}</span>
            </label>
            <div className="panel-actions">
              <button className="button" disabled={!consent || !password || keyTooShort}>
                {working ? 'Connecting…' : `Connect ${tool.short}`}
              </button>
            </div>
          </fieldset>
          {(blocker ?? connection.reason) && (
            <p className={connection.status === 'error' ? 'panel-problem' : 'panel-hint'}>
              {blocker ?? connection.reason}
            </p>
          )}
        </form>
      )}
    </article>
  );
}
