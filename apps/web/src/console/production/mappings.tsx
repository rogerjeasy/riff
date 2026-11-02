import { useState } from 'react';
import type { Version } from '../../lib/types.js';
import { Check, Fingerprint } from '../panel-kit.js';
import { toolOf, type BotKind, type ProductionMapping, type ProductionState } from './contracts.js';

const OPERATION = { start: 'Start or resume', pause: 'Pause' } as const;
const TOOL_NAME: Record<BotKind, string> = { streamerbot: 'Streamer.bot', firebot: 'Firebot' };
/** `$randomUUID` and `$unixTimestamp` (epoch seconds) are Firebot replace variables. */
const FIREBOT_EVENT_DATA = `{
  "riff": {
    "key": "your Riff event key",
    "eventId": "$randomUUID",
    "causalId": "$randomUUID",
    "origin": "firebot",
    "hops": 0,
    "at": $unixTimestamp
  }
}`;

/** Tool custom event → exact approved interaction, plus an optional round-end action. */
export function ProductionMappings({
  state,
  versions,
  busy,
  panic,
  mutate,
}: {
  state: ProductionState;
  versions: Version[];
  busy: boolean;
  panic: boolean;
  mutate: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [eventName, setEvent] = useState('Start challenge');
  const [versionId, setVersion] = useState('');
  const [control, setControl] = useState<'start' | 'pause'>('start');
  const [actionId, setAction] = useState('');
  const [document, setDocument] = useState('');
  const [problem, setProblem] = useState('');
  const [toolChoice, setTool] = useState<BotKind | null>(null);
  const preferred: BotKind =
    state.connections.streamerbot.status !== 'connected' &&
    state.connections.firebot.status === 'connected'
      ? 'firebot'
      : 'streamerbot';
  const tool = toolChoice ?? preferred;
  const bot = state.connections[tool];
  const connected = bot.status === 'connected';
  const review = state.mappingReview;
  const eligible = versions.filter(
    (v) => v.status === 'active' && v.approvedAt !== null && !v.incident,
  );
  const title = (id: string) => {
    const v = versions.find((x) => x.id === id);
    return v ? `${v.title} v${v.number}` : 'Version no longer available';
  };
  const actionName = (m: ProductionMapping) =>
    m.actionId
      ? (state.connections[toolOf(m)].actions.find((a) => a.id === m.actionId)?.name ??
        'Unknown action')
      : '—';
  const replacing = state.mappings.some((m) => m.eventName === eventName);
  const blocked = busy || panic || !connected;
  const propose = (mappings: ProductionMapping[]) => void mutate('mappings/review', { mappings });

  return (
    <section className="production-section" aria-labelledby="production-bot-heading">
      <div>
        <h3 id="production-bot-heading">Streamer.bot and Firebot actions</h3>
        <p className="panel-hint">
          A named custom event from Streamer.bot or Firebot can start, resume or pause one exact
          approved interaction. Start never resets a running round. When a round finishes, Riff can
          run one action you choose — a Streamer.bot action or a Firebot preset effect list or
          variable — with no scripts or arbitrary arguments.
        </p>
      </div>

      {state.mappings.length > 0 ? (
        <table className="production-table">
          <caption className="sr-only">Approved mappings</caption>
          <thead>
            <tr>
              <th scope="col">Custom event</th>
              <th scope="col">Tool</th>
              <th scope="col">Does</th>
              <th scope="col">Interaction</th>
              <th scope="col">When the round ends</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.mappings.map((m) => (
              <tr key={m.id}>
                <th scope="row">
                  <code>{m.eventName}</code>
                </th>
                <td>{TOOL_NAME[toolOf(m)]}</td>
                <td>{OPERATION[m.control]}</td>
                <td>{title(m.versionId)}</td>
                <td>{actionName(m)}</td>
                <td>
                  <button
                    type="button"
                    className="button small ghost"
                    disabled={busy || panic}
                    aria-label={`Review removal of ${m.eventName}`}
                    onClick={() => propose(state.mappings.filter((x) => x.id !== m.id))}
                  >
                    Remove…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="panel-hint">No approved mappings yet.</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          propose([
            ...state.mappings.filter((m) => m.eventName !== eventName),
            {
              id: state.mappings.find((m) => m.eventName === eventName)?.id ?? crypto.randomUUID(),
              eventName,
              versionId,
              control,
              actionId: actionId || null,
              tool,
            },
          ]);
        }}
      >
        <fieldset disabled={blocked}>
          <legend>{replacing ? `Change “${eventName}”` : 'Add a mapping'}</legend>
          <div className="panel-grid">
            <label>
              Tool
              <select
                value={tool}
                onChange={(e) => {
                  setTool(e.target.value as BotKind);
                  setAction('');
                }}
              >
                <option value="streamerbot">
                  Streamer.bot
                  {state.connections.streamerbot.status === 'connected' ? '' : ' (not connected)'}
                </option>
                <option value="firebot">
                  Firebot
                  {state.connections.firebot.status === 'connected' ? '' : ' (not connected)'}
                </option>
              </select>
            </label>
            <label>
              Custom event name
              <input
                required
                maxLength={120}
                value={eventName}
                onChange={(e) => setEvent(e.target.value)}
              />
            </label>
            <label>
              Approved interaction
              <select required value={versionId} onChange={(e) => setVersion(e.target.value)}>
                <option value="">Choose current approved version</option>
                {eligible.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title} v{v.number}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Allowed operation
              <select
                value={control}
                onChange={(e) => setControl(e.target.value as 'start' | 'pause')}
              >
                <option value="start">Start or resume</option>
                <option value="pause">Pause</option>
              </select>
            </label>
            <label>
              When its round finishes
              <select value={actionId} onChange={(e) => setAction(e.target.value)}>
                <option value="">No {TOOL_NAME[tool]} action</option>
                {bot.actions
                  .filter((a) => a.enabled)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="panel-actions">
            <button className="button">Review action mapping</button>
            <span className="panel-hint">
              {panic
                ? 'Resume from the emergency stop first.'
                : !connected
                  ? `Connect ${TOOL_NAME[tool]} above to choose actions.`
                  : !eligible.length
                    ? 'Approve an interaction first; only live, approved versions can be mapped.'
                    : 'Nothing changes until you approve the exact reviewed set.'}
            </span>
          </div>
        </fieldset>
      </form>

      {review && (
        <section className="panel-surface production-review" aria-label="Review mapping changes">
          <div className="production-section-head">
            <h4>Review mapping changes</h4>
            <span className="panel-hint">
              Review <Fingerprint value={review.digest} label="Mapping review" />
            </span>
          </div>
          {review.differences.length > 0 && (
            <ul className="production-diff">
              {review.differences.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          <p className="panel-hint">
            After approval: {review.mappings.length || 'no'}{' '}
            {review.mappings.length === 1 ? 'mapping' : 'mappings'}
            {review.mappings.length > 0 &&
              ` — ${review.mappings
                .map(
                  (m) =>
                    `${m.eventName} (${TOOL_NAME[toolOf(m)]}) → ${OPERATION[m.control].toLowerCase()} ${title(m.versionId)}`,
                )
                .join('; ')}`}
            .
          </p>
          {review.unsupported.length > 0 && (
            <ul className="panel-checks">
              {review.unsupported.map((line, i) => (
                <Check ok={false} key={i}>
                  {line}
                </Check>
              ))}
            </ul>
          )}
          <div className="panel-actions">
            <button
              type="button"
              className="button primary"
              disabled={blocked || review.unsupported.length > 0}
              onClick={() => void mutate('mappings/approve', { digest: review.digest })}
            >
              Approve these exact mappings
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={() => void mutate('mappings/discard', { digest: review.digest })}
            >
              Discard review
            </button>
            {review.unsupported.length > 0 && (
              <span className="panel-problem">
                Unsupported items must be removed before approval.
              </span>
            )}
          </div>
        </section>
      )}

      <details>
        <summary>How to send a custom event safely</summary>
        <p className="panel-hint">
          Each event needs Riff metadata with a unique <code>eventId</code>, a <code>causalId</code>
          , an external <code>origin</code>, <code>hops</code> 0–2 and <code>at</code> (epoch ms;
          Firebot may send seconds). Forward causal metadata unchanged. Riff rejects its own echoes,
          repeats and events older than two minutes, so loops stop by themselves.
        </p>
        <p className="panel-hint">
          <strong>Streamer.bot:</strong> send a Custom.Event with <code>args.riff</code>.
        </p>
        <pre>
          {JSON.stringify(
            {
              eventName,
              args: {
                riff: {
                  eventId: 'unique-event-id',
                  causalId: 'unique-root-id',
                  origin: 'creator-tool',
                  hops: 0,
                  at: 'current epoch milliseconds',
                },
              },
            },
            null,
            2,
          )}
        </pre>
        <p className="panel-hint">
          <strong>Firebot:</strong> add a “Send Custom WebSocket Event” effect named{' '}
          <code>{eventName}</code> with this JSON data, using your Riff event key. Riff passes
          causal metadata to preset lists as <code>riffEventId</code>, <code>riffCausalId</code>,{' '}
          <code>riffOrigin</code>, <code>riffHops</code> and <code>riffAt</code> arguments.
        </p>
        <pre>{FIREBOT_EVENT_DATA}</pre>
      </details>
      <details>
        <summary>Import a Riff mapping file</summary>
        <form
          className="production-import"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setProblem('');
              void mutate('import', { document: JSON.parse(document) as unknown });
            } catch {
              setProblem('That is not valid JSON.');
            }
          }}
        >
          <p className="panel-hint">
            Supported here: <code>riff-production</code> version 1 JSON. For Streamer.bot, Firebot
            or OBS exports use “Import from another tool” below. Importing only stages a review;
            current mappings keep working.
          </p>
          <label>
            Configuration JSON
            <textarea
              rows={5}
              spellCheck={false}
              maxLength={32768}
              value={document}
              onChange={(e) => setDocument(e.target.value)}
            />
          </label>
          <div className="panel-actions">
            <button className="button ghost" disabled={busy || panic || !document.trim()}>
              Inspect configuration import
            </button>
            {problem && <span className="panel-problem">{problem}</span>}
          </div>
        </form>
      </details>
    </section>
  );
}
