import { useState } from 'react';
import type { Version } from '../../lib/types.js';
import { Check, Fingerprint } from '../panel-kit.js';
import type { ProductionMapping, ProductionState } from './contracts.js';

const OPERATION = { start: 'Start or resume', pause: 'Pause' } as const;

/** Streamer.bot Custom.Event → exact approved interaction, plus an optional round-end action. */
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
  const bot = state.connections.streamerbot;
  const connected = bot.status === 'connected';
  const review = state.mappingReview;
  const eligible = versions.filter(
    (v) => v.status === 'active' && v.approvedAt !== null && !v.incident,
  );
  const title = (id: string) => {
    const v = versions.find((x) => x.id === id);
    return v ? `${v.title} v${v.number}` : 'Version no longer available';
  };
  const actionName = (id: string | null) =>
    id ? (bot.actions.find((a) => a.id === id)?.name ?? 'Unknown action') : '—';
  const replacing = state.mappings.some((m) => m.eventName === eventName);
  const blocked = busy || panic || !connected;
  const propose = (mappings: ProductionMapping[]) => void mutate('mappings/review', { mappings });

  return (
    <section className="production-section" aria-labelledby="production-bot-heading">
      <div>
        <h3 id="production-bot-heading">Streamer.bot actions</h3>
        <p className="panel-hint">
          A named Custom.Event can start, resume or pause one exact approved interaction. Start
          never resets a running round. When a round finishes, Riff can run one bot action you
          choose — no scripts or arbitrary arguments.
        </p>
      </div>

      {state.mappings.length > 0 ? (
        <table className="production-table">
          <caption className="sr-only">Approved mappings</caption>
          <thead>
            <tr>
              <th scope="col">Custom event</th>
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
                <td>{OPERATION[m.control]}</td>
                <td>{title(m.versionId)}</td>
                <td>{actionName(m.actionId)}</td>
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
            },
          ]);
        }}
      >
        <fieldset disabled={blocked}>
          <legend>{replacing ? `Change “${eventName}”` : 'Add a mapping'}</legend>
          <div className="panel-grid">
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
                <option value="">No external action</option>
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
                  ? 'Connect Streamer.bot above to choose actions.'
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
                    `${m.eventName} → ${OPERATION[m.control].toLowerCase()} ${title(m.versionId)}`,
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
        <summary>How to send a Custom.Event safely</summary>
        <p className="panel-hint">
          Each event needs <code>args.riff</code> with a unique <code>eventId</code>, a{' '}
          <code>causalId</code>, an external <code>origin</code>, <code>hops</code> 0–2 and{' '}
          <code>at</code> (epoch ms). Forward causal metadata unchanged. Riff rejects its own
          echoes, repeats and events older than two minutes, so bot loops stop by themselves.
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
            Supported: <code>riff-production</code> version 1 JSON. Native Streamer.bot or Firebot
            exports, C# code and plugins are listed as unsupported and never executed. Importing
            only stages a review; current mappings keep working.
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
