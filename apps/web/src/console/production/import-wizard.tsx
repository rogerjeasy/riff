import { useId, useState } from 'react';
import { z } from 'zod';
import type { Version } from '../../lib/types.js';
import { Segmented, Stat } from '../panel-kit.js';
import {
  draftResultSchema,
  importReportSchema,
  type DraftResult,
  type ImportItem,
  type ImportReport,
  type ImportTool,
  type ProductionState,
} from './contracts.js';
import type { useProduction } from './use-production.js';

const MAX_BYTES = 256 * 1024;
const TOOLS: readonly {
  value: ImportTool;
  label: string;
  how: string;
  accept: string;
  paste: string;
}[] = [
  {
    value: 'streamerbot',
    label: 'Streamer.bot',
    how: 'In Streamer.bot select the actions, right-click → Export, and copy the export string (or save it as a file).',
    accept: '.txt,.json,.sb',
    paste: 'Streamer.bot export string or JSON',
  },
  {
    value: 'firebot',
    label: 'Firebot',
    how: 'In Firebot open Setups → Create Setup, add the commands, events and preset effect lists you want, and save the .firebotsetup file.',
    accept: '.firebotsetup,.json',
    paste: 'Firebot setup JSON',
  },
  {
    value: 'obs',
    label: 'OBS',
    how: 'In OBS choose Scene Collection → Export and pick the exported .json file. Riff reads scenes and sources as a reference list.',
    accept: '.json',
    paste: 'OBS scene collection JSON',
  },
];
const KIND: Record<ImportItem['kind'], string> = {
  action: 'Action',
  command: 'Command',
  event: 'Event',
  preset: 'Preset list',
  scene: 'Scene',
  source: 'Source',
  script: 'Script',
  component: 'Other',
};
const STATUS: Record<ImportItem['status'], { label: string; tone: string }> = {
  mapped: { label: 'Mapped', tone: 'good' },
  review: { label: 'Needs review', tone: 'warn' },
  imported: { label: 'Reference', tone: 'muted' },
  skipped: { label: 'Skipped', tone: 'muted' },
};
const TRIGGER: Record<NonNullable<ImportItem['trigger']>['kind'], string> = {
  command: 'Chat command',
  cheer: 'Cheer',
  sub: 'Subscription',
  raid: 'Raid',
  redemption: 'Channel points',
  follow: 'Follow',
};
const ACTION: Record<ImportItem['actions'][number]['kind'], string> = {
  scene: 'Switch scene',
  'source-visibility': 'Source visibility',
  media: 'Play media',
  chat: 'Chat message',
};
type Filter = 'all' | ImportItem['status'];
type Decision = {
  decision: 'skip' | 'intent' | 'bridge';
  versionId: string;
  control: 'start' | 'pause';
};

/**
 * Guided import of another tool's configuration: pick the tool, add its export, review a
 * per-item report and choose what to draft. Reading never runs anything; drafts never
 * approve anything — interactions go to the composer, bridges to the mapping review.
 */
