import { TransitionReview } from './transition-review.js';
import { sameDefinition } from '../../sessions/presentation.js';
import { useState } from 'react';
import type { Automation, ScenarioResult, Version } from '../../lib/types.js';
import { approvalLine, CODE_LABEL, shortHash, triggerSummary } from '../format.js';
import type { RegressionEvidence } from '../rehearsal/contracts.js';
import { describeCheck } from '../rehearsal/labels.js';
import './review.css';

const INTENT_BADGE: Record<string, [string, string]> = {
  match: ['✓ Matches what you said', 'good'],
  mismatch: ['✗ Differs from what you said', 'bad'],
  assumed: ['Assumed — you didn’t say', 'warn'],
  preserved: ['Kept from the live version', 'muted'],
  changed: ['Changed without being asked', 'warn'],
};

interface EvidenceProps {
  version: Version;
  automation: Automation | undefined;
  panic: boolean;
  onApprove: (version: Version, resetSession?: boolean) => Promise<void>;
  onDiscard: (version: Version) => Promise<void>;
  previewed: boolean;
  /** Requested with `!riff create|edit` from the broadcaster's chat. */
  fromChat?: boolean;
  onTransitioned?: ((message: string) => Promise<void>) | undefined;
}

export function Evidence(props: EvidenceProps) {
  const active = props.automation?.versions.find((v) => v.id === props.automation?.activeVersionId);
  // Consent belongs to this exact comparison and round; chat progress is revalidated by the host.
  const context = JSON.stringify([
    props.version.id,
    props.version.artifactId,
    props.automation?.activeVersionId,
    active?.artifactId,
    props.automation?.session?.id,
  ]);
  return <EvidenceCard key={context} {...props} />;
}

