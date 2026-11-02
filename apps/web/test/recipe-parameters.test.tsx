// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultScene } from '../src/scenes/schema.js';
import { recipePackageSchema } from '../src/console/recipes/contracts.js';
import { ParameterForm, accentContrast } from '../src/console/recipes/parameters.js';
import {
  ACCENT_PALETTE,
  declarationsFor,
  emptyDeclaration,
} from '../src/console/recipes/declare.js';

afterEach(cleanup);
const manifest = {
  sdkVersion: '0.3.0',
  capabilities: ['overlay'],
  trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const pack = recipePackageSchema.parse({
  version: 1,
  recipeId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  digest: 'b'.repeat(64),
  title: 'Tomato',
  description: 'Public tomato recipe',
  author: 'A creator',
  license: 'MIT',
  rightsAttested: true,
  source: 'async (e,riff)=>{}',
  manifest,
  tests: [],
  scene: defaultScene(),
  presentation: { language: 'en', reducedMotion: false },
  assets: [{ id: 'tomato', credit: 'Riff', license: 'project-license' }],
  lineage: [],
  parameters: [
    { id: 'command', kind: 'command', label: 'Command' },
    { id: 'maxPerViewer', kind: 'number', label: 'Uses per viewer', min: 1, max: 6, step: 1 },
    {
      id: 'accent',
      kind: 'color',
      label: 'Accent',
      palette: ['#ffd166', '#7ae582'],
      default: '#ffd166',
    },
    { id: 'headline', kind: 'copy', label: 'Headline', maxLength: 40, default: { en: 'Splat!' } },
  ],
});

it('edits declared parameters within bounds, flags widening and applies without free text', () => {
  const onApply = vi.fn();
  render(
    <ParameterForm pack={pack} language="en" disabled={null} busy={false} onApply={onApply} />,
  );
  const apply = screen.getByRole('button', { name: 'Apply parameters and rehearse' });
  const uses = screen.getByLabelText(/Uses per viewer/);
  fireEvent.change(uses, { target: { value: '9' } });
  expect(screen.getByText('Choose 1–6.')).toBeTruthy();
  expect((apply as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(uses, { target: { value: '5' } });
  expect(screen.getAllByText('Authority widened').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: '!Splat' } });
  // Commands are lowercased as typed, so the preview shows exactly what viewers type.
  expect(screen.getByLabelText('Live instruction preview').textContent).toContain('!splat');
  fireEvent.click(screen.getByLabelText('#7ae582'));
  fireEvent.click(apply);
  expect(onApply).toHaveBeenCalledWith({
    command: '!splat',
    maxPerViewer: 5,
    accent: '#7ae582',
    headline: { en: 'Splat!' },
  });
});

it('offers publishers only contrast-safe accents and bounds that include the published values', () => {
  for (const color of ACCENT_PALETTE) expect(accentContrast(color)).toBeGreaterThanOrEqual(3);
  const list = declarationsFor(
    { ...emptyDeclaration(), command: true, uses: true, usesMin: 5, usesMax: 50, headline: ' Hi ' },
    manifest as never,
    'fr',
  );
  expect(list).toEqual([
    { id: 'command', kind: 'command', label: 'Chat command' },
    { id: 'maxPerViewer', kind: 'number', label: 'Uses per viewer', min: 3, max: 20, step: 1 },
    { id: 'headline', kind: 'copy', label: 'Headline', maxLength: 80, default: { fr: 'Hi' } },
  ]);
});
