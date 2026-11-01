// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ParticipationPage } from '../src/participation/page.js';
import { ParticipationPanel } from '../src/console/participation/panel.js';
import { createSceneOverlay } from '../src/scenes/live.js';
import { defaultScene } from '../src/scenes/schema.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const settings = {
  revision: 0,
  language: 'inherit',
  reducedMotion: false,
  highContrast: false,
  effectLabels: false,
};
it('saves explicit broadcast choices with revision identity and never changes gameplay rules', async () => {
  const fetcher = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          settings:
            init?.method === 'POST'
              ? { ...settings, ...JSON.parse(String(init.body)).settings, revision: 1 }
              : settings,
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<ParticipationPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Participation access/ }));
  await screen.findByRole('group', { name: 'Broadcast language' });
  expect(screen.getByRole('button', { name: 'Save presentation preferences' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Français' }));
  fireEvent.click(screen.getByRole('switch', { name: /Reduce motion on stream/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save presentation preferences' }));
  await screen.findByText(/Broadcast preferences saved/);
  const call = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    expectedRevision: 0,
    settings: { language: 'fr', reducedMotion: true, highContrast: false, effectLabels: false },
  });
});
it('keeps companion preferences on this device and reads only public guidance', async () => {
  const fetcher = vi.fn(
    async (url: unknown) =>
      new Response(
        JSON.stringify({
          language: String(url).includes('fr') ? 'fr' : 'en',
          stopped: false,
          reducedMotion: false,
          highContrast: false,
          helpCommand: '!riff help',
          interactions: [
            {
              id: 'public',
              title: 'Tomatoes',
              phase: 'running',
              free: true,
              instructions: ['Type !tomato · 3 per 60 seconds'],
              objective: 'Join with chat',
              remainingMs: null,
              scores: [],
              outcome: null,
            },
          ],
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ParticipationPage />);
  await screen.findByText(/Type !tomato/);
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } });
  await screen.findByRole('heading', { name: 'Participer au direct' });
  expect(JSON.parse(localStorage.getItem('riff-participation-preferences')!).language).toBe('fr');
  view.unmount();
  render(<ParticipationPage />);
  await screen.findByRole('heading', { name: 'Participer au direct' });
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/participation?'))).toBe(true);
});
it('honors broadcast motion, contrast and text labels within the approved scene', () => {
  const root = document.createElement('div'),
    overlay = createSceneOverlay(root, { reducedMotion: false });
  overlay.setScenes([
    {
      automationId: 'a',
      versionId: 'v',
      revision: 1,
      digest: 'a'.repeat(64),
      scene: defaultScene(),
      instructions: ['Type !tomato'],
      reducedMotion: true,
      highContrast: true,
      effectLabels: true,
    },
  ]);
  expect(root.querySelector('[data-high-contrast=true]')).not.toBeNull();
  expect(overlay.effect({ automationId: 'a', versionId: 'v', asset: 'tomato', x: 0.5 })).toBe(true);
  expect(root.textContent).toContain('tomato');
  overlay.clear();
});
it('emphasises the on-stream instructions while a help request is active', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const overlay = createSceneOverlay(root, { reducedMotion: true });
  const projection = {
    automationId: 'a',
    versionId: 'v',
    revision: 1,
    digest: 'a'.repeat(64),
    scene: defaultScene(),
    instructions: ['Type !tomato'],
  };
  overlay.setScenes([{ ...projection, help: true }]);
  expect(root.querySelector('[data-help="true"]')).not.toBeNull();
  overlay.setScenes([projection]);
  expect(root.querySelector('[data-help="true"]')).toBeNull();
  overlay.clear();
  root.remove();
});
