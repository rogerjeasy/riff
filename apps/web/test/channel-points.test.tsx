// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChannelPointsPanel } from '../src/console/channel-points/channel-points-panel.js';
import { PredictionsPanel } from '../src/console/channel-points/predictions-panel.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const access = {
  connected: true,
  configured: true,
  consent: { granted: true, url: '/auth/twitch?features=channel-points' },
  eligibility: 'affiliate',
  panicked: false,
  lastError: null,
};
const points = {
  ...access,
  subscription: 'subscribed',
  limits: { titleLength: 45, promptLength: 200, rewards: 50 },
  rewards: [
    {
      id: 'reward-1',
      title: 'Hydrate',
      cost: 500,
      prompt: '',
      inputRequired: false,
      cooldownSeconds: null,
      enabled: true,
      paused: false,
      policy: 'auto',
      automationId: null,
      automationTitle: null,
    },
  ],
  automations: [{ id: 'auto-1', title: 'Hydrate Splash', status: 'live', reward: 'Hydrate' }],
  redemptions: [
    {
      id: 'r1',
      rewardId: 'reward-1',
      rewardTitle: 'Hydrate',
      viewerName: 'Ada',
      input: '',
      status: 'queued',
      code: 'ACCEPTED',
      reason: 'Accepted and shown. Waiting for you to fulfil or refund.',
      redeemedAt: '2026-11-01T10:00:00Z',
      receivedAt: 1_000,
    },
  ],
};
const prediction = {
  id: 'p1',
  title: 'Will we beat the boss?',
  winningOutcomeId: null,
  outcomes: [
    { id: 'o1', title: 'Yes', users: 3, channelPoints: 300, color: 'BLUE' },
    { id: 'o2', title: 'No', users: 1, channelPoints: 100, color: 'PINK' },
  ],
  windowSeconds: 120,
  status: 'LOCKED',
  createdAt: '2026-11-01T10:00:00Z',
  endedAt: null,
  lockedAt: '2026-11-01T10:02:00Z',
};
const predictions = {
  ...access,
  consent: { granted: true, url: '/auth/twitch?features=predictions' },
  limits: {
    titleLength: 45,
    outcomeLength: 25,
    outcomes: { min: 2, max: 10 },
    windowSeconds: { min: 30, max: 1800 },
  },
  current: prediction,
  requests: [],
};
function stub(state: unknown) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const posted = (fetcher: ReturnType<typeof stub>) =>
  fetcher.mock.calls
    .map((call) => call as unknown as [string, RequestInit | undefined])
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => [url, JSON.parse(String(init?.body))]);

it('links a Riff reward to a Channel Points interaction with a host settlement policy', async () => {
  const fetcher = stub(points);
  render(<ChannelPointsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Channel Points/ }));
  await screen.findByText('Riff rewards');
  expect(screen.getByText(/Riff can only manage rewards it created/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Triggers interaction'), { target: { value: 'auto-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'I review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save link' }));
  await vi.waitFor(() =>
    expect(posted(fetcher)).toContainEqual([
      '/api/channel-points/rewards/reward-1/link',
      { automationId: 'auto-1', policy: 'manual' },
    ]),
  );
});

it('lets the creator fulfil or refund a waiting redemption and confirms deletion', async () => {
  const fetcher = stub(points);
  render(<ChannelPointsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Channel Points/ }));
  const item = (await screen.findByText(/Waiting for you to fulfil/)).closest('li')!;
  fireEvent.click(within(item).getByRole('button', { name: 'Refund' }));
  await vi.waitFor(() =>
    expect(posted(fetcher)).toContainEqual([
      '/api/channel-points/redemptions/r1',
      { action: 'refund' },
    ]),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: 'Delete…' })).toHaveProperty('disabled', false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
  const confirm = screen.getByRole('group', { name: 'Confirm deleting Hydrate' });
  expect(document.activeElement).toBe(
    within(confirm).getByRole('button', { name: 'Delete reward' }),
  );
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
  expect(posted(fetcher).some(([url]) => String(url).endsWith('/delete'))).toBe(false);
});

it('explains consent and eligibility instead of offering actions', async () => {
  stub({ ...points, consent: { granted: false, url: '/auth/twitch?features=channel-points' } });
  render(<ChannelPointsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Channel Points/ }));
  const link = await screen.findByRole('link', { name: 'Allow Channel Points access' });
  expect(link.getAttribute('href')).toBe('/auth/twitch?features=channel-points');
  expect(screen.queryByRole('button', { name: 'Create reward' })).toBeNull();
  cleanup();
  stub({ ...points, eligibility: 'ineligible' });
  render(<ChannelPointsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Channel Points/ }));
  await screen.findByText(/only to Affiliate and Partner channels/);
});

it('resolves only after choosing a winner and confirming the payout', async () => {
  const fetcher = stub(predictions);
  render(<PredictionsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Predictions/ }));
  await screen.findByText('Will we beat the boss?');
  const resolve = screen.getByRole('button', { name: 'Resolve…' });
  expect(resolve).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('radio', { name: /No/ }));
  fireEvent.click(resolve);
  const confirm = screen.getByRole('group', { name: 'Confirm prediction action' });
  expect(confirm.textContent).toContain('Pay out to “No”');
  expect(posted(fetcher)).toEqual([]);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm winner' }));
  await vi.waitFor(() =>
    expect(posted(fetcher)).toEqual([
      [
        '/api/predictions/end',
        { action: 'resolve', predictionId: 'p1', confirm: true, winningOutcomeId: 'o2' },
      ],
    ]),
  );
});

it('shows automation proposals that only the creator can open', async () => {
  const fetcher = stub({
    ...predictions,
    current: null,
    requests: [
      {
        id: 'q1',
        source: 'automation',
        automationId: 'a1',
        automationTitle: 'Prediction Prompt',
        title: 'Clutch?',
        outcomes: ['Yes', 'No'],
        windowSeconds: 90,
        status: 'proposed',
        predictionId: null,
        message: '',
        createdAt: 1,
      },
    ],
  });
  render(<PredictionsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Predictions/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open this prediction' }));
  await vi.waitFor(() =>
    expect(posted(fetcher)).toEqual([['/api/predictions/proposals/q1/open', {}]]),
  );
});
