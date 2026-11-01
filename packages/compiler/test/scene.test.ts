import type { CompilerSession } from '../src/transport.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE } from '@riff/sdk';
import { sceneSchema, classifySceneEdit, compileScene } from '../src/scene.js';
import { createOfflineTransport } from '../src/offline.js';

const scene = () => structuredClone(DEFAULT_SCENE);
describe('host-owned scenes', () => {
  it('accepts the safe scene and rejects overlap, overflow, unknown assets and oversized time', () => {
    expect(sceneSchema.safeParse(scene()).success).toBe(true);
    for (const mutate of [
      (s: ReturnType<typeof scene>) => {
        s.nodes[0]!.rect.x = 10;
      },
      (s: ReturnType<typeof scene>) => {
        s.regions[0]!.rect.width = 1001;
      },
      (s: ReturnType<typeof scene>) => {
        s.nodes[0]!.timing.delayMs = 60001;
      },
      (s: ReturnType<typeof scene>) => {
        s.nodes[1]!.rect.width = 100;
      },
    ]) {
      const input = scene();
      mutate(input);
      expect(sceneSchema.safeParse(input).success).toBe(false);
    }
    const input = scene();
    expect(sceneSchema.safeParse({ ...input, script: 'alert(1)' }).success).toBe(false);
    expect(
      sceneSchema.safeParse({ ...input, nodes: [{ ...input.nodes[0], asset: 'https://bad' }] })
        .success,
    ).toBe(false);
  });
  it('only classifies position edits inside approved regions as configuration', () => {
    const original = scene(),
      next = scene();
    next.nodes[0]!.rect.x += 5;
    expect(classifySceneEdit(original, next)).toBe('configuration');
    next.nodes[3]!.timing.durationMs = 2000;
    expect(classifySceneEdit(original, next)).toBe('review');
    expect(classifySceneEdit(null, scene())).toBe('review');
  });
  it('edits the selected canonical node in explicitly offline mode', async () => {
    const result = await compileScene(
      { scene: scene(), selectionId: 'effects', intent: 'Move right by 10 units' },
      createOfflineTransport(),
    );
    expect(result.scene.nodes[0]!.rect.x).toBe(470);
    expect(result.origin).toBe('offline');
    expect(result.scene.nodes.slice(1)).toEqual(scene().nodes.slice(1));
    await expect(
      compileScene(
        {
          scene: scene(),
          selectionId: 'effects',
          intent: 'Send chat messages and change cooldown',
        },
        createOfflineTransport(),
      ),
    ).rejects.toThrow(/behavior|supported/i);
  });
  it('quotes selected context, validates model output and closes transport', async () => {
    let closed = false;
    const next = scene();
    next.nodes[0]!.rect.x += 5;
    const result = await compileScene(
      { scene: scene(), selectionId: 'effects', intent: 'Move this slightly to the right' },
      {
        kind: 'codex',
        model: 'test',
        async open(_request, files, options) {
          expect(files['TASK.md']).toContain('effects');
          expect(options?.outputSchema).toBeDefined();
          return {
            threadId: 'thread',
            async turn(prompt) {
              expect(prompt).toContain('untrusted');
              return { output: { scene: next, summary: 'Moved right.' }, usage: null };
            },
            async close() {
              closed = true;
            },
          };
        },
      },
    );
    expect(closed).toBe(true);
    expect(result.scene).toEqual(next);
  });
});
it('bounds uncooperative model turns and closes the session after cancellation', async () => {
  let closed = false;
  await expect(
    compileScene(
      { scene: scene(), selectionId: 'effects', intent: 'Move right by 10 units' },
      {
        kind: 'codex',
        model: 'test',
        async open() {
          return {
            threadId: null,
            turn: () => new Promise(() => undefined),
            async close() {
              closed = true;
            },
          };
        },
      },
      { timeoutMs: 10 },
    ),
  ).rejects.toThrow(/cancelled|timed out/);
  expect(closed).toBe(true);
});
it('retains the selected celebration delay and duration in the canonical document', async () => {
  const result = await compileScene(
    {
      scene: scene(),
      selectionId: 'celebration',
      intent: 'Show this 2 seconds after round end for 5 seconds',
    },
    createOfflineTransport(),
  );
  expect(result.scene.nodes.find((n) => n.id === 'celebration')?.timing).toEqual({
    trigger: 'round-end',
    delayMs: 2000,
    durationMs: 5000,
  });
});
it('replays the recorded scene prompt fixture through host validation', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/scene-edit.json', import.meta.url), 'utf8'),
  );
  const result = await compileScene(
    { scene: scene(), selectionId: fixture.selectionId, intent: fixture.intent },
    {
      kind: 'codex',
      model: 'fixture',
      async open() {
        return {
          threadId: 'fixture',
          async turn() {
            return { output: fixture.output, usage: null };
          },
          async close() {},
        };
      },
    },
  );
  expect(result.promptVersion).toBe(fixture.promptVersion);
  expect(result.scene.nodes.find((n) => n.id === 'effects')?.rect.x).toBe(470);
});
it('closes a late-opened model workspace after the request has timed out', async () => {
  let resolve!: (session: CompilerSession) => void;
  let closed = false;
  await expect(
    compileScene(
      { scene: scene(), selectionId: 'effects', intent: 'Move right by 10 units' },
      {
        kind: 'codex',
        model: 'test',
        open: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
      { timeoutMs: 10 },
    ),
  ).rejects.toThrow(/timed out/);
  resolve({
    threadId: null,
    async turn() {
      throw new Error('Must not run');
    },
    async close() {
      closed = true;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(true);
});
