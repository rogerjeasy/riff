import { useEffect, useRef, type RefObject } from 'react';
import type { Decision, SessionSnapshot, Version } from '../../lib/types.js';
import { SessionHud } from '../sessions/session-hud.js';
import { explain, formatClock, shortHash, tone } from '../format.js';
import type { RehearsalResult, RehearsalRun, RehearsalScenario } from './contracts.js';
import type { ExpectationDraft } from './input-editor.js';
import { codeLabel, describeCheck, logicalClock, stepTitle, timeOf, verdict } from './labels.js';

type Frame = RehearsalResult['timeline'][number];
type Check = RehearsalResult['checks'][number];
interface Props {
  version: Version;
  versions: Version[];
  scenario: RehearsalScenario;
  run: RehearsalRun | null;
  /** Complete replay for the current exact identity, when known. */
  full: RehearsalRun | null;
  compare: string;
  freshStart: boolean;
  busy: boolean;
  canRun: boolean;
  dirty: boolean;
  cursor: number;
  playing: boolean;
  origin: string;
  setCompare: (value: string) => void;
  setFreshStart: (value: boolean) => void;
  goTo: (cursor: number) => void;
  scrubTo: (cursor: number) => void;
  play: () => void;
  pause: () => void;
  cancel: () => void;
  primaryStage: RefObject<HTMLDivElement | null>;
  compareStage: RefObject<HTMLDivElement | null>;
  onExpect: (draft: ExpectationDraft) => void;
  onFix: (focus: { checkId: string; side: 'primary' | 'compare' }) => void;
}