export function ImportWizard({
  state,
  versions,
  busy,
  panic,
  send,
  onDraftIntent,
}: {
  state: ProductionState;
  versions: Version[];
  busy: boolean;
  panic: boolean;
  send: ReturnType<typeof useProduction>['send'];
  onDraftIntent?: ((text: string) => void) | undefined;
}) {
  const ids = useId();
  const [tool, setTool] = useState<ImportTool | null>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [result, setResult] = useState<DraftResult | null>(null);
  const [problem, setProblem] = useState('');
  const [working, setWorking] = useState<'read' | 'draft' | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [sent, setSent] = useState<string | null>(null);
  const meta = TOOLS.find((t) => t.value === tool) ?? null;
  const eligible = versions.filter(
    (v) => v.status === 'active' && v.approvedAt !== null && !v.incident,
  );
  const chosen = report
    ? report.items.filter((i) => (decisions[i.id]?.decision ?? 'skip') !== 'skip')
    : [];
  const incomplete = chosen.some((i) => {
    const d = decisions[i.id];
    return d?.decision === 'bridge' && !d.versionId;
  });
  const step = result ? 4 : report ? 3 : tool ? 2 : 1;
  const stage = (n: number) => (n < step ? 'done' : n === step ? 'current' : 'next');

  function reset(next: ImportTool | null) {
    setTool(next);
    setText('');
    setFileName(null);
    setReport(null);
    setDecisions({});
    setResult(null);
    setProblem('');
    setFilter('all');
  }
  async function readFile(file: File | undefined) {
    setProblem('');
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setProblem(
        `That file is ${Math.ceil(file.size / 1024)} KiB; at most 256 KiB can be imported.`,
      );
      return;
    }
    setFileName(file.name);
    setText(await file.text());
  }
  async function preview() {
    if (!tool) return;
    setProblem('');
    setResult(null);
    setWorking('read');
    const out = await send(
      'import/preview',
      { tool, text },
      z.object({ report: importReportSchema }),
      { quiet: true },
    );
    setWorking(null);
    if (!out.ok) return setProblem(out.message);
    setReport(out.value.report);
    setDecisions({});
    setFilter('all');
  }
  async function draft() {
    if (!tool || !report) return;
    setProblem('');
    setWorking('draft');
    const out = await send(
      'import/drafts',
      {
        tool,
        text,
        decisions: chosen.map((i) => {
          const d = decisions[i.id] as Decision;
          return d.decision === 'bridge'
            ? { id: i.id, decision: 'bridge', versionId: d.versionId, control: d.control }
            : { id: i.id, decision: d.decision };
        }),
      },
      draftResultSchema,
      { quiet: true },
    );
    setWorking(null);
    if (!out.ok) return setProblem(out.message);
    setResult(out.value);
    setReport(out.value.report);
    setDecisions({});
  }
  const decide = (id: string, patch: Partial<Decision>) =>
    setDecisions((all) => ({
      ...all,
      [id]: { decision: 'skip', versionId: '', control: 'start', ...all[id], ...patch },
    }));
  const visible = report?.items.filter((i) => filter === 'all' || i.status === filter) ?? [];
  const bridges = result?.state.mappingReview?.mappings.filter((m) => m.id.startsWith('import-'));

  return (
    <section className="production-section" aria-labelledby={`${ids}-heading`}>
      <div className="production-section-head">
        <div>
          <h3 id={`${ids}-heading`}>Import from another tool</h3>
          <p className="panel-hint">
            Bring commands, alerts and scenes from Streamer.bot, Firebot or OBS. Riff reads the
            export as data only — scripts and code are listed for you to review, never run — and
            nothing goes live until you approve it through the usual steps.
          </p>
        </div>
        <ol className="production-stepper" aria-label="Import progress">
          {['Tool', 'Export', 'Review', 'Drafts'].map((label, i) => (
            <li
              key={label}
              data-state={stage(i + 1)}
              aria-current={stage(i + 1) === 'current' ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
      </div>

      <fieldset disabled={busy || panic}>
        <legend className="sr-only">Choose the tool to import from</legend>
        <Segmented
          label="Tool to import from"
          value={tool}
          options={TOOLS.map(({ value, label }) => ({ value, label }))}
          onChange={(next) => next !== tool && reset(next)}
        />
        {panic && <p className="panel-hint">Resume from the emergency stop to import.</p>}
      </fieldset>

      {meta && !report && (
        <form
          className="production-import"
          onSubmit={(e) => {
            e.preventDefault();
            void preview();
          }}
        >
          <p className="panel-hint">{meta.how}</p>
          <div className="panel-grid">
            <label>
              Export file
              <input
                type="file"
                accept={meta.accept}
                onChange={(e) => void readFile(e.target.files?.[0])}
              />
              {fileName && <span className="panel-hint">Loaded {fileName}.</span>}
            </label>
          </div>
          <label>
            Or paste the {meta.paste}
            <textarea
              rows={6}
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setFileName(null);
                setText(e.target.value);
              }}
            />
            <span className="panel-hint">Up to 256 KiB. Reading changes nothing.</span>
          </label>
          <div className="panel-actions">
            <button className="button" disabled={busy || panic || !text.trim()}>
              {working === 'read' ? 'Reading export…' : `Read ${meta.label} export`}
            </button>
          </div>
        </form>
      )}

      {report && (
        <section className="panel-surface import-report" aria-labelledby={`${ids}-report`}>
          <div className="production-section-head">
            <h4 id={`${ids}-report`}>
              {TOOLS.find((t) => t.value === report.tool)?.label} import report
              {report.title ? ` — “${report.title}”` : ''}
            </h4>
            <button
              type="button"
              className="button small ghost"
              disabled={busy}
              onClick={() => reset(tool)}
            >
              Choose another export
            </button>
          </div>
          <dl className="panel-stats">
            <Stat label="Read" value={report.counts.imported} hint="Items read as data" />
            <Stat label="Mapped" value={report.counts.mapped} tone="good" hint="Ready to draft" />
            <Stat
              label="Needs review"
              value={report.counts.review}
              {...(report.counts.review ? { tone: 'warn' as const } : {})}
              hint="Scripts or unknown parts"
            />
            <Stat label="Skipped" value={report.counts.skipped} hint="Not imported" />
          </dl>
          {report.notes.length > 0 && (
            <ul className="import-notes">
              {report.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
          {report.items.length === 0 ? (
            <p className="panel-hint">This export contains nothing Riff can read.</p>
          ) : (
            <>
              <div className="import-toolbar">
                <Segmented
                  label="Show items"
                  value={filter}
                  options={[
                    { value: 'all', label: `All (${report.items.length})` },
                    { value: 'mapped', label: `Mapped (${report.counts.mapped})` },
                    { value: 'review', label: `Needs review (${report.counts.review})` },
                    { value: 'skipped', label: `Skipped (${report.counts.skipped})` },
                  ]}
                  onChange={setFilter}
                />
                {report.items.some((i) => i.status === 'mapped' && i.intent) && (
                  <button
                    type="button"
                    className="button small ghost"
                    disabled={busy}
                    onClick={() => {
                      for (const i of report.items)
                        if (i.status === 'mapped' && i.intent) decide(i.id, { decision: 'intent' });
                    }}
                  >
                    Draft every mapped item as an interaction
                  </button>
                )}
              </div>
              <ol className="import-items">
                {visible.map((item) => (
                  <ImportRow
                    key={item.id}
                    item={item}
                    decision={decisions[item.id]}
                    eligible={eligible}
                    disabled={busy || panic}
                    onChange={(patch) => decide(item.id, patch)}
                  />
                ))}
                {visible.length === 0 && <li className="panel-hint">No items in this view.</li>}
              </ol>
              <div className="panel-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || panic || !chosen.length || incomplete}
                  onClick={() => void draft()}
                >
                  {working === 'draft'
                    ? 'Creating drafts…'
                    : chosen.length
                      ? `Create ${chosen.length} draft${chosen.length === 1 ? '' : 's'}`
                      : 'Create drafts'}
                </button>
                <span className="panel-hint">
                  {incomplete
                    ? 'Choose the approved interaction for every bridge.'
                    : 'Drafts change nothing live. Interactions open in the composer; bridges join the mapping review above.'}
                </span>
              </div>
            </>
          )}
        </section>
      )}

      {result && (
        <section className="panel-surface import-result" aria-labelledby={`${ids}-result`}>
          <h4 id={`${ids}-result`} role="status">
            Drafted {result.intents.length} interaction{result.intents.length === 1 ? '' : 's'}
            {bridges?.length
              ? ` and staged ${bridges.length} bridge mapping${bridges.length === 1 ? '' : 's'}`
              : ''}
            . Nothing was approved or run.
          </h4>
          {!!bridges?.length && (
            <p className="panel-hint">
              Review and approve the staged bridges in “Streamer.bot and Firebot actions” above. In
              your tool, send a custom event with the same name to trigger them.
            </p>
          )}
          {result.intents.length > 0 && (
            <ol className="import-intents">
              {result.intents.map((intent) => (
                <li key={intent.id}>
                  <strong>{intent.name}</strong>
                  <blockquote>{intent.text}</blockquote>
                  <div className="panel-actions">
                    {onDraftIntent ? (
                      <button
                        type="button"
                        className="button small"
                        onClick={() => {
                          onDraftIntent(intent.text);
                          setSent(intent.id);
                        }}
                      >
                        {sent === intent.id ? 'In the composer ✓' : 'Open in composer'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => void navigator.clipboard?.writeText(intent.text)}
                    >
                      Copy text
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {problem && (
        <p role="alert" className="panel-problem">
          {problem}
        </p>
      )}
      {state.connections.firebot.status !== 'connected' && tool === 'firebot' && report && (
        <p className="panel-hint">
          Connect Firebot above to bridge its events live; drafting works without a connection.
        </p>
      )}
    </section>
  );
}

function ImportRow({
  item,
  decision,
  eligible,
  disabled,
  onChange,
}: {
  item: ImportItem;
  decision: Decision | undefined;
  eligible: Version[];
  disabled: boolean;
  onChange: (patch: Partial<Decision>) => void;
}) {
  const id = useId();
  const status = STATUS[item.status];
  const choice = decision?.decision ?? 'skip';
  const draftable = item.status !== 'skipped' && (item.intent || item.bridge);
  return (
    <li className="import-item" data-status={item.status} aria-labelledby={`${id}-name`}>
      <div className="import-item-head">
        <strong id={`${id}-name`}>{item.name}</strong>
        <span className="badge muted">{KIND[item.kind]}</span>
        <span className={`badge ${status.tone}`}>{status.label}</span>
        {item.drafted && (
          <span className="badge good">
            Already drafted as {item.drafted === 'intent' ? 'an interaction' : 'a bridge'}
          </span>
        )}
      </div>
      {(item.trigger || item.actions.length > 0) && (
        <p className="import-summary">
          {item.trigger && (
            <span>
              <span className="import-label">When</span> {TRIGGER[item.trigger.kind]}
              {item.trigger.detail ? ` ${item.trigger.detail}` : ''}
            </span>
          )}
          {item.actions.length > 0 && (
            <span>
              <span className="import-label">Does</span>{' '}
              {item.actions.map((a) => `${ACTION[a.kind]}: ${a.detail}`).join(' · ')}
            </span>
          )}
        </p>
      )}
      {item.reason && <p className="panel-hint">{item.reason}</p>}
      {item.review.length > 0 && (
        <ul className="import-review">
          {item.review.map((line, i) => (
            <li key={i}>
              <span className="sr-only">Needs manual review: </span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {draftable && (
        <div className="panel-grid import-decision">
          <label>
            What to do
            <select
              value={choice}
              disabled={disabled}
              onChange={(e) => onChange({ decision: e.target.value as Decision['decision'] })}
            >
              <option value="skip">Leave it out</option>
              {item.intent && <option value="intent">Draft an interaction to edit and test</option>}
              {item.bridge && (
                <option value="bridge">Bridge its event to an approved interaction</option>
              )}
            </select>
          </label>
          {choice === 'bridge' && (
            <>
              <label>
                Approved interaction
                <select
                  required
                  value={decision?.versionId ?? ''}
                  disabled={disabled}
                  onChange={(e) => onChange({ versionId: e.target.value })}
                >
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
                  value={decision?.control ?? 'start'}
                  disabled={disabled}
                  onChange={(e) => onChange({ control: e.target.value as Decision['control'] })}
                >
                  <option value="start">Start or resume</option>
                  <option value="pause">Pause</option>
                </select>
              </label>
              {!eligible.length && (
                <p className="panel-hint">
                  Approve an interaction first; bridges only reach live, approved versions.
                </p>
              )}
            </>
          )}
          {choice === 'intent' && (
            <p className="panel-hint import-intent-preview">
              <span className="import-label">Draft</span> {item.intent}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
