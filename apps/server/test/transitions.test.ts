import { afterEach, expect, it, vi } from 'vitest';
import { artifactIdentity, pauseSession } from '@riff/sandbox';
import type { ExperienceDefinition, SessionTransitionBoundary } from '@riff/sdk';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { sessionTransitions, sessionOutbox, versions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { forChannel } from '../src/db/repositories/studio.js';
import type { VersionRow } from '../src/db/repositories/studio.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const definition: ExperienceDefinition = {
  version: 1,
  title: 'Battle',
  durationMs: 120000,
  maxParticipants: 16,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score', target: null },
};
const migration = `(input)=>{const s=JSON.parse(JSON.stringify(input.snapshot));for(const p of Object.values(s.participants))p.remaining+=input.newDefinition.resource.perParticipant-input.oldDefinition.resource.perParticipant;return s;}`;
async function setup(database?: DatabaseConnection) {
  let at = 1000;
  const app = await createApp({ logger: false, ...(database ? { database } : {}), now: () => at });
  apps.push(app);
  const repo = app.riff.repo;
  const automation = repo.createAutomation('Battle');
  function version(def: ExperienceDefinition, parent: string | null = null, suffix = '') {
    const source =
      `async(e,riff)=>{await riff.overlay.emit({kind:'projectile',asset:'tomato',x:riff.util.random()});}` +
      suffix;
    const manifest = {
      sdkVersion: '0.4.0',
      capabilities: ['overlay', 'session'],
      experience: def,
      trigger: {
        command: def.contribution.command,
        audience: ['viewer'],
        maxPerViewer: 5,
        windowMs: 120000,
      },
      limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
    };
    return repo.insertVersion({
      automationId: automation.id,
      parentVersionId: parent,
      artifactId: artifactIdentity({ source, manifest }),
      title: 'Battle',
      intent: 'Battle',
      source,
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
  const old = version(definition);
  repo.activate(automation.id, old.id);
  app.riff.runtime.activate(automation.id, repo.version(old.id)!);
  const next = version(
    {
      ...definition,
      resource: { name: 'throws', perParticipant: 5 },
      contribution: { command: '!splat', points: 1 },
    },
    old.id,
  );
  const chat = (id: string, text: string) =>
    app.riff.runtime.handleChat({
      id,
      text,
      viewerId: 'alice',
      viewerName: 'Alice',
      channelId: 'channel',
      roles: ['viewer'],
      source: 'twitch',
    });
  await chat('join', '!red');
  await chat('throw', '!throw');
  const preview = async (
    boundary: SessionTransitionBoundary = 'immediate',
    source = migration,
    target: VersionRow = next,
  ) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/versions/${target.id}/transition/preview`,
      headers: { 'x-riff-request': '1' },
      payload: { boundary, migrationSource: source },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().transition;
  };
  const approve = async (t: Record<string, unknown>, target: VersionRow = next) =>
    app.inject({
      method: 'POST',
      url: `/api/transitions/${t.id}/approve`,
      headers: { 'x-riff-request': '1' },
      payload: {
        evidenceId: t.evidenceId,
        artifactId: target.artifactId,
        expectedActiveVersionId: old.id,
        sessionId: repo.session(automation.id)!.id,
        boundary: (t.plan as { boundary: string }).boundary,
      },
    });
  return {
    app,
    repo,
    automation,
    old,
    next,
    version,
    chat,
    preview,
    approve,
    setAt: (n: number) => {
      at = n;
    },
    now: () => at,
  };
}
it('privately compares then revalidates current chat at approval and audits across the migration', async () => {
  const f = await setup();
  const before = f.repo.session(f.automation.id)!;
  const t = await f.preview();
  expect(t.status).toBe('review');
  expect(t.evidence.comparison.provenance).toBe('synthetic');
  expect(t.evidence.comparison.steps.length).toBeGreaterThan(0);
  expect(f.repo.session(f.automation.id)).toEqual(before);
  await f.chat('during-review', '!throw');
  const approved = await f.approve(t);
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().transition.status).toBe('applied');
  expect(f.repo.session(f.automation.id)?.snapshot).toMatchObject({
    scores: { red: 2 },
    participants: { alice: { remaining: 3, contributions: 2, teamId: 'red' } },
  });
  expect((await f.chat('old', '!throw'))[0]?.code).toBe('UNRELATED');
  expect((await f.chat('new', '!splat'))[0]?.code).toBe('ACCEPTED');
  expect((await f.app.riff.studio.auditSession(f.automation.id)).status).toBe('verified');
});
it('rejects stale session resets and exact evidence identity mismatch without activation', async () => {
  const f = await setup();
  const t = await f.preview();
  const bad = await f.approve({ ...t, evidenceId: '0'.repeat(64) });
  expect(bad.statusCode).toBe(409);
  f.app.riff.studio.resetSession(f.automation.id);
  expect((await f.approve(t)).statusCode).toBe(409);
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
});
it('persists round-end pending work, supports cancellation and applies on final state only once', async () => {
  const f = await setup();
  const t = await f.preview('round-end');
  expect((await f.approve(t)).json().transition.status).toBe('pending');
  await f.chat('pending-chat', '!throw');
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  f.setAt(121000);
  await f.app.riff.runtime.tick();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.next.id);
  const final = f.repo.session(f.automation.id)!;
  expect(final.snapshot).toMatchObject({
    phase: 'finished',
    scores: { red: 2 },
    participants: { alice: { remaining: 3 } },
  });
  await f.app.riff.runtime.tick();
  expect(f.repo.session(f.automation.id)?.revision).toBe(final.revision);
});
it('requires stopped approval while already paused and keeps it paused', async () => {
  const f = await setup();
  const t = await f.preview('stopped');
  expect((await f.approve(t)).statusCode).toBe(409);
  f.app.riff.studio.pause(f.automation.id);
  expect((await f.approve(t)).statusCode).toBe(200);
  expect(f.repo.session(f.automation.id)?.snapshot.phase).toBe('paused');
  expect(f.repo.automation(f.automation.id)?.status).toBe('paused');
  expect(f.app.riff.runtime.running()).toEqual([]);
});
it('panic cancels pending approval permanently and rejects delayed activation', async () => {
  const f = await setup();
  const t = await f.preview('round-end');
  await f.approve(t);
  f.app.riff.studio.panic('test');
  expect(
    f.app.riff.studio
      .snapshot()
      .automations[0]?.transitions.find((x: { id: string }) => x.id === t.id)?.status,
  ).toBe('cancelled');
  f.app.riff.studio.resume();
  f.setAt(121000);
  await f.app.riff.runtime.tick();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
});
it('failed storage leaves source state and engine usable', async () => {
  const f = await setup();
  const t = await f.preview();
  const before = f.repo.session(f.automation.id)!;
  const write = vi.spyOn(f.repo, 'commitTransition').mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  expect((await f.approve(t)).statusCode).toBe(500);
  write.mockRestore();
  expect(f.repo.session(f.automation.id)).toEqual(before);
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  expect((await f.chat('after-fail', '!throw'))[0]?.code).toBe('ACCEPTED');
});
it('rejects hostile output, resource-loss rollback and failed candidates', async () => {
  const f = await setup();
  let r = await f.app.inject({
    method: 'POST',
    url: `/api/versions/${f.next.id}/transition/preview`,
    headers: { 'x-riff-request': '1' },
    payload: {
      boundary: 'immediate',
      migrationSource: '(input)=>({...input.snapshot,scores:{red:99,blue:0}})',
    },
  });
  expect(r.statusCode).toBe(409);
  const t = await f.preview();
  await f.approve(t);
  r = await f.app.inject({
    method: 'POST',
    url: `/api/versions/${f.old.id}/transition/preview`,
    headers: { 'x-riff-request': '1' },
    payload: { boundary: 'immediate', migrationSource: migration },
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().message).toMatch(/reset/i);
});

it('recovers a durable pending transition across process replacement and allows permanent cancellation', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const t = await f.preview('round-end');
    await f.approve(t);
    await f.app.close();
    apps.splice(apps.indexOf(f.app), 1);
    f.setAt(121000);
    const restarted = await createApp({ logger: false, database, now: f.now });
    apps.push(restarted);
    await restarted.riff.runtime.tick();
    expect(restarted.riff.repo.automation(f.automation.id)?.activeVersionId).toBe(f.next.id);
    expect(restarted.riff.repo.transition(t.id)?.status).toBe('applied');
    const count = restarted.riff.repo
      .sessionJournal(f.repo.session(f.automation.id)!.id)
      .filter((e) => e.kind === 'migration').length;
    expect(count).toBe(1);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});
it('explicit cancellation prevents a pending transition after restart', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const t = await f.preview('round-end');
    await f.approve(t);
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/transitions/${t.id}/cancel`,
      headers: { 'x-riff-request': '1' },
    });
    expect(r.json().transition.status).toBe('cancelled');
    await f.app.close();
    apps.splice(apps.indexOf(f.app), 1);
    f.setAt(121000);
    const restarted = await createApp({ logger: false, database, now: f.now });
    apps.push(restarted);
    await restarted.riff.runtime.tick();
    expect(restarted.riff.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});
it('round-end approval on an already finished round applies immediately without restarting it', async () => {
  const f = await setup();
  f.setAt(121000);
  await f.app.riff.runtime.tick();
  const t = await f.preview('round-end');
  const r = await f.approve(t);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().transition.status).toBe('applied');
  expect(f.repo.session(f.automation.id)?.snapshot.phase).toBe('finished');
});
it('chat arriving during asynchronous activation is retained on the replacement engine', async () => {
  const f = await setup();
  const t = await f.preview();
  const activation = f.app.riff.studio.approveTransition(t.id, {
    evidenceId: t.evidenceId,
    artifactId: f.next.artifactId!,
    expectedActiveVersionId: f.old.id,
    sessionId: t.sourceSessionId,
    boundary: 'immediate',
  });
  const chat = f.chat('while-activating', '!splat');
  await activation;
  expect((await chat)[0]?.code).toBe('ACCEPTED');
  expect(f.repo.session(f.automation.id)?.snapshot.participants.alice).toMatchObject({
    contributions: 2,
    remaining: 3,
  });
});
it('panic arriving while migration is asynchronous fences commit and requires a fresh review', async () => {
  const f = await setup();
  const t = await f.preview();
  const original = f.repo.session.bind(f.repo);
  let release!: () => void;
  const begun = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.spyOn(f.repo, 'session').mockImplementation((id) => {
    const result = original(id);
    release();
    return result;
  });
  const activation = f.app.riff.runtime.activateTransition(t.id);
  await begun;
  f.app.riff.runtime.panic('during worker');
  await expect(activation).rejects.toThrow();
  read.mockRestore();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  expect(f.repo.session(f.automation.id)?.snapshot.scores.red).toBe(1);
  expect(f.repo.transition(t.id)?.status).toBe('cancelled');
  f.app.riff.runtime.resume();
  expect((await f.approve(t)).statusCode).toBe(409);
});
it('a revision change immediately before CAS preserves the newer state and refuses the candidate', async () => {
  const f = await setup();
  const t = await f.preview();
  const original = f.repo.commitTransition.bind(f.repo);
  const write = vi.spyOn(f.repo, 'commitTransition').mockImplementationOnce((...args) => {
    const current = f.repo.session(f.automation.id)!;
    f.repo.updateSessionControl(
      f.automation.id,
      pauseSession(current.snapshot, 2000, current.definition),
    );
    return original(...args);
  });
  expect((await f.approve(t)).statusCode).toBe(409);
  write.mockRestore();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  expect(f.repo.session(f.automation.id)?.snapshot.phase).toBe('paused');
});
it('rejects altered persisted evidence and unapproved failed targets', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const t = await f.preview();
    database.db
      .update(sessionTransitions)
      .set({ evidence: { preserved: ['invented'] } })
      .where(eq(sessionTransitions.id, t.id))
      .run();
    expect((await f.approve(t)).statusCode).toBe(409);
    f.repo.updateVersion(f.next.id, { status: 'failed' });
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/versions/${f.next.id}/transition/preview`,
      headers: { 'x-riff-request': '1' },
      payload: { boundary: 'immediate', migrationSource: migration },
    });
    expect(r.statusCode).toBe(409);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});
it('tenant-scopes evidence and enforces mutation guards before creating a private rehearsal', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const t = await f.preview();
    const other = forChannel(database, 'other');
    other.ensure('Other');
    expect(other.transition(t.id)).toBeUndefined();
    expect(other.transitions()).toEqual([]);
    expect(other.cancelTransition(t.id)).toBeUndefined();
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/versions/${f.next.id}/transition/preview`,
      headers: { origin: 'https://hostile.example' },
      payload: { boundary: 'immediate', migrationSource: migration },
    });
    expect(r.statusCode).toBe(403);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});
