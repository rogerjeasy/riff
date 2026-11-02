import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type {
  Automation,
  DecisionCode,
  ExperienceDefinition,
  Role,
  SessionParticipant,
  SessionSnapshot,
  Transition,
  TransitionBoundary,
  Version,
} from '../../lib/types.js';
import { audienceLabel, CODE_LABEL, formatClock, tone } from '../format.js';

export const BOUNDARIES: Record<TransitionBoundary, { label: string; hint: string; cta: string }> =
  {
    immediate: {
      label: 'Right now',
      hint: 'Applies on approval. Chat keeps playing; Riff re-checks the latest progress first.',
      cta: 'Apply now and keep progress',
    },
    'round-end': {
      label: 'When this round ends',
      hint: 'Waits for the current round to finish. It does not start another round.',
      cta: 'Schedule for round end',
    },
    stopped: {
      label: 'While paused',
      hint: 'Only while this interaction is paused. It stays paused until you resume it.',
      cta: 'Apply while paused',
    },
  };

const KEPT: Record<string, string> = {
  identity: 'Same round',
  participants: 'Players',
  teams: 'Teams',
  scores: 'Scores',
  contributions: 'Contributions',
  phase: 'Round state',
  time: 'Round clock',
};
const DECISION: Record<string, string> = { ...CODE_LABEL, ACCEPTED: 'Accepted' };
const PHASE: Record<SessionSnapshot['phase'], string> = {
  running: 'running',
  paused: 'paused',
  finished: 'finished',
};
const PLAYER_ROWS = 12;

