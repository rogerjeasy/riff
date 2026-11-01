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
const siege: ExperienceDefinition = {
  version: 2,
  title: 'Castle Siege',
  durationMs: 60_000,
  maxParticipants: 64,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'attacks', perParticipant: 3 },
  contribution: { command: '!attack', points: 1 },
  objective: { kind: 'highest-score', target: null },
  mechanics: {
    match: { rounds: 3, intermissionMs: 5000 },
    health: { label: 'Health', max: 6, damage: 1, heal: null },
    burst: {
      command: '!shield',
      label: 'Shield',
      participants: 3,
      windowMs: 10_000,
      points: 0,
      limit: 1,
      shieldMs: 10_000,
    },
    milestones: [],
  },
};
const source = `async (e,riff)=>{const s=riff.session.snapshot();if(s.phase==='running')await riff.overlay.emit({kind:'projectile',asset:'tomato',x:riff.util.random()});}`;
function activate(app: RiffApp) {
  const automation = app.riff.repo.createAutomation('Castle Siege');
  const version = app.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: null,
    title: 'Siege',
    intent: 'Siege',
    source,
    manifest: {
      sdkVersion: '0.4.0',
      capabilities: ['overlay', 'session'],
      experience: siege,
      trigger: { command: '!attack', audience: ['viewer'], maxPerViewer: 3, windowMs: 60_000 },
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
  app.riff.repo.activate(automation.id, version.id);
  app.riff.runtime.activate(automation.id, app.riff.repo.version(version.id)!);
  return { automation, version };
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

it('serializes concurrent bursts and damage, survives restart mid-match and advances rounds once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'riff-mechanics-'));
  const path = join(directory, 'studio.db');
  let connection = openDatabase(path);
  migrateConnection(connection);
  let at = 1000;
  let app = await createApp({ logger: false, database: connection, now: () => at });
  apps.push(app);
  try {
    const messages: string[] = [];
    app.riff.overlay.attach({ send: (data) => messages.push(data), close() {} }, 'home');
    const { automation } = activate(app);
    // Stream guidance names every version 2 command, not just joins and the contribution.
    expect(messages.join('\n')).toContain('also !shield');
    const send = (id: string, viewer: string, text: string) =>
      app.riff.runtime.handleChat(chat(id, viewer, text));
    for (const viewer of ['r1', 'r2', 'r3']) await send(`join-${viewer}`, viewer, '!red');
    for (const viewer of ['b1', 'b2']) await send(`join-${viewer}`, viewer, '!blue');
    // Concurrent shield attempts: duplicates of one viewer and redeliveries count once.
    const codes = (
      await Promise.all([
        send('s1', 'r1', '!shield'),
        send('s1', 'r1', '!shield'),
        send('s1b', 'r1', '!shield'),
        send('s2', 'r2', '!shield'),
        send('s3', 'r3', '!shield'),
      ])
    ).map((decisions) => decisions[0]?.code);
    expect(codes.filter((code) => code === 'ACCEPTED')).toHaveLength(3);
    expect(codes).toContain('BURST_COUNTED');
    expect(codes).toContain('DUPLICATE');
    let state = app.riff.repo.session(automation.id)!.snapshot;
    expect(state.mechanics?.standings.red).toMatchObject({ bursts: 1, shieldUntil: 11_000 });
    // Shielded red takes no damage; red's attacks hit blue.
    await Promise.all([
      send('b1-a', 'b1', '!attack'),
      send('r1-a', 'r1', '!attack'),
      send('r2-a', 'r2', '!attack'),
    ]);
    state = app.riff.repo.session(automation.id)!.snapshot;
    expect(state.mechanics?.standings.red?.health).toBe(6);
    expect(state.mechanics?.standings.blue?.health).toBe(4);

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    // Restart after the round-one deadline: recovery ends the round once and opens the break.
    at = 62_000;
    connection = openDatabase(path);
    app = await createApp({ logger: false, database: connection, now: () => at });
    apps.push(app);
    await app.riff.runtime.tick();
    state = app.riff.repo.session(automation.id)!.snapshot;
    expect(state.mechanics).toMatchObject({ round: 2, wins: { red: 1, blue: 0 } });
    expect(state.participants.r1).toEqual({ teamId: 'red', remaining: 3, contributions: 0 });
    const revision = app.riff.repo.session(automation.id)!.revision;
    await app.riff.runtime.tick();
    expect(app.riff.repo.session(automation.id)!.revision).toBe(revision);
    expect((await send('r1-a', 'r1', '!attack'))[0]?.code).toBe('DUPLICATE');
    expect((await send('break', 'r1', '!attack'))[0]?.code).toBe('ROUND_INTERMISSION');
    at = 66_000; // round one ended at 61 s; the 5 s break ends at 66 s
    for (let i = 0; i < 6; i++) await send(`kill-${i}`, `r${(i % 3) + 1}`, '!attack');
    state = app.riff.repo.session(automation.id)!.snapshot;
    expect(state).toMatchObject({ phase: 'finished', outcome: 'elimination', winner: 'red' });
    expect(state.mechanics?.wins).toEqual({ red: 2, blue: 0 });
    const audit = await app.inject({
      method: 'POST',
      url: `/api/automations/${automation.id}/session/audit`,
      headers: { 'x-riff-request': '1' },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audit).toMatchObject({ status: 'verified' });
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
