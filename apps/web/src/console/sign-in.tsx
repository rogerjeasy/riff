import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import './sign-in.css';

/** Hosted console sign-in. The server issues an HttpOnly session cookie; we just reload. */
export function SignIn({
  compact = false,
  onSignedIn = () => location.reload(),
}: {
  compact?: boolean;
  /** Called once a session exists; reloading re-initialises every live connection. */
  onSignedIn?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A private sign-in link (?access=…) normally never reaches this screen: the server trades
  // it for a session before serving the page. When a dev server sits in front, redeem it
  // here instead, then remove the token from the address either way.
  useEffect(() => {
    const url = new URL(location.href);
    const token = url.searchParams.get('access');
    if (!token) return;
    url.searchParams.delete('access');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    void fetch(`/api/session?access=${encodeURIComponent(token)}`, { credentials: 'same-origin' })
      .then(() => api.session())
      .then((session) => {
        if (session.authenticated) onSignedIn();
        else setError('That sign-in link is no longer valid. Ask your Riff host for a new one.');
      })
      .catch(() => setError('Couldn’t reach your studio. Check your connection and try again.'));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      await api.login(password);
      onSignedIn();
    } catch (cause) {
      setPending(false);
      setError(
        cause instanceof ApiError && cause.status > 0
          ? cause.message
          : 'Couldn’t reach your studio. Check your connection and try again.',
      );
    }
  }
  return (
    <main className={`sign-in${compact ? ' compact' : ''}`}>
      <form className="sign-in-card" onSubmit={(e) => void submit(e)} noValidate>
        <span className="brand" aria-hidden="true">
          riff<span>.</span>
        </span>
        <div className="sign-in-heading">
          <h1>{compact ? 'Sign in to the dock' : 'Sign in to your studio'}</h1>
          <p className="sign-in-host">{location.host}</p>
        </div>
        <label className="sign-in-field">
          Password
          <span className="sign-in-input">
            <input
              type={visible ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              autoFocus
              spellCheck={false}
              value={password}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="sign-in-reveal"
              aria-pressed={visible}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>
        {error && (
          <p id="sign-in-error" role="alert" className="sign-in-error">
            {error}
          </p>
        )}
        <button className="button primary sign-in-submit" disabled={!password || pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="sign-in-note">
          {compact
            ? 'Tip: add this dock with your private sign-in link and it will stay signed in.'
            : 'Your Riff host gave you this password. In OBS, use your private sign-in link for the dock instead.'}
        </p>
      </form>
    </main>
  );
}
