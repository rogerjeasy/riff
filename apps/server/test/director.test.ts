import { afterEach, expect, it } from 'vitest';
import {
  DEFAULT_DIRECTOR_ENVELOPE,
  EXAMPLES,
  type PermissionManifest,
  type DirectorState,
} from '@riff/sdk';
import { artifactIdentity } from '@riff/sandbox';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { directorRepository } from '../src/db/repositories/director.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const post = (app: RiffApp, action: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: `/api/director/${action}`,
    payload,
    headers: { 'x-riff-request': '1' },
  });
function version(app: RiffApp, session = false) {
  const example = EXAMPLES[0]!;
  const manifest: PermissionManifest = session
    ? {
        ...example.manifest,
        sdkVersion: '0.4.0',
        capabilities: ['overlay', 'session'],
        experience: {
          version: 1,
          title: 'Community tomatoes',
          durationMs: 120000,
          maxParticipants: 256,
          teams: [],
          resource: { name: 'throws', perParticipant: 3 },
          contribution: { command: '!tomato', points: 2 },
          objective: { kind: 'collective-goal', target: 1000 },
        },
      }
    : example.manifest;
  return app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Director proof').id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: example.source, manifest }),
    title: 'Director proof',
    intent: example.intent,
    source: example.source,
    manifest,
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: { verification: { ok: true }, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
}
async function review(app: RiffApp, session = false) {
  const v = version(app, session);
  const saved = await post(app, 'draft', {
    expectedRevision: 0,
    envelope: DEFAULT_DIRECTOR_ENVELOPE,
  });
  expect(saved.statusCode).toBe(200);
  const replay = await post(app, 'rehearse', { expectedRevision: 1, versionId: v.id });
  expect(replay.statusCode).toBe(200);
  return { state: replay.json().state as DirectorState, version: v };
}
it('requires exact private stress evidence before approval and preserves real session progress', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const live: string[] = [];
  app.riff.overlay.attach({ send: (s) => live.push(s), close() {} }, 'home');
  const { state, version: v } = await review(app, true);
  const evidence = state.draft!.evidence!;
  expect(evidence.passed).toBe(true);
  expect(evidence.accepted).toBeGreaterThan(0);
  expect(evidence.contributions).toBeGreaterThan(0);
  expect(evidence.stateDigest).toBe(evidence.replayStateDigest);
  expect(Object.values(evidence.scores).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  expect(evidence.telemetry.coalesced).toBeGreaterThan(0);
  expect(live.some((s) => JSON.parse(s).type === 'effect')).toBe(false);
  expect(app.riff.repo.session(v.automationId)).toBeUndefined();
  expect(
    (
      await post(app, 'approve', {
        expectedRevision: state.revision,
        digest: state.draft!.digest,
        evidenceHash: '0'.repeat(64),
      })
    ).statusCode,
  ).toBe(409);
  const approval = await post(app, 'approve', {
    expectedRevision: state.revision,
    digest: state.draft!.digest,
    evidenceHash: evidence.hash,
  });
  expect(approval.json().state.enabled).toBe(true);
  const current = approval.json().state as DirectorState;
  expect(
    (
      await post(app, 'control', {
        expectedRevision: current.revision,
        action: 'manual',
        settings: { intervalMs: 250, batchSize: 6, intensity: 100 },
      })
    ).statusCode,
  ).toBe(409);
  const lock = await post(app, 'control', { expectedRevision: current.revision, action: 'locked' });
  expect(lock.json().state.mode).toBe('locked');
  expect(
    (await post(app, 'control', { expectedRevision: current.revision, action: 'balanced' }))
      .statusCode,
  ).toBe(409);
  expect((await post(app, 'stop', {})).json().state.enabled).toBe(false);
});
it('isolates channel storage and rejects forged authority, stale drafts and unguarded mutations', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/director/draft',
        payload: { expectedRevision: 0, envelope: DEFAULT_DIRECTOR_ENVELOPE },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await post(app, 'draft', {
        expectedRevision: 0,
        envelope: { ...DEFAULT_DIRECTOR_ENVELOPE, cooldownMs: 10 },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await post(app, 'draft', { expectedRevision: 1, envelope: DEFAULT_DIRECTOR_ENVELOPE }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await post(app, 'rehearse', {
        expectedRevision: 0,
        versionId: '00000000-0000-4000-8000-000000000001',
      })
    ).statusCode,
  ).toBe(409);
  const db = openDatabase(':memory:');
  migrateConnection(db);
  try {
    const a = directorRepository(db, 'a'),
      b = directorRepository(db, 'b');
    a.save(0, {
      revision: 1,
      draft: null,
      approved: null,
      enabled: false,
      mode: 'balanced',
      settings: null,
      history: [],
    });
    expect(b.get()).toBeUndefined();
    expect(() => a.save(0, { ...a.get()!, revision: 1 })).toThrow(/changed/i);
  } finally {
    db.close();
  }
});
it('clears delayed cosmetics on panic and retains approval without automatic restart', async () => {
  const db = openDatabase(':memory:');
  migrateConnection(db);
  let time = 1000;
  const app = await createApp({ logger: false, database: db, now: () => time });
  const { state, version: v } = await review(app);
  await post(app, 'approve', {
    expectedRevision: state.revision,
    digest: state.draft!.digest,
    evidenceHash: state.draft!.evidence!.hash,
  });
  app.riff.studio.approve(v.id, {
    artifactId: v.artifactId!,
    reportHash: v.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  const frames: string[] = [];
  app.riff.overlay.attach({ send: (s) => frames.push(s), close() {} }, 'home');
  await app.riff.runtime.handleChat({
    id: 'one',
    channelId: 'home',
    viewerId: 'viewer',
    viewerName: 'Viewer',
    roles: ['viewer'],
    text: '!tomato',
    source: 'twitch',
  });
  expect(app.riff.director.view().telemetry?.pending).toBeGreaterThan(0);
  app.riff.runtime.panic('test');
  time += 2000;
  app.riff.director.tick();
  expect(frames.some((s) => JSON.parse(s).type === 'effect')).toBe(false);
  await app.close();
  const restarted = await createApp({ logger: false, database: db });
  expect(restarted.riff.director.view()).toMatchObject({
    enabled: false,
    approved: { digest: state.draft!.digest },
  });
  await restarted.close();
  db.close();
});
it('rejects an in-flight rehearsal after its draft is replaced', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  app.riff.director.save(0, DEFAULT_DIRECTOR_ENVELOPE);
  const pending = app.riff.director.rehearse(1, v.id);
  app.riff.director.save(1, { ...DEFAULT_DIRECTOR_ENVELOPE, interruptionsPerMinute: 10 });
  await expect(pending).rejects.toMatchObject({ code: 'STALE' });
  expect(app.riff.director.view().draft?.evidence).toBeNull();
  expect(() =>
    app.riff.director.approve(2, app.riff.director.view().draft!.digest, '0'.repeat(64)),
  ).toThrow(/evidence/i);
});
it('commits every accepted contribution before coalescing and drops revoked queued versions', async () => {
  let at = 1000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const { state, version: v } = await review(app, true);
  app.riff.director.approve(state.revision, state.draft!.digest, state.draft!.evidence!.hash);
  app.riff.studio.approve(v.id, {
    artifactId: v.artifactId!,
    reportHash: v.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  const frames: { type: string }[] = [];
  app.riff.overlay.attach({ send: (s) => frames.push(JSON.parse(s)), close() {} }, 'home');
  for (let n = 0; n < 20; n++) {
    const decisions = await app.riff.runtime.handleChat({
      id: `surge-${n}`,
      channelId: 'home',
      viewerId: `person-${n}`,
      viewerName: 'Viewer',
      roles: ['viewer'],
      text: '!tomato',
      source: 'twitch',
    });
    expect(decisions[0]?.code).toBe('ACCEPTED');
  }
  const snapshot = app.riff.repo.session(v.automationId)!.snapshot;
  expect(snapshot.scores.community).toBe(40);
  expect(
    Object.values(snapshot.participants).every((p) => p.contributions === 1 && p.remaining === 2),
  ).toBe(true);
  at += 1600;
  app.riff.director.tick();
  expect(frames.filter((f) => f.type === 'effect').length).toBeLessThan(20);
  expect(app.riff.director.view().telemetry?.coalesced).toBeGreaterThan(0);
  const before = frames.length;
  await app.riff.runtime.handleChat({
    id: 'late',
    channelId: 'home',
    viewerId: 'late',
    viewerName: 'Late',
    roles: ['viewer'],
    text: '!tomato',
    source: 'twitch',
  });
  app.riff.repo.updateAutomation(v.automationId, { status: 'paused' });
  at += 2000;
  app.riff.director.tick();
  expect(frames.slice(before).some((f) => f.type === 'effect')).toBe(false);
});
it('stops presentation in memory even when the durable write fails', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const { state } = await review(app);
  app.riff.director.approve(state.revision, state.draft!.digest, state.draft!.evidence!.hash);
  // A second service with an injected failed repository exercises the same stop path.
  const { createDirectorService } = await import('../src/services/director/service.js');
  const stored = app.riff.director.view();
  let writesFail = false;
  const service = createDirectorService({
    repo: app.riff.repo,
    blocked: () => false,
    emit: () => {
      throw new Error('Unexpected output');
    },
    storage: {
      claimBatch: () => true,
      get: () => stored,
      save: (_expected, next) => {
        if (writesFail) throw new Error('Disk unavailable');
        Object.assign(stored, next);
      },
    },
  });
  service.control(stored.revision, 'balanced');
  writesFail = true;
  expect(() => service.stop()).toThrow('Disk unavailable');
  expect(service.view().enabled).toBe(false);
  expect(() => service.tick()).not.toThrow();
  service.close();
});
it('rejects gameplay queue overflow visibly before counting a contribution', async () => {
  const app = await createApp({ logger: false, now: () => 1000 });
  apps.push(app);
  const v = version(app, true);
  app.riff.repo.activate(v.automationId, v.id, 'console');
  app.riff.runtime.activate(v.automationId, app.riff.repo.version(v.id)!);
  const message = (n: number) => ({
    id: `capacity-${n}`,
    channelId: 'home',
    viewerId: `viewer-${n}`,
    viewerName: 'Viewer',
    roles: ['viewer' as const],
    text: '!tomato',
    source: 'twitch' as const,
  });
  const acceptedWork = Array.from({ length: 128 }, (_, n) =>
    app.riff.runtime.handleChat(message(n)),
  );
  const overflow = await app.riff.runtime.handleChat(message(128));
  expect(overflow[0]?.code).toBe('CAPACITY');
  await Promise.all(acceptedWork);
  expect(
    app.riff.repo.session(v.automationId)?.snapshot.participants['viewer-128'],
  ).toBeUndefined();
  expect(app.riff.repo.activity(200).some((entry) => entry.code === 'CAPACITY')).toBe(true);
});
it.each(['swap', 'rollback', 'reset'] as const)(
  'fences queued cosmetics across %s before choosing a new batch',
  async (change) => {
    let at = 1000;
    const app = await createApp({ logger: false, now: () => at });
    apps.push(app);
    const { state, version: v } = await review(app, true);
    app.riff.director.approve(state.revision, state.draft!.digest, state.draft!.evidence!.hash);
    app.riff.studio.approve(v.id, {
      artifactId: v.artifactId!,
      reportHash: v.reportHash!,
      approvedBy: 'console',
      activeVersionId: null,
    });
    const frames: { type: string; payload: { viewer?: string } }[] = [];
    app.riff.overlay.attach({ send: (s) => frames.push(JSON.parse(s)), close() {} }, 'home');
    const chat = (id: string) =>
      app.riff.runtime.handleChat({
        id,
        channelId: 'home',
        viewerId: id,
        viewerName: id,
        roles: ['viewer'],
        text: '!tomato',
        source: 'twitch',
      });
    // Freeze one-slot batches so an obsolete effect would consume the only selection.
    const current = app.riff.director.view();
    app.riff.director.control(current.revision, 'manual', {
      intervalMs: 1500,
      batchSize: 1,
      intensity: 35,
    });
    await chat('old');
    if (change === 'reset')
      app.riff.runtime.resetSession(v.automationId, app.riff.repo.version(v.id)!);
    else {
      const next = app.riff.repo.insertVersion({
        ...v,
        parentVersionId: v.id,
        status: 'candidate',
      });
      app.riff.repo.activate(v.automationId, next.id, 'console');
      app.riff.runtime.activate(v.automationId, app.riff.repo.version(next.id)!);
      if (change === 'rollback') {
        app.riff.repo.activate(v.automationId, v.id, 'console');
        app.riff.runtime.activate(v.automationId, app.riff.repo.version(v.id)!);
      }
    }
    await chat('new');
    at += 1600;
    app.riff.director.tick();
    expect(frames.filter((f) => f.type === 'effect').map((f) => f.payload.viewer)).toEqual(['new']);
  },
);
it('preserves the interruption budget across approvals and restart with atomic channel scope', () => {
  const db = openDatabase(':memory:');
  migrateConnection(db);
  try {
    const storage = directorRepository(db, 'home');
    const initial = {
      revision: 1,
      draft: null,
      approved: null,
      enabled: false,
      mode: 'balanced' as const,
      settings: null,
      history: [],
    };
    storage.save(0, initial);
    expect(storage.claimBatch(1000, 1)).toBe(true);
    storage.save(1, { ...initial, revision: 2 });
    expect(storage.claimBatch(1001, 1)).toBe(false);
    const reopened = directorRepository(db, 'home');
    expect(reopened.claimBatch(2000, 1)).toBe(false);
    expect(reopened.claimBatch(61000, 1)).toBe(true);
    expect(directorRepository(db, 'other').claimBatch(61001, 60)).toBe(false);
  } finally {
    db.close();
  }
});
it('enforces one durable batch even after exact reapproval and process restart', async () => {
  let at = 1000;
  const db = openDatabase(':memory:');
  migrateConnection(db);
  const app = await createApp({ logger: false, database: db, now: () => at });
  const v = version(app);
  app.riff.director.save(0, { ...DEFAULT_DIRECTOR_ENVELOPE, interruptionsPerMinute: 1 });
  const reviewed = await app.riff.director.rehearse(1, v.id);
  app.riff.director.approve(
    reviewed.revision,
    reviewed.draft!.digest,
    reviewed.draft!.evidence!.hash,
  );
  app.riff.studio.approve(v.id, {
    artifactId: v.artifactId!,
    reportHash: v.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  const frames: { type: string }[] = [];
  const attach = (a: RiffApp) =>
    a.riff.overlay.attach({ send: (s) => frames.push(JSON.parse(s)), close() {} }, 'home');
  const chat = (a: RiffApp, id: string) =>
    a.riff.runtime.handleChat({
      id,
      channelId: 'home',
      viewerId: id,
      viewerName: id,
      roles: ['viewer'],
      text: '!tomato',
      source: 'twitch',
    });
  attach(app);
  await chat(app, 'first');
  at += 2000;
  app.riff.director.tick();
  expect(frames.filter((f) => f.type === 'effect')).toHaveLength(1);
  app.riff.director.approve(
    app.riff.director.view().revision,
    reviewed.draft!.digest,
    reviewed.draft!.evidence!.hash,
  );
  await chat(app, 'second');
  at += 2000;
  app.riff.director.tick();
  expect(frames.filter((f) => f.type === 'effect')).toHaveLength(1);
  await app.close();
  const restarted = await createApp({ logger: false, database: db, now: () => at });
  try {
    attach(restarted);
    restarted.riff.director.control(restarted.riff.director.view().revision, 'balanced');
    await chat(restarted, 'third');
    at += 2000;
    restarted.riff.director.tick();
    expect(frames.filter((f) => f.type === 'effect')).toHaveLength(1);
    expect(
      restarted.riff.director
        .view()
        .telemetry?.decisions.some((d) => d.reason.includes('durable interruption')),
    ).toBe(true);
  } finally {
    await restarted.close();
    db.close();
  }
});
it('prunes old envelope revisions instead of locking drafts, keeping the approved one', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const { state } = await review(app);
  const approved = await post(app, 'approve', {
    expectedRevision: state.revision,
    digest: state.draft!.digest,
    evidenceHash: state.draft!.evidence!.hash,
  });
  let revision = (approved.json().state as DirectorState).revision;
  for (let n = 0; n < 60; n++) {
    const saved = await post(app, 'draft', {
      expectedRevision: revision,
      envelope: { ...DEFAULT_DIRECTOR_ENVELOPE, interruptionsPerMinute: 1 + (n % 50) },
    });
    expect(saved.statusCode).toBe(200);
    revision = (saved.json().state as DirectorState).revision;
  }
  const final = (await app.inject({ url: '/api/director' })).json().state as DirectorState;
  expect(final.history).toHaveLength(50);
  expect(final.history.some((h) => h.revision === final.approved!.revision)).toBe(true);
  expect(final.history.at(-1)!.revision).toBe(61);
});
it('reports a stopped stress test as a clear conflict rather than a server failure', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const v = version(app);
  await post(app, 'draft', { expectedRevision: 0, envelope: DEFAULT_DIRECTOR_ENVELOPE });
  const running = post(app, 'rehearse', { expectedRevision: 1, versionId: v.id });
  await new Promise((resolve) => setImmediate(resolve));
  await post(app, 'stop', {});
  const result = await running;
  if (result.statusCode !== 200) {
    expect(result.statusCode).toBe(409);
    expect(result.json().message).toMatch(/stopped|changed/i);
  }
});
