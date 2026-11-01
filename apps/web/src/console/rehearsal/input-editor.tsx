import { useRef, useState } from 'react';
import type { Role, Version } from '../../lib/types.js';
import {
  decisionCodes,
  scenarioSchema,
  type Expectation,
  type RehearsalScenario,
  type RehearsalStep,
} from './contracts.js';
const roles: Role[] = ['viewer', 'subscriber', 'moderator', 'broadcaster'];
const timeOf = (step: RehearsalStep) => (step.kind === 'chat' ? step.event.at : step.at);
const caption = (step: RehearsalStep) =>
  step.kind === 'chat' ? `${step.event.viewerId}: ${step.event.text}` : step.kind;
export function InputEditor({
  scenario,
  version,
  busy,
  edit,
  onError: setError,
}: {
  scenario: RehearsalScenario;
  version: Version;
  busy: boolean;
  edit: (value: RehearsalScenario) => void;
  onError: (message: string) => void;
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
  const nextKey = useRef(0);
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
      setError('Expectation is outside the supported bounds.');
      return;
    }
    edit(next);
  }
  return (
    <>
      <details>
        <summary>Inject chat and host controls</summary>
        <fieldset disabled={busy || scenario.steps.length >= 120} className="rehearsal-grid">
          <legend>Supported normalized synthetic inputs</legend>
          <label>
            Viewer identity
            <input value={viewer} maxLength={80} onChange={(e) => setViewer(e.target.value)} />
          </label>
          <div className="rehearsal-roles">
            {roles.map((role) => (
              <label key={role}>
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
            Injected chat
            <input value={chat} maxLength={500} onChange={(e) => setChat(e.target.value)} />
          </label>
          <label>
            Delay / advance (ms)
            <input
              type="number"
              min={0}
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
            />
          </label>
          <button
            className="button small"
            disabled={
              !viewer || !viewerRoles.length || !chat || !Number.isSafeInteger(delay) || delay < 0
            }
            onClick={() => addChat()}
          >
            Add chat step
          </button>
          <button
            className="button small"
            disabled={!scenario.steps.some((s) => s.kind === 'chat') || delay < 0}
            onClick={() => addChat(true)}
          >
            Duplicate last delivery
          </button>
          <label>
            Host control
            <select value={control} onChange={(e) => setControl(e.target.value as typeof control)}>
              <option value="advance">advance clock</option>
              <option value="pause" disabled={!version.manifest.experience}>
                pause session
              </option>
              <option value="resume" disabled={!version.manifest.experience}>
                resume session
              </option>
            </select>
          </label>
          <button
            className="button small"
            disabled={!Number.isSafeInteger(delay) || delay < 0}
            onClick={() => {
              const step: RehearsalStep = { kind: control, key: uniqueKey(), at: highTime + delay };
              edit({ ...scenario, steps: [...scenario.steps, step] });
              setTarget(step.key);
            }}
          >
            Add control step
          </button>
        </fieldset>
        <ol className="rehearsal-inputs">
          {scenario.steps.map((step, index) => (
            <li key={step.key}>
              <details>
                <summary>
                  {index + 1}. {caption(step)} · {timeOf(step)} ms
                </summary>
                <fieldset disabled={busy}>
                  <p>Stable key: {step.key}</p>
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
                    <>
                      <p>
                        Roles: {step.event.roles.join(', ')} · Delivery: {step.event.id}
                      </p>
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
                    </>
                  )}
                  <button
                    className="button small"
                    onClick={() =>
                      edit({
                        ...scenario,
                        steps: scenario.steps.filter((s) => s.key !== step.key),
                        expectations: scenario.expectations.filter((c) => c.stepKey !== step.key),
                      })
                    }
                  >
                    Remove step {index + 1}
                  </button>
                </fieldset>
              </details>
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>Explicit expectations</summary>
        <fieldset disabled={busy || scenario.expectations.length >= 20} className="rehearsal-grid">
          <legend>Independent host checks</legend>
          <label>
            Expectation step
            <select
              value={target || scenario.steps.at(-1)?.key || ''}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose step</option>
              {scenario.steps.map((s, i) => (
                <option key={s.key} value={s.key}>
                  {i + 1}. {caption(s)}
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
                setExpected(kind === 'decision' ? 'ACCEPTED' : kind === 'phase' ? 'running' : '1');
              }}
            >
              {['effects', 'decision', 'phase', 'score', 'remaining'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          {expectKind === 'decision' || expectKind === 'phase' ? (
            <label>
              Expected {expectKind}
              <select value={expected} onChange={(e) => setExpected(e.target.value)}>
                {(expectKind === 'decision'
                  ? decisionCodes
                  : ['running', 'paused', 'finished']
                ).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {expectKind === 'effects' ? 'Expected effect count' : `Expected ${expectKind}`}
              <input
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
              <input value={subject} maxLength={80} onChange={(e) => setSubject(e.target.value)} />
            </label>
          )}
          <button
            className="button small"
            disabled={!scenario.steps.length}
            onClick={addExpectation}
          >
            Add expectation
          </button>
        </fieldset>
        <ul>
          {scenario.expectations.map((check) => (
            <li key={check.id}>
              {check.stepKey}: expected {check.kind} {check.value}
              {'teamId' in check
                ? ` for ${check.teamId}`
                : 'viewerId' in check
                  ? ` for ${check.viewerId}`
                  : ''}{' '}
              <button
                className="button small"
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
                className="button small"
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
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
