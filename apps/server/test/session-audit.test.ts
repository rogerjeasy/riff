import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ExperienceDefinition } from '@riff/sdk';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const battle: ExperienceDefinition = {
  version: 1,
  title: 'Tomato Battle',
  durationMs: 120_000,
  maxParticipants: 256,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score', target: null },
};
const goal: ExperienceDefinition = {
  ...battle,
  title: 'Community Goal',
  teams: [],
  resource: { name: 'hearts', perParticipant: 3 },
  contribution: { command: '!grow', points: 1 },
  objective: { kind: 'collective-goal', target: 4 },
};
function activate(app: RiffApp, experience: ExperienceDefinition) {
  const automation = app.riff.repo.createAutomation(experience.title);
  const version = app.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: null,
    title: experience.title,
    intent: experience.title,
    source: `async (e, riff) => { await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() }); }`,
    manifest: {
      sdkVersion: '0.4.0',
      capabilities: ['overlay', 'session'],
      experience,
      trigger: {
        command: experience.contribution.command,
        audience: ['viewer'],
        maxPerViewer: 3,
        windowMs: 120_000,
      },
      limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
    },
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  app.riff.repo.activate(automation.id, version.id, 'console');
  app.riff.runtime.activate(automation.id, app.riff.repo.version(version.id)!);
  return automation;
}
const chat = (id: string, viewer: string, text: string): LiveChatMessage => ({
  id,
  viewerId: viewer,
  viewerName: viewer,
  text,
  channelId: 'channel',
  roles: ['viewer'],
  source: 'twitch',
});
const post = (app: RiffApp, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: { 'x-riff-request': '1' }, payload });
const audit = async (app: RiffApp, id: string) =>
  (await post(app, `/api/automations/${id}/session/audit`)).json().audit;

it('replays a live battle across concurrency, redelivery, panic, restart and the deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'riff-audit-'));
  const path = join(directory, 'studio.db');
  let connection = openDatabase(path);
  migrateConnection(connection);
  let at = 1_000;
  let app = await createApp({ logger: false, database: connection, now: () => at });
  apps.push(app);
  try {
    const { id } = activate(app, battle);
    const roster = ['ada', 'bo', 'cy', 'di'];
    await Promise.all(
      roster.map((v, i) =>
        app.riff.runtime.handleChat(chat(`join-${v}`, v, i % 2 ? '!blue' : '!red')),
      ),
    );
    at = 2_000;
    const throws = roster.flatMap((v) => [0, 1, 2, 3].map((n) => chat(`t-${v}-${n}`, v, '!throw')));
    // Twitch may deliver any notification more than once.
    await Promise.all([...throws, ...throws].map((m) => app.riff.runtime.handleChat(m)));
    at = 10_000;
    await post(app, '/api/channel/panic');
    at = 40_000;
    expect((await post(app, '/api/channel/resume', { confirm: true })).statusCode).toBe(200);
    // Restart: the round, its journal and its event identities survive.
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    at = 60_000;
    connection = openDatabase(path);
    app = await createApp({ logger: false, database: connection, now: () => at });
    apps.push(app);
    expect((await app.riff.runtime.handleChat(chat('t-ada-0', 'ada', '!throw')))[0]?.code).toBe(
      'DUPLICATE',
    );
    at = 200_000;
    await app.riff.runtime.tick();
    const stored = app.riff.repo.session(id)!.snapshot;
    expect(stored).toMatchObject({ phase: 'finished', winner: 'tie', scores: { red: 6, blue: 6 } });

    const outbox = app.riff.repo.sessionOutbox(id).length;
    const result = await audit(app, id);
    expect(result).toMatchObject({
      status: 'verified',
      joins: 4,
      contributions: 12,
      rejections: 4,
      divergence: null,
    });
    expect(result.controls).toBeGreaterThanOrEqual(3); // panic pause, resume, deadline
    expect(result.replayed).toEqual(JSON.parse(JSON.stringify(stored)));
    // The audit is read-only: no state, outbox or overlay change.
    expect(app.riff.repo.session(id)!.snapshot).toEqual(stored);
    expect(app.riff.repo.sessionOutbox(id)).toHaveLength(outbox);

    // A point written outside the engine is caught.
    const forged = { ...stored, scores: { red: 7, blue: 6 } };
    connection.client
      .prepare('UPDATE experience_sessions SET snapshot = ? WHERE automation_id = ?')
      .run(JSON.stringify(forged), id);
    expect((await audit(app, id)).status).toBe('diverged');
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('audits a cooperative goal through the same engine and starts a fresh journal on reset', async () => {
  let at = 1_000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const { id } = activate(app, goal);
  for (const [i, viewer] of ['ana', 'ben', 'ana', 'cy', 'dee'].entries()) {
    at += 10;
    await app.riff.runtime.handleChat(chat(`g${i}`, viewer, '!grow'));
  }
  expect(app.riff.repo.session(id)!.snapshot).toMatchObject({
    outcome: 'goal',
    winner: 'community',
  });
  expect(await audit(app, id)).toMatchObject({
    status: 'verified',
    contributions: 4,
    rejections: 1,
  });
  await post(app, `/api/automations/${id}/session/reset`, { confirm: true });
  const fresh = await audit(app, id);
  expect(fresh).toMatchObject({ status: 'verified', entries: 1, contributions: 0 });
  expect(fresh.sessionId).toBe(app.riff.repo.session(id)!.snapshot.id);
});

it('reports rounds without a session and requires the mutation guard', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const automation = app.riff.repo.createAutomation('Plain');
  expect((await post(app, `/api/automations/${automation.id}/session/audit`)).statusCode).toBe(404);
  const unguarded = await app.inject({
    method: 'POST',
    url: `/api/automations/${automation.id}/session/audit`,
  });
  expect(unguarded.statusCode).toBe(403);
});

it('timer ticks write nothing until the deadline, then finish the round exactly once', async () => {
  let at = 1_000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const { id } = activate(app, battle);
  const revisions = () => app.riff.repo.session(id)!.snapshot.revision;
  const journal = () => app.riff.repo.sessionJournal(app.riff.repo.session(id)!.id).length;
  const before = { revision: revisions(), journal: journal() };
  for (at = 1_250; at < 121_000; at += 250) await app.riff.runtime.tick();
  // The countdown is derived from deadlineAt; time alone is not a state change.
  expect({ revision: revisions(), journal: journal() }).toEqual(before);
  at = 121_000;
  await app.riff.runtime.tick();
  await app.riff.runtime.tick();
  expect(app.riff.repo.session(id)!.snapshot).toMatchObject({
    phase: 'finished',
    outcome: 'deadline',
  });
  expect(journal()).toBe(before.journal + 1);
  expect((await audit(app, id)).status).toBe('verified');
});

it('tells overlay viewers how to join a round instead of a rolling allowance', async () => {
  const app = await createApp({ logger: false, now: () => 1_000 });
  apps.push(app);
  activate(app, battle);
  activate(app, goal);
  const frames: { type: string; payload: { lines?: string[] } }[] = [];
  app.riff.overlay.attach(
    { send: (data) => frames.push(JSON.parse(data)), close: () => undefined },
    'home',
  );
  const lines = frames.filter((f) => f.type === 'instructions').at(-1)?.payload.lines;
  expect(lines).toEqual([
    'Type !red or !blue to join a team, then !throw · 3 throws each this round',
    'Type !grow to help reach 4 together · 3 hearts each this round',
  ]);
});
