// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProductionPanel } from '../src/console/production/panel.js';
import { ProductionTest } from '../src/console/production/test-frame.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const connection = {
  status: 'connected',
  reason: null,
  url: 'ws://127.0.0.1:4455',
  scenes: ['Live'],
  actions: [],
};
const state = {
  revision: 0,
  configured: true,
  origin: 'instance',
  connections: {
    obs: connection,
    streamerbot: { ...connection, status: 'disconnected', scenes: [] },
  },
  obsReview: null,
  mappingReview: null,
  mappings: [],
  recent: [],
};
it('requires an exact OBS review then visual test confirmation before live setup', async () => {
  let current: Record<string, unknown> = { ...state };
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (String(url).endsWith('/obs/review'))
      current = {
        ...current,
        obsReview: {
          ...body,
          digest: 'a'.repeat(64),
          operation: 'create',
          status: 'review',
          before: null,
        },
      };
    if (String(url).endsWith('/obs/apply'))
      current = { ...current, obsReview: { ...(current.obsReview as object), status: 'test' } };
    return new Response(JSON.stringify({ state: current }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ProductionPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Production setup/ }));
  await screen.findByLabelText('OBS scene');
  fireEvent.change(screen.getByLabelText('OBS scene'), { target: { value: 'Live' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review overlay setup' }));
  await screen.findByRole('button', { name: 'Apply reviewed test frame' });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/obs/apply'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed test frame' }));
  const enable = await screen.findByRole('button', { name: 'Enable reviewed live overlay' });
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(
    screen.getByLabelText('I can see the Riff test frame in the selected OBS scene.'),
  );
  expect((enable as HTMLButtonElement).disabled).toBe(false);
});
it('renders the OBS diagnostic without requesting private or live data', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<ProductionTest />);
  expect(screen.getByRole('heading', { name: 'Riff source connected' })).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
