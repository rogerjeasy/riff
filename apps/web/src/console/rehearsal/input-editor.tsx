import { useEffect, useRef, useState } from 'react';
import type { Role, Version } from '../../lib/types.js';
import {
  decisionCodes,
  scenarioSchema,
  type Expectation,
  type RehearsalScenario,
  type RehearsalStep,
} from './contracts.js';
import { codeLabel, describeExpectation, logicalClock, stepTitle, timeOf } from './labels.js';

const roles: Role[] = ['viewer', 'subscriber', 'moderator', 'broadcaster'];
const KINDS: { kind: Expectation['kind']; label: string }[] = [
  { kind: 'decision', label: 'Host outcome' },
  { kind: 'effects', label: 'Effects on stage' },
  { kind: 'phase', label: 'Round phase' },
  { kind: 'score', label: 'Team score' },
  { kind: 'remaining', label: 'Viewer resources left' },
];
/** A pre-filled expectation requested from the player inspector. */
export interface ExpectationDraft {
  stepKey: string;
  kind: Expectation['kind'];
  value: string;
  n: number;
}
export function InputEditor({
  scenario,
  version,
  busy,
  edit,
  onError: setError,
  draft,
}: {
  scenario: RehearsalScenario;
  version: Version;
  busy: boolean;
  edit: (value: RehearsalScenario) => void;
  onError: (message: string) => void;
  draft?: ExpectationDraft | null;
}) {
  const [viewer, setViewer] = useState('alice');
  const [viewerRoles, setViewerRoles] = useState<Role[]>(['viewer']);
  const [chat, setChat] = useState(version.manifest.trigger.command);
  const [delay, setDelay] = useState(1000);
  const [control, setControl] = useState<'advance' | 'pause' | 'resume'>('advance');
  const [target, setTarget] = useState('');
  const [expectKind, setExpectKind] = useState<Expectation['kind']>('effects');
  const [expected, setExpected] = useState('1');
  const [subject, setSubject] = useState('community');
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLDetailsElement>(null);
  const valueField = useRef<HTMLSelectElement & HTMLInputElement>(null);
  const nextKey = useRef(0);
  const stateful = Boolean(version.manifest.experience);
  const commands = [
    version.manifest.trigger.command,
    ...(version.manifest.experience?.teams.map((t) => t.joinCommand) ?? []),
  ];
  const viewers = [
    ...new Set(scenario.steps.flatMap((s) => (s.kind === 'chat' ? [s.event.viewerId] : []))),
  ];
  useEffect(() => {
    if (!draft) return;
    setTarget(draft.stepKey);
    setExpectKind(draft.kind);
    setExpected(draft.value);
    setOpen(true);
    requestAnimationFrame(() => {
      section.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      valueField.current?.focus();
    });
  }, [draft]);
  function uniqueKey() {
    let key: string;
    do {
      key = `step_${++nextKey.current}`;
    } while (scenario.steps.some((s) => s.key === key));
    return key;
  }
  function uniqueDeliveryId() {
    let id: string;
    do {
      id = `event_${uniqueKey()}`;
    } while (scenario.steps.some((step) => step.kind === 'chat' && step.event.id === id));
    return id;
  }
  const highTime = Math.max(scenario.initialAt, ...scenario.steps.map(timeOf));
  function addChat(duplicate = false) {
    const last = [...scenario.steps].reverse().find((s) => s.kind === 'chat');
    const step: RehearsalStep =
      duplicate && last?.kind === 'chat'
        ? { ...last, key: uniqueKey(), event: { ...last.event, at: highTime + delay } }
        : {
            kind: 'chat',
            key: uniqueKey(),
            event: {
              id: uniqueDeliveryId(),
              channelId: 'rehearsal',
              viewerId: viewer,
              roles: viewerRoles,
              text: chat,
              at: highTime + delay,
            },
          };
    edit({ ...scenario, steps: [...scenario.steps, step] });
    setTarget(step.key);
  }
  function addExpectation() {
    const stepKey = target || scenario.steps.at(-1)?.key;
    if (!stepKey) return;
    let value: Expectation;
    const base = { id: `check_${Date.now()}_${scenario.expectations.length}`, stepKey };
    switch (expectKind) {
      case 'decision':
        value = { ...base, kind: expectKind, value: expected as (typeof decisionCodes)[number] };
        break;
      case 'phase':
        value = { ...base, kind: expectKind, value: expected as 'running' | 'paused' | 'finished' };
        break;
      case 'score':
        value = { ...base, kind: expectKind, teamId: subject, value: Number(expected) };
        break;
      case 'remaining':
        value = { ...base, kind: expectKind, viewerId: subject, value: Number(expected) };
        break;
      default:
        value = { ...base, kind: 'effects', value: Number(expected) };
    }
    const next = { ...scenario, expectations: [...scenario.expectations, value] };
    const check = scenarioSchema.safeParse(next);
    if (!check.success) {
      setError('That expectation is outside the supported range.');
      return;
    }
    edit(next);
  }
  const full = scenario.steps.length >= 120;
  return (
    <details
      className="studio-edit"
      ref={section}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        Edit inputs
        <span className="note">
          {' '}
          · {scenario.steps.length} step{scenario.steps.length === 1 ? '' : 's'} ·{' '}
          {scenario.expectations.length} expectation{scenario.expectations.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="edit-columns">
        <section aria-label="Add steps">
          <h4>Add a step</h4>
          <fieldset disabled={busy || full} className="rehearsal-grid">
            <legend className="sr-only">Supported normalized synthetic inputs</legend>
            <label>
              Viewer identity
              <input
                value={viewer}
                maxLength={80}
                list="rehearsal-viewers"
                onChange={(e) => setViewer(e.target.value)}
              />
              <datalist id="rehearsal-viewers">
                {viewers.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
            <label>
              Injected chat
              <input
                value={chat}
                maxLength={500}
                list="rehearsal-commands"
                onChange={(e) => setChat(e.target.value)}
              />
              <datalist id="rehearsal-commands">
                {commands.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <div className="rehearsal-roles" role="group" aria-label="Viewer roles">
              {roles.map((role) => (
                <label key={role} className="chip-check">
                  <input
                    type="checkbox"
                    aria-label={`${role} role`}
                    checked={viewerRoles.includes(role)}
                    onChange={(e) =>
                      setViewerRoles((current) =>
                        e.target.checked ? [...current, role] : current.filter((x) => x !== role),
                      )
                    }
                  />
                  {role}
                </label>
              ))}
            </div>
            <label>
              Time after the last step (ms)
              <input
                type="number"
                min={0}
                step={100}
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
              />
            </label>
            <div className="edit-actions">
              <button
                type="button"
                className="button small primary"
                disabled={
                  !viewer ||
                  !viewerRoles.length ||
                  !chat ||
                  !Number.isSafeInteger(delay) ||
                  delay < 0
                }
                onClick={() => addChat()}
              >
                Add chat step
              </button>
              <button
                type="button"
                className="button small"
                disabled={!scenario.steps.some((s) => s.kind === 'chat') || delay < 0}
                title="Twitch can deliver the same message twice; the host must count it once"
                onClick={() => addChat(true)}
              >
                Duplicate last delivery
              </button>
            </div>
            <label>
              Host control
              <select
                value={control}
                onChange={(e) => setControl(e.target.value as typeof control)}
              >
                <option value="advance">Move the clock forward</option>
                <option value="pause" disabled={!stateful}>
                  Pause the round
                </option>
                <option value="resume" disabled={!stateful}>
                  Resume the round
                </option>
              </select>
            </label>
            <button
              type="button"
              className="button small"
              disabled={!Number.isSafeInteger(delay) || delay < 0}
              onClick={() => {
                const step: RehearsalStep = {
                  kind: control,
                  key: uniqueKey(),
                  at: highTime + delay,
                };
                edit({ ...scenario, steps: [...scenario.steps, step] });
                setTarget(step.key);
              }}
            >
              Add control step
            </button>
          </fieldset>
          {full && <p className="note">This scenario has the maximum of 120 steps.</p>}
          {scenario.steps.length > 0 && (
            <ol className="rehearsal-inputs" aria-label="Editable steps">
              {scenario.steps.map((step, index) => (
                <li key={step.key}>
                  <details>
                    <summary>
                      <span className="step-n">{index + 1}</span> {stepTitle(step)}{' '}
                      <small className="mono">
                        {logicalClock(timeOf(step) - scenario.initialAt)}
                      </small>
                    </summary>
                    <fieldset disabled={busy} className="rehearsal-grid">
                      <legend className="sr-only">Step {index + 1}</legend>
                      <label>
                        Step {index + 1} time
                        <input
                          type="number"
                          min={0}
                          value={timeOf(step)}
                          onChange={(e) =>
                            edit({
                              ...scenario,
                              steps: scenario.steps.map((s) =>
                                s.key !== step.key
                                  ? s
                                  : s.kind === 'chat'
                                    ? { ...s, event: { ...s.event, at: Number(e.target.value) } }
                                    : { ...s, at: Number(e.target.value) },
                              ),
                            })
                          }
                        />
                      </label>
                      {step.kind === 'chat' && (
                        <label>
                          Step {index + 1} message
                          <input
                            maxLength={500}
                            value={step.event.text}
                            onChange={(e) =>
                              edit({
                                ...scenario,
                                steps: scenario.steps.map((s) =>
                                  s.key === step.key && s.kind === 'chat'
                                    ? { ...s, event: { ...s.event, text: e.target.value } }
                                    : s,
                                ),
                              })
                            }
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className="button small danger"
                        onClick={() =>
                          edit({
                            ...scenario,
                            steps: scenario.steps.filter((s) => s.key !== step.key),
                            expectations: scenario.expectations.filter(
                              (c) => c.stepKey !== step.key,
                            ),
                          })
                        }
                      >
                        Remove step {index + 1}
                      </button>
                    </fieldset>
                    {step.kind === 'chat' && (
                      <p className="note mono">
                        Roles {step.event.roles.join(', ')} · delivery {step.event.id} · key{' '}
                        {step.key}
                      </p>
                    )}
                  </details>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-label="Expectations">
          <h4>Expect an outcome</h4>
          <p className="note">
            The host compares each expectation with what really happened. Use “Expect an outcome
            here” on any step to pre-fill this form.
          </p>
          <fieldset
            disabled={busy || scenario.expectations.length >= 20}
            className="rehearsal-grid"
          >
            <legend className="sr-only">Independent host checks</legend>
            <label>
              Expectation step
              <select
                value={target || scenario.steps.at(-1)?.key || ''}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose step</option>
                {scenario.steps.map((s, i) => (
                  <option key={s.key} value={s.key}>
                    {i + 1}. {stepTitle(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Check kind
              <select
                value={expectKind}
                onChange={(e) => {
                  const kind = e.target.value as Expectation['kind'];
                  setExpectKind(kind);
                  setExpected(
                    kind === 'decision' ? 'ACCEPTED' : kind === 'phase' ? 'running' : '1',
                  );
                }}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            {expectKind === 'decision' || expectKind === 'phase' ? (
              <label>
                Expected {expectKind === 'decision' ? 'outcome' : 'phase'}
                <select
                  ref={valueField}
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                >
                  {expectKind === 'decision'
                    ? decisionCodes.map((v) => (
                        <option key={v} value={v}>
                          {codeLabel(v)} ({v})
                        </option>
                      ))
                    : ['running', 'paused', 'finished'].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
            ) : (
              <label>
                {expectKind === 'effects'
                  ? 'Expected effect count'
                  : expectKind === 'score'
                    ? 'Expected score'
                    : 'Expected resources left'}
                <input
                  ref={valueField}
                  type="number"
                  min={0}
                  max={expectKind === 'effects' ? 10 : expectKind === 'remaining' ? 100 : 2560000}
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </label>
            )}
            {(expectKind === 'score' || expectKind === 'remaining') && (
              <label>
                {expectKind === 'score' ? 'Team identity' : 'Participant identity'}
                <input
                  value={subject}
                  maxLength={80}
                  list={expectKind === 'remaining' ? 'rehearsal-viewers' : 'rehearsal-teams'}
                  onChange={(e) => setSubject(e.target.value)}
                />
                <datalist id="rehearsal-teams">
                  {(version.manifest.experience?.teams.map((t) => t.id) ?? ['community']).map(
                    (t) => (
                      <option key={t} value={t} />
                    ),
                  )}
                </datalist>
              </label>
            )}
            <button
              type="button"
              className="button small primary"
              disabled={!scenario.steps.length}
              onClick={addExpectation}
            >
              Add expectation
            </button>
          </fieldset>
          {scenario.expectations.length > 0 ? (
            <ul className="expectation-list">
              {scenario.expectations.map((check) => (
                <li key={check.id}>
                  <span>{describeExpectation(check, scenario)}</span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={busy}
                      onClick={() => {
                        setTarget(check.stepKey);
                        setExpectKind(check.kind);
                        setExpected(String(check.value));
                        setSubject(
                          'teamId' in check
                            ? check.teamId
                            : 'viewerId' in check
                              ? check.viewerId
                              : 'community',
                        );
                        edit({
                          ...scenario,
                          expectations: scenario.expectations.filter((c) => c.id !== check.id),
                        });
                      }}
                    >
                      Edit expectation
                    </button>
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={busy}
                      onClick={() =>
                        edit({
                          ...scenario,
                          expectations: scenario.expectations.filter((c) => c.id !== check.id),
                        })
                      }
                    >
                      Remove expectation
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">
              No expectations yet. Without them, a replay only proves host safety.
            </p>
          )}
        </section>
      </div>
    </details>
  );
}
