// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InsightsPanel } from '../src/console/insights/panel.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const base = {
  range: { kind: 'stream', from: 0, to: 3_600_000, bucketMs: 300_000 },
  minimumGroup: 3,
  empty: false,
  participation: {
    participants: 5,
    attempts: 19,
    admitted: 4,
    blocked: 15,
    activeMinutes: 4,
    perActiveMinute: 1,
    series: [
      { start: 0, suppressed: false, admitted: 4, blocked: 13, participants: 4 },
      { start: 300_000, suppressed: true, admitted: null, blocked: null, participants: null },
      { start: 600_000, suppressed: false, admitted: 0, blocked: 0, participants: 0 },
    ],
  },
  blocked: {
    total: 15,
    reasons: [
      { reason: 'viewer-limit', label: 'Per-viewer limit', count: 12 },
      { reason: 'finished', label: 'Round already finished', count: 3 },
    ],
  },
  automations: [
    {
      automationId: 'a1',
      title: 'Tomato Battle',
      triggers: 17,
      admitted: 4,
      blocked: 13,
      participants: 4,
      incidents: 0,
      reasons: [{ reason: 'viewer-limit', count: 12 }],
    },
  ],
  sessions: { started: 2, finished: 1, goal: 1, deadline: 0 },
  compiles: {
    total: 3,
    ready: 2,
    question: 0,
    unsupported: 0,
    failed: 1,
    cancelled: 0,
    successRate: 0.66,
    medianMs: 2500,
    p90Ms: 9000,
  },
  incidents: { total: 0 },
  proposals: { suggestions: 2, contributors: null, ballots: 0, votes: 0, selections: 0 },
  takeaways: [
    {
      tone: 'warn',
      text: '12 actions on Tomato Battle were blocked by the per-viewer limit — consider raising it if chat wants to play more.',
    },
  ],
};
const respond = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

it('renders KPI tiles, takeaways, an accessible chart table and the per-interaction table', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => respond({ insights: base })),
  );
  render(<InsightsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Insights/ }));
  expect(await screen.findByText(/12 actions on Tomato Battle were blocked/)).toBeTruthy();
  expect(screen.getByText('People taking part')).toBeTruthy();
  expect(screen.getByRole('group', { name: /Participation chart/ })).toBeTruthy();
  const reasons = screen.getByRole('heading', { name: 'Why actions were blocked' }).parentElement!;
  expect(within(reasons).getByText('Per-viewer limit')).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Participation per interval' })).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'Tomato Battle' })).toBeTruthy();
  expect(screen.getByText(/Hidden — fewer than 3 people/)).toBeTruthy();
  expect(screen.getByText(/never lists, ranks or scores individual viewers/)).toBeTruthy();
});

it('moves through chart intervals with the keyboard and describes each one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => respond({ insights: base })),
  );
  render(<InsightsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Insights/ }));
  const chart = await screen.findByRole('group', { name: /Participation chart/ });
  fireEvent.keyDown(chart, { key: 'Home' });
  expect(screen.getByText(/4 admitted, 13 blocked, 4 people/)).toBeTruthy();
  fireEvent.keyDown(chart, { key: 'ArrowRight' });
  expect(screen.getAllByText(/hidden — fewer than 3 people/).length).toBeGreaterThan(0);
});

it('shows a friendly empty state', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => respond({ insights: { ...base, empty: true } })),
  );
  render(<InsightsPanel />);
  expect(await screen.findByText(/No activity from a stream yet/)).toBeTruthy();
});

it('loads the chosen range and surfaces failures with a retry', async () => {
  let fail = true;
  const fetcher = vi.fn(async (url: unknown) => {
    if (fail)
      return respond({ code: 'FAILED', message: 'Insights are unavailable.' }, { status: 500 });
    const kind = new URL(String(url), 'http://x').searchParams.get('range');
    return respond({ insights: { ...base, range: { ...base.range, kind } } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<InsightsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Insights/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Insights are unavailable/);
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  expect(await screen.findByText(/12 actions on Tomato Battle/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('range=7d'))).toBe(true);
});
