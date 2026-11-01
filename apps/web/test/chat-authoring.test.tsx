// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChatAuthoringPanel, useChatAuthoring } from '../src/console/chat-authoring/panel.js';
import { formatRemaining } from '../src/console/chat-authoring/contracts.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = (now: number) => ({
  enabled: false,
  revision: 0,
  updatedAt: null,
  replies: {
    available: false,
    reason: 'Reconnect Twitch and approve “Send chat messages” (user:write:chat).',
    lastError: null,
  },
  pending: null,
  activeCode: null,
  recentCodes: [],
  candidates: [],
  limits: { compilesPerWindow: 3, compileWindowMs: 900_000, compilesUsed: 0, codeTtlMs: 300_000 },
  lockedUntil: null,
  now,
});

function Harness(props: { onReview: (id: string) => void; notify: (m: string) => void }) {
  const state = useChatAuthoring(null);
  return (
    <ChatAuthoringPanel
      state={state}
      panic={false}
      onReview={props.onReview}
      notify={props.notify}
    />
  );
}

it('requires an explicit, informed opt-in before enabling in-chat authoring', async () => {
  let current = base(Date.now());
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      expect(String(url)).toBe('/api/chat-authoring/settings');
      expect(JSON.parse(String(init.body))).toEqual({ enabled: true, expectedRevision: 0 });
      current = { ...current, enabled: true, revision: 1 };
    }
    return new Response(JSON.stringify(current), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const notify = vi.fn();
  render(<Harness onReview={() => undefined} notify={notify} />);
  fireEvent.click(await screen.findByRole('button', { name: /Chat authoring/ }));
  expect(screen.getByText('Off')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn on…' }));
  const confirm = screen.getByRole('group', { name: 'Confirm in-chat authoring' });
  expect(within(confirm).getByText(/Approving from chat skips the private rehearsal/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(within(confirm).getByRole('button', { name: 'I understand — turn on' }));
  await screen.findByText('On · owner only');
  expect(notify).toHaveBeenCalledWith('In-chat authoring is on.');
  expect(screen.getByRole('link', { name: 'Reconnect Twitch' }).getAttribute('href')).toBe(
    '/auth/twitch',
  );
});

it('shows the live code with a countdown, revokes it and links chat candidates to review', async () => {
  const now = Date.now();
  const code = {
    id: '6f9619ff-8b86-4011-b42d-00cf4fc964ff',
    code: 'K7Q3X',
    versionId: 'version-1',
    issuedAt: now,
    expiresAt: now + 125_000,
  };
  let current: ReturnType<typeof base> & Record<string, unknown> = {
    ...base(now),
    enabled: true,
    revision: 1,
    replies: { available: true, reason: null, lastError: null },
    pending: {
      kind: 'create',
      intent: 'tomatoes',
      runId: 'r1',
      requestedAt: now,
      status: 'awaiting',
    },
    activeCode: code,
    candidates: [{ versionId: 'version-1', kind: 'create', requestedAt: now }],
  } as never;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      expect(String(url)).toBe(`/api/chat-authoring/codes/${code.id}/revoke`);
      current = {
        ...current,
        pending: null,
        activeCode: null,
        recentCodes: [
          {
            id: code.id,
            code: code.code,
            versionId: 'version-1',
            status: 'revoked',
            closedAt: now,
            reason: 'Revoked from the console.',
          },
        ],
      } as never;
    }
    return new Response(JSON.stringify(current), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const onReview = vi.fn();
  render(<Harness onReview={onReview} notify={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: /Chat authoring/ }));
  expect(screen.getByText('K7Q3X')).toBeTruthy();
  expect(screen.getByRole('timer').textContent).toMatch(/expires in 2:0[45]/);
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }));
  expect(onReview).toHaveBeenCalledWith('version-1');
  expect(screen.getAllByText('From chat').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke code' }));
  await screen.findByText('No chat candidate is waiting.');
  expect(screen.getByText('Withdrawn')).toBeTruthy();
});

it('formats countdowns without going negative', () => {
  expect(formatRemaining(125_000)).toBe('2:05');
  expect(formatRemaining(-5)).toBe('0:00');
});
