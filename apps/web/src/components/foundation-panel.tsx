import { useEffect, useState } from 'react';
import { fetchHealth } from '../lib/health.js';

const messages = {
  checking: 'Checking local host…',
  ready: 'Local host ready',
  unavailable: 'Local host unavailable',
};

export function FoundationPanel({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<keyof typeof messages>('checking');
  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal).then(
      () => {
        if (!controller.signal.aborted) setStatus('ready');
      },
      () => {
        if (!controller.signal.aborted) setStatus('unavailable');
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className={compact ? 'studio studio-compact' : 'studio'}>
      <header className="brand-row">
        <span className="brand">
          riff<span aria-hidden="true">.</span>
        </span>
        <span className="badge">Project foundation</span>
      </header>
      <div className="intro">
        <p className="eyebrow">Invent it together.</p>
        <h1>{compact ? 'Riff control dock' : 'Your next live idea starts here.'}</h1>
        <p className="description">A home for the interactions your community imagines.</p>
      </div>
      <section className="status-card" aria-labelledby="status-heading">
        <h2 id="status-heading">Workspace status</h2>
        <p role="status" className="host-status">
          <span className={`status-dot status-${status}`} aria-hidden="true" />
          {messages[status]}
        </p>
        <p className="muted">Live connections and automation controls are not configured yet.</p>
        {status === 'unavailable' && <p>Start the local server, then refresh this page.</p>}
      </section>
      {!compact && (
        <nav aria-label="Development surfaces">
          <a href="/dock/">
            Open control dock <span aria-hidden="true">↗</span>
          </a>
          <a href="/overlay/">
            Open transparent overlay <span aria-hidden="true">↗</span>
          </a>
        </nav>
      )}
    </main>
  );
}
