// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/console/app.js';
import { ProposalInbox } from '../src/console/proposals/inbox.js';
import { api, ApiError } from '../src/lib/api.js';

const proposal = (id = 'p1', state = 'shortlisted', revision = 2) => ({
  id,
  channelId: 'c',
  text: `Change ${id} to !splat and add two throws`,
  normalizedText: 'change',
  state,
  revision,
  contributorCount: 3,
  createdAt: 1,
  updatedAt: 1,
});
const snapshot = (proposals = [proposal()]) => ({
  proposals,
  grants: [{ id: 'g', accountId: 'mod1', channelId: 'c', createdAt: 1 }],
  selections: [],
  ballots: [],
});
const selection = {
  id: 's1',
  channelId: 'c',
  proposalId: 'p1',
  proposalRevision: 3,
  brief: 'Reviewed two extra throws',
  baseVersionId: null,
  createdAt: 2,
  revokedAt: null,
};
const props = () => ({
  studio: { proposals: snapshot(), automations: [], runs: [], panic: false },
  runs: {},
  onRun: vi.fn(),
  onReview: vi.fn(),
  refresh: vi.fn(async () => undefined),
});
// Fixtures deliberately keep wire-only identities in the private console.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(extra: Record<string, unknown> = {}) {
  const p = { ...props(), ...extra };
  vi.spyOn(api, 'proposals').mockResolvedValue(snapshot() as never);
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  return p;
}
it('groups duplicates, uses exact moderation revision and exposes private history pages', async () => {
  vi.spyOn(api, 'moderateProposal').mockResolvedValue({
    proposal: proposal('p1', 'hidden', 3),
  } as never);
  vi.spyOn(api, 'proposalHistory').mockResolvedValue({
    history: [{ id: 1, actor: 'creator', action: 'shortlist', revision: 2, at: 1 }],
  } as never);
  setup();
  expect(await screen.findByText('3 contributors · grouped suggestion')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  expect(await screen.findByText(/creator · shortlist/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  await waitFor(() => expect(api.moderateProposal).toHaveBeenCalledWith('p1', 2, 'hide'));
});
it('manages explicit moderator grants and explains badges alone do not authorize', async () => {
  vi.spyOn(api, 'proposalGrant').mockResolvedValue({ ok: true });
  setup();
  expect(await screen.findByText(/Twitch moderator badge/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Moderator account ID'), { target: { value: 'mod2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant moderation' }));
  await waitFor(() => expect(api.proposalGrant).toHaveBeenCalledWith('mod2', true));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke mod1' }));
  await waitFor(() => expect(api.proposalGrant).toHaveBeenCalledWith('mod1', false));
});
it('saves an edited selection without generating and only generates on a separate deliberate click', async () => {
  vi.spyOn(api, 'selectProposal').mockResolvedValue({ selection } as never);
  vi.spyOn(api, 'generateSelection').mockResolvedValue({
    id: 'run1',
    stage: 'queued',
    selectionId: 's1',
  } as never);
  const p = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Review brief' }));
  fireEvent.change(screen.getByLabelText('Reviewed brief'), { target: { value: selection.brief } });
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  await screen.findByRole('button', { name: 'Generate selected brief' });
  expect(api.selectProposal).toHaveBeenCalledWith('p1', 2, selection.brief, null);
  expect(api.generateSelection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Generate selected brief' }));
  await waitFor(() =>
    expect(p.onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run1' })),
  );
});
it('drops a delayed selection after switching proposals and prevents double save', async () => {
  let resolve!: (v: unknown) => void;
  vi.spyOn(api, 'selectProposal').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const list = snapshot([proposal(), proposal('p2')]);
  vi.spyOn(api, 'proposals').mockResolvedValue(list as never);
  const p = props();
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Review brief' })).toHaveLength(2),
  );
  const review = screen.getAllByRole('button', { name: 'Review brief' });
  fireEvent.click(review[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
  expect(api.selectProposal).toHaveBeenCalledTimes(1);
  fireEvent.click(review[1]!);
  await act(async () => resolve({ selection }));
  expect((screen.getByLabelText('Reviewed brief') as HTMLTextAreaElement).value).toContain('p2');
  expect(screen.queryByRole('button', { name: 'Generate selected brief' })).toBeNull();
});
it('shows quota and stale errors without granting generation authority', async () => {
  vi.spyOn(api, 'moderateProposal').mockRejectedValue(
    new ApiError('Suggestion quota reached.', 429, 'CHANNEL_LIMIT'),
  );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('Suggestion quota reached.'),
  );
  expect(screen.queryByRole('button', { name: 'Generate selected brief' })).toBeNull();
});
it('paginates bounded private inbox and creates revision-bound advisory ballots', async () => {
  vi.spyOn(api, 'createProposalBallot').mockResolvedValue({ ballot: { id: 'b' } } as never);
  vi.spyOn(api, 'proposals').mockResolvedValue(
    snapshot(Array.from({ length: 50 }, (_, i) => proposal(`p${i}`))) as never,
  );
  const p = props();
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  await waitFor(() =>
    expect(screen.getAllByRole('checkbox', { name: /Include in ballot/ })).toHaveLength(50),
  );
  fireEvent.click(screen.getAllByRole('checkbox', { name: /Include in ballot/ })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Open ballot' }));
  await waitFor(() =>
    expect(api.createProposalBallot).toHaveBeenCalledWith([{ id: 'p0', revision: 2 }], 60),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next proposals' }));
  await waitFor(() =>
    expect(api.proposals).toHaveBeenCalledWith(expect.objectContaining({ offset: 50, limit: 50 })),
  );
});
it('shows closed ties, current open countdown, and closes against the ballot revision', async () => {
  const ballot = {
    id: 'b1',
    revision: 4,
    deadlineAt: Date.now() + 60000,
    closedAt: null,
    options: [
      { proposalId: 'p1', option: 1, votes: 3 },
      { proposalId: 'p2', option: 2, votes: 3 },
    ],
  };
  vi.spyOn(api, 'proposals').mockResolvedValue({
    ...snapshot(),
    ballots: [ballot, { ...ballot, id: 'b2', closedAt: 1 }],
  } as never);
  vi.spyOn(api, 'closeProposalBallot').mockResolvedValue({ ballot } as never);
  const p = props();
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  expect(await screen.findByText(/Tie · creator decides/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close ballot' }));
  await waitFor(() => expect(api.closeProposalBallot).toHaveBeenCalledWith('b1', 4));
});
it('hands ready selected runs to existing candidate review without activation', async () => {
  const row = { ...proposal(), state: 'selected', revision: 3 };
  const s = { ...snapshot([row]), selections: [selection] };
  vi.spyOn(api, 'proposals').mockResolvedValue(s as never);
  const p = {
    ...props(),
    studio: { ...props().studio, proposals: s },
    runs: {
      r: {
        id: 'r',
        selectionId: 's1',
        stage: 'ready',
        result: { versionId: 'v1', status: 'ready' },
      },
    },
  };
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review candidate' }));
  expect(p.onReview).toHaveBeenCalledWith('v1');
  expect(
    within(screen.getByLabelText('Audience inbox')).queryByRole('button', {
      name: /Activate|Approve/,
    }),
  ).toBeNull();
});
it('ignores a delayed stale save failure after the creator chooses another brief', async () => {
  let reject!: (reason: unknown) => void;
  vi.spyOn(api, 'selectProposal').mockImplementation(
    () =>
      new Promise((_r, j) => {
        reject = j;
      }),
  );
  vi.spyOn(api, 'proposals').mockResolvedValue(snapshot([proposal(), proposal('p2')]) as never);
  const p = props();
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Review brief' })).toHaveLength(2),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Review brief' })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Review brief' })[1]!);
  await act(async () => reject(new ApiError('Revision changed.', 409, 'STALE')));
  expect((screen.getByLabelText('Reviewed brief') as HTMLTextAreaElement).value).toContain('p2');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('immediately withdraws a saved brief when studio invalidation hides it, before reload returns', async () => {
  const s = {
    ...snapshot([{ ...proposal(), state: 'selected', revision: 3 }]),
    selections: [selection],
  };
  vi.spyOn(api, 'proposals').mockResolvedValue(s as never);
  const p = { ...props(), studio: { ...props().studio, proposals: s } };
  const { rerender } = render(
    <ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh inbox' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review brief' }));
  expect(screen.getByRole('button', { name: 'Generate selected brief' })).toBeTruthy();
  vi.mocked(api.proposals).mockImplementation(() => new Promise(() => undefined));
  const next = {
    ...p,
    studio: {
      ...p.studio,
      proposals: {
        ...s,
        proposals: [proposal('p1', 'hidden', 4)],
        selections: [{ ...selection, revokedAt: 4 }],
      },
    },
  };
  rerender(<ProposalInbox {...(next as unknown as Parameters<typeof ProposalInbox>[0])} />);
  expect(screen.queryByLabelText('Reviewed brief')).toBeNull();
  expect(screen.queryByText(selection.brief)).toBeNull();
});
it('ignores late generation after switching editor and prevents duplicate generation requests', async () => {
  let resolve!: (value: unknown) => void;
  const s = {
    ...snapshot([{ ...proposal(), state: 'selected', revision: 3 }, proposal('p2')]),
    selections: [selection],
  };
  vi.spyOn(api, 'proposals').mockResolvedValue(s as never);
  vi.spyOn(api, 'generateSelection').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const p = { ...props(), studio: { ...props().studio, proposals: s } };
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Review brief' })).toHaveLength(2),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh inbox' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Review brief' })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Generate selected brief' }));
  fireEvent.click(screen.getByRole('button', { name: 'Starting generation…' }));
  expect(api.generateSelection).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Review brief' })[1]!);
  await act(async () => resolve({ id: 'r', stage: 'queued' }));
  expect(p.onRun).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Reviewed brief') as HTMLTextAreaElement).value).toContain('p2');
});
it('editing a saved selection requires saving again before generation', async () => {
  const s = {
    ...snapshot([{ ...proposal(), state: 'selected', revision: 3 }]),
    selections: [selection],
  };
  vi.spyOn(api, 'proposals').mockResolvedValue(s as never);
  const p = { ...props(), studio: { ...props().studio, proposals: s } };
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh inbox' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review brief' }));
  fireEvent.change(screen.getByLabelText('Reviewed brief'), {
    target: { value: 'Different reviewed brief' },
  });
  expect(screen.queryByRole('button', { name: 'Generate selected brief' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Save selection' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it('ignores a superseded inbox page response', async () => {
  let resolve!: (value: unknown) => void;
  vi.spyOn(api, 'proposals')
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }) as never,
    )
    .mockResolvedValue(snapshot([proposal('new', 'hidden')]) as never);
  const p = props();
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  fireEvent.change(screen.getByLabelText('Proposal state'), { target: { value: 'hidden' } });
  expect(await screen.findByText('Change new to !splat and add two throws')).toBeTruthy();
  await act(async () => resolve(snapshot([proposal('old')])));
  expect(screen.queryByText('Change old to !splat and add two throws')).toBeNull();
});

it('tracks a returned durable proposal run immediately in existing authoring progress', async () => {
  const s = {
    ...snapshot([{ ...proposal(), state: 'selected', revision: 3 }]),
    selections: [selection],
  };
  const studio = {
    panic: false,
    panicAt: null,
    overlay: { connections: 0 },
    running: [],
    lastEvent: null,
    automations: [],
    activity: [],
    compiler: { kind: 'offline', model: null },
    runs: [],
    twitch: { state: 'unconfigured', configured: false },
    proposals: s,
  };
  const run = {
    id: 'durable-run',
    selectionId: selection.id,
    intent: selection.brief,
    automationId: null,
    baseVersionId: null,
    stage: 'queued',
    attempt: 0,
    transport: 'offline',
    model: null,
    startedAt: Date.now(),
    progress: [],
    result: null,
  };
  vi.spyOn(api, 'studio').mockResolvedValue(studio as never);
  vi.spyOn(api, 'proposals').mockResolvedValue(s as never);
  vi.spyOn(api, 'overlay').mockResolvedValue({ url: '/overlay?key=example', connections: 0 });
  vi.spyOn(api, 'generateSelection').mockResolvedValue(run as never);
  vi.stubGlobal(
    'WebSocket',
    class {
      close = vi.fn();
    },
  );
  render(<App />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh inbox' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review brief' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate selected brief' }));
  expect(await screen.findByText(`“${selection.brief}”`)).toBeTruthy();
  expect(screen.getByText('Queued')).toBeTruthy();
});
it('offers a deliberate new immutable selection after terminal generation failure', async () => {
  const s = {
    ...snapshot([{ ...proposal(), state: 'selected', revision: 3 }]),
    selections: [selection],
  };
  vi.spyOn(api, 'proposals').mockResolvedValue(s as never);
  const p = {
    ...props(),
    studio: { ...props().studio, proposals: s },
    runs: {
      r: {
        id: 'r',
        selectionId: selection.id,
        stage: 'failed',
        result: { status: 'failed', error: 'Interrupted before restart.', versionId: null },
      },
    },
  };
  render(<ProposalInbox {...(p as unknown as Parameters<typeof ProposalInbox>[0])} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh inbox' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review brief' }));
  expect(screen.getByText(/Interrupted before restart/)).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Save new selection' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Generate selected brief' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
