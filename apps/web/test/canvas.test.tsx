// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasEditor } from '../src/console/canvas/editor.js';
import { sceneApi } from '../src/console/canvas/api.js';
import { defaultScene, type SceneState } from '../src/scenes/schema.js';
const state: SceneState = {
  versionId: 'v',
  artifactId: 'a'.repeat(64),
  revision: 0,
  digest: 'b'.repeat(64),
  scene: defaultScene(),
  classification: 'review',
  appliedRevision: null,
  history: [],
  checks: ['Protected regions clear'],
};
const version = {
  id: 'v',
  artifactId: state.artifactId,
  number: 1,
  status: 'active' as const,
  manifest: {
    sdkVersion: '0.4.0',
    capabilities: ['overlay'],
    trigger: {
      command: '!tomato',
      audience: ['viewer' as const],
      maxPerViewer: 3,
      windowMs: 60000,
    },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
  },
};
beforeEach(() => {
  vi.spyOn(sceneApi, 'read').mockResolvedValue(structuredClone(state));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('saves keyboard geometry edits through the exact revision and requires review before apply', async () => {
  const save = vi.spyOn(sceneApi, 'save').mockImplementation(async (_id, rev, scene) => ({
    ...state,
    scene,
    revision: rev + 1,
    digest: 'c'.repeat(64),
  }));
  const apply = vi
    .spyOn(sceneApi, 'apply')
    .mockResolvedValue({ ...state, revision: 1, appliedRevision: 1 });
  render(<CanvasEditor version={version} panic={false} />);
  const effects = await screen.findByRole('button', { name: 'Select effects' });
  fireEvent.click(effects);
  fireEvent.keyDown(effects, { key: 'ArrowRight' });
  fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[1]).toBe(0);
  expect(save.mock.calls[0]?.[2].nodes.find((n) => n.id === 'effects')?.rect.x).toBe(470);
  expect(
    (screen.getByRole('button', { name: 'Approve and apply layout' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText('I reviewed this layout and its changes'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve and apply layout' }));
  await waitFor(() =>
    expect(apply).toHaveBeenCalledWith('v', 1, 'c'.repeat(64), expect.any(AbortSignal)),
  );
});
it('rejects protected overlaps locally and never saves a malformed scene', async () => {
  const save = vi.spyOn(sceneApi, 'save');
  render(<CanvasEditor version={version} panic={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select effects' }));
  fireEvent.change(screen.getByLabelText('X position'), { target: { value: '20' } });
  expect(screen.getByRole('alert').textContent).toMatch(/protected|unprotected/i);
  expect((screen.getByRole('button', { name: 'Save layout' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(save).not.toHaveBeenCalled();
});
it('passes explicit selection context to generation and fences late results after switching versions', async () => {
  let done: (s: SceneState) => void = () => {};
  vi.spyOn(sceneApi, 'generate').mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const { rerender } = render(<CanvasEditor version={version} panic={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select celebration' }));
  fireEvent.change(screen.getByLabelText(/Describe a change/), {
    target: { value: 'Show the winner here after 2 seconds' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Draft this change' }));
  expect(sceneApi.generate).toHaveBeenCalledWith(
    'v',
    0,
    'celebration',
    'Show the winner here after 2 seconds',
    expect.any(AbortSignal),
  );
  vi.mocked(sceneApi.read).mockResolvedValue({ ...state, versionId: 'v2', revision: 7 });
  rerender(<CanvasEditor version={{ ...version, id: 'v2' }} panic={false} />);
  await screen.findByText(/Layout revision 7/);
  done({ ...state, revision: 3 });
  await waitFor(() => expect(screen.queryByText(/Layout revision 3/)).toBeNull());
});
it('keeps emergency stop authoritative over scene activation', async () => {
  render(<CanvasEditor version={version} panic={true} />);
  await screen.findByText(/Layout revision 0/);
  fireEvent.click(screen.getByLabelText('I reviewed this layout and its changes'));
  expect(
    (screen.getByRole('button', { name: 'Approve and apply layout' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('shows initial saved geometry changes against the effective default scene', async () => {
  const changed = defaultScene();
  changed.nodes.find((n) => n.id === 'effects')!.rect.x += 10;
  const first = {
    revision: 1,
    digest: 'c'.repeat(64),
    scene: changed,
    source: 'direct' as const,
    classification: 'review' as const,
  };
  vi.mocked(sceneApi.read).mockResolvedValue({ ...state, ...first, history: [first] });
  render(<CanvasEditor version={version} panic={false} />);
  await screen.findByRole('button', { name: 'Select effects' });
  expect(screen.queryByText(/Same as the default layout/)).toBeNull();
  expect(screen.getByText('Effects moved to 470, 40')).not.toBeNull();
});
it('hands the same host instructions to rehearsal as to its own renderer', async () => {
  const instructions = ['Join a team: !red / !blue', 'Everyone: !throw · 3 throws per round'];
  vi.mocked(sceneApi.read).mockResolvedValue({ ...state, instructions });
  const onScene = vi.fn();
  render(<CanvasEditor version={version} panic={false} onScene={onScene} />);
  await screen.findByRole('button', { name: 'Select effects' });
  expect(onScene).toHaveBeenCalledWith(state.scene, instructions);
});