/** Private player: one host replay, then frame playback, step list and exact inspector. */
export function Player(props: Props) {
  const { version, versions, scenario, run, full, compare, busy, canRun, cursor, playing } = props;
  const steps = (run && !full ? run.scenario : scenario).steps;
  const total = steps.length;
  const frames: Frame[] = full?.result.timeline ?? run?.result.timeline ?? [];
  const compareFrames: Frame[] = full?.comparison?.timeline ?? run?.comparison?.timeline ?? [];
  const differences = full?.differences ?? run?.differences ?? [];
  // The best evidence for checks: a full replay, otherwise the current exact prefix.
  const evidence = full ?? run;
  const exact = run && run.result.through === cursor ? run : null;
  const frame = cursor > 0 ? frames[cursor - 1] : undefined;
  const compareFrame = cursor > 0 ? compareFrames[cursor - 1] : undefined;
  const step = cursor > 0 ? steps[cursor - 1] : undefined;
  const definition = (versions.find((v) => v.id === run?.versionId) ?? version).manifest.experience;
  const comparison = versions.find((v) => v.id === compare);
  const label = (v: Version | undefined) => (v ? `${v.title} v${v.number}` : 'Unknown version');
  const summary = evidence ? verdict(evidence.result) : null;
  const options = versions.filter((v) => v.id !== version.id && v.artifactId);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-current="step"]')
      ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [cursor]);
  const time = exact?.result.cursor.at ?? frame?.at ?? scenario.initialAt;
  const elapsed = time - scenario.initialAt;
  const decisionAt = (f: Frame | undefined) => f?.decision ?? null;
  const ready = canRun && !playing;

  return (
    <section className="player" aria-label="Scenario player">
      <div className={`player-stages ${compare ? 'split' : ''}`}>
        <StageView
          title={
            compare
              ? label(versions.find((v) => v.id === (run?.versionId ?? version.id)) ?? version)
              : null
          }
          stage={props.primaryStage}
          ariaLabel="Private current primary effects"
          frame={frame}
          session={exact?.result.cursor.session ?? null}
          clock={elapsed}
          origin={props.origin}
          teams={definition?.teams}
        />
        {compare && (
          <StageView
            title={label(comparison)}
            stage={props.compareStage}
            ariaLabel="Private current comparison effects"
            frame={compareFrame}
            session={exact?.comparison?.cursor.session ?? null}
            clock={elapsed}
            origin="Comparison"
            teams={comparison?.manifest.experience?.teams}
          />
        )}
      </div>

      <div className="transport" role="group" aria-label="Timeline controls">
        <button
          type="button"
          className="button small ghost"
          disabled={!ready}
          onClick={() => props.goTo(0)}
          title="Back to the start"
        >
          <span aria-hidden="true">⏮</span> Reset timeline
        </button>
        <button
          type="button"
          className="button small ghost"
          disabled={!ready || cursor === 0}
          onClick={() => props.goTo(cursor - 1)}
        >
          <span aria-hidden="true">◀</span> Previous step
        </button>
        {playing ? (
          <button type="button" className="button small primary play" onClick={props.pause}>
            <span aria-hidden="true">⏸</span> Pause
          </button>
        ) : (
          <button
            type="button"
            className="button small primary play"
            disabled={!canRun}
            onClick={props.play}
          >
            <span aria-hidden="true">▶</span> Play
          </button>
        )}
        <button
          type="button"
          className="button small ghost"
          disabled={!ready || cursor >= total}
          onClick={() => props.goTo(cursor + 1)}
        >
          Next step <span aria-hidden="true">▶</span>
        </button>
        <button
          type="button"
          className="button small ghost"
          disabled={!ready}
          onClick={() => props.goTo(total)}
        >
          Run to end <span aria-hidden="true">⏭</span>
        </button>
        {busy && (
          <button type="button" className="button small danger" onClick={props.cancel}>
            Cancel operation
          </button>
        )}
      </div>

      <div className="scrubber">
        <div className="track" aria-hidden="true">
          {steps.map((s, i) => {
            const d = frames[i]?.decision;
            const failed = evidence?.result.checks.some(
              (c) => c.stepKey === s.key && c.status === 'failed',
            );
            return (
              <i
                key={s.key}
                data-tone={failed ? 'bad' : d ? tone(d.code) : frames[i] ? 'muted' : 'unknown'}
                data-past={i < cursor}
                data-differs={differences.some((x) => x.through === i + 1) || undefined}
              />
            );
          })}
        </div>
        <label>
          <span className="sr-only">Timeline cursor</span>
          <input
            type="range"
            min={0}
            max={total}
            step={1}
            value={cursor}
            disabled={!canRun || props.dirty}
            aria-valuetext={cursor === 0 ? 'Start' : `Step ${cursor} of ${total}`}
            onChange={(e) => props.scrubTo(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="player-status" role="status">
        <strong>
          {busy
            ? 'Replaying privately…'
            : playing
              ? `Playing · step ${cursor} of ${total}`
              : cursor === 0
                ? `Start · ${total} step${total === 1 ? '' : 's'}`
                : `Step ${cursor} of ${total}`}
        </strong>
        <span className="mono">Logical time {logicalClock(elapsed)}</span>
        {props.dirty && total > 0 && !busy && (
          <span className="note">Play saves your inputs first</span>
        )}
      </p>

      {summary && evidence && (
        <Verdict
          summary={summary}
          scenario={evidence.scenario}
          comparison={evidence.comparison ? verdict(evidence.comparison) : null}
          onFix={props.onFix}
          differences={differences.length}
          compareLabel={label(comparison)}
        />
      )}

      {total === 0 ? (
        <div className="player-empty">
          <p>
            <strong>No steps yet.</strong> Load a preset above, import the live round, or add chat
            in “Edit inputs” below.
          </p>
        </div>
      ) : (
        <div className="player-body">
          <ol className="step-list" ref={list} aria-label="Scenario steps">
            <li aria-current={cursor === 0 ? 'step' : undefined}>
              <button
                type="button"
                disabled={!canRun}
                onClick={() => props.goTo(0)}
                aria-label="Go to start"
              >
                <span className="step-n">0</span>
                <span className="step-what">
                  {scenario.initialSession ? 'Start from recorded round' : 'Start · fresh round'}
                </span>
              </button>
            </li>
            {steps.map((s, i) => {
              const f = frames[i];
              const d = decisionAt(f);
              const checks = evidence?.result.checks.filter(
                (c) => c.stepKey === s.key && c.category === 'expectation',
              );
              const broke = evidence?.result.checks.some(
                (c) => c.stepKey === s.key && c.category === 'invariant' && c.status === 'failed',
              );
              const differs = differences.find((x) => x.through === i + 1);
              return (
                <li
                  key={s.key}
                  aria-current={cursor === i + 1 ? 'step' : undefined}
                  data-future={i >= cursor || undefined}
                >
                  <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => props.goTo(i + 1)}
                    aria-label={`Go to step ${i + 1}: ${stepTitle(s)}`}
                  >
                    <span className="step-n">{i + 1}</span>
                    <span className="step-what">
                      {stepTitle(s)}
                      <small className="mono">{logicalClock(timeOf(s) - scenario.initialAt)}</small>
                    </span>
                    <span className="step-tags">
                      {d && (
                        <span className={`badge ${tone(d.code)}`}>
                          {codeLabel(d.code, Boolean(definition))}
                        </span>
                      )}
                      {!d && f && (
                        <span className="badge muted">
                          {s.kind === 'chat' ? 'No decision' : 'Host'}
                        </span>
                      )}
                      {checks?.map((c) => (
                        <span
                          key={c.id}
                          className={`check-dot ${c.status}`}
                          title={describeCheck(c, scenario)}
                        >
                          {c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '○'}
                        </span>
                      ))}
                      {broke && <span className="badge bad">Unsafe</span>}
                      {differs && (
                        <span
                          className="badge warn"
                          title="Outcome differs in the comparison version"
                        >
                          Differs
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <section className="inspector" aria-label="Cursor inspector">
            <h3>
              {cursor === 0 ? 'At the start' : `Step ${cursor}`}
              {step && (
                <span className="note"> · {logicalClock(timeOf(step) - scenario.initialAt)}</span>
              )}
            </h3>
            {step ? (
              <p className="inspector-input">
                {stepTitle(step)}
                {step.kind === 'chat' && <small> · roles {step.event.roles.join(', ')}</small>}
              </p>
            ) : (
              <p className="inspector-input">
                {scenario.initialSession
                  ? 'Recorded starting state, before any step.'
                  : 'Fresh round at the logical origin, before any step.'}
              </p>
            )}
            <Outcome
              decision={exact?.result.cursor.decision ?? decisionAt(frame)}
              text={step?.kind === 'chat' ? step.event.text : ''}
              version={version}
              known={Boolean(exact || frame)}
            />
            {compare && cursor > 0 && (
              <div className="compare-outcome">
                <h4>{label(comparison)}</h4>
                <Outcome
                  decision={exact?.comparison?.cursor.decision ?? decisionAt(compareFrame)}
                  text={step?.kind === 'chat' ? step.event.text : ''}
                  version={comparison ?? version}
                  known={Boolean(exact?.comparison || compareFrame)}
                />
              </div>
            )}
            {step && evidence && (
              <StepChecks
                checks={evidence.result.checks.filter(
                  (c) => c.stepKey === step.key && c.category === 'expectation',
                )}
                scenario={evidence.scenario}
              />
            )}
            {step && (
              <button
                type="button"
                className="button small ghost"
                onClick={() =>
                  props.onExpect({
                    stepKey: step.key,
                    kind: step.kind === 'chat' ? 'decision' : definition ? 'phase' : 'effects',
                    value:
                      step.kind === 'chat'
                        ? ((exact?.result.cursor.decision ?? decisionAt(frame))?.code ?? 'ACCEPTED')
                        : definition
                          ? (exact?.result.cursor.session?.phase ??
                            frame?.summary?.phase ??
                            'running')
                          : '0',
                    n: Date.now(),
                  })
                }
              >
                + Expect an outcome here
              </button>
            )}
            {exact ? (
              <>
                {definition && exact.result.cursor.session && (
                  <SessionHud
                    definition={definition}
                    snapshot={exact.result.cursor.session}
                    now={exact.result.cursor.at}
                    label="Primary cursor session"
                  />
                )}
                <StateView session={exact.result.cursor.session} />
                {exact.comparison && (
                  <details className="compare-state">
                    <summary>{label(comparison)} state</summary>
                    <StateView session={exact.comparison.cursor.session} />
                  </details>
                )}
              </>
            ) : (
              frame?.summary && (
                <p className="note">
                  Scores and phase shown on the stage. Pause or choose a step to see every viewer’s
                  resources.
                </p>
              )
            )}
          </section>
        </div>
      )}

      <details className="studio-compare" open={Boolean(compare)}>
        <summary>
          Compare with another version
          {compare ? <span className="badge warn">{label(comparison)}</span> : null}
        </summary>
        <fieldset disabled={busy} className="rehearsal-grid">
          <legend className="sr-only">Same inputs and seed, synchronized cursors</legend>
          <label>
            Compare version
            <select value={compare} onChange={(e) => props.setCompare(e.target.value)}>
              <option value="">No comparison</option>
              {options.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.title} v{v.number}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={props.freshStart}
              onChange={(e) => props.setFreshStart(e.target.checked)}
            />
            Fresh start for both versions
          </label>
        </fieldset>
        <p className="note">
          Both versions replay the same inputs and seed, step by step. Not migration approval
          evidence: keeping a live round’s progress is reviewed separately in step 4. A pinned
          snapshot must fit both versions when fresh start is off.
        </p>
        {options.length === 0 && <p className="note">No other version to compare yet.</p>}
      </details>

      {evidence && (
        <p className="evidence-line mono">
          {evidence.result.status} · seed {evidence.result.seed} · artifact{' '}
          {shortHash(evidence.result.artifactId)} · scenario{' '}
          {shortHash(evidence.result.scenarioHash)} · evidence{' '}
          {shortHash(evidence.result.evidenceHash)} ·{' '}
          {evidence.freshStart ? 'fresh-start replay' : 'pinned scenario origin'} ·{' '}
          {evidence.result.provenance.kind}
        </p>
      )}
    </section>
  );
}

function StageView(props: {
  title: string | null;
  stage: RefObject<HTMLDivElement | null>;
  ariaLabel: string;
  frame: Frame | undefined;
  session: SessionSnapshot | null;
  clock: number;
  origin: string;
  teams?: { id: string; label: string }[] | undefined;
}) {
  const name = (id: string) => props.teams?.find((t) => t.id === id)?.label ?? id;
  const scores = props.session?.scores ?? props.frame?.summary?.scores;
  const phase = props.session?.phase ?? props.frame?.summary?.phase;
  const remaining = props.session?.remainingMs ?? props.frame?.summary?.remainingMs;
  const winner = props.session?.winner ?? props.frame?.summary?.winner ?? null;
  return (
    <div className="player-stage">
      {props.title && <h4>{props.title}</h4>}
      <div className="stage-frame">
        <div
          ref={props.stage}
          className="stage interactive-stage"
          role="img"
          aria-label={props.ariaLabel}
        >
          <div className="stage-cam" aria-hidden="true">
            <span>Your camera</span>
          </div>
        </div>
        <div className="stage-hud" aria-hidden="true">
          <span className="mono">⏱ {logicalClock(props.clock)}</span>
          <span>{props.origin}</span>
        </div>
        {scores && (
          <div className="stage-score" aria-label="Round score at this step">
            {Object.entries(scores).map(([team, score]) => (
              <span key={team}>
                {name(team)} <strong>{score}</strong>
              </span>
            ))}
            {phase === 'finished' ? (
              <span className="badge muted">
                {winner === 'tie' ? 'Tie' : winner ? `${name(winner)} wins` : 'Finished'}
              </span>
            ) : phase === 'paused' ? (
              <span className="badge warn">Paused</span>
            ) : remaining !== undefined ? (
              <span className="mono">{formatClock(remaining)} left</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Outcome(props: {
  decision: Decision | null;
  text: string;
  version: Version;
  known: boolean;
}) {
  const d = props.decision;
  if (!props.known) return <p className="note">Replay this step to see what the host decided.</p>;
  if (!d) return <p className="outcome muted">No chat decision at this step.</p>;
  const a = d.allowance;
  return (
    <div className="outcome">
      <p>
        <span className={`badge ${tone(d.code)}`}>
          {codeLabel(d.code, Boolean(props.version.manifest.experience))}
        </span>{' '}
        {explain(d, props.text, d.viewerId ?? 'viewer', props.version.manifest)}
      </p>
      <p className="note">
        {d.effects.length
          ? `${d.effects.length} effect${d.effects.length === 1 ? '' : 's'} on stage (${d.effects.map((e) => e.asset).join(', ')})`
          : 'Nothing shown on stage'}
        {/* Stateless outcomes already explain the allowance in the sentence above. */}
        {a && (props.version.manifest.experience || !['ACCEPTED', 'VIEWER_LIMIT'].includes(d.code))
          ? ` · allowance ${a.used} of ${a.max} used`
          : ''}
        {' · '}
        <span className="mono">{d.code}</span>
      </p>
    </div>
  );
}

function StepChecks({ checks, scenario }: { checks: Check[]; scenario: RehearsalScenario }) {
  if (!checks.length) return null;
  return (
    <ul className="step-checks" aria-label="Expectations at this step">
      {checks.map((c) => (
        <li
          key={c.id}
          data-tone={c.status === 'failed' ? 'bad' : c.status === 'passed' ? 'good' : 'muted'}
        >
          {c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '○'}{' '}
          {describeCheck(c, scenario)}
        </li>
      ))}
    </ul>
  );
}

function Verdict(props: {
  summary: ReturnType<typeof verdict>;
  scenario: RehearsalScenario;
  comparison: ReturnType<typeof verdict> | null;
  onFix: Props['onFix'];
  differences: number;
  compareLabel: string;
}) {
  const { summary } = props;
  const failures = [
    ...summary.failures.map((c) => ({ c, side: 'primary' as const })),
    ...(props.comparison?.failures ?? []).map((c) => ({ c, side: 'compare' as const })),
  ];
  return (
    <section
      className={`verdict ${failures.length ? 'bad' : summary.tone}`}
      aria-label="Rehearsal result"
    >
      <p className="verdict-title">
        <span aria-hidden="true">
          {failures.length ? '✗' : summary.tone === 'good' ? '✓' : '…'}
        </span>{' '}
        {failures.length && !summary.failures.length
          ? `${props.compareLabel}: ${failures.length} check${failures.length === 1 ? '' : 's'} failed`
          : summary.title}
      </p>
      <p className="note">
        {summary.expectations.total
          ? `${summary.expectations.passed} of ${summary.expectations.total} expectations met · `
          : ''}
        {summary.safety.passed} of {summary.safety.total} host safety checks passed
        {props.comparison
          ? ` · ${props.differences} ${props.differences === 1 ? 'step differs' : 'steps differ'} from ${props.compareLabel}`
          : ''}
      </p>
      {failures.length > 0 && (
        <ul>
          {failures.slice(0, 5).map(({ c, side }) => (
            <li key={`${side}:${c.id}`}>
              <span>
                {side === 'compare' ? `${props.compareLabel}: ` : ''}
                {describeCheck(c, props.scenario)}
              </span>
              <button
                type="button"
                className="button small"
                onClick={() => props.onFix({ checkId: c.id, side })}
              >
                Fix this failure
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StateView({ session }: { session: SessionSnapshot | null }) {
  if (!session) return null;
  const people = Object.entries(session.participants);
  return (
    <details className="state-view">
      <summary>
        Viewer resources · {people.length} participant{people.length === 1 ? '' : 's'}
      </summary>
      <p className="note">
        Phase {session.phase} · revision {session.revision} · {formatClock(session.remainingMs)}{' '}
        left · winner {session.winner ?? 'none'}
      </p>
      <table>
        <caption className="sr-only">Cursor participant resources</caption>
        <thead>
          <tr>
            <th>Viewer</th>
            <th>Team</th>
            <th>Left</th>
            <th>Used</th>
          </tr>
        </thead>
        <tbody>
          {people.map(([id, p]) => (
            <tr key={id}>
              <th>{id}</th>
              <td>{p.teamId ?? 'community'}</td>
              <td>{p.remaining}</td>
              <td>{p.contributions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