/** Approval always echoes the exact private evidence, never a captured live snapshot. */
export function TransitionReview(props: {
  version: Version;
  automation: Automation;
  panic: boolean;
  allowed: boolean;
  onChanged?: ((message: string) => Promise<void>) | undefined;
}) {
  const { version, automation } = props;
  const [boundary, setBoundary] = useState<TransitionBoundary>('immediate');
  const [source, setSource] = useState(version.evidence.migration?.source ?? '');
  const [proof, setProof] = useState<{ key: string; row: Transition } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'approve' | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null);
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
  const paused = automation.session?.phase === 'paused';
  const stoppedBlocked = boundary === 'stopped' && !paused;
  const closed = automation.transitions?.find(
    (t) => t.id === reviewed?.id && (t.status === 'cancelled' || t.status === 'applied'),
  );
  const activeNumber = automation.versions.find((v) => v.id === automation.activeVersionId)?.number;
  const fail = (error: unknown) =>
    setMessage({
      tone: 'bad',
      text:
        error instanceof ApiError
          ? error.message
          : 'This review could not finish. Preview again before approving.',
    });
  const preview = async () => {
    setBusy('preview');
    setProof(null);
    setMessage(null);
    try {
      const row = await api.previewTransition(version.id, boundary, source || undefined);
      if (!mounted.current) return;
      if (currentKey.current !== key) {
        setMessage({
          tone: 'bad',
          text: 'The version, source or timing changed during preview. Preview again.',
        });
        return;
      }
      if (
        row.targetVersionId !== version.id ||
        row.sourceVersionId !== automation.activeVersionId ||
        row.sourceSessionId !== automation.session?.id ||
        row.plan.boundary !== boundary ||
        (source && row.migrationSource !== source)
      ) {
        setMessage({
          tone: 'bad',
          text: 'The returned evidence does not match this selection. Preview again.',
        });
        return;
      }
      setProof({ key, row });
    } catch (error) {
      if (mounted.current) fail(error);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const approve = async () => {
    if (!reviewed || currentKey.current !== proof?.key) return;
    setBusy('approve');
    setMessage(null);
    try {
      const result = await api.approveTransition(reviewed, version.reportHash);
      setProof(null);
      const text =
        result.status === 'pending'
          ? `Scheduled. v${version.number} takes over when this round ends; cancel it any time from the live panel.`
          : `Applied. v${version.number} is live and everyone kept their progress.`;
      setMessage({ tone: 'good', text });
      // Applying makes this version live, which replaces this card; the app toast persists.
      await props.onChanged?.(text);
    } catch (error) {
      setProof(null);
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="transition-review"
      aria-label="Keep live progress"
      aria-busy={busy !== null}
    >
      <h3>
        {version.approvedAt
          ? `Roll back to v${version.number} and keep progress`
          : 'Preview the change privately'}
      </h3>
      <p className="note">
        Riff carries current teams, scores and contributions into v{version.number}, then rehearses
        both versions side by side. Nothing reaches chat or your overlay until you approve.
      </p>

      <fieldset className="tr-boundary">
        <legend>When this change takes effect</legend>
        <div className="choice-row">
          {(Object.keys(BOUNDARIES) as TransitionBoundary[]).map((value) => (
            <label key={value} className="choice-card compact" data-selected={boundary === value}>
              <input
                type="radio"
                name={`boundary-${version.id}`}
                value={value}
                checked={boundary === value}
                onChange={() => setBoundary(value)}
              />
              <span>
                <b>{BOUNDARIES[value].label}</b>
                <small>{BOUNDARIES[value].hint}</small>
              </span>
            </label>
          ))}
        </div>
        {stoppedBlocked && (
          <p className="note warn-text">Pause this interaction before approving this timing.</p>
        )}
      </fieldset>

      <div className="tr-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy !== null || props.panic || version.blockers.length > 0}
          onClick={() => void preview()}
        >
          {busy === 'preview' ? 'Rehearsing privately…' : 'Preview keeping progress'}
        </button>
        {!reviewed && !busy && (
          <span className="muted small">
            Takes a moment: the migration runs in an isolated worker.
          </span>
        )}
      </div>

      {stale && (
        <p role="alert" className="tr-result bad">
          The version, source or timing changed. Preview again before approving.
        </p>
      )}
      {message && (
        <p role="status" className={`tr-result ${message.tone}`}>
          {message.text}
        </p>
      )}

      {reviewed && (
        <div className="tr-evidence">
          <Summary transition={reviewed} />
          <RulesComparison
            transition={reviewed}
            activeNumber={activeNumber}
            next={version.number}
          />
          <ProgressPanel
            title="Everyone’s progress"
            caption="Live progress now → after the change"
            before={reviewed.evidence.migration.before}
            after={reviewed.evidence.migration.after}
            definition={reviewed.evidence.afterRules.definition}
            open
          />
          <Rehearsal transition={reviewed} activeNumber={activeNumber} next={version.number} />
          {closed && (
            <p role="alert" className="tr-result bad">
              This review is no longer open ({closed.status}). Preview again.
            </p>
          )}
          {reviewed.status === 'review' && !closed && (
            <div className="tr-approve">
              <button
                type="button"
                className="button go"
                disabled={busy !== null || !props.allowed || props.panic || stoppedBlocked}
                onClick={() => void approve()}
              >
                {busy === 'approve' ? 'Applying…' : BOUNDARIES[reviewed.plan.boundary].cta}
              </button>
              {!props.allowed && !props.panic && (
                <span className="small warn-text" role="note">
                  Confirm the authority change above to enable approval.
                </span>
              )}
              {stoppedBlocked && props.allowed && (
                <span className="small warn-text" role="note">
                  Pause the interaction to enable this timing.
                </span>
              )}
              <span className="muted small">
                Approval binds evidence{' '}
                <span className="mono">{reviewed.evidenceId.slice(0, 8)}</span> to this exact round.
                If chat moves on, Riff re-runs the checks on the latest progress.
              </span>
            </div>
          )}
        </div>
      )}

      <details className="tr-advanced">
        <summary>Advanced · migration code</summary>
        <label>
          Migration source (optional)
          <textarea
            className="mono"
            rows={6}
            maxLength={32768}
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <p className="note">
          Leave empty to use the host’s preserving migration. Whatever runs here, Riff checks the
          result independently and rejects anything that changes kept progress.
        </p>
        {reviewed && (
          <>
            <pre aria-label="Reviewed migration source">
              <code>{reviewed.migrationSource}</code>
            </pre>
            <p className="note mono">Evidence {reviewed.evidenceId}</p>
          </>
        )}
      </details>
    </section>
  );
}

interface Rule {
  label: string;
  before: string;
  after: string;
}
function describeRules(
  a: { definition: ExperienceDefinition; audience: string[] },
  b: { definition: ExperienceDefinition; audience: string[] },
): Rule[] {
  const fmt = (r: typeof a): [string, string][] => {
    const d = r.definition;
    const audience = audienceLabel(r.audience as Role[]);
    return [
      ['Command', d.contribution.command],
      ['Who can play', capitalize(audience)],
      [`${capitalize(d.resource.name)} per player`, String(d.resource.perParticipant)],
      [
        'Scoring',
        `${d.contribution.points} ${d.contribution.points === 1 ? 'point' : 'points'} per ${d.contribution.command}`,
      ],
      [
        'Goal',
        d.objective.kind === 'collective-goal'
          ? `Community reaches ${d.objective.target ?? '?'}`
          : 'Highest team score wins',
      ],
      ['Round length', formatClock(d.durationMs)],
      [
        'Teams',
        d.teams.length
          ? d.teams.map((t) => `${t.label} (${t.joinCommand})`).join(' · ')
          : 'Everyone together',
      ],
      ['Max players', String(d.maxParticipants)],
    ];
  };
  // Rows align by position; the resource may be renamed, so label by the new rules.
  const before = fmt(a);
  return fmt(b).map(([label, after], i) => ({ label, before: before[i]?.[1] ?? '—', after }));
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Summary({ transition: t }: { transition: Transition }) {
  const rules = describeRules(t.evidence.beforeRules, t.evidence.afterRules).filter(
    (r) => r.before !== r.after,
  );
  return (
    <dl className="tr-summary" aria-label="Reviewed transition">
      <div data-tone="good">
        <dt>Kept</dt>
        <dd>
          {t.evidence.preserved.map((p) => (
            <span key={p} className="tr-chip good">
              ✓ {KEPT[p] ?? p}
            </span>
          ))}
        </dd>
      </div>
      <div data-tone="accent">
        <dt>Changes</dt>
        <dd>
          {rules.length
            ? rules.map((r) => (
                <span key={r.label} className="tr-chip accent">
                  {r.label}: <s>{r.before}</s> → <b>{r.after}</b>
                </span>
              ))
            : 'Handler only; session rules are identical'}
        </dd>
      </div>
      <div>
        <dt>Reset</dt>
        <dd>{t.evidence.reset.length ? t.evidence.reset.join(', ') : 'Nothing'}</dd>
      </div>
      <div>
        <dt>Takes effect</dt>
        <dd>{BOUNDARIES[t.evidence.takesEffect].label}</dd>
      </div>
    </dl>
  );
}

function RulesComparison(props: {
  transition: Transition;
  activeNumber: number | undefined;
  next: number;
}) {
  const rows = describeRules(
    props.transition.evidence.beforeRules,
    props.transition.evidence.afterRules,
  );
  return (
    <div className="tr-block">
      <h4>Rules</h4>
      <table className="intent-table tr-rules" aria-label="Before and after rules">
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Live v{props.activeNumber ?? '?'}</th>
            <th scope="col">New v{props.next}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const changed = r.before !== r.after;
            return (
              <tr key={r.label} data-changed={changed || undefined}>
                <th scope="row">{r.label}</th>
                <td className={changed ? 'from' : undefined}>{r.before}</td>
                <td>
                  {r.after}
                  {changed && <span className="badge warn">changed</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Rehearsal(props: {
  transition: Transition;
  activeNumber: number | undefined;
  next: number;
}) {
  const c = props.transition.evidence.comparison;
  const text = (id: string) => c.events.find((e) => e.id === id)?.text ?? id;
  const cell = (d: { code: string; reason: string; effects: unknown[] }) => (
    <td title={d.reason}>
      <span className={`badge ${tone(d.code)}`}>{DECISION[d.code as DecisionCode] ?? d.code}</span>
      {d.effects.length > 0 && (
        <span className="muted small">
          {' '}
          · {d.effects.length} {d.effects.length === 1 ? 'effect' : 'effects'}
        </span>
      )}
      <span className="tr-reason">{d.reason}</span>
    </td>
  );
  return (
    <div className="tr-block">
      <h4>Private rehearsal · same chat, both versions</h4>
      <p className="note">
        Synthetic inputs, not recorded live history. Both versions receive the same messages and
        random seed; no effects reach chat or the live overlay.
        {c.resumedPrivately &&
          ' The round is paused, so Riff resumed private copies to show how each version would answer.'}
      </p>
      <table className="intent-table tr-rehearsal">
        <thead>
          <tr>
            <th scope="col">Chat message</th>
            <th scope="col">Live v{props.activeNumber ?? '?'}</th>
            <th scope="col">New v{props.next}</th>
          </tr>
        </thead>
        <tbody>
          {c.steps.map((step) => (
            <tr key={step.eventId}>
              <th scope="row" className="mono">
                {text(step.eventId)}
              </th>
              {cell(step.before)}
              {cell(step.after)}
            </tr>
          ))}
        </tbody>
      </table>
      <ProgressPanel
        title="Progress after this rehearsal"
        caption={`Each cell: live v${props.activeNumber ?? '?'} → new v${props.next}`}
        before={c.before}
        after={c.after}
        definition={props.transition.evidence.afterRules.definition}
      />
    </div>
  );
}

function ProgressPanel(props: {
  title: string;
  caption: string;
  before: SessionSnapshot;
  after: SessionSnapshot;
  definition: ExperienceDefinition;
  open?: boolean;
}) {
  const { before, after, definition } = props;
  const [all, setAll] = useState(false);
  const team = (p: SessionParticipant | undefined) =>
    p
      ? p.teamId === null
        ? 'Community'
        : (definition.teams.find((t) => t.id === p.teamId)?.label ?? p.teamId)
      : 'Not joined';
  const ids = [
    ...new Set([...Object.keys(before.participants), ...Object.keys(after.participants)]),
  ].sort((a, b) => a.localeCompare(b));
  const shown = all ? ids : ids.slice(0, PLAYER_ROWS);
  const teams = [...new Set([...Object.keys(before.scores), ...Object.keys(after.scores)])];
  const teamLabel = (id: string) =>
    definition.teams.find((t) => t.id === id)?.label ?? capitalize(id);
  return (
    <details className="tr-progress" open={props.open}>
      <summary>
        {props.title}
        <span className="muted small">
          {' '}
          · {ids.length} {ids.length === 1 ? 'player' : 'players'}
        </span>
      </summary>
      <div className="tr-scoreboard">
        {teams.map((id) => (
          <span key={id} className="score-chip">
            <span className="muted">{teamLabel(id)}</span>{' '}
            <Delta from={before.scores[id]} to={after.scores[id]} />
          </span>
        ))}
        <span className="score-chip">
          <span className="muted">Clock</span>{' '}
          {before.remainingMs === after.remainingMs
            ? formatClock(after.remainingMs)
            : `${formatClock(before.remainingMs)} → ${formatClock(after.remainingMs)}`}{' '}
          <span className="muted small">
            {before.phase === after.phase
              ? PHASE[after.phase]
              : `${PHASE[before.phase]} → ${PHASE[after.phase]}`}
          </span>
        </span>
      </div>
      {ids.length > 0 ? (
        <table className="intent-table tr-players">
          <caption className="muted small">{props.caption}</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Team</th>
              <th scope="col">Contributions</th>
              <th scope="col">{capitalize(definition.resource.name)} left</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((id) => {
              const a = before.participants[id],
                b = after.participants[id];
              return (
                <tr key={id}>
                  <th scope="row">{id}</th>
                  <td>{team(a) === team(b) ? team(b) : `${team(a)} → ${team(b)}`}</td>
                  <td>
                    <Delta from={a?.contributions} to={b?.contributions} />
                  </td>
                  <td>
                    <Delta from={a?.remaining} to={b?.remaining} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="note">Nobody has joined this round yet.</p>
      )}
      {ids.length > PLAYER_ROWS && (
        <button type="button" className="button small ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer players' : `Show all ${ids.length} players`}
        </button>
      )}
    </details>
  );
}

function Delta({ from, to }: { from: number | undefined; to: number | undefined }) {
  if (from === to) return <>{to ?? '—'}</>;
  const text = `${from ?? 'Not joined'} → ${to ?? 'Not joined'}`;
  if (from === undefined || to === undefined) return <>{text}</>;
  const d = to - from;
  return (
    <>
      {text} <span className={`badge ${d > 0 ? 'good' : 'bad'}`}>{d > 0 ? `+${d}` : d}</span>
    </>
  );
}
