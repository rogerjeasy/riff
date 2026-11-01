import { useState } from 'react';
import type { ProductionState } from './contracts.js';

type Kind = 'obs' | 'streamerbot';
const TOOL: Record<Kind, { name: string; url: string; where: string; found: string }> = {
  obs: {
    name: 'OBS Studio',
    url: 'ws://127.0.0.1:4455',
    where: 'OBS → Tools → WebSocket Server Settings',
    found: 'scenes',
  },
  streamerbot: {
    name: 'Streamer.bot',
    url: 'ws://127.0.0.1:8080',
    where: 'Streamer.bot → Servers/Clients → WebSocket Server',
    found: 'actions',
  },
};
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
  const connection = state.connections[kind];
  const [url, setUrl] = useState(connection.url ?? tool.url);
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const connected = connection.status === 'connected';
  const found = kind === 'obs' ? connection.scenes.length : connection.actions.length;
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
          </p>
          {connection.reason && <p className="panel-hint">{connection.reason}</p>}
          <button
            type="button"
            className="button small ghost"
            disabled={busy}
            onClick={() => void mutate('disconnect', { kind })}
          >
            Disconnect {tool.name === 'OBS Studio' ? 'OBS' : tool.name} and revoke access
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
              WebSocket endpoint
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
            <label>
              Server password
              <input
                required
                type="password"
                autoComplete="off"
                value={password}
                maxLength={500}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="panel-hint">Found in {tool.where}. Authentication must be on.</span>
            </label>
            <label className="panel-checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>Allow Riff to list {tool.found} (read-only). Nothing changes yet.</span>
            </label>
            <div className="panel-actions">
              <button className="button" disabled={!consent || !password}>
                {working ? 'Connecting…' : `Connect ${kind === 'obs' ? 'OBS' : 'Streamer.bot'}`}
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
