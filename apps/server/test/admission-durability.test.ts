import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const apps: RiffApp[] = [];
const cleanup: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const done of cleanup.splice(0)) done();
});
const toss = `async (e, riff) => { await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() }); }`;
function activate(app: RiffApp, effectsPerMinute = 60) {
  const automation = app.riff.repo.createAutomation('Tomato Toss');
  const version = app.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: null,
    title: 'Tomato Toss',
    intent: 'Tomato Toss',
    source: toss,
    manifest: {
      sdkVersion: '0.3.0',
      capabilities: ['overlay'],
      trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60_000 },
      limits: { effectsPerEvent: 1, effectsPerMinute },
    },
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  app.riff.repo.activate(automation.id, version.id);
  app.riff.runtime.activate(automation.id, app.riff.repo.version(version.id)!);
  return automation;
}
const chat = (id: string, viewer: string, text = '!tomato'): LiveChatMessage => ({
  id,
  viewerId: viewer,
  viewerName: viewer,
  text,
  channelId: 'channel',
  roles: ['viewer'],
  source: 'twitch',
});
async function restartable() {
  const directory = mkdtempSync(join(tmpdir(), 'riff-admission-'));
  const path = join(directory, 'studio.db');
  let connection: DatabaseConnection | null = null;
  const clock = { at: 1_000 };
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  async function boot() {
    connection = openDatabase(path);
    migrateConnection(connection);
    const app = await createApp({ logger: false, database: connection, now: () => clock.at });
    apps.push(app);
    return app;
  }
  async function stop(app: RiffApp) {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection?.close();
  }
  return { boot, stop, clock, connection: () => connection as unknown as DatabaseConnection };
}
const code = async (app: RiffApp, message: LiveChatMessage) =>
  (await app.riff.runtime.handleChat(message))[0]?.code;

it('keeps rolling allowances and duplicate protection across a restart', async () => {
  const { boot, stop, clock } = await restartable();
  let app = await boot();
  activate(app);
  for (const n of [1, 2, 3]) {
    clock.at = 1_000 + n * 1_000;
    expect(await code(app, chat(`a${n}`, 'alice'))).toBe('ACCEPTED');
  }
  await stop(app);
  clock.at = 10_000;
  app = await boot();
  // The fourth throw in the same rolling minute is still blocked after the restart.
  expect(await code(app, chat('a4', 'alice'))).toBe('VIEWER_LIMIT');
  // Twitch redelivers a notification it already sent before the restart.
  expect(await code(app, chat('a2', 'alice'))).toBe('DUPLICATE');
  expect(await code(app, chat('b1', 'bob'))).toBe('ACCEPTED');
  // The first throw at t=2000 leaves the window at t=62000.
  clock.at = 62_000;
  expect(await code(app, chat('a5', 'alice'))).toBe('ACCEPTED');
  expect(await code(app, chat('a6', 'alice'))).toBe('VIEWER_LIMIT');
  // Twenty minutes later the engine's in-memory window has forgotten a1; storage has not.
  clock.at = 62_000 + 20 * 60_000;
  expect(await code(app, chat('a1', 'alice'))).toBe('DUPLICATE');
  // Records older than the longest rolling window are pruned.
  clock.at += 2 * 60 * 60_000;
  await code(app, chat('late', 'carol'));
  expect(app.riff.repo.admissionsSince(0).map((row) => row.eventId)).toEqual(['late']);
});

it('restores the per-minute effect budget after a restart', async () => {
  const { boot, stop, clock } = await restartable();
  let app = await boot();
  activate(app, 2);
  expect(await code(app, chat('x1', 'ana'))).toBe('ACCEPTED');
  expect(await code(app, chat('x2', 'ben'))).toBe('ACCEPTED');
  await stop(app);
  clock.at = 5_000;
  app = await boot();
  expect(await code(app, chat('x3', 'cy'))).toBe('CHANNEL_LIMIT');
  clock.at = 61_500;
  expect(await code(app, chat('x4', 'cy'))).toBe('ACCEPTED');
});

it('never sends an effect it could not record, and pauses the interaction', async () => {
  const { boot, connection } = await restartable();
  const app = await boot();
  const automation = activate(app);
  const frames: string[] = [];
  app.riff.overlay.attach({ send: (data) => frames.push(data), close: () => undefined }, 'home');
  connection().client.exec(
    "CREATE TRIGGER fail_admission BEFORE INSERT ON admission_events BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  expect(await code(app, chat('z1', 'alice'))).toBe('STOPPED');
  expect(frames.some((f) => JSON.parse(f).type === 'effect')).toBe(false);
  expect(app.riff.repo.automation(automation.id)?.status).toBe('paused');
});
