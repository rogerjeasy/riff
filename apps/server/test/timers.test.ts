import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileOffline } from '@riff/compiler';
import { verifyCandidate } from '@riff/sandbox';
import { TIMER_LIMITS, type PermissionManifest } from '@riff/sdk';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const apps: RiffApp[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const manifest: PermissionManifest = {
  sdkVersion: '0.4.0',
  capabilities: ['overlay', 'timer'],
  trigger: { command: '!start', audience: ['viewer'], maxPerViewer: 5, windowMs: 60_000 },
  limits: { effectsPerEvent: 3, effectsPerMinute: 30 },
};
const once = `async (event, riff) => {
  if (event.source === 'timer.fired') {
    for (let i = 0; i < 3; i++) await riff.overlay.emit({ kind: 'projectile', asset: 'heart', x: 0.2 + i * 0.3 });
    return;
  }
  await riff.timer.start('celebrate', 60000);
}`;
const repeating = once.replace(
  "start('celebrate', 60000)",
  "start('tick', 10000, { repeat: true })",
);

const clock = { at: 1_000 };
async function boot(connection?: DatabaseConnection) {
  const app = await createApp({
    logger: false,
    now: () => clock.at,
    ...(connection ? { database: connection } : {}),
  });
  apps.push(app);
  return app;
}
function install(app: RiffApp, source = once, title = 'Countdown', limits = manifest.limits) {
  const automation = app.riff.repo.createAutomation(title);
  const version = app.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: null,
    title,
    intent: title,
    source,
    manifest: { ...manifest, limits },
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
  return { automationId: automation.id, versionId: version.id };
}
const chat = (id: string, viewer = 'ada', text = '!start'): LiveChatMessage => ({
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
const activity = (app: RiffApp) => app.riff.repo.activity(100);
/** Overlay deliveries that carried effects (chat starts deliver an empty accepted decision). */
const shown = (deliver: {
  mock: { calls: [{ effects: unknown[]; reason: string }, ...unknown[]][] };
}) => deliver.mock.calls.filter((call) => call[0].effects.length > 0);
async function persistent() {
  const directory = mkdtempSync(join(tmpdir(), 'riff-timers-'));
  directories.push(directory);
  const path = join(directory, 'studio.db');
  const connection = openDatabase(path);
  migrateConnection(connection);
  return { path, connection };
}

describe('host-owned named timers', () => {
  it('a chat command schedules a persisted timer that fires through the live overlay once', async () => {
    clock.at = 1_000;
    const app = await boot();
    const deliver = vi.spyOn(app.riff.overlay, 'deliver');
    const { automationId } = install(app);
    expect((await app.riff.runtime.handleChat(chat('m1')))[0]?.code).toBe('ACCEPTED');
    expect(app.riff.runtime.timers(automationId)).toMatchObject([
      { name: 'celebrate', repeat: false, intervalMs: 60_000, scheduledAt: 61_000 },
    ]);
    const studio = (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
      automations: { id: string; timers: { name: string; scheduledAt: number }[] }[];
    }>();
    expect(studio.automations[0]?.timers).toMatchObject([
      { name: 'celebrate', scheduledAt: 61_000 },
    ]);
    clock.at = 60_999;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(0);
    clock.at = 61_000;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(1);
    expect(shown(deliver)[0]?.[0]).toMatchObject({ code: 'ACCEPTED', mode: 'live' });
    expect(shown(deliver)[0]?.[0].effects).toHaveLength(3);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
    clock.at = 200_000;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(1);
    expect(activity(app).some((a) => a.message.startsWith('Timer “celebrate” fired'))).toBe(true);
  });

  it('restarting a name replaces the pending timer instead of adding another', async () => {
    clock.at = 1_000;
    const app = await boot();
    const { automationId } = install(app);
    await app.riff.runtime.handleChat(chat('m1', 'ada'));
    clock.at = 31_000;
    await app.riff.runtime.handleChat(chat('m2', 'bo'));
    expect(app.riff.runtime.timers(automationId)).toMatchObject([
      { name: 'celebrate', scheduledAt: 91_000 },
    ]);
    clock.at = 61_000;
    const deliver = vi.spyOn(app.riff.overlay, 'deliver');
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(0);
  });

  it('repeating timers keep their cadence and stop when cancelled from the console', async () => {
    clock.at = 0;
    const app = await boot();
    const deliver = vi.spyOn(app.riff.overlay, 'deliver');
    const { automationId } = install(app, repeating, 'Ticker');
    await app.riff.runtime.handleChat(chat('m1'));
    for (const at of [10_000, 20_000, 30_500]) {
      clock.at = at;
      await app.riff.runtime.tick();
    }
    expect(shown(deliver)).toHaveLength(3);
    expect(app.riff.runtime.timers(automationId)[0]).toMatchObject({
      scheduledAt: 40_000,
      fires: 3,
    });
    const cancelled = await post(app, `/api/automations/${automationId}/timers/tick/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
    expect(
      (await post(app, `/api/automations/${automationId}/timers/tick/cancel`)).statusCode,
    ).toBe(404);
    expect(
      (await post(app, `/api/automations/${automationId}/timers/Bad%20Name/cancel`)).statusCode,
    ).toBe(404);
    clock.at = 60_000;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(3);
    expect(activity(app).some((a) => a.code === 'TIMER_CANCELLED')).toBe(true);
  });

  it('timer fires spend the same per-minute effect budget as chat and are recorded durably', async () => {
    clock.at = 0;
    const app = await boot();
    const { automationId } = install(app, repeating, 'Ticker', {
      effectsPerEvent: 3,
      effectsPerMinute: 9,
    });
    await app.riff.runtime.handleChat(chat('m1'));
    for (let i = 1; i <= 7; i++) {
      clock.at = i * 10_000;
      await app.riff.runtime.tick();
    }
    const codes = app.riff.repo
      .admissionsSince(-1)
      .filter((row) => row.viewerId === 'timer:tick')
      .map((row) => row.code);
    expect(codes).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'CHANNEL_LIMIT',
      'CHANNEL_LIMIT',
      'CHANNEL_LIMIT',
      'ACCEPTED',
    ]);
    expect(app.riff.runtime.timers(automationId)[0]?.fires).toBe(7);
  });
});

describe('timer storage failures', () => {
  it('a timer that cannot be saved is reported and never fires later', async () => {
    clock.at = 1_000;
    const app = await boot();
    const { automationId } = install(app);
    vi.spyOn(app.riff.repo, 'applyTimerOps').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect((await app.riff.runtime.handleChat(chat('m1')))[0]?.code).toBe('ACCEPTED');
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
    expect(activity(app).find((a) => a.code === 'TIMER_FAILED')?.message).toMatch(/will not fire/);
  });
});

describe('cancel semantics', () => {
  it.each([
    ['pause', (app: RiffApp, id: string) => post(app, `/api/automations/${id}/pause`)],
    ['panic', (app: RiffApp) => post(app, '/api/channel/panic')],
  ])('%s cancels pending timers and resume never recreates them', async (_label, stop) => {
    clock.at = 1_000;
    const app = await boot();
    const deliver = vi.spyOn(app.riff.overlay, 'deliver');
    const { automationId } = install(app);
    await app.riff.runtime.handleChat(chat('m1'));
    expect((await stop(app, automationId)).statusCode).toBe(200);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
    if (_label === 'panic') await post(app, '/api/channel/resume', { confirm: true });
    else await post(app, `/api/automations/${automationId}/resume`);
    clock.at = 120_000;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(0);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });

  it('activating another version (approve or rollback) cancels the old version timers', async () => {
    clock.at = 1_000;
    const app = await boot();
    const { automationId } = install(app);
    await app.riff.runtime.handleChat(chat('m1'));
    const next = app.riff.repo.insertVersion({
      automationId,
      parentVersionId: null,
      artifactId: null,
      title: 'v2',
      intent: 'v2',
      source: once,
      manifest,
      tests: [],
      behavior: {},
      assumptions: [],
      evidence: {},
      origin: 'manual',
      compileRunId: null,
      status: 'candidate',
    });
    app.riff.repo.activate(automationId, next.id, 'console');
    app.riff.runtime.activate(automationId, app.riff.repo.version(next.id)!);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });

  it('a trapped timer handler quarantines the version and cancels its timers', async () => {
    clock.at = 0;
    const app = await boot();
    const trap = `async (event, riff) => {
      if (event.source === 'timer.fired') { await riff.timer.start('other', 6000); throw new Error('boom'); }
      await riff.timer.start('a', 10000);
      await riff.timer.start('b', 20000);
    }`;
    const { automationId, versionId } = install(app, trap, 'Trap');
    await app.riff.runtime.handleChat(chat('m1'));
    clock.at = 10_000;
    await app.riff.runtime.tick();
    expect(app.riff.repo.version(versionId)?.status).toBe('quarantined');
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });
});

describe('restart behavior', () => {
  async function scheduleAndRestart(downUntil: number, source = once) {
    const { path, connection } = await persistent();
    clock.at = 1_000;
    let app = await boot(connection);
    const { automationId } = install(app, source);
    await app.riff.runtime.handleChat(chat('m1'));
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    clock.at = downUntil;
    const reopened = openDatabase(path);
    app = await boot(reopened);
    const deliver = vi.spyOn(app.riff.overlay, 'deliver');
    return { app, automationId, deliver };
  }

  it('resumes a pending timer on boot and fires it on time', async () => {
    const { app, deliver } = await scheduleAndRestart(30_000);
    clock.at = 61_000;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(1);
  });

  it('fires once with missed:true when it fell due during downtime within the grace window', async () => {
    const { app, deliver, automationId } = await scheduleAndRestart(
      61_000 + TIMER_LIMITS.missedGraceMs,
    );
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(1);
    expect(shown(deliver)[0]?.[0].reason).toMatch(/late/);
    expect(activity(app).some((a) => /fired 30 s late/.test(a.message))).toBe(true);
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(1);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });

  it('skips and logs a fire overdue beyond the grace window instead of replaying it', async () => {
    const { app, deliver, automationId } = await scheduleAndRestart(
      61_001 + TIMER_LIMITS.missedGraceMs,
    );
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(0);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
    expect(activity(app).find((a) => a.code === 'TIMER_EXPIRED')?.message).toMatch(
      /beyond the 30 s grace window/,
    );
  });

  it('re-arms an expired repeating timer on its original cadence without a burst', async () => {
    const { app, deliver, automationId } = await scheduleAndRestart(95_000, repeating);
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(0);
    expect(app.riff.runtime.timers(automationId)[0]?.scheduledAt).toBe(101_000);
    clock.at = 101_000;
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(1);
  });

  it('never fires twice when a crash happened between the durable decision and re-arming', async () => {
    const { app, deliver, automationId } = await scheduleAndRestart(61_000);
    const row = app.riff.repo.timers(automationId)[0]!;
    app.riff.repo.recordAdmission({
      automationId,
      eventId: `timer:${row.id}:${row.scheduledAt}`,
      viewerId: 'timer:celebrate',
      at: 61_000,
      code: 'ACCEPTED',
      effects: 3,
    });
    await app.riff.runtime.tick();
    expect(shown(deliver)).toHaveLength(0);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });

  it('drops timers on boot when their version is no longer live', async () => {
    const { path, connection } = await persistent();
    clock.at = 1_000;
    let app = await boot(connection);
    const { automationId } = install(app);
    await app.riff.runtime.handleChat(chat('m1'));
    // Simulate a pause whose timer cancellation write did not happen.
    app.riff.repo.updateAutomation(automationId, { status: 'paused' });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    app = await boot(openDatabase(path));
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });
});

describe('private preview isolation', () => {
  it('preview runs timers on a virtual clock and never touches the live scheduler', async () => {
    clock.at = 1_000;
    const app = await boot();
    const { versionId, automationId } = install(app);
    const result = await post(app, `/api/versions/${versionId}/preview`, {
      seed: 5,
      events: [
        {
          id: 'p1',
          channelId: 'preview',
          viewerId: 'ada',
          roles: ['viewer'],
          text: '!start',
          at: 0,
        },
        {
          id: 'p2',
          channelId: 'preview',
          viewerId: 'ada',
          roles: ['viewer'],
          text: 'hi',
          at: 60_000,
        },
      ],
    });
    expect(result.statusCode).toBe(200);
    const body = result.json<{ timerFires: { name: string; at: number; before: number }[] }>();
    expect(body.timerFires).toMatchObject([{ name: 'celebrate', at: 60_000, before: 1 }]);
    expect(app.riff.runtime.timers(automationId)).toEqual([]);
  });

  it.each([
    'Every 10 minutes show a hydration reminder on the overlay.',
    'After !start, show a countdown and celebrate in 60 seconds.',
  ])(
    'the offline compiler output passes the full host verifier: %s',
    async (intent) => {
      const output = compileOffline({ intent, base: null });
      const report = await verifyCandidate({
        source: output.source ?? '',
        manifest: output.manifest,
        tests: output.tests,
      });
      expect(report.failureReport).toBeNull();
      expect(report.ok).toBe(true);
    },
    60_000,
  );
});
