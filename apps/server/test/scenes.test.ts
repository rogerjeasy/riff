import type { OverlayMessage } from '../src/services/overlay/broker.js';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_SCENE, EXAMPLES } from '@riff/sdk';
import { artifactIdentity } from '@riff/sandbox';
import { createApp, type RiffApp } from '../src/app.js';
import type { SceneState } from '../src/services/scenes/service.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const post = (app: RiffApp, path: string, payload: object) =>
  app.inject({ method: 'POST', url: path, payload, headers: { 'x-riff-request': '1' } });
function version(app: RiffApp) {
  const example = EXAMPLES[0]!;
  return app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Tomato').id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: example.source, manifest: example.manifest }),
    title: 'Tomato',
    intent: example.intent,
    source: example.source,
    manifest: example.manifest,
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: { verification: { ok: true }, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
}
it('persists revision CAS, immutable review evidence and rejects stale/private activation', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app),
    path = `/api/scenes/${v.id}`;
  const initial = await app.inject(path);
  expect(initial.statusCode).toBe(200);
  expect(initial.json().state.revision).toBe(0);
  const edited = structuredClone(DEFAULT_SCENE);
  edited.nodes[0]!.rect.x += 5;
  const saved = await post(app, path, { expectedRevision: 0, source: 'direct', scene: edited });
  expect(saved.statusCode).toBe(200);
  const state = saved.json().state as SceneState;
  expect(state).toMatchObject({ revision: 1, classification: 'review', appliedRevision: null });
  expect(
    (await post(app, path, { expectedRevision: 0, source: 'direct', scene: edited })).statusCode,
  ).toBe(409);
  expect(
    (await post(app, `${path}/apply`, { expectedRevision: 1, digest: state.digest })).statusCode,
  ).toBe(409);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  expect(
    (await post(app, `${path}/apply`, { expectedRevision: 1, digest: '0'.repeat(64) })).statusCode,
  ).toBe(409);
  expect(
    (await post(app, `${path}/apply`, { expectedRevision: 1, digest: state.digest })).json().state
      .appliedRevision,
  ).toBe(1);
  edited.nodes[0]!.rect.x += 5;
  const configuration = await post(app, path, {
    expectedRevision: 1,
    source: 'direct',
    scene: edited,
  });
  expect(configuration.json().state.classification).toBe('configuration');
  expect(configuration.json().state.appliedRevision).toBe(1);
  const undo = await post(app, `${path}/undo`, { expectedRevision: 2, targetRevision: 1 });
  expect(undo.json().state).toMatchObject({ revision: 3, scene: state.scene });
  expect(undo.json().state.history).toHaveLength(3);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: path,
        payload: { expectedRevision: 3, scene: edited, source: 'direct' },
      })
    ).statusCode,
  ).toBe(403);
});
it('rejects protected overlap, forged generation source and unknown cross-channel versions', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app),
    path = `/api/scenes/${v.id}`;
  const invalid = structuredClone(DEFAULT_SCENE);
  invalid.nodes[0]!.rect.x = 20;
  expect(
    (await post(app, path, { expectedRevision: 0, source: 'direct', scene: invalid })).statusCode,
  ).toBe(400);
  expect(
    (await post(app, path, { expectedRevision: 0, source: 'generated', scene: DEFAULT_SCENE }))
      .statusCode,
  ).toBe(400);
  expect((await app.inject('/api/scenes/00000000-0000-4000-8000-000000000001')).statusCode).toBe(
    404,
  );
});
it('generates an offline contextual candidate without publishing it and honors panic', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app),
    path = `/api/scenes/${v.id}`;
  const messages: string[] = [];
  app.riff.overlay.attach({ send: (data) => messages.push(data), close() {} }, 'home');
  const saved = await post(app, `${path}/generate`, {
    expectedRevision: 0,
    selectionId: 'effects',
    intent: 'Move right by 10 units',
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().state.history[0].source).toBe('generated');
  expect(
    messages.flatMap((m) => (JSON.parse(m).type === 'scenes' ? JSON.parse(m).payload.scenes : [])),
  ).toHaveLength(0);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  app.riff.studio.panic('test');
  expect(
    (await post(app, `${path}/apply`, { expectedRevision: 1, digest: saved.json().state.digest }))
      .statusCode,
  ).toBe(409);
});
it('rejects a model result when another edit wins CAS while generation is running', async () => {
  let resolve!: (value: { output: unknown; usage: null }) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const app = await createApp({
    logger: false,
    transport: {
      kind: 'codex',
      model: 'test',
      async open() {
        return {
          threadId: 'thread',
          async turn() {
            started();
            return new Promise((r) => {
              resolve = r;
            });
          },
          async close() {},
        };
      },
    },
  });
  apps.push(app);
  const v = version(app),
    path = `/api/scenes/${v.id}`;
  const generating = post(app, `${path}/generate`, {
    expectedRevision: 0,
    selectionId: 'effects',
    intent: 'Move right by 10 units',
  });
  void generating.then(() => undefined);
  await ready;
  expect(
    (await post(app, path, { expectedRevision: 0, source: 'direct', scene: DEFAULT_SCENE }))
      .statusCode,
  ).toBe(200);
  resolve({ output: { scene: DEFAULT_SCENE, summary: 'done' }, usage: null });
  const response = await generating;
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('STALE');
  expect((await app.inject(path)).json().state.history).toHaveLength(1);
});
it('publishes exact active scenes with per-automation instructions and withdraws them on pause', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app),
    path = `/api/scenes/${v.id}`;
  const messages: OverlayMessage[] = [];
  app.riff.overlay.attach(
    { send: (data) => messages.push(JSON.parse(data) as OverlayMessage), close() {} },
    'home',
  );
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  const active = messages.filter((m) => m.type === 'scenes').at(-1)!;
  expect(active.payload.scenes[0]).toMatchObject({
    versionId: v.id,
    automationId: v.automationId,
    revision: 0,
  });
  expect(active.payload.scenes[0]!.instructions[0]).toContain('!tomato');
  const saved = (
    await post(app, path, { expectedRevision: 0, source: 'direct', scene: DEFAULT_SCENE })
  ).json().state;
  await post(app, `${path}/apply`, { expectedRevision: 1, digest: saved.digest });
  const applied = messages.filter((m) => m.type === 'scenes').at(-1)!;
  expect(applied.payload.scenes[0]!.digest).toBe(saved.digest);
  app.riff.studio.pause(v.automationId);
  expect(messages.filter((m) => m.type === 'scenes').at(-1)!.payload.scenes).toEqual([]);
});
it('rejects scene application conflicting with another active protected region', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const first = version(app),
    second = version(app);
  app.riff.studio.approve(first.id, { artifactId: first.artifactId!, activeVersionId: null });
  app.riff.studio.approve(second.id, { artifactId: second.artifactId!, activeVersionId: null });
  // This camera sits where the first interaction's default effects fly: a real protected conflict.
  const candidate = structuredClone(DEFAULT_SCENE);
  candidate.regions.find((r) => r.id === 'camera')!.rect = {
    x: 500,
    y: 20,
    width: 100,
    height: 100,
  };
  candidate.nodes.find((n) => n.id === 'effects')!.rect = {
    x: 440,
    y: 140,
    width: 540,
    height: 480,
  };
  const path = `/api/scenes/${second.id}`;
  const saved = (
    await post(app, path, { expectedRevision: 0, source: 'direct', scene: candidate })
  ).json().state;
  expect(saved.sharing.join(' ')).toContain('protects part of the screen');
  const applied = await post(app, `${path}/apply`, { expectedRevision: 1, digest: saved.digest });
  expect(applied.statusCode).toBe(409);
  expect(applied.json().message).toContain('another active');
});
it('isolates tenants and restores the applied scene after server restart', async () => {
  const { openDatabase } = await import('../src/db/client.js');
  const { forChannel } = await import('../src/db/repositories/studio.js');
  const { migrateConnection } = await import('../src/app.js');
  const database = openDatabase(':memory:');
  migrateConnection(database);
  const app = await createApp({ logger: false, database });
  const v = version(app);
  const foreign = forChannel(database, 'foreign');
  foreign.ensure('Other');
  const other = foreign.insertVersion({ ...v, automationId: foreign.createAutomation('Other').id });
  expect((await app.inject(`/api/scenes/${other.id}`)).statusCode).toBe(404);
  const saved = app.riff.scenes.save(v.id, 0, DEFAULT_SCENE);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  app.riff.scenes.apply(v.id, saved.revision, saved.digest);
  await app.close();
  const restarted = await createApp({ logger: false, database });
  try {
    expect(restarted.riff.scenes.state(v.id)).toMatchObject({
      appliedRevision: 1,
      digest: saved.digest,
      scene: saved.scene,
    });
    const messages: OverlayMessage[] = [];
    restarted.riff.overlay.attach(
      { send: (data) => messages.push(JSON.parse(data) as OverlayMessage), close() {} },
      'home',
    );
    expect(messages.find((m) => m.type === 'scenes')).toMatchObject({
      payload: { scenes: [{ versionId: v.id, revision: 1, digest: saved.digest }] },
    });
  } finally {
    await restarted.close();
    database.close();
  }
});
it('rejects invalid ancestry and superseded behavior without changing applied presentation', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  const saved = app.riff.scenes.save(v.id, 0, DEFAULT_SCENE);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  const replacement = app.riff.repo.insertVersion({ ...v, parentVersionId: v.id });
  app.riff.studio.approve(replacement.id, {
    artifactId: replacement.artifactId!,
    activeVersionId: v.id,
  });
  expect(() => app.riff.scenes.apply(v.id, saved.revision, saved.digest)).toThrow(/active/);
  const removedParent = app.riff.repo.insertVersion({
    ...v,
    parentVersionId: '00000000-0000-4000-8000-000000000001',
  });
  expect(() => app.riff.scenes.save(removedParent.id, 0, DEFAULT_SCENE)).toThrow();
  expect(app.riff.scenes.state(v.id).appliedRevision).toBeNull();
});
it('withdraws cached scenes if authoritative reads fail and recovers on a later refresh', async () => {
  const { vi } = await import('vitest');
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  const messages: OverlayMessage[] = [];
  app.riff.overlay.attach(
    { send: (data) => messages.push(JSON.parse(data) as OverlayMessage), close() {} },
    'home',
  );
  const failure = vi.spyOn(app.riff.repo, 'automations').mockImplementationOnce(() => {
    throw new Error('database unavailable');
  });
  app.riff.hub.publish('studio', null);
  expect(messages.filter((m) => m.type === 'scenes').at(-1)?.payload.scenes).toEqual([]);
  failure.mockRestore();
  app.riff.hub.publish('studio', null);
  expect(messages.filter((m) => m.type === 'scenes').at(-1)?.payload.scenes).toHaveLength(1);
});
it('refuses persisted scene evidence whose digest no longer matches the reviewed document', async () => {
  const { openDatabase } = await import('../src/db/client.js');
  const { migrateConnection } = await import('../src/app.js');
  const database = openDatabase(':memory:');
  migrateConnection(database);
  const app = await createApp({ logger: false, database });
  try {
    const v = version(app),
      saved = app.riff.scenes.save(v.id, 0, DEFAULT_SCENE);
    const row = database.client
      .prepare('SELECT evidence FROM scene_revisions WHERE version_id = ?')
      .get(v.id) as { evidence: string };
    const changed = JSON.parse(row.evidence);
    changed.scene.nodes[0].rect.x += 1;
    database.client
      .prepare('UPDATE scene_revisions SET evidence = ? WHERE version_id = ?')
      .run(JSON.stringify(changed), v.id);
    expect(() => app.riff.scenes.state(v.id)).toThrow(/artifact|evidence|review|active/);
    expect(saved.revision).toBe(1);
  } finally {
    await app.close();
    database.close();
  }
});
it('re-emits the same eligible scene after a clear and refresh', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  const messages: OverlayMessage[] = [];
  app.riff.overlay.attach(
    { send: (data) => messages.push(JSON.parse(data) as OverlayMessage), close() {} },
    'home',
  );
  app.riff.overlay.clear('pause');
  const afterClear = messages.length;
  app.riff.hub.publish('studio', null);
  expect(messages.slice(afterClear).find((m) => m.type === 'scenes')).toMatchObject({
    payload: { scenes: [{ versionId: v.id }] },
  });
});
it('pins inherited presentation approval to a new behavior version without later parent drift', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  const custom = structuredClone(DEFAULT_SCENE);
  custom.regions[0]!.rect.width = 250;
  const saved = app.riff.scenes.save(v.id, 0, custom);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  app.riff.scenes.apply(v.id, saved.revision, saved.digest);
  const child = app.riff.repo.insertVersion({ ...v, parentVersionId: v.id });
  app.riff.scenes.inherit(child.id, v.id);
  const inherited = app.riff.scenes.state(child.id);
  expect(inherited).toMatchObject({
    revision: 1,
    appliedRevision: 1,
    source: 'inherited',
    scene: custom,
    inheritedFrom: { versionId: v.id, revision: 1, digest: saved.digest },
  });
  custom.regions[0]!.rect.width = 260;
  const parentNext = app.riff.scenes.save(v.id, 1, custom);
  app.riff.scenes.apply(v.id, parentNext.revision, parentNext.digest);
  expect(app.riff.scenes.state(child.id).scene).toEqual(inherited.scene);
  app.riff.studio.approve(child.id, { artifactId: child.artifactId!, activeVersionId: v.id });
  const messages: OverlayMessage[] = [];
  app.riff.overlay.attach(
    { send: (data) => messages.push(JSON.parse(data) as OverlayMessage), close() {} },
    'home',
  );
  expect(messages.find((m) => m.type === 'scenes')).toMatchObject({
    payload: { scenes: [{ versionId: child.id, scene: inherited.scene }] },
  });
});
it('inherits presentation inside the normal authoring candidate transaction', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  const saved = app.riff.scenes.save(v.id, 0, DEFAULT_SCENE);
  app.riff.scenes.apply(v.id, saved.revision, saved.digest);
  const started = app.riff.authoring.start({
    intent: 'Change the command to !splat, allow two throws per 30 seconds, subscribers only.',
    baseVersionId: v.id,
  });
  for (let i = 0; i < 200; i++) {
    const run = app.riff.authoring.runs().find((r) => r.id === started.id);
    if (run?.result) {
      expect(run.result.status).toBe('ready');
      expect(app.riff.scenes.state(run.result.versionId!)).toMatchObject({
        source: 'inherited',
        appliedRevision: 1,
        scene: saved.scene,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Authoring did not finish');
});
it('returns the same host participation instructions for private and live scene views', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  const messages: OverlayMessage[] = [];
  app.riff.overlay.attach({ send: (data) => messages.push(JSON.parse(data)), close() {} }, 'home');
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });
  const live = messages.filter((m) => m.type === 'scenes').at(-1);
  expect(live?.type).toBe('scenes');
  const state = (await app.inject(`/api/scenes/${v.id}`)).json().state;
  expect(state.instructions).toEqual(
    live?.type === 'scenes' ? live.payload.scenes[0]?.instructions : [],
  );
});

