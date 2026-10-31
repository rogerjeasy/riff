import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type { ExperienceDefinition, SessionAudit, SessionSnapshot } from '../../lib/types.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Proves the live scoreboard: the host replays this round's journal in a private
 * engine and compares every decision and the stored result. Read-only by design.
 */
export function RoundAudit(props: {
  automationId: string;
  definition: ExperienceDefinition;
  session: SessionSnapshot;
}) {
  const [result, setResult] = useState<{ audit: SessionAudit; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audit = result?.audit.sessionId === props.session.id ? result.audit : null;
  const stale = audit !== null && result?.revision !== props.session.revision;
  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult({
        audit: await api.auditSession(props.automationId),
        revision: props.session.revision,
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not reach the server to verify.');
    } finally {
      setBusy(false);
    }
  }
  const resource = props.definition.resource.name;
  return (
    <div className="round-audit">
      <button
        type="button"
        className="button small ghost"
        onClick={() => void run()}
        disabled={busy}
        aria-describedby={`audit-${props.automationId}`}
      >
        {busy ? 'Verifying…' : audit ? 'Verify again' : 'Verify round'}
      </button>
      <p
        id={`audit-${props.automationId}`}
        className="audit-result"
        data-status={error ? 'error' : (audit?.status ?? 'idle')}
        role="status"
      >
        {error ??
          (!audit ? (
            'Replays every recorded join, throw and clock change privately and checks the score.'
          ) : audit.status === 'verified' ? (
            <>
              <b>✓ Score verified.</b> {plural(audit.joins, 'join')},{' '}
              {plural(audit.contributions, resource.replace(/s$/, ''), resource)},{' '}
              {plural(audit.rejections, 'blocked attempt')} and{' '}
              {plural(audit.controls, 'clock change')} replayed privately in{' '}
              {audit.durationMs < 1 ? 'under 1 ms' : `${audit.durationMs} ms`}; scores, resources
              and outcome match exactly.
              {stale && ' The round has moved on since — verify again for the latest state.'}
            </>
          ) : audit.status === 'diverged' ? (
            <>
              <b>⚠ The stored round does not match its journal.</b> {audit.summary} Pause this
              interaction and reset the round before relying on the result.
            </>
          ) : (
            audit.summary
          ))}
      </p>
    </div>
  );
}
