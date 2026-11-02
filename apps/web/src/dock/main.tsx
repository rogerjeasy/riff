// Base design system first; component stylesheets layer on top of it.
import '../styles/studio.css';
import { DockReviews } from './reviews.js';
import '../console/production/production.css';
import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../lib/api.js';
import { useStudio } from '../lib/use-studio.js';
import { StopControl } from '../console/app.js';
import { SignIn } from '../console/sign-in.js';
import { ago, tone } from '../console/format.js';
import './dock.css';

/** OBS custom dock: stop, pause and incidents stay one click away during a show. */
function Dock() {
  const { studio, connection, signedOut, refresh } = useStudio();
  const [message, setMessage] = useState<string | null>(null);
  const notify = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 4000);
  }, []);
  if (signedOut && !studio) return <SignIn compact />;
  if (!studio)
    return (
      <main className="dock dock-connecting">
        <header className="dock-head">
          <span className="dock-mark" aria-hidden="true" />
          <h1>Riff control dock</h1>
        </header>
        <p role="status" className="dock-connecting-status">
          Connecting…
        </p>
      </main>
    );
  const live = studio.automations.filter((a) => a.activeVersionId);
  return (
    <main className="dock" data-panic={studio.panic || undefined}>
      <div className="dock-top">
        <header className="dock-head">
          <span className="dock-mark" aria-hidden="true" />
          <h1>Riff control dock</h1>
          <span
            className={`pill dock-connection ${studio.panic ? 'bad' : connection === 'online' ? 'good' : 'muted'}`}
            role="status"
          >
            {studio.panic ? 'Stopped' : connection === 'online' ? 'Connected' : 'Reconnecting'}
          </span>
        </header>
        <StopControl studio={studio} notify={notify} compact />
      </div>
      <section className="dock-section" aria-labelledby="dock-interactions">
        <h2 id="dock-interactions" className="dock-label">
          Interactions <span className="dock-count">{live.length}</span>
        </h2>
        <ul className="dock-list">
          {live.map((a) => (
            <li key={a.id} data-status={a.status}>
              <span className="dock-dot" aria-hidden="true" />
              <span className="dock-title">{a.title}</span>
              {a.status === 'live' ? (
                <button
                  type="button"
                  className="button small ghost"
                  onClick={() =>
                    void api.automation(a.id, 'pause').then(() => notify(`Paused ${a.title}`))
                  }
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  className="button small"
                  onClick={() =>
                    void api.automation(a.id, 'resume').then(
                      () => notify(`Resumed ${a.title}`),
                      () => notify('Cannot resume this version'),
                    )
                  }
                >
                  Resume
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <DockReviews
        automations={studio.automations}
        panic={studio.panic}
        refresh={refresh}
        notify={notify}
      />
      <section className="dock-section" aria-labelledby="dock-activity">
        <h2 id="dock-activity" className="dock-label">
          Activity
        </h2>
        <ol className="feed compact dock-feed" aria-label="Recent activity">
          {studio.activity.slice(0, 6).map((entry) => (
            <li key={entry.id} data-tone={tone(entry.code)}>
              <span className={`badge ${tone(entry.code)}`}>{entry.code ?? entry.kind}</span>
              <span className="dock-feed-message">{entry.message}</span>
              <time className="muted">{ago(entry.at)}</time>
            </li>
          ))}
        </ol>
      </section>
      <a className="dock-viewer-link" href="/participate" target="_blank" rel="noreferrer">
        Open viewer instructions ↗
      </a>
      {message && (
        <p className="toast good dock-toast" role="status">
          {message}
        </p>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing dock root');
createRoot(root).render(
  <StrictMode>
    <Dock />
  </StrictMode>,
);