it('lets live interactions share text space, and explains how the overlay resolves it', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const first = version(app),
    second = version(app);
  app.riff.studio.approve(first.id, { artifactId: first.artifactId!, activeVersionId: null });
  app.riff.studio.approve(second.id, { artifactId: second.artifactId!, activeVersionId: null });
  const path = `/api/scenes/${second.id}`;
  const moved = structuredClone(DEFAULT_SCENE);
  moved.nodes.find((n) => n.id === 'effects')!.rect.x += 10;
  const saved = (
    await post(app, path, { expectedRevision: 0, source: 'direct', scene: moved })
  ).json().state as SceneState & { sharing: string[] };
  expect(saved.sharing).toHaveLength(1);
  expect(saved.sharing[0]).toMatch(
    /Shares screen space with “Tomato”.*instructions combine into one panel/,
  );
  const applied = await post(app, `${path}/apply`, { expectedRevision: 1, digest: saved.digest });
  expect(applied.statusCode).toBe(200);
  expect(applied.json().state.appliedRevision).toBe(1);
});
it('explains which object breaks a layout instead of a generic rejection', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  const invalid = structuredClone(DEFAULT_SCENE);
  invalid.nodes.find((n) => n.id === 'effects')!.rect.x = 20;
  const response = await post(app, `/api/scenes/${v.id}`, {
    expectedRevision: 0,
    source: 'direct',
    scene: invalid,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().message).toContain('Effects covers the protected Camera region');
});