function EvidenceCard(props: EvidenceProps) {
  const { version } = props;
  const verification = version.evidence.verification;
  const passedStages = verification.stages.filter((s) => s.status === 'passed').length;
  const scenarios = [...verification.generated, ...verification.host];
  const passedScenarios = scenarios.filter((s) => s.passed).length;
  const widening = version.changes.filter((c) => c.authority === 'more');
  const [accepted, setAccepted] = useState(false);
  const [resetConsent, setResetConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = props.automation?.versions.find((v) => v.id === props.automation?.activeVersionId);
  const isLive = version.status === 'active';
  const needsReset = Boolean(
    props.automation?.session &&
    !sameDefinition(active?.manifest.experience, version.manifest.experience),
  );
  // A live round with different rules: the creator picks one path, never two at once.
  const choosable = Boolean(
    needsReset &&
    props.automation &&
    active?.manifest.experience &&
    version.manifest.experience &&
    active.id !== version.id,
  );
  const canKeep = version.progress?.kind !== 'reset-required';
  const resetReasons = version.progress?.reasons ?? [];
  const [mode, setMode] = useState<'keep' | 'fresh'>(canKeep ? 'keep' : 'fresh');
  const keeping = choosable && canKeep && mode === 'keep';
  const approvable =
    !props.panic &&
    (!needsReset || resetConsent) &&
    version.blockers.length === 0 &&
    (widening.length === 0 || accepted);

  return (
    <section className="card evidence" aria-labelledby="evidence-heading">
      <header className="card-head">
        <div>
          <p className="step-label">
            <span>2</span> Test · evidence
          </p>
          <h2 id="evidence-heading">
            {version.title} <span className="version-tag">v{version.number}</span>
            {props.fromChat && (
              <span className="badge chat-badge" title="Requested with !riff from your chat">
                From chat
              </span>
            )}
          </h2>
        </div>
      </header>

      <div className="evidence-verdict" data-ok={verification.ok}>
        <span className="evidence-verdict-icon" aria-hidden="true" />
        <div className="evidence-verdict-body">
          <span className={`pill ${verification.ok ? 'good' : 'bad'}`}>
            {verification.ok
              ? `Verified · ${passedScenarios}/${scenarios.length} checks`
              : 'Did not pass'}
          </span>
          <span className="evidence-verdict-meter" aria-hidden="true">
            {verification.stages.map((stage) => (
              <span key={stage.id} data-status={stage.status} />
            ))}
            {scenarios.length > 0 && <i />}
            {scenarios.map((result) => (
              <span
                key={`${result.origin}-${result.name}`}
                data-status={result.passed ? 'passed' : 'failed'}
              />
            ))}
          </span>
        </div>
      </div>

      <dl className="facts" aria-label="What this version does">
        <div>
          <dt>When it runs</dt>
          <dd>{version.behavior.when || triggerSummary(version.manifest)}</dd>
        </div>
        <div>
          <dt>What it does</dt>
          <dd>{version.behavior.what}</dd>
        </div>
        <div>
          <dt>Who can trigger it</dt>
          <dd>{version.behavior.who}</dd>
        </div>
        <div>
          <dt>How much it may do</dt>
          <dd>
            {version.behavior.howMuch}
            <small>
              {' '}
              · at most {version.manifest.limits.effectsPerMinute} effects/min for the channel
            </small>
          </dd>
        </div>
        <div>
          <dt>What passed</dt>
          <dd>
            {passedStages}/{verification.stages.length} pipeline stages ·{' '}
            {verification.generated.filter((s) => s.passed).length}/{verification.generated.length}{' '}
            generated tests · {verification.host.filter((s) => s.passed).length}/
            {verification.host.length} host checks
          </dd>
        </div>
      </dl>

      {(version.evidence.rehearsal ?? verification.rehearsal)?.length ? (
        <RegressionEvidenceList
          checks={version.evidence.rehearsal ?? verification.rehearsal ?? []}
        />
      ) : null}

      {version.evidence.intent.length > 0 && (
        <div className="block">
          <h3>What you asked vs. what will run</h3>
          <table className="intent-table">
            <thead>
              <tr>
                <th scope="col">Aspect</th>
                <th scope="col">You said</th>
                <th scope="col">Will run</th>
                <th scope="col">Check</th>
              </tr>
            </thead>
            <tbody>
              {version.evidence.intent.map((check) => {
                const [label, toneName] = INTENT_BADGE[check.status] ?? ['', 'muted'];
                return (
                  <tr key={check.aspect}>
                    <th scope="row">{check.label}</th>
                    <td data-label="You said">
                      {check.stated ?? <span className="muted">—</span>}
                    </td>
                    <td className="mono" data-label="Will run">
                      {check.actual}
                    </td>
                    <td className="intent-check">
                      <span className={`badge ${toneName}`}>{label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {version.assumptions.length > 0 && (
            <p className="note">Assumptions: {version.assumptions.join(' ')}</p>
          )}
        </div>
      )}

      {version.changes.length > 0 && (
        <div className="block">
          <h3>Changes from live v{active?.number ?? '?'}</h3>
          <ul className="changes">
            {version.changes.map((change) => (
              <li key={change.field} data-authority={change.authority}>
                <span className="change-label">{change.label}</span>
                <span className="mono from">{change.from}</span>
                <span aria-hidden="true">→</span>
                <span className="mono to">{change.to}</span>
                {change.authority !== 'same' && (
                  <span className={`badge ${change.authority === 'more' ? 'warn' : 'muted'}`}>
                    {change.authority === 'more' ? '↑ more authority' : '↓ narrower'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="block">
        <h3>Verification pipeline</h3>
        <ol className="pipeline">
          {verification.stages.map((stage) => (
            <li key={stage.id} data-status={stage.status} title={stage.summary}>
              <span className="pipe-dot" aria-hidden="true" />
              <span className="pipe-label">{stage.label}</span>
              <span className="pipe-meta">
                {stage.status === 'skipped' ? 'skipped' : `${stage.durationMs} ms`}
              </span>
              <span className="pipe-summary">{stage.summary}</span>
            </li>
          ))}
        </ol>
        {verification.findings.length > 0 && (
          <ul className="findings">
            {verification.findings.map((f, i) => (
              <li key={i} data-severity={f.severity}>
                <b>{f.rule}</b>
                {f.line ? ` · line ${f.line}` : ''}: {f.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {scenarios.length > 0 && (
        <details className="block scenarios">
          <summary>
            <h3>Scenario results</h3>
            <span className="muted">
              {verification.generated.length} written by the compiler · {verification.host.length}{' '}
              owned by Riff (the compiler cannot edit these)
            </span>
          </summary>
          <ScenarioList title="Generated tests" results={verification.generated} />
          <ScenarioList title="Host policy checks" results={verification.host} />
        </details>
      )}

      <details className="block code">
        <summary>
          <h3>Code &amp; permission manifest</h3>
          <span className="muted mono">artifact {shortHash(version.artifactId)}</span>
        </summary>
        <div className="code-grid">
          <div className="code-pane" data-label="Handler source">
            <pre aria-label="Handler source">
              <code>{version.source}</code>
            </pre>
          </div>
          <div className="code-pane" data-label="Permission manifest">
            <pre aria-label="Permission manifest">
              <code>{JSON.stringify(version.manifest, null, 2)}</code>
            </pre>
          </div>
        </div>
        <p className="note">
          Origin:{' '}
          {version.origin === 'codex'
            ? 'generated by Codex at runtime'
            : version.origin === 'offline'
              ? 'offline template compiler'
              : version.origin}
          {version.compileRunId ? ` · run ${version.compileRunId.slice(0, 8)}` : ''} · intent “
          {version.intent}”
        </p>
      </details>

      {version.incident && <p className="answer bad">Quarantined: {version.incident}</p>}

      <footer className="approve" aria-labelledby="approve-heading">
        <p className="step-label" id="approve-heading">
          <span>4</span> Approve
        </p>
        {version.approvedAt !== null && (
          <p className="note approved-by">{approvalLine(version.approvedBy, version.approvedAt)}</p>
        )}
        {isLive ? (
          <p className="live-note">
            <span className="live-dot" aria-hidden="true" /> This exact version is live.
          </p>
        ) : (
          <>
            {version.blockers.length > 0 && (
              <ul className="blockers">
                {version.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {widening.length > 0 && version.blockers.length === 0 && (
              <label className="confirm">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                I understand this grants more authority:{' '}
                {widening.map((c) => c.label.toLowerCase()).join(', ')}.
              </label>
            )}
            {choosable && (
              <fieldset className="progress-choice">
                <legend>A round is live. What happens to everyone’s progress?</legend>
                <div className="choice-row">
                  <label
                    className="choice-card"
                    data-selected={keeping}
                    data-disabled={!canKeep || undefined}
                  >
                    <input
                      type="radio"
                      name={`progress-${version.id}`}
                      checked={keeping}
                      disabled={!canKeep}
                      onChange={() => setMode('keep')}
                    />
                    <span>
                      <b>
                        Keep everyone’s progress{' '}
                        {canKeep && <span className="badge good">Recommended</span>}
                      </b>
                      <small>
                        Teams, scores and contributions carry over. Preview it privately first.
                      </small>
                    </span>
                  </label>
                  <label className="choice-card" data-selected={!keeping}>
                    <input
                      type="radio"
                      name={`progress-${version.id}`}
                      checked={!keeping}
                      onChange={() => setMode('fresh')}
                    />
                    <span>
                      <b>Start a fresh round</b>
                      <small>
                        Clears teams, scores, contributions, resources and time, then starts over
                        with v{version.number}’s rules.
                      </small>
                    </span>
                  </label>
                </div>
                {!canKeep && resetReasons.length > 0 && (
                  <div className="why-reset" role="note">
                    <p>Progress can’t carry over because:</p>
                    <ul>
                      {resetReasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </fieldset>
            )}
            {keeping && props.automation && (
              <TransitionReview
                key={`${version.id}:${active?.id}:${props.automation.session?.id}`}
                version={version}
                automation={props.automation}
                panic={props.panic}
                allowed={
                  !props.panic &&
                  version.blockers.length === 0 &&
                  (widening.length === 0 || accepted)
                }
                onChanged={props.onTransitioned}
              />
            )}
            {needsReset && !keeping && (
              <label className="confirm">
                <input
                  type="checkbox"
                  checked={resetConsent}
                  onChange={(e) => setResetConsent(e.target.checked)}
                />
                I agree to reset session progress, teams, scores, contributions, resources and
                remaining time. A new round starts with this version’s rules.
              </label>
            )}
            {!props.previewed && version.blockers.length === 0 && (
              <p className="note">Tip: rehearse it on the private stage before going live.</p>
            )}
            <div className="approve-actions">
              {!keeping && (
                <button
                  type="button"
                  className="button go"
                  disabled={!approvable || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      if (needsReset) await props.onApprove(version, resetConsent);
                      else await props.onApprove(version);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {active
                    ? `Approve v${version.number} & replace v${active.number}`
                    : `Approve v${version.number} & go live`}
                </button>
              )}
              {(version.status === 'candidate' || version.status === 'failed') && (
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => void props.onDiscard(version)}
                >
                  Discard
                </button>
              )}
            </div>
            {!keeping && (
              <p className="note mono">
                Approval binds to artifact {shortHash(version.artifactId)} and test report{' '}
                {shortHash(version.reportHash)}.
              </p>
            )}
          </>
        )}
      </footer>
    </section>
  );
}

function ScenarioList({ title, results }: { title: string; results: ScenarioResult[] }) {
  if (!results.length) return null;
  return (
    <div className="scenario-group">
      <h4>{title}</h4>
      <ul>
        {results.map((result) => (
          <li key={`${result.origin}-${result.name}`} data-passed={result.passed}>
            <details>
              <summary>
                <span className="tick" aria-label={result.passed ? 'passed' : 'failed'}>
                  {result.passed ? '✓' : '✗'}
                </span>
                {result.name}{' '}
                <span className="muted">
                  · {result.kind} · {result.steps.length} messages · {result.durationMs} ms
                </span>
              </summary>
              <div className="table-scroll">
                <table className="steps">
                  <thead>
                    <tr>
                      <th scope="col">At</th>
                      <th scope="col">Viewer</th>
                      <th scope="col">Message</th>
                      <th scope="col">Expected</th>
                      <th scope="col">Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.steps.map((step, i) => (
                      <tr key={i} data-passed={step.passed}>
                        <td className="mono">
                          {(step.at / 1000).toFixed(step.at % 1000 ? 3 : 0)}s
                        </td>
                        <td>
                          {step.viewer}
                          <small> {step.roles.filter((r) => r !== 'viewer').join(' ')}</small>
                        </td>
                        <td className="mono">{step.text}</td>
                        <td>
                          {CODE_LABEL[step.expect]}
                          {step.expectEffects === null ? ' (≥1)' : ` (${step.expectEffects})`}
                          {step.expectSession && (
                            <details>
                              <summary>Expected session</summary>
                              <pre aria-label="Expected session evidence">
                                {JSON.stringify(step.expectSession, null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                        <td>
                          {CODE_LABEL[step.actual]} ({step.actualEffects})
                          {step.session && (
                            <details>
                              <summary>{step.session.phase} · session evidence</summary>
                              <pre aria-label="Actual session evidence">
                                {JSON.stringify(
                                  {
                                    phase: step.session.phase,
                                    scores: step.session.scores,
                                    remainingMs: step.session.remainingMs,
                                    participants: step.session.participants,
                                  },
                                  null,
                                  2,
                                )}
                              </pre>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Saved regressions pinned for this candidate: plain verdicts first, exact record on demand. */
function RegressionEvidenceList({ checks }: { checks: RegressionEvidence[] }) {
  const failed = checks.filter((c) => !c.ok).length;
  return (
    <details className="block regression-evidence" open={failed > 0}>
      <summary>
        Saved regressions{' '}
        <span className={`badge ${failed ? 'bad' : 'good'}`}>
          {failed
            ? `${failed} of ${checks.length} failed`
            : `${checks.length} of ${checks.length} passed`}
        </span>
      </summary>
      <p className="note">
        Riff replayed every saved regression for this interaction against this exact candidate. The
        set was pinned when generation started, including any deleted since. A failure blocks
        approval.
      </p>
      {checks.map((check) => {
        const result = check.result;
        const expectations = result?.checks.filter((c) => c.category === 'expectation') ?? [];
        const safety = result?.checks.filter((c) => c.category === 'invariant') ?? [];
        return (
          <section key={check.regressionId} aria-label={`Regression ${check.regressionId}`}>
            <h3>
              <span className={`badge ${check.ok ? 'good' : 'bad'}`}>
                {check.ok ? 'Passed' : 'Failed'}
              </span>{' '}
              {result
                ? `${result.totalSteps} step${result.totalSteps === 1 ? '' : 's'} · ${expectations.filter((c) => c.status === 'passed').length} of ${expectations.length} expectations met · ${safety.filter((c) => c.status === 'passed').length} of ${safety.length} safety checks`
                : 'Could not replay'}
            </h3>
            {check.failure && <p className="answer bad">{check.failure}</p>}
            {result ? (
              <ul>
                {result.checks
                  .filter((c) => c.category === 'expectation' || c.status === 'failed')
                  .map((item) => (
                    <li key={item.id} data-tone={item.status === 'failed' ? 'bad' : 'good'}>
                      {item.status === 'passed' ? '✓' : '✗'} {describeCheck(item, result)}{' '}
                      <span className="muted">({item.summary})</span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>Independent replay unavailable; see the verification failure.</p>
            )}
            <details>
              <summary>Exact record</summary>
              <p className="mono">
                Regression {check.regressionId}
                <br />
                Origin version {check.originVersionId} · artifact{' '}
                {shortHash(check.originArtifactId)} · scenario {shortHash(check.scenarioHash)}
                {result && (
                  <>
                    <br />
                    {result.through}/{result.totalSteps} steps · seed {result.seed} ·{' '}
                    {result.provenance.kind} · evidence {shortHash(result.evidenceHash)}
                  </>
                )}
              </p>
            </details>
          </section>
        );
      })}
    </details>
  );
}