it('private previews never dispatch overlay effects and activation discards old queued cosmetics', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const messages: string[] = [];
    f.app.riff.overlay.attach({ send: (s) => messages.push(s), close: () => {} }, 'channel');
    messages.length = 0;
    const t = await f.preview();
    expect(messages.filter((s) => JSON.parse(s).type === 'effect')).toEqual([]);
    const state = f.repo.session(f.automation.id)!;
    const decision = (await f.chat('cosmetic', '!throw'))[0]!;
    database.db
      .insert(sessionOutbox)
      .values({
        id: 'old-effect',
        channelId: f.repo.channelId,
        automationId: f.automation.id,
        sessionId: state.id,
        versionId: f.old.id,
        decision,
        viewer: 'Alice',
        at: 1000,
        dispatchedAt: null,
      })
      .run();
    messages.length = 0;
    await f.approve(t);
    expect(f.repo.sessionOutbox(f.automation.id)).toEqual([]);
    expect(messages.filter((s) => JSON.parse(s).type === 'effect')).toEqual([]);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});

it('malformed verification evidence fails closed as an approval blocker', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    database.db.update(versions).set({ evidence: {} }).where(eq(versions.id, f.next.id)).run();
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/versions/${f.next.id}/transition/preview`,
      headers: { 'x-riff-request': '1' },
      payload: { boundary: 'immediate', migrationSource: migration },
    });
    expect(r.statusCode).toBe(409);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});

it('audits migration after an identical-definition activation with no intervening chat', async () => {
  const f = await setup();
  const same = f.version(definition, f.old.id, '/* revised handler */');
  f.app.riff.studio.approve(same.id, { artifactId: same.artifactId!, activeVersionId: f.old.id });
  const t = await f.preview();
  await f.app.riff.studio.approveTransition(t.id, {
    evidenceId: t.evidenceId,
    artifactId: f.next.artifactId!,
    expectedActiveVersionId: same.id,
    sessionId: t.sourceSessionId,
    boundary: 'immediate',
  });
  expect((await f.app.riff.studio.auditSession(f.automation.id)).status).toBe('verified');
});

it('rolls back every state/version write when the migration journal write fails', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const t = await f.preview();
    const before = f.repo.session(f.automation.id);
    f.setAt(2000);
    database.client.exec(
      "CREATE TEMP TRIGGER fail_migration_journal BEFORE INSERT ON session_journal WHEN NEW.kind = 'migration' BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END",
    );
    expect((await f.approve(t)).statusCode).toBe(500);
    expect(f.repo.session(f.automation.id)).toEqual(before);
    expect(f.repo.version(f.old.id)?.status).toBe('active');
    expect(f.repo.version(f.next.id)?.status).toBe('candidate');
    expect(f.repo.transition(t.id)?.status).toBe('review');
    expect((await f.chat('after-transaction-failure', '!throw'))[0]?.code).toBe('ACCEPTED');
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});
it('uses the same reviewed migration for compatible rollback against current progress', async () => {
  const f = await setup();
  const rename = f.version(
    { ...definition, contribution: { command: '!splat', points: 1 } },
    f.old.id,
  );
  const t = await f.preview('immediate', migration, rename);
  await f.app.riff.studio.approveTransition(t.id, {
    evidenceId: t.evidenceId,
    artifactId: rename.artifactId!,
    expectedActiveVersionId: f.old.id,
    sessionId: t.sourceSessionId,
    boundary: 'immediate',
  });
  await f.chat('newer-progress', '!splat');
  const rollback = await f.preview('immediate', migration, f.repo.version(f.old.id)!);
  await f.app.riff.studio.approveTransition(rollback.id, {
    evidenceId: rollback.evidenceId,
    artifactId: f.old.artifactId!,
    expectedActiveVersionId: rename.id,
    sessionId: rollback.sourceSessionId,
    boundary: 'immediate',
  });
  expect(f.repo.session(f.automation.id)?.snapshot).toMatchObject({
    scores: { red: 2 },
    participants: { alice: { contributions: 2, remaining: 1 } },
  });
  expect((await f.chat('restored-command', '!throw'))[0]?.code).toBe('ACCEPTED');
  expect((await f.app.riff.studio.auditSession(f.automation.id)).status).toBe('verified');
});
it('manual ordinary activation invalidates pending transitions', async () => {
  const f = await setup();
  const t = await f.preview('round-end');
  await f.approve(t);
  const same = f.version(definition, f.old.id, '/* ordinary edit */');
  f.app.riff.studio.approve(same.id, { artifactId: same.artifactId!, activeVersionId: f.old.id });
  expect(f.repo.transition(t.id)?.status).toBe('cancelled');
  f.setAt(121000);
  await f.app.riff.runtime.tick();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(same.id);
});
it('panic cancellation survives a failed cancellation write through the durable epoch and explicit recovery', async () => {
  const f = await setup();
  const t = await f.preview('round-end');
  await f.approve(t);
  const cancel = vi.spyOn(f.repo, 'invalidateTransitions').mockImplementationOnce(() => {
    throw new Error('cancel storage failed');
  });
  f.app.riff.runtime.panic('degraded cancel');
  cancel.mockRestore();
  expect(f.repo.transition(t.id)?.status).toBe('pending');
  expect(f.repo.state().panic).toBe(true);
  f.app.riff.runtime.resume();
  expect(f.repo.transition(t.id)?.status).toBe('cancelled');
  f.setAt(121000);
  await f.app.riff.runtime.tick();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
});

it('CAS refuses a target whose health changes after runtime preparation', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const t = await f.preview();
    const original = f.repo.commitTransition.bind(f.repo);
    const commit = vi.spyOn(f.repo, 'commitTransition').mockImplementationOnce((...args) => {
      database.db
        .update(versions)
        .set({ status: 'failed' })
        .where(eq(versions.id, f.next.id))
        .run();
      return original(...args);
    });
    expect((await f.approve(t)).statusCode).toBe(409);
    commit.mockRestore();
    expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});

it('rejects a migration that no longer preserves current progress after chat during review', async () => {
  const f = await setup();
  const conditional = migration.replace(
    'return s;',
    'if(s.participants.alice.contributions>1)s.scores.red=99;return s;',
  );
  const t = await f.preview('immediate', conditional);
  await f.chat('new-current-progress', '!throw');
  const before = f.repo.session(f.automation.id);
  expect((await f.approve(t)).statusCode).toBe(409);
  expect(f.repo.session(f.automation.id)).toEqual(before);
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
});

it('atomically journals boundary clock normalization before migration and audits the new rules', async () => {
  const f = await setup();
  const t = await f.preview();
  f.setAt(5000);
  expect((await f.approve(t)).statusCode).toBe(200);
  const state = f.repo.session(f.automation.id)!;
  expect(state.snapshot).toMatchObject({
    updatedAt: 5000,
    remainingMs: 116000,
    revision: 4,
    participants: { alice: { remaining: 4 } },
  });
  expect(f.repo.sessionJournal(state.id).map((e) => e.kind)).toEqual([
    'start',
    'chat',
    'chat',
    'advance',
    'migration',
  ]);
  expect((await f.app.riff.studio.auditSession(f.automation.id)).status).toBe('verified');
});

it.each(['false', 'reject'] as const)(
  'keeps the source usable when target preparation returns %s',
  async (outcome) => {
    const host = await import('@riff/sandbox');
    const original = host.createEngine;
    const f = await setup();
    const t = await f.preview();
    const before = f.repo.session(f.automation.id);
    const journal = f.repo.sessionJournal(t.sourceSessionId);
    f.setAt(5000);
    const factory = vi.spyOn(host, 'createEngine').mockImplementation((candidate, options) => {
      const engine = original(candidate, options);
      if (options.mode === 'live' && host.artifactIdentity(candidate) === f.next.artifactId) {
        if (outcome === 'false') vi.spyOn(engine, 'warm').mockResolvedValueOnce(false);
        else vi.spyOn(engine, 'warm').mockRejectedValueOnce(new Error('worker startup failed'));
      }
      return engine;
    });
    const response = await f.approve(t);
    factory.mockRestore();
    expect(response.statusCode).toBe(409);
    expect(f.repo.session(f.automation.id)).toEqual(before);
    expect(f.repo.sessionJournal(t.sourceSessionId)).toEqual(journal);
    expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
    expect((await f.chat('usable-after-warm-failure', '!throw'))[0]?.code).toBe('ACCEPTED');
  },
);
it('does not apply a pending transition when target preparation reports false', async () => {
  const host = await import('@riff/sandbox');
  const original = host.createEngine;
  const f = await setup();
  const t = await f.preview('round-end');
  await f.approve(t);
  const factory = vi.spyOn(host, 'createEngine').mockImplementation((candidate, options) => {
    const engine = original(candidate, options);
    if (options.mode === 'live' && host.artifactIdentity(candidate) === f.next.artifactId)
      vi.spyOn(engine, 'warm').mockResolvedValueOnce(false);
    return engine;
  });
  f.setAt(121000);
  await f.app.riff.runtime.tick();
  factory.mockRestore();
  expect(f.repo.automation(f.automation.id)?.activeVersionId).toBe(f.old.id);
  expect(f.repo.session(f.automation.id)?.snapshot).toMatchObject({
    phase: 'finished',
    revision: 3,
    updatedAt: 121000,
  });
  expect(f.repo.sessionJournal(t.sourceSessionId).map((e) => e.kind)).toEqual([
    'start',
    'chat',
    'chat',
    'advance',
  ]);
  expect(f.repo.transition(t.id)?.status).toBe('cancelled');
  expect((await f.chat('finished-after-warm-failure', '!throw'))[0]?.code).toBe('SESSION_FINISHED');
});

it.each([
  { verification: { ok: false }, intent: [] },
  { verification: { ok: true }, intent: [{ status: 'mismatch' }] },
])(
  'CAS rejects changed target verification or intent without any transition writes: %j',
  async (evidence) => {
    const database = openDatabase(':memory:');
    migrateConnection(database);
    try {
      const f = await setup(database);
      const t = await f.preview();
      const before = f.repo.session(f.automation.id);
      const journal = f.repo.sessionJournal(t.sourceSessionId);
      const outbox = f.repo.sessionOutbox(f.automation.id);
      f.setAt(5000);
      const original = f.repo.commitTransition.bind(f.repo);
      const commit = vi.spyOn(f.repo, 'commitTransition').mockImplementationOnce((...args) => {
        database.db.update(versions).set({ evidence }).where(eq(versions.id, f.next.id)).run();
        return original(...args);
      });
      expect((await f.approve(t)).statusCode).toBe(409);
      commit.mockRestore();
      expect(f.repo.session(f.automation.id)).toEqual(before);
      expect(f.repo.sessionJournal(t.sourceSessionId)).toEqual(journal);
      expect(f.repo.sessionOutbox(f.automation.id)).toEqual(outbox);
      expect(f.repo.transition(t.id)?.status).toBe('review');
      expect(f.repo.version(f.old.id)?.status).toBe('active');
      expect(f.repo.version(f.next.id)?.status).toBe('candidate');
    } finally {
      await Promise.all(apps.splice(0).map((a) => a.close()));
      database.close();
    }
  },
);
it('CAS rejects a rollback target whose previous approval was removed after preparation', async () => {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  try {
    const f = await setup(database);
    const rename = f.version(
      { ...definition, contribution: { command: '!splat', points: 1 } },
      f.old.id,
    );
    const forward = await f.preview('immediate', migration, rename);
    await f.app.riff.studio.approveTransition(forward.id, {
      evidenceId: forward.evidenceId,
      artifactId: rename.artifactId!,
      expectedActiveVersionId: f.old.id,
      sessionId: forward.sourceSessionId,
      boundary: 'immediate',
    });
    const t = await f.preview('immediate', migration, f.repo.version(f.old.id)!);
    const before = f.repo.session(f.automation.id);
    const journal = f.repo.sessionJournal(t.sourceSessionId);
    const outbox = f.repo.sessionOutbox(f.automation.id);
    const original = f.repo.commitTransition.bind(f.repo);
    const commit = vi.spyOn(f.repo, 'commitTransition').mockImplementationOnce((...args) => {
      database.db.update(versions).set({ approvedAt: null }).where(eq(versions.id, f.old.id)).run();
      return original(...args);
    });
    await expect(
      f.app.riff.studio.approveTransition(t.id, {
        evidenceId: t.evidenceId,
        artifactId: f.old.artifactId!,
        expectedActiveVersionId: rename.id,
        sessionId: t.sourceSessionId,
        boundary: 'immediate',
      }),
    ).rejects.toThrow();
    commit.mockRestore();
    expect(f.repo.session(f.automation.id)).toEqual(before);
    expect(f.repo.sessionJournal(t.sourceSessionId)).toEqual(journal);
    expect(f.repo.sessionOutbox(f.automation.id)).toEqual(outbox);
    expect(f.repo.transition(t.id)?.status).toBe('review');
    expect(f.repo.version(rename.id)?.status).toBe('active');
    expect(f.repo.version(f.old.id)?.status).toBe('superseded');
  } finally {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    database.close();
  }
});

