// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createSceneOverlay } from '../src/scenes/live.js';
import { defaultScene } from '../src/scenes/schema.js';
const projection = {
  automationId: 'a',
  versionId: 'v',
  revision: 1,
  digest: 'a'.repeat(64),
  scene: defaultScene(),
  instructions: ['Type !tomato'],
};
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
it('routes effects by exact version and withdraws all content on clear', () => {
  vi.useFakeTimers();
  const root = document.createElement('div');
  document.body.append(root);
  const live = createSceneOverlay(root, { reducedMotion: true });
  live.setScenes([projection]);
  expect(live.effect({ automationId: 'a', versionId: 'old', asset: 'tomato', x: 0.5 })).toBe(false);
  expect(live.effect({ automationId: 'a', versionId: 'v', asset: 'tomato', x: 0.5 })).toBe(true);
  expect(root.querySelector('[data-projectile]')).not.toBeNull();
  live.clear();
  expect(root.childElementCount).toBe(0);
  expect(live.effect({ automationId: 'a', versionId: 'v', asset: 'tomato', x: 0.5 })).toBe(false);
});
it('never lets another scene cross a protected region or cover critical text', () => {
  const root = document.createElement('div'),
    live = createSceneOverlay(root, { reducedMotion: true });
  const other = defaultScene();
  other.regions[0]!.rect = { x: 500, y: 20, width: 200, height: 300 };
  // This peer projection is itself invalid: fail closed for the whole replacement.
  live.setScenes([projection, { ...projection, automationId: 'b', versionId: 'b', scene: other }]);
  expect(root.childElementCount).toBe(0);
  live.setScenes([projection, { ...projection, automationId: 'b', versionId: 'b' }]);
  // Idle scoreboards draw nothing, so they neither show a dark box nor reserve space.
  expect(
    [...root.querySelectorAll<HTMLElement>('[data-scene-kind="scoreboard"]')].every(
      (e) => e.dataset.empty === 'true' && !e.textContent,
    ),
  ).toBe(true);
});
it('clears old scene content and effects when a valid replacement arrives', () => {
  vi.useFakeTimers();
  const root = document.createElement('div'),
    live = createSceneOverlay(root, { reducedMotion: true });
  live.setScenes([projection]);
  live.effect({ automationId: 'a', versionId: 'v', asset: 'tomato', x: 0.5 });
  live.setScenes([{ ...projection, versionId: 'v2', instructions: ['Type !splat'] }]);
  expect(root.querySelector('[data-projectile]')).toBeNull();
  expect(root.textContent).not.toContain('!tomato');
  expect(root.textContent).toContain('!splat');
});
const roundDefinition = {
  version: 1 as const,
  title: 'Battle',
  durationMs: 10000,
  maxParticipants: 10,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score' as const, target: null },
};
const round = {
  id: 'old',
  phase: 'running' as const,
  startedAt: 0,
  deadlineAt: 10000,
  remainingMs: 10000,
  updatedAt: 0,
  revision: 0,
  participants: {},
  scores: { red: 1, blue: 0 },
  winner: null,
  outcome: null,
};
it('clears prior-round projectiles when only the session identity changes', () => {
  vi.useFakeTimers();
  const root = document.createElement('div'),
    live = createSceneOverlay(root, { reducedMotion: true });
  live.setScenes([projection]);
  live.setSessions([
    { automationId: 'a', versionId: 'v', definition: roundDefinition, snapshot: round },
  ]);
  expect(live.effect({ automationId: 'a', versionId: 'v', asset: 'tomato', x: 0.5 })).toBe(true);
  live.setSessions([
    {
      automationId: 'a',
      versionId: 'v',
      definition: roundDefinition,
      snapshot: { ...round, id: 'new', scores: { red: 0, blue: 0 } },
    },
  ]);
  expect(root.querySelector('[data-projectile]')).toBeNull();
});
it('reserves visible critical text and cuts effects around it regardless of mounting order', () => {
  const peer = defaultScene();
  peer.regions.find((r) => r.id === 'scoreboard-region')!.rect = {
    x: 440,
    y: 340,
    width: 400,
    height: 520,
  };
  peer.regions.find((r) => r.id === 'gameplay')!.rect = { x: 20, y: 340, width: 400, height: 520 };
  peer.nodes.find((n) => n.kind === 'scoreboard')!.rect = {
    x: 440,
    y: 340,
    width: 400,
    height: 240,
  };
  peer.nodes.find((n) => n.kind === 'instructions')!.rect = {
    x: 440,
    y: 600,
    width: 400,
    height: 240,
  };
  peer.nodes.find((n) => n.kind === 'effects')!.rect = { x: 20, y: 340, width: 400, height: 240 };
  peer.nodes.find((n) => n.kind === 'celebration')!.rect = {
    x: 20,
    y: 640,
    width: 400,
    height: 180,
  };
  const root = document.createElement('div'),
    live = createSceneOverlay(root, { reducedMotion: true });
  live.setScenes([{ ...projection, automationId: 'b', versionId: 'b', scene: peer }]);
  live.setScenes([projection, { ...projection, automationId: 'b', versionId: 'b', scene: peer }]);
  // Only a scoreboard with a round to show reserves its space.
  live.setSessions([sessionFor('b', 'b')]);
  const effect = root.querySelector<HTMLElement>(
    '[data-scene-automation=a] [data-scene-kind=effects]',
  )!;
  const score = root.querySelector<HTMLElement>(
    '[data-scene-automation=b] [data-scene-kind=scoreboard]',
  )!;
  // Effects keep playing but are cut away where the other interaction's text sits.
  expect(effect.hidden).toBe(false);
  expect(effect.dataset.clipped).toBe('true');
  expect(score.hidden).toBe(false);
  expect(live.effect({ automationId: 'a', versionId: 'v', asset: 'tomato', x: 0.5 })).toBe(true);
});

