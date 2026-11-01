import { useCallback, useEffect, useRef, useState } from 'react';
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
    if (cause.status === 409)
      return `${cause.message} Refresh and review the latest revision before trying again.`;
    if (cause.status === 429) return `${cause.message} Wait for capacity before trying again.`;
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
    setBase(previous?.baseVersionId ?? '');
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
  return (
    <section className="card proposal-inbox" aria-label="Audience inbox">
      <header className="card-head">
        <div>
          <p className="step-label">Community · creator control</p>
          <h2>Audience inbox</h2>
        </div>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh inbox
        </button>
      </header>
      <p className="hint">
        Suggestions and votes are advisory. Only you save a reviewed brief, generate a candidate,
        rehearse, and approve it.
      </p>
      <details className="proposal-guidance">
        <summary>Chat commands, privacy & limits</summary>
        <p>
          <code>!riff suggest &lt;text&gt;</code> ·{' '}
          <code>!riff vote &lt;ballot-id&gt; &lt;option&gt;</code> ·{' '}
          <code>!riff credit on|off</code>
        </p>
        <p>
          Credit defaults off. Chat submissions are already public on Twitch; credit off removes
          Riff attribution, not the original chat message. Pending and hidden ideas stay off the
          Riff overlay.
        </p>
        <p>
          8–500 characters; 3 suggestion attempts per account and 20 per channel in a rolling
          minute, including duplicates. Up to 100 visible proposals, 1,000 contributors per group,
          five ballot options, one open ballot, 15–600 seconds and 10,000 first valid votes. Ballots
          never select or generate automatically.
        </p>
      </details>
      {error && (
        <p className="answer bad" role="alert">
          {error}
        </p>
      )}
      <div className="proposal-toolbar">
        <label>
          View
          <select
            aria-label="Proposal state"
            value={filter}
            onChange={(e) => nav(e.target.value as typeof filter, 0)}
          >
            <option value="">All proposals</option>
            <option value="pending">Pending</option>
            <option value="shortlisted">Shortlisted</option>
            <option value="selected">Selected</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
        <p className="hint" role="status">
          {loading
            ? 'Loading proposals…'
            : `${data.proposals.length} proposals · page ${offset / PAGE + 1}`}
        </p>
      </div>
      <ul className="proposal-list" aria-busy={loading}>
        {data.proposals.map((p) => (
          <li key={p.id} className="proposal-row" data-state={p.state}>
            <div>
              <span className="pill muted">
                {p.state} · r{p.revision}
              </span>
              <p className="proposal-text">{p.text}</p>
              <p className="hint">{p.contributorCount ?? 1} contributors · grouped suggestion</p>
            </div>
            <div className="proposal-actions">
              {eligible(p) && (
                <label className="proposal-choice">
                  <input
                    type="checkbox"
                    aria-label={`Include in ballot: ${p.text}`}
                    checked={choices.some((c) => c.id === p.id)}
                    disabled={
                      Boolean(open) ||
                      loading ||
                      (!choices.some((c) => c.id === p.id) && choices.length >= 5)
                    }
                    onChange={(e) =>
                      setChoices((rows) =>
                        e.target.checked ? [...rows, p] : rows.filter((c) => c.id !== p.id),
                      )
                    }
                  />
                  Ballot
                </label>
              )}
              {p.state === 'pending' && (
                <button
                  type="button"
                  className="button small ghost"
                  disabled={loading || busy.has(p.id)}
                  onClick={() =>
                    void action(p.id, async () => {
                      const result = await api.moderateProposal(p.id, p.revision, 'shortlist');
                      setData((d) => ({
                        ...d,
                        proposals: d.proposals.map((row) =>
                          row.id === p.id && result.proposal.revision >= row.revision
                            ? { ...row, ...result.proposal }
                            : row,
                        ),
                      }));
                      await refresh();
                    })
                  }
                >
                  Shortlist
                </button>
              )}
              {eligible(p) && (
                <button
                  type="button"
                  className="button small ghost"
                  disabled={loading}
                  onClick={() => review(p)}
                >
                  Review brief
                </button>
              )}
              <button
                type="button"
                className="button small ghost"
                disabled={loading || busy.has(p.id)}
                onClick={() => {
                  if (editorRef.current?.id === p.id) invalidateEditor();
                  setChoices((rows) => rows.filter((c) => c.id !== p.id));
                  void action(p.id, async () => {
                    const result = await api.moderateProposal(
                      p.id,
                      p.revision,
                      p.state === 'hidden' ? 'restore' : 'hide',
                    );
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
                }}
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
        ))}
      </ul>
      {!loading && data.proposals.length === 0 && (
        <p className="hint">No proposals in this view. Ask chat to suggest an idea.</p>
      )}
      <nav className="proposal-pagination" aria-label="Proposal pages">
        <button
          type="button"
          className="button ghost small"
          disabled={loading || offset === 0}
          onClick={() => nav(filter, offset - PAGE)}
        >
          Previous proposals
        </button>
        <button
          type="button"
          className="button ghost small"
          disabled={loading || data.proposals.length < PAGE}
          onClick={() => nav(filter, offset + PAGE)}
        >
          Next proposals
        </button>
      </nav>
      {historyTarget && (
        <div className="proposal-detail" aria-label="Moderation history">
          <h3>Private moderation history</h3>
          <p className="hint">Proposal {historyTarget.id}</p>
          {historyLoading ? (
            <p role="status">Loading history…</p>
          ) : (
            <ul>
              {history.map((row) => (
                <li key={row.id}>
                  {row.actor} · {row.action} · revision {row.revision} ·{' '}
                  {new Date(row.at).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
          <div className="proposal-actions">
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
      <details className="proposal-detail">
        <summary>Moderator grants · {data.grants.length}/100</summary>
        <p className="hint">
          A Twitch moderator badge also requires a Riff grant to shortlist or hide via chat. Grants
          never allow selection, generation, or activation. Broadcaster moderation remains
          available.
        </p>
        <form
          className="proposal-toolbar"
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
              aria-label="Moderator account ID"
              maxLength={128}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
          <button
            className="button small ghost"
            disabled={busy.has('grant') || !account.trim() || data.grants.length >= 100}
          >
            Grant moderation
          </button>
        </form>
        <ul>
          {data.grants.map((g) => (
            <li key={g.id} className="proposal-toolbar">
              <span>{g.accountId}</span>
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
      </details>
      <div className="proposal-detail">
        <h3>Advisory ballot</h3>
        <p className="hint">
          Choose up to five shortlisted ideas, on this page. First valid vote is final. You can
          select any eligible idea regardless of rank.
        </p>
        <div className="proposal-toolbar">
          <label>
            Duration (seconds)
            <input
              type="number"
              min={15}
              max={600}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="button small ghost"
            disabled={
              Boolean(open) ||
              loading ||
              choices.length === 0 ||
              duration < 15 ||
              duration > 600 ||
              !Number.isInteger(duration) ||
              busy.has('ballot')
            }
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
            Open ballot
          </button>
        </div>
        <div className="proposal-ballots">
          {data.ballots.map((ballot) => {
            const active = ballot.closedAt === null && ballot.deadlineAt > now;
            const options = ballot.options ?? [];
            const max = Math.max(0, ...options.map((o) => o.votes));
            const tied = options.filter((o) => o.votes === max).length > 1;
            return (
              <article key={ballot.id} className="proposal-ballot">
                <p>
                  <b>
                    {active
                      ? `Open · ${Math.ceil((ballot.deadlineAt - now) / 1000)}s left`
                      : 'Closed'}
                  </b>{' '}
                  · {ballot.closedAt !== null && tied ? 'Tie · creator decides' : 'Creator decides'}
                </p>
                <p className="hint mono">
                  {active ? `!riff vote ${ballot.id} <option>` : ballot.id}
                </p>
                <ol>
                  {options.map((o) => {
                    const p = data.proposals.find((p) => p.id === o.proposalId);
                    return (
                      <li key={o.option} value={o.option}>
                        {p?.text ?? 'Private option (outside this view)'} · {o.votes} votes
                        {p && eligible(p) && (
                          <button
                            type="button"
                            className="button small ghost"
                            onClick={() => review(p)}
                          >
                            Review option {o.option}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
                {active && (
                  <button
                    type="button"
                    className="button small ghost"
                    disabled={busy.has(ballot.id)}
                    onClick={() =>
                      void action(ballot.id, async () => {
                        await api.closeProposalBallot(ballot.id, ballot.revision);
                        await load();
                        await refresh();
                      })
                    }
                  >
                    Close ballot
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {editor && (
        <div className="proposal-detail proposal-editor">
          <h3>Review selected brief</h3>
          <p className="hint">
            Proposal r{editor.revision}. Saving creates immutable provenance; it does not compile.
            Editing again requires a new selection.
          </p>
          <label htmlFor="proposal-brief">Reviewed brief</label>
          <textarea
            id="proposal-brief"
            value={brief}
            maxLength={500}
            rows={3}
            onChange={(e) => changeDraft(e.target.value, base)}
          />
          <label htmlFor="proposal-base">Base version</label>
          <select
            id="proposal-base"
            value={base}
            onChange={(e) => changeDraft(brief, e.target.value)}
          >
            <option value="">New interaction</option>
            {studio.automations
              .flatMap((a) => a.versions)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title} · v{v.number} · {v.status}
                </option>
              ))}
          </select>
          <p className="hint">
            {brief.length}/500 characters · Generating produces a candidate for the existing tests,
            private rehearsal, and approval flow.
          </p>
          <div className="proposal-actions">
            <button
              type="button"
              className="button primary small"
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
                  className="button primary small"
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
            <button type="button" className="button ghost small" onClick={invalidateEditor}>
              Close brief
            </button>
          </div>
          {studio.panic && (
            <p className="hint">
              Generation is paused while the channel is stopped. Proposals remain private until
              resume.
            </p>
          )}
          {currentRun && (
            <p role="status">
              Generation: {currentRun.stage}
              {currentRun.result?.error ? ` · ${currentRun.result.error}` : ''}. Follow the
              authoring progress and evidence below.
            </p>
          )}
        </div>
      )}
      {visibleSelections.length > 0 && (
        <div className="proposal-detail">
          <h3>Saved selections & results</h3>
          <ul>
            {visibleSelections.map((s) => {
              const run = Object.values(allRuns).find((r) => r.selectionId === s.id);
              const publicStatus = studio.community?.selections.find(
                (item) => item.id === s.id,
              )?.status;
              return (
                <li key={s.id}>
                  <p>{s.brief}</p>
                  <p className="hint">
                    {publicStatus ?? run?.stage ?? 'selected'} ·{' '}
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
        </div>
      )}
    </section>
  );
}
