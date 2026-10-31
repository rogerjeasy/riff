import { useEffect, useState } from 'react';
import type { Run, Version } from '../../lib/types.js';

const EXAMPLES = [
  {
    label: 'Tomato Battle',
    text: 'Tomato Battle: viewers join Red with !red or Blue with !blue, then use !throw to throw tomatoes. Give each participant 3 throws for a 120 second round; the team with the highest score wins.',
  },
  {
    label: 'Community Goal',
    text: 'Community Goal: everyone uses !grow to contribute hearts, with 3 contributions per participant in a 120 second round. Work together toward a collective goal of 5 points.',
  },
  {
    label: 'Tomato Toss',
    text: 'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.',
  },
  {
    label: 'Heart burst for subs',
    text: 'Subscribers can type !love to send a heart, once every 30 seconds.',
  },
  { label: 'Star shower', text: 'Let everyone use !star to throw stars, at most 5 per minute.' },
];
const EDITS = [
  'Change the command to !splat, allow two throws per 30 seconds, subscribers only.',
  'Make it stars instead of tomatoes.',
  'Let moderators only, once every 10 seconds.',
];
const STAGES: { id: Run['stage'][]; label: string }[] = [
  { id: ['queued'], label: 'Queued' },
  { id: ['drafting'], label: 'Drafting' },
  { id: ['verifying', 'repairing'], label: 'Verifying' },
  { id: ['ready', 'question', 'unsupported', 'failed', 'cancelled'], label: 'Result' },
];

export function Composer(props: {
  editing: Version | null;
  run: Run | null;
  compiler: { kind: 'codex' | 'offline'; model: string | null };
  onGenerate: (intent: string, baseVersionId: string | null) => Promise<void>;
  onCancel: (runId: string) => void;
  onOpenVersion: (versionId: string) => void;
  draft: string;
  setDraft: (text: string) => void;
}) {
  const { editing, run, draft, setDraft } = props;
  const [mode, setMode] = useState<'new' | 'edit'>(editing ? 'edit' : 'new');
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const busy = Boolean(run && !run.result);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [busy]);
  const editingId = editing?.id ?? null;
  useEffect(() => setMode(editingId ? 'edit' : 'new'), [editingId]);
  const base = mode === 'edit' ? editing : null;
  const submit = async () => {
    if (draft.trim().length < 8 || busy) return;
    setSubmitting(true);
    try {
      await props.onGenerate(draft.trim(), base?.id ?? null);
    } finally {
      setSubmitting(false);
    }
  };
  const stageIndex = run ? STAGES.findIndex((s) => s.id.includes(run.stage)) : -1;
  const thoughts = run?.progress.filter((p) => p.text.trim()).slice(-4) ?? [];

  return (
    <section className="card composer" aria-labelledby="describe-heading">
      <header className="card-head">
        <div>
          <p className="step-label">
            <span>1</span> Describe
          </p>
          <h2 id="describe-heading">
            {base ? `Change “${base.title}”` : 'What should your chat be able to do?'}
          </h2>
        </div>
        {editing && (
          <div className="segmented" role="group" aria-label="Authoring mode">
            <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
              New idea
            </button>
            <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
              Edit v{editing.number}
            </button>
          </div>
        )}
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="intent">
          Describe the interaction in one or two sentences
        </label>
        <textarea
          id="intent"
          value={draft}
          maxLength={1200}
          rows={3}
          placeholder={
            base
              ? 'e.g. Change the command to !splat and make it subscribers only'
              : 'e.g. Let viewers throw tomatoes with !tomato, three per person per minute'
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
          }}
          disabled={busy}
        />
        <div className="chips" aria-label={base ? 'Suggested changes' : 'Examples'}>
          {(base ? EDITS.map((text) => ({ label: text, text })) : EXAMPLES).map((example) => (
            <button
              key={example.label}
              type="button"
              className="chip"
              onClick={() => setDraft(example.text)}
              disabled={busy}
            >
              {example.label}
            </button>
          ))}
        </div>
        <div className="composer-foot">
          <p className="hint">
            {props.compiler.kind === 'codex' ? (
              <>
                Compiled at runtime by <b>Codex</b>
                {props.compiler.model ? ` (${props.compiler.model})` : ''} in a read-only, offline
                workspace.
              </>
            ) : (
              <>
                Using the <b>offline template compiler</b> (no model call). Set
                RIFF_COMPILER_MODE=codex to compile with Codex.
              </>
            )}
          </p>
          <button
            type="submit"
            className="button primary"
            disabled={busy || submitting || draft.trim().length < 8}
          >
            {busy ? 'Working…' : base ? 'Generate change' : 'Generate'} <kbd>⌘↵</kbd>
          </button>
        </div>
      </form>

      {run && (
        <div className={`run run-${run.stage}`} aria-live="polite">
          <ol className="run-stages">
            {STAGES.map((stage, index) => (
              <li
                key={stage.label}
                data-state={
                  index < stageIndex
                    ? 'done'
                    : index === stageIndex
                      ? run.result
                        ? run.result.status
                        : 'active'
                      : 'todo'
                }
              >
                {index === STAGES.length - 1 && run.result
                  ? resultLabel(run.result.status)
                  : stage.label}
                {stage.id.includes('repairing') && run.stage === 'repairing'
                  ? ' · repairing once'
                  : ''}
              </li>
            ))}
          </ol>
          <div className="run-meta">
            <span>“{run.intent.length > 90 ? `${run.intent.slice(0, 90)}…` : run.intent}”</span>
            <span className="mono">
              {(
                ((run.result ? run.startedAt + run.result.durationMs : now) - run.startedAt) /
                1000
              ).toFixed(1)}
              s{run.transport === 'codex' ? ' · Codex' : ' · offline'}
            </span>
          </div>
          {busy && thoughts.length > 0 && (
            <ul className="thoughts" aria-label="Compiler progress">
              {thoughts.map((thought) => (
                <li key={`${thought.at}-${thought.text.slice(0, 20)}`} data-kind={thought.kind}>
                  {thought.text}
                </li>
              ))}
            </ul>
          )}
          {busy && (
            <button
              type="button"
              className="button ghost small"
              onClick={() => props.onCancel(run.id)}
            >
              Cancel
            </button>
          )}
          {run.result?.status === 'question' && (
            <div className="answer">
              <p>
                <b>One question first:</b> {run.result.question}
              </p>
              <div className="chips">
                {run.result.choices.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className="chip"
                    onClick={() => setDraft(`${run.intent} ${choice}`)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            </div>
          )}
          {run.result?.status === 'unsupported' && (
            <div className="answer">
              <p>
                <b>Not possible yet:</b> {run.result.unsupportedReason}
              </p>
              {run.result.alternative && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => setDraft(run.result?.alternative ?? '')}
                >
                  Try instead: {run.result.alternative}
                </button>
              )}
            </div>
          )}
          {(run.result?.status === 'failed' || run.result?.status === 'cancelled') && (
            <div className="answer bad">
              <p>{run.result.error ?? 'Generation failed.'} Your live interaction is unchanged.</p>
              {run.result.versionId && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => run.result?.versionId && props.onOpenVersion(run.result.versionId)}
                >
                  See what failed
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function resultLabel(status: NonNullable<Run['result']>['status']) {
  return {
    ready: 'Ready to review',
    question: 'Needs your answer',
    unsupported: 'Not supported',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }[status];
}
