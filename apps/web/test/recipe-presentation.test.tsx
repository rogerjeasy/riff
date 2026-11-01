// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createSceneOverlay } from '../src/scenes/live.js';
import { defaultScene, sceneProjectionSchema } from '../src/scenes/schema.js';
const projection = {
  automationId: 'recipe',
  versionId: 'installed',
  revision: 1,
  digest: 'a'.repeat(64),
  scene: defaultScene(),
  instructions: ['Tapez !tomate · trois par minute'],
  reducedMotion: true,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});
it('carries reviewed recipe motion and localized guidance through the protected scene renderer', () => {
  vi.useFakeTimers();
  const animate = vi.fn(() => ({ onfinish: null }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
  const root = document.createElement('div');
  document.body.append(root);
  const overlay = createSceneOverlay(root, { reducedMotion: false });
  overlay.setScenes([projection]);
  expect(root.textContent).toContain('Tapez !tomate');
  expect(
    overlay.effect({ automationId: 'recipe', versionId: 'installed', asset: 'tomato', x: 0.5 }),
  ).toBe(true);
  expect(root.querySelector('[data-projectile]')).not.toBeNull();
  expect(animate).not.toHaveBeenCalled();
  expect(
    overlay.effect({ automationId: 'recipe', versionId: 'unapproved', asset: 'tomato', x: 0.5 }),
  ).toBe(false);
  overlay.clear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});
it('rejects malformed presentation flags instead of weakening scene validation', () => {
  expect(sceneProjectionSchema.safeParse(projection).success).toBe(true);
  expect(sceneProjectionSchema.safeParse({ ...projection, reducedMotion: 'false' }).success).toBe(
    false,
  );
});
