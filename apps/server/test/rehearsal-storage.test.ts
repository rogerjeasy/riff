import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compileOffline } from '@riff/compiler';
import {
  createSessionSnapshot,
  rehearsalScenarioHash,
  rehearsalScenarioSchema,
  type RehearsalScenario,
} from '@riff/sandbox';
import type { ExperienceDefinition } from '@riff/sdk';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createRehearsalService } from '../src/services/rehearsal/service.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const scenario: RehearsalScenario = {
  version: 1,
  seed: 41,
  initialAt: 1000,
  initialSession: null,
  steps: [
    {
      kind: 'chat',
      key: 'throw',
      event: {
        id: 'one',
        viewerId: 'a',
        channelId: 'rehearsal',
        roles: ['viewer'],
        text: '!tomato',
        at: 1000,
      },
    },
  ],
  expectations: [{ id: 'two', stepKey: 'throw', kind: 'effects', value: 2 }],
  provenance: { kind: 'synthetic' },
};
function addVersion(repo: ReturnType<typeof forChannel>, stateful = false) {
  const output = compileOffline({
    intent: stateful
      ? 'Community Goal: everyone uses !grow to contribute hearts, 3 contributions each for a 120 second round, target of 5 points.'
      : 'Everyone can throw a tomato with !tomato, 3 times per minute.',
    base: null,
  });
  return repo.insertVersion({
    automationId: repo.createAutomation('Private').id,
    parentVersionId: null,
    artifactId: null,
    title: output.title,
    intent: 'Test',
    source: output.source!,
    manifest: output.manifest,
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
}
it('retains immutable regressions and exact run evidence across SQLite restart and isolates every tenant lookup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'riff-rehearsal-'));
  let connection = openDatabase(join(dir, 'studio.db'));
  migrateConnection(connection);
  let app = await createApp({ logger: false, database: connection });
  apps.push(app);
  try {
    const row = addVersion(app.riff.repo);
    const saved = app.riff.rehearsal.create({ name: 'Retain', scenario });
    const run = await app.riff.rehearsal.runScenario(saved.id, {
      expectedRevision: 0,
      versionId: row.id,
    });
    const reduced = await app.riff.rehearsal.minimize(run.id, {
      side: 'primary',
      checkId: 'expect:two',
    });
    const retained = app.riff.rehearsal.saveRegression({
      name: 'Regression',
      runId: reduced.id,
      checkId: 'expect:two',
    });
    const other = forChannel(connection, 'another');
    other.ensure('Another');
    const second = addVersion(other);
    const isolated = createRehearsalService(other);
    expect(() => isolated.scenario(saved.id)).toThrowError('unavailable');
    expect(() => isolated.run(run.id)).toThrowError('unavailable');
    expect(() => isolated.regression(retained.id)).toThrowError('unavailable');
    expect(() =>
      app.riff.rehearsal.preset({ versionId: second.id, preset: 'proof', seed: 1 }),
    ).toThrowError('unavailable');
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    connection = openDatabase(join(dir, 'studio.db'));
    app = await createApp({ logger: false, database: connection });
    apps.push(app);
    expect(app.riff.rehearsal.run(run.id)).toEqual(run);
    expect(app.riff.rehearsal.regression(retained.id)).toEqual(retained);
    expect((await app.riff.rehearsal.runRegression(retained.id, row.id)).result.status).toBe(
      'failed',
    );
    await app.close();
    apps.splice(apps.indexOf(app), 1);
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
it('bounds history and libraries, revision-checks deletion, and keeps regression evidence after run pruning', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  const repo = forChannel(connection, 'private');
  repo.ensure('Private');
  const service = createRehearsalService(repo);
  try {
    const row = addVersion(repo);
    const saved = service.create({ name: 'First', scenario });
    for (let i = 1; i < 50; i++) service.create({ name: `Saved ${i}`, scenario });
    expect(() => service.create({ name: 'Full', scenario })).toThrowError('full');
    expect(() => service.deleteScenario(saved.id, 4)).toThrowError('changed');
    const run = await service.runScenario(saved.id, { expectedRevision: 0, versionId: row.id });
    const reduced = await service.minimize(run.id, { side: 'primary', checkId: 'expect:two' });
    const regression = service.saveRegression({
      name: 'Keep',
      runId: reduced.id,
      checkId: 'expect:two',
    });
    for (let i = 0; i < 101; i++)
      repo.insertRehearsalRun({ ...run, id: randomUUID(), createdAt: reduced.createdAt + i + 100 });
    expect(service.runs()).toHaveLength(100);
    expect(() => service.run(reduced.id)).toThrowError('unavailable');
    expect(service.regression(regression.id)).toEqual(regression);
    for (let i = 1; i < 10; i++)
      repo.insertRehearsalRegression({ ...regression, id: randomUUID() });
    expect(() => repo.insertRehearsalRegression({ ...regression, id: randomUUID() })).toThrowError(
      'full',
    );
    for (let group = 0; group < 4; group++) {
      const other = addVersion(repo);
      for (let i = 0; i < 10; i++)
        repo.insertRehearsalRegression({
          ...regression,
          id: randomUUID(),
          automationId: other.automationId,
          originVersionId: other.id,
        });
    }
    expect(service.regressions()).toHaveLength(50);
    expect(() =>
      repo.insertRehearsalRegression({
        ...regression,
        id: randomUUID(),
        automationId: randomUUID(),
      }),
    ).toThrowError('full');
  } finally {
    service.close();
    connection.close();
  }
}, 60_000);
it('sanitizes a bounded complete journal without changing live state or sending overlay effects', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  let compilerInput: unknown = null;
  const app = await createApp({
    logger: false,
    database: connection,
    transport: {
      kind: 'offline',
      model: null,
      async open(input) {
        compilerInput = input;
        throw new Error('Controlled transport stop');
      },
    },
  });
  apps.push(app);
  try {
    const repo = app.riff.repo,
      row = addVersion(repo, true),
      definition = (row.manifest as { experience: ExperienceDefinition }).experience;
    const snapshot = createSessionSnapshot(definition, 1000, 'recorded-round');
    snapshot.participants['private-account-123'] = { teamId: null, contributions: 1, remaining: 2 };
    snapshot.scores.community = 1;
    repo.replaceSession({
      automationId: row.automationId,
      versionId: row.id,
      definition,
      snapshot,
    });
    const insert = connection.client.prepare(
      'INSERT INTO session_journal(channel_id,session_id,automation_id,version_id,kind,at,event,code,digest) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const chat = {
      id: 'private-event-token',
      viewerId: 'private-account-123',
      channelId: 'private-channel',
      roles: ['moderator', 'viewer'],
      text: 'secret raw text and token',
      at: 1100,
    };
    insert.run(
      'home',
      snapshot.id,
      row.automationId,
      row.id,
      'chat',
      1100,
      JSON.stringify(chat),
      'UNRELATED',
      'digest',
    );
    insert.run(
      'home',
      snapshot.id,
      row.automationId,
      row.id,
      'chat',
      1200,
      JSON.stringify({ ...chat, text: '!grow', at: 1200 }),
      'DUPLICATE',
      'digest',
    );
    const liveTables = [
      'experience_sessions',
      'session_journal',
      'session_outbox',
      'session_events',
      'admission_events',
      'versions',
      'channel_state',
    ];
    const before = () =>
      JSON.stringify(liveTables.map((t) => connection.client.prepare(`SELECT * FROM ${t}`).all()));
    const original = before();
    const messages: string[] = [];
    app.riff.overlay.attach({ send: (data) => messages.push(data), close() {} }, 'home');
    messages.length = 0;
    const imported = app.riff.rehearsal.recording({
      versionId: row.id,
      sessionId: snapshot.id,
      seed: 42,
    });
    const serialized = JSON.stringify(imported);
    for (const raw of [
      'private-event-token',
      'private-account-123',
      'private-channel',
      'secret raw text',
    ])
      expect(serialized).not.toContain(raw);
    expect(imported.initialSession).toMatchObject({
      id: 'rehearsal',
      participants: { 'viewer-1': { contributions: 1, remaining: 2 } },
    });
    expect(imported.steps).toMatchObject([
      { event: { id: 'event-1', viewerId: 'viewer-1', text: 'unrelated' } },
      { event: { id: 'event-1', viewerId: 'viewer-1', text: '!grow' } },
    ]);
    const saved = app.riff.rehearsal.create({
      name: 'Recorded',
      recording: { versionId: row.id, sessionId: snapshot.id, seed: 42 },
    });
    await app.riff.rehearsal.runScenario(saved.id, { expectedRevision: 0, versionId: row.id });
    expect(before()).toBe(original);
    expect(messages.some((m) => JSON.parse(m).type === 'effect')).toBe(false);
    const originalManifest = row.manifest as {
      experience: ExperienceDefinition;
      trigger: { maxPerViewer: number };
    };
    const changedManifest = structuredClone(originalManifest);
    changedManifest.experience.resource.perParticipant = 4;
    changedManifest.trigger.maxPerViewer = 4;
    const alternative = repo.insertVersion({
      ...row,
      manifest: changedManifest,
      parentVersionId: row.id,
    });
    await expect(
      app.riff.rehearsal.runScenario(saved.id, {
        expectedRevision: 0,
        versionId: row.id,
        compareVersionId: alternative.id,
        through: 0,
      }),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SESSION' });
    const fresh = await app.riff.rehearsal.runScenario(saved.id, {
      expectedRevision: 0,
      versionId: row.id,
      compareVersionId: alternative.id,
      through: 0,
      freshStart: true,
    });
    expect(fresh.freshStart).toBe(true);
    expect(fresh.scenario.initialSession).toBeNull();
    expect(fresh.scenario.provenance.kind).toBe('synthetic-derivative');
    const edited = app.riff.rehearsal.update(saved.id, {
      name: 'Injected',
      expectedRevision: 0,
      scenario: {
        ...imported,
        provenance: { kind: 'synthetic' },
        expectations: [{ id: 'effect', stepKey: 'recorded-2', kind: 'effects', value: 1 }],
      },
    });
    expect(edited.scenario.provenance.kind).toBe('synthetic-derivative');
    const privateData = JSON.stringify(repo.rehearsalScenarios());
    expect(privateData).not.toContain('private-account-123');
    const failed = await app.riff.rehearsal.runScenario(saved.id, {
      versionId: row.id,
      expectedRevision: 1,
    });
    const reduced = await app.riff.rehearsal.minimize(failed.id, {
      side: 'primary',
      checkId: 'expect:effect',
    });
    app.riff.rehearsal.saveRegression({
      name: 'Private recording check',
      runId: reduced.id,
      checkId: 'expect:effect',
    });
    const repair = app.riff.authoring.start({
      intent: 'Keep the interaction exactly as requested.',
      baseVersionId: row.id,
    });
    for (let i = 0; i < 100 && !repair.result; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(compilerInput).not.toBeNull();
    const quoted = JSON.stringify(compilerInput);
    for (const raw of [
      'private-event-token',
      'private-account-123',
      'private-channel',
      'secret raw text',
    ])
      expect(quoted).not.toContain(raw);
    for (let i = 0; i < 120; i++)
      insert.run(
        'home',
        snapshot.id,
        row.automationId,
        row.id,
        'advance',
        1300 + i,
        null,
        null,
        'digest',
      );
    expect(() =>
      app.riff.rehearsal.recording({ versionId: row.id, sessionId: snapshot.id, seed: 42 }),
    ).toThrowError('unavailable');
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
  }
}, 60_000);
it('serializes expensive work, aborts cancellation/shutdown and releases the operation slot', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  const repo = forChannel(connection, 'private');
  repo.ensure('Private');
  const row = addVersion(repo);
  const service = createRehearsalService(repo);
  try {
    const saved = service.create({ name: 'Work', scenario });
    const controller = new AbortController();
    const running = service.runScenario(
      saved.id,
      { versionId: row.id, expectedRevision: 0 },
      controller.signal,
    );
    await expect(
      service.runScenario(saved.id, { versionId: row.id, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    const completed = await service.runScenario(saved.id, {
      versionId: row.id,
      expectedRevision: 0,
    });
    expect(completed.result.status).toBe('failed');
    const pending = service.runScenario(saved.id, { versionId: row.id, expectedRevision: 0 });
    service.close();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    const timed = createRehearsalService(repo, { timeoutMs: 1 });
    await expect(
      timed.runScenario(saved.id, { versionId: row.id, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    timed.close();
  } finally {
    service.close();
    connection.close();
  }
}, 60_000);

it('pins imported captures before edits and resolves only owned durable run provenance on new saves', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  const app = await createApp({ logger: false, database: connection });
  apps.push(app);
  try {
    const service = app.riff.rehearsal;
    const row = addVersion(app.riff.repo, true);
    const definition = (row.manifest as { experience: ExperienceDefinition }).experience;
    const snapshot = createSessionSnapshot(definition, 1000, 'pinned-round');
    app.riff.repo.replaceSession({
      automationId: row.automationId,
      versionId: row.id,
      definition,
      snapshot,
    });
    const post = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, payload, headers: { 'x-riff-request': '1' } });
    const capture = (
      await post('/api/rehearsals/scenarios', {
        name: 'Capture',
        recording: { versionId: row.id, sessionId: snapshot.id, seed: 42 },
      })
    ).json().scenario;
    const recorded = await service.runScenario(capture.id, {
      expectedRevision: 0,
      versionId: row.id,
    });
    // Later journal entries must not change the already imported capture or its source hash.
    connection.client
      .prepare(
        'INSERT INTO session_journal(channel_id,session_id,automation_id,version_id,kind,at,event,code,digest) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run('home', snapshot.id, row.automationId, row.id, 'advance', 1100, null, null, 'digest');
    expect(
      service.recording({ versionId: row.id, sessionId: snapshot.id, seed: 42 }).steps,
    ).toHaveLength(1);
    expect(service.scenario(capture.id).scenario.steps).toHaveLength(0);
    const clean = { ...capture.scenario, provenance: { kind: 'synthetic' as const } };
    const renamed = service.update(capture.id, {
      name: 'Renamed',
      expectedRevision: 0,
      scenario: clean,
    });
    expect(renamed.scenario).toEqual(capture.scenario);
    const edited = service.update(capture.id, {
      name: 'Injected',
      expectedRevision: 1,
      scenario: { ...clean, steps: [{ kind: 'advance', key: 'injected', at: 1200 }] },
    });
    const derivative = {
      kind: 'synthetic-derivative',
      sourceScenarioHash: rehearsalScenarioHash(capture.scenario),
    };
    expect(edited.scenario.provenance).toEqual(derivative);
    expect(service.scenario(edited.id)).toEqual(edited);
    const editedRun = await service.runScenario(edited.id, {
      expectedRevision: 2,
      versionId: row.id,
    });
    expect(editedRun.result.provenance).toEqual(derivative);
    for (const source of [recorded, editedRun]) {
      for (const changed of [false, true]) {
        const inputs = {
          ...source.scenario,
          seed: changed ? 43 : source.scenario.seed,
          provenance: { kind: 'synthetic' },
        };
        const response = await post('/api/rehearsals/scenarios', {
          name: 'Adopted',
          scenario: inputs,
          sourceRunId: source.id,
        });
        expect(response.statusCode).toBe(201);
        const saved = response.json().scenario;
        expect(saved.scenario.provenance).toEqual(
          changed
            ? {
                kind: 'synthetic-derivative',
                sourceScenarioHash: rehearsalScenarioHash(source.scenario),
              }
            : source.scenario.provenance,
        );
        expect(service.scenario(saved.id).scenario).toEqual(saved.scenario);
        expect(
          (await service.runScenario(saved.id, { expectedRevision: 0, versionId: row.id })).result
            .provenance,
        ).toEqual(saved.scenario.provenance);
      }
      expect(
        (
          await post('/api/rehearsals/scenarios', {
            name: 'Forged',
            scenario: source.scenario,
            sourceRunId: source.id,
          })
        ).statusCode,
      ).toBe(400);
    }
    const other = forChannel(connection, 'other');
    other.ensure('Other');
    const isolated = createRehearsalService(other);
    expect(() =>
      isolated.create({ name: 'Foreign', scenario: clean, sourceRunId: recorded.id }),
    ).toThrowError('unavailable');
    const foreignVersion = addVersion(other);
    const foreignScenario = isolated.create({ name: 'Foreign', scenario });
    const foreignRun = await isolated.runScenario(foreignScenario.id, {
      versionId: foreignVersion.id,
      expectedRevision: 0,
    });
    expect(
      (
        await post('/api/rehearsals/scenarios', {
          name: 'Foreign source',
          scenario: clean,
          sourceRunId: foreignRun.id,
        })
      ).statusCode,
    ).toBe(404);
    await isolated.close();
    expect(
      (
        await post('/api/rehearsals/scenarios', {
          name: 'Missing',
          scenario: clean,
          sourceRunId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post('/api/rehearsals/scenarios', {
          name: 'Forged hash',
          scenario: clean,
          sourceRunId: recorded.id,
          sourceScenarioHash: 'a'.repeat(64),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post('/api/rehearsals/scenarios', {
          name: 'Mixed authority',
          recording: { versionId: row.id, sessionId: snapshot.id, seed: 42 },
          sourceRunId: recorded.id,
        })
      ).statusCode,
    ).toBe(400);
    const nearCap: RehearsalScenario = {
      ...scenario,
      expectations: [],
      steps: Array.from({ length: 120 }, (_, i) => ({
        kind: 'chat' as const,
        key: `step-${i}`,
        event: {
          id: `event-${i}`,
          channelId: 'rehearsal',
          viewerId: 'viewer',
          roles: [],
          text: 'x'.repeat(500),
          at: 1000,
        },
      })),
    };
    let padding = 131050 - Buffer.byteLength(JSON.stringify(nearCap));
    for (const step of nearCap.steps) {
      if (step.kind !== 'chat') continue;
      const extra = Math.min(padding, 1000);
      step.event.text =
        '€'.repeat(Math.floor(extra / 2)) +
        (extra % 2 ? 'é' : '') +
        'x'.repeat(500 - Math.ceil(extra / 2));
      padding -= extra;
    }
    expect(Buffer.byteLength(JSON.stringify(nearCap))).toBe(131050);
    expect(rehearsalScenarioSchema.safeParse(nearCap).success).toBe(true);
    expect(
      (
        await post('/api/rehearsals/scenarios', {
          name: 'Too large after metadata',
          scenario: nearCap,
          sourceRunId: recorded.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(() =>
      service.update(capture.id, { name: 'Too large', expectedRevision: 2, scenario: nearCap }),
    ).toThrowError('Invalid');
    expect(service.scenario(capture.id).revision).toBe(2);
    // Pruned sources fail closed instead of silently saving synthetic inputs.
    for (let i = 0; i < 101; i++)
      app.riff.repo.insertRehearsalRun({
        ...recorded,
        id: randomUUID(),
        createdAt: Date.now() + i,
      });
    expect(
      (
        await post('/api/rehearsals/scenarios', {
          name: 'Pruned',
          scenario: clean,
          sourceRunId: recorded.id,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
  }
}, 60_000);
