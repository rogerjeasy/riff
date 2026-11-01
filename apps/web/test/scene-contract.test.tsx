import { expect, it } from 'vitest';
import { DEFAULT_SCENE } from '../../../packages/sdk/dist/scene.js';
import { sceneSchema as host } from '../../../packages/compiler/dist/scene.js';
import { sceneSchema as browser, defaultScene } from '../src/scenes/schema.js';
it('keeps host and browser defaults and safety checks in agreement', () => {
  expect(defaultScene()).toEqual(DEFAULT_SCENE);
  const cases: unknown[] = [defaultScene(), { ...defaultScene(), script: 'alert(1)' }];
  for (const field of ['x', 'y', 'width', 'height'] as const)
    for (const value of [-1, 0, 1, 400, 1001, NaN, Infinity]) {
      const s = defaultScene();
      s.nodes[0]!.rect[field] = value;
      cases.push(s);
    }
  for (const kind of ['effects', 'scoreboard', 'instructions'])
    cases.push({ ...defaultScene(), nodes: defaultScene().nodes.filter((n) => n.kind !== kind) });
  const unprotected = defaultScene();
  unprotected.regions[0]!.protected = false;
  cases.push(unprotected);
  const collided = defaultScene();
  collided.nodes[0]!.rect = { ...collided.nodes[1]!.rect };
  cases.push(collided);
  for (const c of cases) expect(browser.safeParse(c).success).toBe(host.safeParse(c).success);
});
