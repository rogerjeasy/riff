import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../lib/api.js';
import { useStudio } from '../lib/use-studio.js';
import { StopControl } from '../console/app.js';
import { SignIn } from '../console/sign-in.js';
import { ago, tone } from '../console/format.js';
import '../styles/studio.css';

/** OBS custom dock: stop, pause and incidents stay one click away during a show. */
function Dock() {
  const { studio, connection, signedOut } = useStudio();
  const [message, setMessage] = useState<string | null>(null);
  const notify = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 4000);
  }, []);
  if (signedOut && !studio) return <SignIn compact />;
  if (!studio)
    return (
      <main className="dock">
        <h1>Riff control dock</h1>
        <p role="status">Connecting…</p>
      </main>
    );
  return (
    <main className="dock">
      <header className="dock-head">
        <h1>Riff control dock</h1>
        <span
          className={`pill ${studio.panic ? 'bad' : connection === 'online' ? 'good' : 'muted'}`}
          role="status"
        >
          {studio.panic ? 'Stopped' : connection === 'online' ? 'Connected' : 'Reconnecting'}
        </span>
      </header>
      <StopControl studio={studio} notify={notify} compact />
      <ul className="dock-list">
        {studio.automations
          .filter((a) => a.activeVersionId)
          .map((a) => (
            <li key={a.id}>
              <span>{a.title}</span>
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
      <ol className="feed compact" aria-label="Recent activity">
        {studio.activity.slice(0, 6).map((entry) => (
          <li key={entry.id}>
            <span className={`badge ${tone(entry.code)}`}>{entry.code ?? entry.kind}</span>
            <span>{entry.message}</span>
            <time className="muted">{ago(entry.at)}</time>
          </li>
        ))}
      </ol>
      {message && (
        <p className="toast good" role="status">
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