const sessionFor = (automationId: string, versionId: string) => ({
  automationId,
  versionId,
  definition: roundDefinition,
  snapshot: round,
});
it('combines instructions that share space and never overlaps two scoreboards', () => {
  const root = document.createElement('div'),
    live = createSceneOverlay(root, { reducedMotion: true });
  live.setScenes([
    projection,
    { ...projection, automationId: 'b', versionId: 'b', instructions: ['Type !splat'] },
  ]);
  live.setSessions([sessionFor('a', 'v'), sessionFor('b', 'b')]);
  const shown = (automation: string, kind: string) =>
    root.querySelector<HTMLElement>(
      `[data-scene-automation=${automation}] [data-scene-kind=${kind}]`,
    )!;
  expect(shown('a', 'instructions').textContent).toContain('!tomato');
  expect(shown('a', 'instructions').textContent).toContain('!splat');
  expect(shown('b', 'instructions').hidden).toBe(true);
  // No free spot in b's area: its scoreboard is withheld rather than drawn over a's.
  expect(shown('a', 'scoreboard').hidden).toBe(false);
  expect(shown('b', 'scoreboard').hidden).toBe(true);
});
it('moves a conflicting scoreboard to the nearest free spot in its own area', () => {
  const peer = defaultScene();
  peer.nodes.find((n) => n.kind === 'instructions')!.regionId = 'gameplay';
  peer.nodes.find((n) => n.kind === 'instructions')!.rect = {
    x: 460,
    y: 40,
    width: 500,
    height: 220,
  };
  peer.nodes.find((n) => n.kind === 'effects')!.rect = { x: 460, y: 280, width: 500, height: 340 };
  const root = document.createElement('div'),
    live = createSceneOverlay(root, { reducedMotion: true });
  live.setScenes([
    { ...projection, instructions: [] },
    { ...projection, automationId: 'b', versionId: 'b', scene: peer },
  ]);
  live.setSessions([sessionFor('a', 'v'), sessionFor('b', 'b')]);
  const moved = root.querySelector<HTMLElement>(
    '[data-scene-automation=b] [data-scene-kind=scoreboard]',
  )!;
  expect(moved.hidden).toBe(false);
  expect(moved.style.top).toBe('58%');
  expect(moved.textContent).toContain('Red: 1');
});
