// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultScene, sceneSchema } from '../src/scenes/schema.js';
import {
  renderScene,
  launchSceneEffect,
  clearScene,
  timingVisible,
  roundStatus,
} from '../src/scenes/render.js';
import { scoreboardSide, hasStandardAreas } from '../src/scenes/layouts.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
describe('canonical scene boundary', () => {
  it('accepts safe scenes and rejects unsafe geometry, authority and timing', () => {
    const scene = defaultScene();
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    const effects = scene.nodes.find((n) => n.kind === 'effects')!;
    effects.rect = { x: 20, y: 20, width: 240, height: 300 };
    expect(sceneSchema.safeParse(scene).success).toBe(false);
    expect(
      sceneSchema.safeParse({ ...defaultScene(), url: 'https://example.com/asset' }).success,
    ).toBe(false);
    const timed = defaultScene();
    timed.nodes[0]!.timing.delayMs = 60001;
    expect(sceneSchema.safeParse(timed).success).toBe(false);
  });
  it('rejects duplicate identities, tiny critical text and unknown assets', () => {
    const scene = defaultScene();
    scene.nodes[0]!.id = scene.regions[0]!.id;
    expect(sceneSchema.safeParse(scene).success).toBe(false);
    const tiny = defaultScene();
    tiny.nodes.find((n) => n.kind === 'scoreboard')!.rect.width = 10;
    expect(sceneSchema.safeParse(tiny).success).toBe(false);
    const invalid = JSON.parse(JSON.stringify(defaultScene()));
    invalid.nodes[0].asset = 'https://example.com';
    expect(sceneSchema.safeParse(invalid).success).toBe(false);
  });
});
describe('shared scene renderer', () => {
  it('clips every projectile to the approved effect box and clears on scene changes', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.append(root);
    renderScene(root, defaultScene(), { instructions: ['Type !tomato'], now: 0 });
    expect(launchSceneEffect(root, { asset: 'tomato', x: 0.5 }, { reducedMotion: true })).toBe(
      true,
    );
    const layer = root.querySelector<HTMLElement>('[data-scene-kind="effects"]')!;
    expect(layer.style.overflow).toBe('hidden');
    expect(layer.querySelector('[data-projectile]')).not.toBeNull();
    const moved = defaultScene();
    moved.nodes.find((n) => n.kind === 'effects')!.rect.x += 10;
    moved.nodes.find((n) => n.kind === 'effects')!.rect.width -= 10;
    renderScene(root, moved, { now: 1 });
    expect(root.querySelector('[data-projectile]')).toBeNull();
    clearScene(root);
    expect(launchSceneEffect(root, { asset: 'tomato', x: 0.5 })).toBe(false);
  });
  it('renders untrusted labels as text and withdraws invalid scenes', () => {
    const root = document.createElement('div');
    renderScene(root, defaultScene(), { now: 0, instructions: ['<img src=x onerror=alert(1)>'] });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img');
    const invalid = defaultScene();
    invalid.regions[0]!.rect.width = 2000;
    renderScene(root, invalid, { now: 0 });
    expect(root.childElementCount).toBe(0);
  });
  it('uses logical elapsed time, pauses round-start tracks and bounds round-end tracks', () => {
    const start = { trigger: 'round-start' as const, delayMs: 1000, durationMs: 2000 };
    const snapshot = {
      id: 's',
      phase: 'running' as const,
      startedAt: 0,
      deadlineAt: 10000,
      remainingMs: 10000,
      updatedAt: 0,
      revision: 0,
      participants: {},
      scores: {},
      winner: null,
      outcome: null,
    };
    expect(timingVisible(start, { snapshot, now: 999, durationMs: 10000 })).toBe(false);
    expect(timingVisible(start, { snapshot, now: 1000, durationMs: 10000 })).toBe(true);
    expect(
      timingVisible(start, {
        snapshot: { ...snapshot, phase: 'paused', remainingMs: 8500 },
        now: 90000,
        durationMs: 10000,
      }),
    ).toBe(true);
    expect(timingVisible(start, { snapshot, now: 3000, durationMs: 10000 })).toBe(false);
    const finish = { ...snapshot, phase: 'finished' as const, remainingMs: 0, updatedAt: 10000 };
    const end = { trigger: 'round-end' as const, delayMs: 100, durationMs: 500 };
    expect(timingVisible(end, { snapshot: finish, now: 10099 })).toBe(false);
    expect(timingVisible(end, { snapshot: finish, now: 10100 })).toBe(true);
    expect(timingVisible(end, { snapshot: finish, now: 10600 })).toBe(false);
  });
});
it('keeps mobile instructions readable by paging complete words and commands', () => {
  const root = document.createElement('div');
  Object.defineProperties(root, { clientWidth: { value: 320 }, clientHeight: { value: 180 } });
  const command = '!abcdefghijklmnopqrstuvwxyzabcdef';
  const text = `Subscribers: type ${command} three times per minute`;
  const seen: string[] = [];
  for (let now = 0; now < 36000; now += 6000) {
    renderScene(root, defaultScene(), { now, instructions: [text] });
    seen.push(root.querySelector('[data-scene-kind=instructions]')?.textContent ?? '');
  }
  expect(seen.every((page) => page.length <= 34)).toBe(true);
  expect(seen.some((page) => page.includes(command))).toBe(true);
  expect(root.querySelector('[data-scene-kind=instructions]')?.getAttribute('aria-label')).toBe(
    text,
  );
});

