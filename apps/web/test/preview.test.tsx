// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InteractionPreview } from '../src/console/rehearsal/preview.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('stop fences a late response and reset starts with an empty timeline', async () => {
  let complete: (value: Response) => void = () => undefined;
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  render(<InteractionPreview />);
  fireEvent.click(screen.getByRole('button', { name: 'Send command' }));
  expect(screen.getByRole('status').textContent).toContain('Running');
  fireEvent.click(screen.getByRole('button', { name: 'Stop preview' }));
  complete(
    new Response(
      JSON.stringify({
        provenance: 'synthetic',
        reference: 'Tomato Toss',
        artifactId: 'a'.repeat(64),
        seed: 42,
        decisions: [],
      }),
    ),
  );
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('stopped'));
  expect(screen.getByRole('button', { name: 'Send command' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reset preview' }));
  expect(screen.getByRole('button', { name: 'Send command' }).hasAttribute('disabled')).toBe(false);
  expect(screen.queryAllByTestId('decision')).toHaveLength(0);
});
it('shows a recoverable error when the server is unavailable', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  render(<InteractionPreview />);
  fireEvent.click(screen.getByRole('button', { name: 'Send command' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Check the local server');
  expect(screen.getByRole('button', { name: 'Send command' }).hasAttribute('disabled')).toBe(false);
});
