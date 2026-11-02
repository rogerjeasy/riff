// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ParticipationPanel } from '../src/console/participation/panel.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const settings = {
  revision: 0,
  language: 'inherit',
  reducedMotion: false,
  highContrast: false,
  effectLabels: false,
};
it('shows aggregate viewer language counts and toggles viewer choice without per-viewer data', async () => {
  const counts = {
    enabled: true,
    total: 4,
    languages: [
      { language: 'en', count: 0 },
      { language: 'fr', count: 3 },
      { language: 'es', count: 0 },
      { language: 'de', count: null },
    ],
  };
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/api/participation/viewer-languages'))
      return new Response(
        JSON.stringify({
          viewerLanguages: {
            enabled: JSON.parse(String(init?.body)).enabled,
            total: 0,
            languages: counts.languages.map((l) => ({ ...l, count: 0 })),
          },
        }),
        { status: 200 },
      );
    return new Response(JSON.stringify({ settings, viewerLanguages: counts }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('confirm', () => true);
  render(<ParticipationPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Participation access/ }));
  await screen.findByText(/Chosen languages \(4 viewers\): Français 3 · Deutsch fewer than 3/);
  fireEvent.click(screen.getByRole('switch', { name: /Let viewers choose their language/ }));
  await screen.findByText('No viewer has chosen a language yet.');
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('viewer-languages'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ enabled: false });
});