describe('readable stream text', () => {
  const snapshot = {
    id: 's',
    phase: 'running' as const,
    startedAt: 0,
    deadlineAt: 92_000,
    remainingMs: 92_000,
    updatedAt: 0,
    revision: 0,
    participants: {},
    scores: { red: 5 },
    winner: null,
    outcome: null,
  };
  it('states the round in plain words', () => {
    expect(roundStatus(snapshot, 0)).toBe('1:32 left');
    expect(roundStatus({ ...snapshot, phase: 'paused', remainingMs: 40_000 }, 0)).toBe(
      'Paused · 0:40 left',
    );
    expect(roundStatus({ ...snapshot, phase: 'finished' }, 0)).toBe('Round over');
  });
  it('shows each instruction line separately and draws no empty scoreboard panel', () => {
    const root = document.createElement('div');
    renderScene(root, defaultScene(), {
      now: 0,
      instructions: ['Join a team: !red / !blue', 'Everyone: !throw · 3 throws per round'],
    });
    const lines = [...root.querySelectorAll('[data-scene-kind=instructions] .scene-text')].map(
      (p) => p.textContent,
    );
    expect(lines).toEqual(['Join a team: !red / !blue', 'Everyone: !throw · 3 throws per round']);
    const score = root.querySelector<HTMLElement>('[data-scene-kind=scoreboard]')!;
    expect(score.dataset.empty).toBe('true');
    expect(score.querySelector('.scene-panel')).toBeNull();
  });
  it('previews a well-formed draft that breaks a layout rule, but never shows it live', () => {
    const draft = defaultScene();
    draft.nodes.find((n) => n.kind === 'effects')!.rect.x = 20;
    const preview = document.createElement('div');
    renderScene(preview, draft, { now: 0, guides: true });
    expect(preview.querySelector('[data-scene-kind=effects]')).not.toBeNull();
    const live = document.createElement('div');
    renderScene(live, draft, { now: 0 });
    expect(live.childElementCount).toBe(0);
  });
});
it('offers valid one-click layouts with the scoreboard on either side', () => {
  const right = scoreboardSide(defaultScene(), 'right');
  expect(sceneSchema.safeParse(right).success).toBe(true);
  expect(right.nodes.find((n) => n.kind === 'scoreboard')!.rect.x).toBeGreaterThan(500);
  expect(scoreboardSide(right, 'left')).toEqual(defaultScene());
  expect(hasStandardAreas(right)).toBe(true);
});
