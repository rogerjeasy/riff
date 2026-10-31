import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type {
  Automation,
  SessionSnapshot,
  Transition,
  TransitionBoundary,
  Version,
} from '../../lib/types.js';

const BOUNDARIES = {
  immediate: 'Immediately',
  'round-end': 'When this round finishes',
  stopped: 'While already paused',
};

/** Approval always echoes the exact private evidence, never a captured live snapshot. */
export function TransitionReview(props: {
  version: Version;
  automation: Automation;
  panic: boolean;
  allowed: boolean;
  onChanged?: (() => Promise<void>) | undefined;
}) {
  const { version, automation } = props;
  const [boundary, setBoundary] = useState<TransitionBoundary>('immediate');
  const [source, setSource] = useState(version.evidence.migration?.source ?? '');
  const [proof, setProof] = useState<{ key: string; row: Transition } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selection = JSON.stringify([
    version.id,
    version.artifactId,
    automation.activeVersionId,
    automation.session?.id,
    boundary,
    source,
    props.panic,
  ]);
  const selectionEpoch = useRef({ selection, epoch: 0 });
  if (selectionEpoch.current.selection !== selection)
    selectionEpoch.current = { selection, epoch: selectionEpoch.current.epoch + 1 };
  const key = JSON.stringify([selection, selectionEpoch.current.epoch]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reviewed = proof?.key === key ? proof.row : null;
  const stale = proof !== null && proof.key !== key;
  const stoppedBlocked = boundary === 'stopped' && automation.session?.phase !== 'paused';
  const cancelled = automation.transitions?.some(
    (t) => t.id === reviewed?.id && t.status === 'cancelled',
  );
  const fail = (error: unknown) =>
    setMessage(
      error instanceof ApiError
        ? error.message
        : 'This review could not finish. Preview again before approving.',
    );
  const preview = async () => {
    setBusy(true);
    setProof(null);
    setMessage('');
    try {
      const row = await api.previewTransition(version.id, boundary, source || undefined);
      if (!mounted.current) return;
      if (currentKey.current !== key) {
        setMessage('The version, source or timing changed during preview. Preview again.');
        return;
      }
      if (
        row.targetVersionId !== version.id ||
        row.sourceVersionId !== automation.activeVersionId ||
        row.sourceSessionId !== automation.session?.id ||
        row.plan.boundary !== boundary ||
        (source && row.migrationSource !== source)
      ) {
        setMessage('The returned evidence does not match this selection. Preview again.');
        return;
      }
      setProof({ key, row });
    } catch (error) {
      if (mounted.current) fail(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="block transition-review" aria-label="Keep live progress">
      <h3>{version.approvedAt ? 'Review rollback from current progress' : 'Keep live progress'}</h3>
      <p className="note">
        Preview how this version treats current teams, scores, resources and time. Accepted chat
        during review stays; Riff checks the latest progress again when applying.
      </p>
      <label className="confirm">
        When this change takes effect{' '}
        <select
          value={boundary}
          onChange={(e) => setBoundary(e.target.value as TransitionBoundary)}
        >
          {Object.entries(BOUNDARIES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="note">
        While already paused requires you to pause this interaction first and leaves it paused.
        Round-end does not start another round.
      </p>
      <details className="code">
        <summary>Separate migration source</summary>
        <label>
          Migration source (optional)
          <textarea
            className="mono"
            rows={7}
            maxLength={32768}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <p className="note">
          Leave empty to review the server’s preserving migration for older versions. Exact source
          is shown with the preview.
        </p>
      </details>
      <button
        type="button"
        className="button small"
        disabled={busy || props.panic || version.blockers.length > 0}
        onClick={() => void preview()}
      >
        {busy ? 'Checking transition…' : 'Preview keeping progress'}
      </button>
      {stoppedBlocked && (
        <p className="note">Pause this interaction before approving this timing.</p>
      )}
      {stale && (
        <p role="alert">The version, source or timing changed. Preview again before approving.</p>
      )}
      {message && (
        <p role="status" className="note">
          {message}
        </p>
      )}
      {reviewed && (
        <>
          <dl className="facts" aria-label="Reviewed transition">
            <div>
              <dt>Preserved</dt>
              <dd>{reviewed.evidence.preserved.join(', ')}</dd>
            </div>
            <div>
              <dt>Changed</dt>
              <dd>
                {reviewed.evidence.changed
                  .filter((c) => c.field !== 'source' && c.field !== 'experience')
                  .map((c) => `${c.label}: ${c.from} → ${c.to}`)
                  .join('; ') || 'Session rules shown below'}
              </dd>
            </div>
            <div>
              <dt>Reset</dt>
              <dd>{reviewed.evidence.reset.join(', ') || 'Nothing'}</dd>
            </div>
            <div>
              <dt>Takes effect</dt>
              <dd>{BOUNDARIES[reviewed.evidence.takesEffect]}</dd>
            </div>
          </dl>
          <RulesComparison transition={reviewed} />
          <StateComparison
            before={reviewed.evidence.migration.before}
            after={reviewed.evidence.migration.after}
            label="Current progress after migration"
          />
          <h4>Hypothetical future chat · private comparison</h4>
          <p className="note">
            Synthetic inputs, not recorded live history. {reviewed.evidence.comparison.label}. Both
            versions receive the same messages and random seed; no effects reach chat or the live
            overlay.
          </p>
          <table className="intent-table">
            <thead>
              <tr>
                <th>Message</th>
                <th>Live version</th>
                <th>Selected version</th>
              </tr>
            </thead>
            <tbody>
              {reviewed.evidence.comparison.steps.map((step) => (
                <tr key={step.eventId}>
                  <th scope="row">
                    {reviewed.evidence.comparison.events.find((e) => e.id === step.eventId)?.text ??
                      step.eventId}
                  </th>
                  <td>
                    {step.before.code}: {step.before.reason} · {step.before.effects.length} effects
                  </td>
                  <td>
                    {step.after.code}: {step.after.reason} · {step.after.effects.length} effects
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <StateComparison
            before={reviewed.evidence.comparison.before}
            after={reviewed.evidence.comparison.after}
            label="Progress after hypothetical chat"
          />
          <details className="code">
            <summary>Exact reviewed migration source</summary>
            <pre aria-label="Reviewed migration source">
              <code>{reviewed.migrationSource}</code>
            </pre>
            <p className="note mono">Evidence {reviewed.evidenceId}</p>
          </details>
          {cancelled && <p role="alert">This review was cancelled. Preview again.</p>}
          {reviewed.status === 'review' && !cancelled && (
            <button
              type="button"
              className="button go"
              disabled={busy || !props.allowed || props.panic || stoppedBlocked}
              onClick={async () => {
                if (currentKey.current !== proof?.key) return;
                setBusy(true);
                setMessage('');
                try {
                  const result = await api.approveTransition(reviewed);
                  setProof(null);
                  setMessage(
                    result.status === 'pending'
                      ? 'Approved for round-end. You can cancel it in the live panel.'
                      : 'Applied. Current progress was preserved.',
                  );
                  await props.onChanged?.();
                } catch (error) {
                  setProof(null);
                  fail(error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Approve reviewed change
            </button>
          )}
        </>
      )}
    </section>
  );
}

function RulesComparison({ transition: t }: { transition: Transition }) {
  const a = t.evidence.beforeRules,
    b = t.evidence.afterRules;
  const rules = (r: typeof a) => [
    r.definition.contribution.command,
    r.audience.join(', '),
    `${r.definition.resource.perParticipant} ${r.definition.resource.name}`,
    `${r.definition.contribution.points} points; ${r.definition.objective.kind}${r.definition.objective.target === null ? '' : `, target ${r.definition.objective.target}`}`,
    `${r.definition.durationMs / 1000} seconds`,
    r.definition.teams.map((team) => `${team.label} (${team.joinCommand})`).join(', ') ||
      'Community',
  ];
  return (
    <table className="intent-table" aria-label="Before and after rules">
      <thead>
        <tr>
          <th>Rule</th>
          <th>Live</th>
          <th>Selected</th>
        </tr>
      </thead>
      <tbody>
        {['Command', 'Audience', 'Resource allowance', 'Scoring', 'Timer', 'Teams'].map(
          (label, i) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{rules(a)[i]}</td>
              <td>{rules(b)[i]}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
function StateComparison({
  before,
  after,
  label,
}: {
  before: SessionSnapshot;
  after: SessionSnapshot;
  label: string;
}) {
  return (
    <details open className="block">
      <summary>{label}</summary>
      <p className="note">
        Scores: {JSON.stringify(before.scores)} → {JSON.stringify(after.scores)} · Phase:{' '}
        {before.phase} → {after.phase} · Remaining time: {before.remainingMs} → {after.remainingMs}{' '}
        ms
      </p>
      <table className="intent-table">
        <thead>
          <tr>
            <th>Participant</th>
            <th>Team</th>
            <th>Contributions</th>
            <th>Resources left</th>
          </tr>
        </thead>
        <tbody>
          {[
            ...new Set([...Object.keys(before.participants), ...Object.keys(after.participants)]),
          ].map((id) => (
            <tr key={id}>
              <th scope="row">{id}</th>
              <td>
                {before.participants[id]
                  ? (before.participants[id].teamId ?? 'Community')
                  : 'Absent'}{' '}
                →{' '}
                {after.participants[id] ? (after.participants[id].teamId ?? 'Community') : 'Absent'}
              </td>
              <td>
                {before.participants[id]?.contributions ?? 'Absent'} →{' '}
                {after.participants[id]?.contributions ?? 'Absent'}
              </td>
              <td>
                {before.participants[id]?.remaining ?? 'Absent'} →{' '}
                {after.participants[id]?.remaining ?? 'Absent'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
