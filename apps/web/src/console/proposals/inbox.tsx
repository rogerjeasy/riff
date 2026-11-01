import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../../lib/api.js';
import type { Run, Studio } from '../../lib/types.js';
import type {
  Proposal,
  ProposalHistory,
  ProposalSelection,
  ProposalSnapshot,
} from './contracts.js';

const PAGE = 50;
const empty: ProposalSnapshot = { proposals: [], grants: [], ballots: [], selections: [] };
function message(cause: unknown) {
  if (cause instanceof ApiError) {
    // The inbox reloads itself after a conflict, so the server's message is the whole story.
    if (cause.status === 429) return `${cause.message} Wait a moment and try again.`;
    return cause.message;
  }
  return 'Could not complete this action. Refresh and try again.';
}
const eligible = (p: Proposal) => p.state === 'shortlisted' || p.state === 'selected';

/** Creator-only HTTP controls; audience results never authorize authoring or activation. */
export function ProposalInbox({
  studio,
  runs,
  refresh,
  onRun,
  onReview,
}: {
  studio: Studio;
  runs: Record<string, Run>;
  refresh: () => Promise<void>;
  onRun: (run: Run) => void;
  onReview: (id: string) => void;
}) {
  const [data, setData] = useState<ProposalSnapshot>(studio.proposals ?? empty);
  const [filter, setFilter] = useState<Proposal['state'] | ''>('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const queryKey = `${filter}:${offset}`;
  const currentQuery = useRef(queryKey);
  currentQuery.current = queryKey;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const locks = useRef(new Set<string>());
  const alive = useRef(true);
  const queryEpoch = useRef(0);
  const editorEpoch = useRef(0);
  const [editor, setEditor] = useState<Proposal | null>(null);
  const editorRef = useRef<Proposal | null>(null);
  const [brief, setBrief] = useState('');
  const [base, setBase] = useState('');
  const [saved, setSaved] = useState<ProposalSelection | null>(null);
  const [localRuns, setLocalRuns] = useState<Record<string, Run>>({});
  const [choices, setChoices] = useState<Proposal[]>([]);
  const [duration, setDuration] = useState(60);
  const [account, setAccount] = useState('');
  const [now, setNow] = useState(Date.now());
  const [historyTarget, setHistoryTarget] = useState<{ id: string; offset: number } | null>(null);
  const [history, setHistory] = useState<ProposalHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyEpoch = useRef(0);
  const invalidateEditor = useCallback(() => {
    editorEpoch.current++;
    editorRef.current = null;
    setEditor(null);
    setSaved(null);
    setBrief('');
    setBase('');
  }, []);
  const reconcile = useCallback(
    (next: ProposalSnapshot, verifiedEditor?: Proposal) => {
      const current = editorRef.current;
      if (current) {
        const p = next.proposals.find((row) => row.id === current.id) ?? verifiedEditor;
        if (!p || !eligible(p) || p.revision !== current.revision) invalidateEditor();
        else
          setSaved((s) =>
            s &&
            next.selections.some(
              (row) =>
                row.id === s.id && row.revokedAt === null && row.proposalRevision === p.revision,
            )
              ? s
              : null,
          );
      }
      setChoices((list) =>
        list.filter((p) =>
          next.proposals.some(
            (row) => row.id === p.id && row.revision === p.revision && eligible(row),
          ),
        ),
      );
      setData(next);
    },
    [invalidateEditor],
  );
  const load = useCallback(async () => {
    if (queryKey !== currentQuery.current) return;
    const epoch = ++queryEpoch.current;
    setLoading(true);
    try {
      let next = await api.proposals({
        ...(filter ? { state: filter } : {}),
        offset,
        limit: PAGE,
      });
      if (!alive.current || epoch !== queryEpoch.current) return;
      const current = editorRef.current;
      const editEpoch = editorEpoch.current;
      let verifiedEditor: Proposal | undefined;
      if (current && !next.proposals.some((row) => row.id === current.id)) {
        // Page/filter absence is not removal. Eligible states contain at most
        // 100 nonhidden records, so two bounded pages independently verify it.
        for (let proofOffset = 0; proofOffset < PAGE * 2; proofOffset += PAGE) {
          const proof = await api.proposals({
            state: current.state,
            offset: proofOffset,
            limit: PAGE,
          });
          if (
            !alive.current ||
            epoch !== queryEpoch.current ||
            editEpoch !== editorEpoch.current ||
            editorRef.current?.id !== current.id ||
            editorRef.current.revision !== current.revision
          )
            return;
          verifiedEditor = proof.proposals.find((row) => row.id === current.id);
          next = {
            ...next,
            selections: proof.selections,
            ballots: proof.ballots,
            grants: proof.grants,
          };
          if (verifiedEditor || proof.proposals.length < PAGE) break;
        }
      }
      if (alive.current && epoch === queryEpoch.current) reconcile(next, verifiedEditor);
    } catch (cause) {
      if (alive.current && epoch === queryEpoch.current) {
        setError(message(cause));
        invalidateEditor();
        setData(empty);
      }
    } finally {
      if (alive.current && epoch === queryEpoch.current) setLoading(false);
    }
  }, [filter, offset, queryKey, reconcile, invalidateEditor]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queryEpoch.current++;
      editorEpoch.current++;
      historyEpoch.current++;
    };
  }, []);
  useEffect(() => {
    // Invalidate known removed/replaced selection immediately, before the page reload.
    const incoming = studio.proposals;
    const current = editorRef.current;
    if (incoming && current) {
      const p = incoming.proposals.find((row) => row.id === current.id);
      const removed = p && (!eligible(p) || p.revision !== current.revision);
      const revoked = incoming.selections.some(
        (row) =>
          row.proposalId === current.id &&
          row.revokedAt !== null &&
          row.proposalRevision === current.revision,
      );
      if (removed || revoked) invalidateEditor();
    }
    if (incoming)
      setData((d) => ({
        ...d,
        proposals: d.proposals.map((p) => incoming.proposals.find((row) => row.id === p.id) ?? p),
        selections: d.selections.filter(
          (s) => !incoming.selections.some((row) => row.id === s.id && row.revokedAt !== null),
        ),
      }));
    void load();
  }, [load, studio.proposals, invalidateEditor]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!historyTarget) return;
    const epoch = ++historyEpoch.current;
    setHistory([]);
    setHistoryLoading(true);
    void api
      .proposalHistory(historyTarget.id, historyTarget.offset)
      .then(
        (result) => {
          if (alive.current && epoch === historyEpoch.current) setHistory(result.history);
        },
        (cause: unknown) => {
          if (alive.current && epoch === historyEpoch.current) setError(message(cause));
        },
      )
      .finally(() => {
        if (alive.current && epoch === historyEpoch.current) setHistoryLoading(false);
      });
  }, [historyTarget]);
  async function action(key: string, operation: () => Promise<void>, epoch?: number) {
    if (locks.current.has(key)) return;
    locks.current.add(key);
    setBusy(new Set(locks.current));
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (alive.current && (epoch === undefined || epoch === editorEpoch.current)) {
        setError(message(cause));
        if (cause instanceof ApiError && cause.status === 409) {
          // Save/generate failures are bound to this editor epoch. Moderation and
          // ballot conflicts concern their own records; only fresh proposal data
          // can invalidate whichever brief the creator is currently editing.
          if (epoch !== undefined) invalidateEditor();
          void load();
        }
      }
    } finally {
      locks.current.delete(key);
      if (alive.current) setBusy(new Set(locks.current));
    }
  }
  function review(p: Proposal) {
    editorEpoch.current++;
    editorRef.current = p;
    setEditor(p);
    const previous = data.selections.find(
      (s) => s.proposalId === p.id && s.proposalRevision === p.revision && s.revokedAt === null,
    );
    setSaved(previous ?? null);
    setBrief(previous?.brief ?? p.text);
    // Audience ideas usually change what is already on stream: default to editing the
    // one live interaction, never guessing between several.
    const live = studio.automations.filter((a) => a.status === 'live' && a.activeVersionId);
    setBase(
      previous
        ? (previous.baseVersionId ?? '')
        : live.length === 1
          ? (live[0]?.activeVersionId ?? '')
          : '',
    );
    setError(null);
  }
  function changeDraft(text: string, version: string) {
    editorEpoch.current++;
    setSaved(null);
    setBrief(text);
    setBase(version);
  }
  const visibleSelections = data.selections.filter(
    (s) =>
      s.revokedAt === null &&
      data.proposals.some(
        (p) => p.id === s.proposalId && eligible(p) && p.revision === s.proposalRevision,
      ),
  );
  const allRuns = { ...localRuns, ...runs };
  const currentRun = saved
    ? Object.values(allRuns).find((r) => r.selectionId === saved.id)
    : undefined;
  const open = data.ballots.find((b) => b.closedAt === null && b.deadlineAt > now);
  const nav = (nextFilter: typeof filter, nextOffset: number) => {
    queryEpoch.current++;
    invalidateEditor();
    setChoices([]);
    setFilter(nextFilter);
    setOffset(nextOffset);
  };
  const counts = data.counts;
  const total = counts
    ? counts.pending + counts.shortlisted + counts.selected + counts.hidden
    : undefined;
  const recent = data.ballots.filter((b) => b !== open).slice(0, 3);
  const quiet = !loading && total === 0 && data.ballots.length === 0 && !editor;
  const step = !saved ? 1 : !currentRun?.result?.versionId ? 2 : 3;
  const runText = currentRun
    ? (RUN_TEXT[currentRun.stage] ?? currentRun.stage) +
      (currentRun.result?.error ? ` · ${currentRun.result.error}` : '')
    : null;
  const editIdea = (p: Proposal) => {
    review(p);
    requestAnimationFrame(() => {
      const panel = document.getElementById('proposal-editor');
      panel?.scrollIntoView?.({ block: 'nearest' });
      document.getElementById('proposal-brief')?.focus({ preventScroll: true });
    });
  };
  const moderateRow = (p: Proposal, act: 'shortlist' | 'hide' | 'restore') => {
    if (act !== 'shortlist') {
      if (editorRef.current?.id === p.id) invalidateEditor();
      setChoices((rows) => rows.filter((c) => c.id !== p.id));
    }
    void action(p.id, async () => {
      const result = await api.moderateProposal(p.id, p.revision, act);
      setData((d) => ({
        ...d,
        proposals: d.proposals.map((row) =>
          row.id === p.id && result.proposal.revision >= row.revision
            ? { ...row, ...result.proposal }
            : row,
        ),
      }));
      await refresh();
    });
  };
  const tabs: { value: Proposal['state'] | ''; label: string; count?: number }[] = [
    { value: '', label: 'All', ...(total === undefined ? {} : { count: total }) },
    { value: 'pending', label: 'To review', ...(counts ? { count: counts.pending } : {}) },
    {
      value: 'shortlisted',
      label: 'Shortlisted',
      ...(counts ? { count: counts.shortlisted } : {}),
    },
    { value: 'selected', label: 'Selected', ...(counts ? { count: counts.selected } : {}) },
    { value: 'hidden', label: 'Hidden', ...(counts ? { count: counts.hidden } : {}) },
  ];
  return (
    <section
      className={`card proposal-inbox${quiet ? ' quiet' : ''}`}
      aria-label="Audience inbox"
      aria-busy={loading}
    >
      <header className="card-head">
        <div>
          <p className="step-label">Audience · you decide</p>
          <h2>Audience ideas</h2>
        </div>
        <div className="inbox-head-actions">
          {counts && counts.pending > 0 && (
            <span className="badge warn">{counts.pending} to review</span>
          )}
          {open && <span className="badge vote-open">Vote open</span>}
          <button
            type="button"
            className="button ghost small"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh inbox"
          >
            ↻ Refresh
          </button>
        </div>
      </header>
      {quiet ? (
        <p className="inbox-empty">
          No ideas yet. Viewers type <code>!riff suggest &lt;idea&gt;</code> in chat; ideas stay
          private here until you shortlist them.
        </p>
      ) : (
        <p className="hint">
          Viewers suggest and vote; you decide. Nothing is built or goes live until you generate,
          rehearse and approve it.
        </p>
      )}
      <details className="proposal-guidance">
        <summary>How viewers take part</summary>
        <dl className="guidance-grid">
          <dt>
            <code>!riff suggest &lt;idea&gt;</code>
          </dt>
          <dd>Suggest an idea (8–500 characters). Matching ideas are grouped.</dd>
          <dt>
            <code>!riff vote &lt;ballot&gt; &lt;option&gt;</code>
          </dt>
          <dd>
            Vote once per ballot, e.g. <code>!riff vote 3 2</code>. The first vote counts.
          </dd>
          <dt>
            <code>!riff credit on|off</code>
          </dt>
          <dd>
            Credit is off by default. Chat messages are already public on Twitch; turning credit off
            removes the name from Riff, not the chat message.
          </dd>
          <dt>
            <code>!riff shortlist|hide &lt;#&gt;</code>
          </dt>
          <dd>For you and moderators you grant below, using the idea number shown here.</dd>
        </dl>
        <p className="hint">
          Limits: 3 ideas per viewer and 20 per channel each minute, 100 open ideas, one vote at a
          time with up to five options for 15 s–10 min. Ideas waiting for review and hidden ideas
          never appear on stream.
        </p>
      </details>
      {error && (
        <p className="answer bad" role="alert">
          {error}
        </p>
      )}
      {editor && (
        <div
          id="proposal-editor"
          className="proposal-editor"
          role="region"
          aria-label="Turn an idea into an interaction"
        >
          <div className="editor-head">
            <div>
              <p className="step-label">
                Idea {editor.number ? `#${editor.number}` : ''} · turn it into an interaction
              </p>
              <ol className="idea-steps" aria-label="Progress">
                {['Review the brief', 'Generate a candidate', 'Test, rehearse & approve'].map(
                  (label, index) => (
                    <li
                      key={label}
                      data-state={
                        index + 1 < step ? 'done' : index + 1 === step ? 'current' : 'todo'
                      }
                      aria-current={index + 1 === step ? 'step' : undefined}
                    >
                      <span>{index + 1 < step ? '✓' : index + 1}</span>
                      {label}
                    </li>
                  ),
                )}
              </ol>
            </div>
            <button type="button" className="button ghost small" onClick={invalidateEditor}>
              Close brief
            </button>
          </div>
          <label htmlFor="proposal-brief">Reviewed brief</label>
          <p className="hint" id="proposal-brief-help">
            Tidy the viewer's words into what you want built. Codex treats the brief as a request,
            never as instructions that override Riff's rules.
          </p>
          <textarea
            id="proposal-brief"
            aria-describedby="proposal-brief-help"
            value={brief}
            maxLength={500}
            rows={3}
            onChange={(e) => changeDraft(e.target.value, base)}
          />
          <div className="editor-row">
            <label htmlFor="proposal-base">
              Build as
              <select
                id="proposal-base"
                value={base}
                onChange={(e) => changeDraft(brief, e.target.value)}
              >
                <option value="">A new interaction</option>
                {studio.automations.flatMap((a) =>
                  a.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      An edit of {v.title} v{v.number}
                      {a.activeVersionId === v.id ? ' (live)' : ` (${v.status})`}
                    </option>
                  )),
                )}
              </select>
            </label>
            <span className={`hint counter${brief.length > 480 ? ' warn-text' : ''}`}>
              {brief.length}/500
            </span>
          </div>
          <div className="proposal-actions">
            <button
              type="button"
              className={`button small ${saved ? 'ghost' : 'primary'}`}
              disabled={
                loading ||
                busy.has('save') ||
                brief.trim().length < 8 ||
                Boolean(saved && !currentRun?.result)
              }
              onClick={() => {
                const epoch = editorEpoch.current;
                void action(
                  'save',
                  async () => {
                    const result = await api.selectProposal(
                      editor.id,
                      editor.revision,
                      brief.trim(),
                      base || null,
                    );
                    if (!alive.current || epoch !== editorEpoch.current) return;
                    const next = {
                      ...editor,
                      revision: result.selection.proposalRevision,
                      state: 'selected' as const,
                    };
                    editorRef.current = next;
                    setEditor(next);
                    setSaved(result.selection);
                    setData((d) => ({
                      ...d,
                      proposals: d.proposals.map((p) => (p.id === next.id ? next : p)),
                      selections: [
                        result.selection,
                        ...d.selections.filter((s) => s.proposalId !== next.id),
                      ],
                    }));
                    await refresh();
                  },
                  epoch,
                );
              }}
            >
              {busy.has('save')
                ? 'Saving…'
                : saved && currentRun?.result
                  ? 'Save new selection'
                  : 'Save selection'}
            </button>
            {saved && (
              <>
                <button
                  type="button"
                  className={`button small ${currentRun ? 'ghost' : 'primary'}`}
                  disabled={
                    loading ||
                    studio.panic ||
                    busy.has(`generate-${saved.id}`) ||
                    Boolean(currentRun)
                  }
                  onClick={() => {
                    const selection = saved;
                    const epoch = editorEpoch.current;
                    void action(
                      `generate-${selection.id}`,
                      async () => {
                        const run = await api.generateSelection(selection.id);
                        if (!alive.current || epoch !== editorEpoch.current) return;
                        const linked = { ...run, selectionId: selection.id };
                        setLocalRuns((r) => ({ ...r, [run.id]: linked }));
                        onRun(linked);
                        await refresh();
                      },
                      epoch,
                    );
                  }}
                >
                  {busy.has(`generate-${saved.id}`)
                    ? 'Starting generation…'
                    : 'Generate selected brief'}
                </button>
                {currentRun?.result?.versionId && (
                  <button
                    type="button"
                    className="button small primary"
                    onClick={() => {
                      const id = currentRun.result?.versionId;
                      if (id) {
                        onRun(currentRun);
                        onReview(id);
                      }
                    }}
                  >
                    Review & approve candidate
                  </button>
                )}
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy.has(`revoke-${saved.id}`)}
                  onClick={() => {
                    const id = saved.id;
                    invalidateEditor();
                    void action(`revoke-${id}`, async () => {
                      await api.revokeSelection(id);
                      await load();
                      await refresh();
                    });
                  }}
                >
                  Revoke selection
                </button>
              </>
            )}
          </div>
          <p className="hint" role="status">
            {studio.panic
              ? 'Generation is paused while everything is stopped. Ideas stay private until you resume.'
              : runText
                ? `${runText}. Follow progress and evidence in steps 1–4 below.`
                : saved
                  ? 'Selection saved. Generating spends one compile for this selection only.'
                  : 'Saving records exactly what you chose. It does not build anything yet.'}
          </p>
        </div>
      )}
      <div className="inbox-grid">
        <div className="inbox-ideas">
          <div className="inbox-tabs" role="tablist" aria-label="Proposal state">
            {tabs.map((tab) => (
              <button
                key={tab.value || 'all'}
                type="button"
                role="tab"
                aria-selected={filter === tab.value}
                className="inbox-tab"
                onClick={() => {
                  if (filter !== tab.value) nav(tab.value, 0);
                }}
              >
                {tab.label}
                {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
              </button>
            ))}
          </div>
          <p className="sr-only" role="status">
            {loading
              ? 'Loading proposals…'
              : `${data.proposals.length} proposals · page ${offset / PAGE + 1}`}
          </p>
          <ul className="proposal-list">
            {data.proposals.map((p) => {
              const chosen = choices.some((c) => c.id === p.id);
              return (
                <li key={p.id} className="proposal-row" data-state={p.state}>
                  <div className="idea-main">
                    <div className="idea-meta">
                      {p.number ? <span className="idea-number">#{p.number}</span> : null}
                      <span className={`badge ${STATE[p.state].tone}`}>{STATE[p.state].label}</span>
                      <span className="hint">{ago(p.createdAt, now)}</span>
                    </div>
                    <p className="proposal-text">{p.text}</p>
                    <p className="hint">
                      {(p.contributorCount ?? 1) > 1
                        ? `Suggested by ${p.contributorCount} viewers`
                        : 'Suggested by 1 viewer'}
                    </p>
                  </div>
                  <div className="proposal-actions">
                    {p.state === 'pending' && (
                      <button
                        type="button"
                        className="button small"
                        disabled={loading || busy.has(p.id)}
                        onClick={() => moderateRow(p, 'shortlist')}
                      >
                        Shortlist
                      </button>
                    )}
                    {eligible(p) && (
                      <button
                        type="button"
                        className="button small"
                        disabled={loading}
                        onClick={() => editIdea(p)}
                      >
                        Review brief
                      </button>
                    )}
                    {eligible(p) && (
                      <label className={`proposal-choice${chosen ? ' on' : ''}`}>
                        <input
                          type="checkbox"
                          aria-label={`Include in ballot: ${p.text}`}
                          checked={chosen}
                          disabled={Boolean(open) || loading || (!chosen && choices.length >= 5)}
                          onChange={(e) =>
                            setChoices((rows) =>
                              e.target.checked ? [...rows, p] : rows.filter((c) => c.id !== p.id),
                            )
                          }
                        />
                        Add to vote
                      </label>
                    )}
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={loading || busy.has(p.id)}
                      onClick={() => moderateRow(p, p.state === 'hidden' ? 'restore' : 'hide')}
                    >
                      {p.state === 'hidden' ? 'Restore for review' : 'Hide'}
                    </button>
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => setHistoryTarget({ id: p.id, offset: 0 })}
                    >
                      History
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {!loading && !quiet && data.proposals.length === 0 && (
            <p className="inbox-empty">{EMPTY[filter || 'all']}</p>
          )}
          {(offset > 0 || data.proposals.length >= PAGE) && (
            <nav className="proposal-pagination" aria-label="Proposal pages">
              <button
                type="button"
                className="button ghost small"
                disabled={loading || offset === 0}
                onClick={() => nav(filter, offset - PAGE)}
              >
                Previous proposals
              </button>
              <span className="hint">Page {offset / PAGE + 1}</span>
              <button
                type="button"
                className="button ghost small"
                disabled={loading || data.proposals.length < PAGE}
                onClick={() => nav(filter, offset + PAGE)}
              >
                Next proposals
              </button>
            </nav>
          )}
          {historyTarget && (
            <div className="proposal-detail" role="region" aria-label="Moderation history">
              <h3>
                Private history
                {(() => {
                  const n = data.proposals.find((p) => p.id === historyTarget.id)?.number;
                  return n ? ` · idea #${n}` : '';
                })()}
              </h3>
              {historyLoading ? (
                <p role="status">Loading history…</p>
              ) : history.length === 0 ? (
                <p className="hint">No moderation yet.</p>
              ) : (
                <ul className="history-list">
                  {history.map((row) => (
                    <li key={row.id}>
                      <b>{row.actor === 'creator' ? 'You' : `Moderator ${row.actor}`}</b> ·{' '}
                      {ACTION[row.action] ?? row.action}
                      <span className="hint">
                        {' '}
                        · {new Date(row.at).toLocaleTimeString([], { timeStyle: 'short' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="proposal-actions">
                {(historyTarget.offset > 0 || history.length >= PAGE) && (
                  <>
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={historyLoading || historyTarget.offset === 0}
                      onClick={() =>
                        setHistoryTarget({ ...historyTarget, offset: historyTarget.offset - PAGE })
                      }
                    >
                      Previous history
                    </button>
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={historyLoading || history.length < PAGE}
                      onClick={() =>
                        setHistoryTarget({ ...historyTarget, offset: historyTarget.offset + PAGE })
                      }
                    >
                      Next history
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="button small ghost"
                  onClick={() => {
                    historyEpoch.current++;
                    setHistoryTarget(null);
                    setHistory([]);
                  }}
                >
                  Close history
                </button>
              </div>
            </div>
          )}
        </div>
        <aside className="inbox-side">
          <section className="side-card" aria-label="Chat vote">
            <h3>Chat vote</h3>
            {open ? (
              <BallotCard
                ballot={open}
                now={now}
                proposals={data.proposals}
                busy={busy.has(open.id)}
                onUse={editIdea}
                onClose={() =>
                  void action(open.id, async () => {
                    await api.closeProposalBallot(open.id, open.revision);
                    await load();
                    await refresh();
                  })
                }
              />
            ) : (
              <>
                <p className="hint">
                  Pick up to five shortlisted ideas with “Add to vote”. Votes are advice: you can
                  build any shortlisted idea, whatever the result.
                </p>
                {choices.length > 0 ? (
                  <ol className="vote-picks">
                    {choices.map((p) => (
                      <li key={p.id}>
                        <span>{p.text}</span>
                        <button
                          type="button"
                          className="button small ghost"
                          aria-label={`Remove from vote: ${p.text}`}
                          onClick={() => setChoices((rows) => rows.filter((c) => c.id !== p.id))}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="vote-empty">No ideas picked yet · 0/5</p>
                )}
                <fieldset className="duration">
                  <legend>Voting time</legend>
                  {DURATIONS.map(([seconds, label]) => (
                    <label key={seconds} className={duration === seconds ? 'on' : ''}>
                      <input
                        type="radio"
                        name="ballot-duration"
                        value={seconds}
                        checked={duration === seconds}
                        onChange={() => setDuration(seconds)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <button
                  type="button"
                  className="button small primary wide"
                  disabled={loading || choices.length === 0 || busy.has('ballot')}
                  onClick={() =>
                    void action('ballot', async () => {
                      await api.createProposalBallot(
                        choices.map((p) => ({ id: p.id, revision: p.revision })),
                        duration,
                      );
                      setChoices([]);
                      await load();
                      await refresh();
                    })
                  }
                >
                  {choices.length
                    ? `Start vote · ${choices.length} option${choices.length === 1 ? '' : 's'}`
                    : 'Start vote'}
                </button>
              </>
            )}
            {recent.length > 0 && (
              <div className="recent-votes">
                <h4>Recent results</h4>
                {recent.map((ballot) => (
                  <BallotCard
                    key={ballot.id}
                    ballot={ballot}
                    now={now}
                    proposals={data.proposals}
                    busy={false}
                    onUse={editIdea}
                  />
                ))}
              </div>
            )}
          </section>
          {visibleSelections.length > 0 && (
            <section className="side-card" aria-label="Saved selections">
              <h3>Your selections</h3>
              <ul className="selection-list">
                {visibleSelections.map((s) => {
                  const run = Object.values(allRuns).find((r) => r.selectionId === s.id);
                  const status =
                    studio.community?.selections.find((item) => item.id === s.id)?.status ??
                    (run ? undefined : 'selected');
                  const label = status
                    ? SELECTION_TEXT[status]
                    : run
                      ? (RUN_TEXT[run.stage] ?? run.stage)
                      : 'Selected';
                  return (
                    <li key={s.id}>
                      <p>{s.brief}</p>
                      <p className="hint">
                        <span className={`badge ${status === 'applied' ? 'good' : ''}`}>
                          {label}
                        </span>{' '}
                        {s.baseVersionId ? 'Edits an existing version' : 'New interaction'}
                      </p>
                      {run?.result?.versionId && (
                        <button
                          type="button"
                          className="button small ghost"
                          disabled={loading}
                          onClick={() => {
                            const id = run.result?.versionId;
                            if (id) {
                              onRun(run);
                              onReview(id);
                            }
                          }}
                        >
                          Review candidate
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <details className="side-card proposal-detail">
            <summary>Moderators · {data.grants.length} granted</summary>
            <p className="hint">
              A Twitch moderator badge alone is not enough: grant Riff access so they can{' '}
              <code>!riff shortlist</code> or <code>!riff hide</code> by idea number. Grants never
              allow selecting, generating or going live.
            </p>
            <form
              className="grant-form"
              onSubmit={(e) => {
                e.preventDefault();
                const id = account.trim();
                if (!id) return;
                void action('grant', async () => {
                  await api.proposalGrant(id, true);
                  setAccount('');
                  await load();
                  await refresh();
                });
              }}
            >
              <label>
                Moderator account ID
                <input
                  aria-describedby="grant-help"
                  inputMode="numeric"
                  maxLength={128}
                  placeholder="e.g. 141981764"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                />
              </label>
              <button
                className="button small"
                disabled={busy.has('grant') || !account.trim() || data.grants.length >= 100}
              >
                Grant moderation
              </button>
            </form>
            <p className="hint" id="grant-help">
              The numeric Twitch user ID, not the display name. Up to 100 moderators.
            </p>
            {data.grants.length > 0 && (
              <ul className="grant-list">
                {data.grants.map((g) => (
                  <li key={g.id}>
                    <span className="mono">{g.accountId}</span>
                    <button
                      type="button"
                      className="button small ghost"
                      aria-label={`Revoke ${g.accountId}`}
                      disabled={busy.has(`grant-${g.id}`)}
                      onClick={() =>
                        void action(`grant-${g.id}`, async () => {
                          await api.proposalGrant(g.accountId, false);
                          await load();
                          await refresh();
                        })
                      }
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </aside>
      </div>
    </section>
  );
}

type Ballot = ProposalSnapshot['ballots'][number];
const DURATIONS: [number, string][] = [
  [30, '30 s'],
  [60, '1 min'],
  [120, '2 min'],
  [300, '5 min'],
  [600, '10 min'],
];
const STATE: Record<Proposal['state'], { label: string; tone: string }> = {
  pending: { label: 'To review', tone: 'warn' },
  shortlisted: { label: 'Shortlisted', tone: 'accent' },
  selected: { label: 'Selected', tone: 'good' },
  hidden: { label: 'Hidden', tone: 'muted' },
};
const EMPTY: Record<Proposal['state'] | 'all', string> = {
  all: 'No ideas yet. Viewers type !riff suggest <idea> in chat.',
  pending: 'Nothing to review. New chat ideas land here first, privately.',
  shortlisted: 'No shortlisted ideas. Shortlist ideas to put them to a vote or build one.',
  selected: 'No selected ideas yet. Use “Review brief” on a shortlisted idea.',
  hidden: 'No hidden ideas.',
};
const ACTION: Record<string, string> = {
  shortlist: 'Shortlisted',
  hide: 'Hidden',
  restore: 'Restored for review',
  select: 'Selected with a brief',
};
const RUN_TEXT: Partial<Record<Run['stage'], string>> = {
  queued: 'Waiting to generate',
  drafting: 'Codex is drafting',
  verifying: 'Running tests',
  repairing: 'Repairing a failed check',
  ready: 'Candidate ready to review',
  question: 'Codex needs a clarification',
  unsupported: 'Not supported',
  failed: 'Generation failed',
  cancelled: 'Generation stopped',
};
const SELECTION_TEXT: Record<string, string> = {
  selected: 'Selected',
  queued: 'Waiting to generate',
  generating: 'Generating',
  candidate: 'Candidate ready',
  applied: 'Live',
  failed: 'Not built',
};
function ago(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}
function clock(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Live tally or closed result; votes advise, and any eligible option can be built. */
function BallotCard({
  ballot,
  now,
  proposals,
  busy,
  onUse,
  onClose,
}: {
  ballot: Ballot;
  now: number;
  proposals: Proposal[];
  busy: boolean;
  onUse: (p: Proposal) => void;
  onClose?: () => void;
}) {
  const active = ballot.closedAt === null && ballot.deadlineAt > now;
  const options = ballot.options ?? [];
  const votes = options.reduce((sum, o) => sum + o.votes, 0);
  const max = Math.max(0, ...options.map((o) => o.votes));
  const tied = max > 0 && options.filter((o) => o.votes === max).length > 1;
  const label = ballot.number ? String(ballot.number) : ballot.id;
  return (
    <article className="proposal-ballot" data-active={active}>
      <p className="ballot-head">
        <b>
          {active
            ? `Vote ${ballot.number ? `#${ballot.number}` : ''} · ${clock(ballot.deadlineAt - now)} left`
            : `Vote ${ballot.number ? `#${ballot.number}` : ''} · closed`}
        </b>
        <span className="hint">
          {votes} {votes === 1 ? 'vote' : 'votes'}
          {!active && (tied ? ' · Tie · creator decides' : ' · Creator decides')}
        </span>
      </p>
      {active && (
        <p className="ballot-command">
          Chat types <code>!riff vote {label} &lt;option&gt;</code>
        </p>
      )}
      <ol className="ballot-options">
        {options.map((o) => {
          const p = proposals.find((row) => row.id === o.proposalId);
          const share = votes ? Math.round((o.votes / votes) * 100) : 0;
          return (
            <li
              key={o.option}
              value={o.option}
              data-leading={max > 0 && o.votes === max ? 'true' : undefined}
              style={{ '--share': `${share}%` } as CSSProperties}
            >
              <span className="opt-key">{o.option}</span>
              <span className="opt-text">
                {p?.text ?? 'Idea outside this view'}
                {p && !eligible(p) && <span className="hint"> · no longer eligible</span>}
              </span>
              <span className="opt-votes">
                {o.votes} · {share}%
              </span>
              {p && eligible(p) && (
                <button
                  type="button"
                  className="button small ghost"
                  aria-label={`Review option ${o.option}`}
                  onClick={() => onUse(p)}
                >
                  Use
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {active && onClose && (
        <button type="button" className="button small ghost" disabled={busy} onClick={onClose}>
          End vote now
        </button>
      )}
    </article>
  );
}
