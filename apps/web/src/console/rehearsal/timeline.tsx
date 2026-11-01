import type { RefObject } from 'react';
import type { SessionSnapshot, Version } from '../../lib/types.js';
import { SessionHud } from '../sessions/session-hud.js';
import { shortHash } from '../format.js';
import type { RehearsalRun, RehearsalScenario, RehearsalStep } from './contracts.js';
const timeOf = (step: RehearsalStep) => (step.kind === 'chat' ? step.event.at : step.at);
const caption = (step: RehearsalStep) =>
  step.kind === 'chat' ? `${step.event.viewerId}: ${step.event.text}` : step.kind;
interface Props {
  version: Version;
  versions: Version[];
  scenario: RehearsalScenario;
  run: RehearsalRun | null;
  compare: string;
  freshStart: boolean;
  busy: boolean;
  ready: boolean;
  cursor: number;
  playing: boolean;
  setCompare: (value: string) => void;
  setFreshStart: (value: boolean) => void;
  invalidate: () => void;
  seek: (cursor: number) => void;
  cancel: () => void;
  setPlaying: (value: boolean) => void;
  primaryStage: RefObject<HTMLDivElement | null>;
  compareStage: RefObject<HTMLDivElement | null>;
}
export function Timeline({
  version,
  versions,
  scenario,
  run,
  compare,
  freshStart,
  busy,
  ready,
  cursor,
  playing,
  setCompare,
  setFreshStart,
  invalidate,
  seek,
  cancel,
  setPlaying,
  primaryStage,
  compareStage,
}: Props) {
  const inspected = run?.result;
  const definition = (versions.find((v) => v.id === run?.versionId) ?? version).manifest.experience;
  const selectedStep = (run?.scenario ?? scenario).steps[Math.max(0, cursor - 1)];
  const selectedComparison = versions.find((v) => v.id === compare);
  const versionLabel = (id: string) => {
    const v = versions.find((v) => v.id === id);
    return v ? `${v.title} v${v.number}` : id;
  };
  return (
    <>
      <details>
        <summary>Compare two versions</summary>
        <fieldset disabled={busy} className="rehearsal-grid">
          <legend>Same inputs and seed, synchronized cursors</legend>
          <label>
            Compare version
            <select
              value={compare}
              onChange={(e) => {
                invalidate();
                setCompare(e.target.value);
              }}
            >
              <option value="">Primary only</option>
              {versions
                .filter((v) => v.id !== version.id && v.artifactId)
                .map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.title} v{v.number}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={freshStart}
              onChange={(e) => {
                invalidate();
                setFreshStart(e.target.checked);
              }}
            />
            Fresh start for both versions
          </label>
          <p className="note">
            Not migration approval evidence. A pinned snapshot must validate against both versions
            when fresh start is off.
          </p>
          {versions.filter((v) => v.id !== version.id && v.artifactId).length === 0 && (
            <p>No other executable version is available.</p>
          )}
        </fieldset>
      </details>
      <div className="rehearsal-actions" role="group" aria-label="Timeline controls">
        <button
          className="button small"
          disabled={!ready || !scenario.steps.length}
          onClick={() => setPlaying(true)}
        >
          Play
        </button>
        <button className="button small" disabled={!playing} onClick={cancel}>
          Pause
        </button>
        <button
          className="button small"
          disabled={!ready || cursor === 0}
          onClick={() => {
            setPlaying(false);
            seek(cursor - 1);
          }}
        >
          Previous step
        </button>
        <button
          className="button small"
          disabled={!ready || cursor >= scenario.steps.length}
          onClick={() => {
            setPlaying(false);
            seek(cursor + 1);
          }}
        >
          Next step
        </button>
        <button
          className="button small"
          disabled={!ready}
          onClick={() => {
            setPlaying(false);
            seek(0);
          }}
        >
          Reset timeline
        </button>
        <button
          className="button small"
          disabled={!ready || !scenario.steps.length}
          onClick={() => {
            setPlaying(false);
            seek(scenario.steps.length);
          }}
        >
          Run to end
        </button>
        {busy && (
          <button className="button small" onClick={cancel}>
            Cancel operation
          </button>
        )}
      </div>
      <label>
        Timeline cursor
        <input
          type="range"
          min={0}
          max={scenario.steps.length}
          step={1}
          value={cursor}
          disabled={!ready}
          onChange={(e) => {
            setPlaying(false);
            seek(Number(e.target.value));
          }}
        />
      </label>
      <p role="status">
        {busy
          ? 'Running private operation…'
          : playing
            ? 'Playing'
            : `Cursor ${cursor} / ${scenario.steps.length}`}{' '}
        · Logical time: {inspected?.cursor.at ?? scenario.initialAt} ms
      </p>
      <div className="rehearsal-grid rehearsal-stages">
        <div>
          <h3>Primary · {versionLabel(run?.versionId ?? version.id)}</h3>
          <div
            ref={primaryStage}
            className="stage interactive-stage"
            role="img"
            aria-label="Private current primary effects"
          />
        </div>
        {compare && (
          <div>
            <h3>
              Comparison · {selectedComparison?.title} v{selectedComparison?.number}
            </h3>
            <div
              ref={compareStage}
              className="stage interactive-stage"
              role="img"
              aria-label="Private current comparison effects"
            />
          </div>
        )}
      </div>
      {inspected && (
        <>
          <p className="mono">
            {inspected.status} · seed {inspected.seed} · artifact {shortHash(inspected.artifactId)}{' '}
            · scenario {shortHash(inspected.scenarioHash)} · evidence{' '}
            {shortHash(inspected.evidenceHash)}
          </p>
          <p>
            {run?.freshStart ? 'Fresh-start replay' : 'Pinned scenario origin'} ·{' '}
            {inspected.provenance.kind}
          </p>
          <section aria-label="Cursor inspector">
            <h3>Current input and host state</h3>
            <p>
              {cursor === 0
                ? 'Initial origin'
                : selectedStep
                  ? `${caption(selectedStep)} · input time ${timeOf(selectedStep)} ms`
                  : 'Regression inputs'}
              {selectedStep?.kind === 'chat'
                ? ` · roles ${selectedStep.event.roles.join(', ')}`
                : ''}
            </p>
            <DecisionView result={inspected} />
            {definition && inspected.cursor.session && (
              <SessionHud
                definition={definition}
                snapshot={inspected.cursor.session}
                now={inspected.cursor.at}
                label="Primary cursor session"
              />
            )}
            <StateView session={inspected.cursor.session} />
          </section>
          <Checks result={inspected} />
          {run?.comparison && (
            <section aria-label="Comparison inspector">
              <h3>Comparison result · {run.comparison.status}</h3>
              <DecisionView result={run.comparison} />
              <StateView session={run.comparison.cursor.session} />
              <Checks result={run.comparison} />
              <p>
                {run.differences.length} differing frames at synchronized cursor {cursor}.
              </p>
              <ul>
                {run.differences.map((d) => (
                  <li key={d.key}>
                    Step {d.through}: {d.decision ? 'decision ' : ''}
                    {d.effects ? 'effects ' : ''}
                    {d.state ? 'state' : ''} differ
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
function DecisionView({ result }: { result: RehearsalRun['result'] }) {
  const d = result.cursor.decision;
  return (
    <>
      <p>{d ? `${d.code}: ${d.reason}` : 'No chat decision at this cursor.'}</p>
      {d?.allowance && (
        <p>
          Allowance: {d.allowance.used} / {d.allowance.max}, window {d.allowance.windowMs} ms, next{' '}
          {d.allowance.nextAt ?? 'none'}.
        </p>
      )}
      <p>
        Current effects: {d?.effects.length ?? 0} · state digest{' '}
        {shortHash(result.cursor.stateDigest)}
      </p>
    </>
  );
}
function StateView({ session }: { session: SessionSnapshot | null }) {
  return session ? (
    <>
      <p>
        Phase: {session.phase} · revision {session.revision} · remaining {session.remainingMs} ms ·
        winner {session.winner ?? 'none'}
      </p>
      <p>
        Scores:{' '}
        {Object.entries(session.scores)
          .map(([team, score]) => `${team}: ${score}`)
          .join(', ')}
      </p>
      <table>
        <caption>Cursor participant resources</caption>
        <thead>
          <tr>
            <th>Viewer</th>
            <th>Team</th>
            <th>Remaining</th>
            <th>Contributions</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(session.participants).map(([id, p]) => (
            <tr key={id}>
              <th>{id}</th>
              <td>{p.teamId ?? 'community'}</td>
              <td>{p.remaining}</td>
              <td>{p.contributions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  ) : (
    <p>Stateless interaction: no gameplay session.</p>
  );
}
function Checks({ result }: { result: RehearsalRun['result'] }) {
  return (
    <section aria-label="Rehearsal checks">
      <h3>Current checks</h3>
      {!result.checks.length && <p>No explicit or automatic checks at this cursor.</p>}
      <ul>
        {result.checks.map((c) => (
          <li
            key={c.id}
            data-tone={c.status === 'failed' ? 'bad' : c.status === 'passed' ? 'good' : 'muted'}
          >
            <strong>
              {c.category === 'invariant' ? 'Host invariant' : 'Creator expectation'} · {c.status}
            </strong>
            : {c.summary}{' '}
            <span className="mono">
              {c.id} · expected {String(c.expected)}, actual {String(c.actual)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
