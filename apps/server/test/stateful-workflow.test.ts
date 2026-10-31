import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const definition = {
  version: 1 as const,
  title: 'Tomato Battle',
  durationMs: 120000,
  maxParticipants: 256,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score' as const, target: null },
};
const source = `async (e,riff)=>{const s=riff.session.snapshot();if(s.phase==='running')await riff.overlay.emit({kind:'projectile',asset:'tomato',x:riff.util.random()});}`;
function activate(app: RiffApp, handler = source) {
  const automation = app.riff.repo.createAutomation('Tomato Battle');
  const version = app.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: null,
    title: 'Battle',
    intent: 'Battle',
    source: handler,
    manifest: {
      sdkVersion: '0.4.0',
      capabilities: ['overlay', 'session'],
      experience: definition,
      trigger: { command: '!throw', audience: ['viewer'], maxPerViewer: 3, windowMs: 120000 },
      limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
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
it('serializes concurrent resources, recovers progress and deduplication after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'riff-stateful-'));
  const path = join(directory, 'studio.db');
  let connection = openDatabase(path);
  migrateConnection(connection);
  let at = 1000;
  let app = await createApp({ logger: false, database: connection, now: () => at });
  apps.push(app);
  try {
    const { automation } = activate(app);
    await app.riff.runtime.handleChat(chat('join-a', 'alice', '!red'));
    await app.riff.runtime.handleChat(chat('join-b', 'bob', '!blue'));
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.riff.runtime.handleChat(chat('throw-' + i, 'alice', '!throw')),
      ),
    );
    const before = app.riff.repo.session(automation.id)!.snapshot;
    expect(before.scores).toEqual({ red: 3, blue: 0 });
    expect(before.participants.alice?.remaining).toBe(0);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    at = 2000;
    connection = openDatabase(path);
    app = await createApp({ logger: false, database: connection, now: () => at });
    apps.push(app);
    expect(app.riff.repo.session(automation.id)?.snapshot.scores.red).toBe(3);
    expect((await app.riff.runtime.handleChat(chat('throw-0', 'alice', '!throw')))[0]?.code).toBe(
      'DUPLICATE',
    );
    expect((await app.riff.runtime.handleChat(chat('late', 'alice', '!throw')))[0]?.code).toBe(
      'RESOURCE_LIMIT',
    );
    await app.riff.runtime.handleChat(chat('bob-throw', 'bob', '!throw'));
    at = 121000;
    await app.riff.runtime.tick();
    const end = app.riff.repo.session(automation.id)!.snapshot;
    expect(end.phase).toBe('finished');
    expect(end.winner).toBe('red');
    expect(end.scores).toEqual({ red: 3, blue: 1 });
    expect((await app.riff.runtime.handleChat(chat('too-late', 'bob', '!throw')))[0]?.code).toBe(
      'SESSION_FINISHED',
    );
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('interleaved concurrent throws from many viewers on both teams never lose a point', async () => {
  const app = await createApp({ logger: false, now: () => 5000 });
  apps.push(app);
  const { automation } = activate(app);
  const roster = Array.from({ length: 12 }, (_, i) => ({
    viewer: `viewer${i}`,
    team: i % 2 ? 'blue' : 'red',
  }));
  await Promise.all(
    roster.map(({ viewer, team }) =>
      app.riff.runtime.handleChat(chat(`join-${viewer}`, viewer, `!${team}`)),
    ),
  );
  // Every viewer asks for five throws at once, interleaved across teams, and Twitch
  // redelivers every message (https://dev.twitch.tv/docs/eventsub/#handling-duplicate-events).
  const attempts = Array.from({ length: 5 }, (_, n) =>
    roster.map(({ viewer }) => chat(`throw-${viewer}-${n}`, viewer, '!throw')),
  ).flat();
  const deliveries = [...attempts, ...[...attempts].reverse()];
  const decisions = (
    await Promise.all(deliveries.map((m) => app.riff.runtime.handleChat(m)))
  ).flat();
  const count = (code: string) => decisions.filter((d) => d.code === code).length;
  expect(count('ACCEPTED')).toBe(12 * 3);
  expect(count('RESOURCE_LIMIT')).toBe(12 * 2);
  expect(count('DUPLICATE')).toBe(12 * 5);
  const snapshot = app.riff.repo.session(automation.id)!.snapshot;
  expect(snapshot.scores).toEqual({ red: 18, blue: 18 });
  for (const { viewer } of roster)
    expect(snapshot.participants[viewer]).toMatchObject({ remaining: 0, contributions: 3 });
});

it('pause/panic freeze the timer and an explicit reset creates a fresh fenced session', async () => {
  let at = 1000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const { automation } = activate(app);
  await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
  await app.riff.runtime.handleChat(chat('throw', 'alice', '!throw'));
  at = 21000;
  app.riff.studio.pause(automation.id);
  const paused = app.riff.repo.session(automation.id)!.snapshot;
  expect(paused.phase).toBe('paused');
  expect(paused.remainingMs).toBe(100000);
  at = 101000;
  app.riff.studio.resumeAutomation(automation.id);
  expect(app.riff.repo.session(automation.id)?.snapshot.deadlineAt).toBe(201000);
  app.riff.runtime.panic('test');
  const panicState = app.riff.repo.session(automation.id)!.snapshot;
  at = 999000;
  app.riff.runtime.resume();
  expect(app.riff.repo.session(automation.id)?.snapshot.remainingMs).toBe(panicState.remainingMs);
  const previousId = panicState.id;
  const pending = app.riff.runtime.handleChat(chat('in-flight', 'alice', '!throw'));
  const reset = await app.inject({
    method: 'POST',
    url: `/api/automations/${automation.id}/session/reset`,
    headers: { 'x-riff-request': '1' },
    payload: { confirm: true },
  });
  expect(reset.statusCode).toBe(200);
  await pending;
  expect(app.riff.repo.session(automation.id)?.id).not.toBe(previousId);
  expect(app.riff.repo.session(automation.id)?.snapshot.scores.red).toBe(0);
});
it('private stateful rehearsal is deterministic and never touches durable live state', async () => {
  const app = await createApp({ logger: false, now: () => 1000 });
  apps.push(app);
  const { automation, version } = activate(app);
  const original = app.riff.repo.session(automation.id)!.snapshot;
  const payload = {
    seed: 42,
    events: [
      {
        id: 'join',
        channelId: 'private',
        viewerId: 'alice',
        roles: ['viewer'],
        text: '!red',
        at: 0,
      },
      {
        id: 'throw',
        channelId: 'private',
        viewerId: 'alice',
        roles: ['viewer'],
        text: '!throw',
        at: 1,
      },
    ],
  };
  const run = () =>
    app.inject({
      method: 'POST',
      url: `/api/versions/${version.id}/preview`,
      headers: { 'x-riff-request': '1' },
      payload,
    });
  const first = (await run()).json();
  const second = (await run()).json();
  expect(first.session.scores.red).toBe(1);
  expect(first.session).toEqual(second.session);
  expect(first.decisions).toEqual(second.decisions);
  expect(app.riff.repo.session(automation.id)?.snapshot).toEqual(original);
});

it('keeps committed progress when cosmetic outbox delivery fails afterward', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  const app = await createApp({ logger: false, database: connection, now: () => 1000 });
  apps.push(app);
  try {
    const { automation } = activate(app);
    await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
    connection.client.exec(
      "CREATE TRIGGER fail_claim BEFORE UPDATE ON session_outbox BEGIN SELECT RAISE(ABORT, 'cosmetic unavailable'); END",
    );
    const result = await app.riff.runtime.handleChat(chat('score', 'alice', '!throw'));
    expect(result[0]?.code).toBe('ACCEPTED');
    expect(app.riff.repo.session(automation.id)?.snapshot.scores.red).toBe(1);
    expect(app.riff.repo.automation(automation.id)?.status).toBe('live');
    expect((await app.riff.runtime.handleChat(chat('score', 'alice', '!throw')))[0]?.code).toBe(
      'DUPLICATE',
    );
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
  }
});
it('a rotated overlay receives the authoritative finished session', async () => {
  let at = 1000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const { automation } = activate(app);
  await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
  await app.riff.runtime.handleChat(chat('score', 'alice', '!throw'));
  at = 121000;
  await app.riff.runtime.tick();
  app.riff.overlay.disconnectAll();
  const frames: { type: string; payload: { sessions?: { snapshot: { phase: string } }[] } }[] = [];
  app.riff.overlay.attach(
    { send: (data) => frames.push(JSON.parse(data)), close: () => undefined },
    'home',
  );
  expect(
    frames.find((frame) => frame.type === 'sessions')?.payload.sessions?.[0]?.snapshot.phase,
  ).toBe('finished');
  expect(app.riff.repo.session(automation.id)?.snapshot.scores.red).toBe(1);
});

it('persists panic even if pausing a session fails, and stays stopped after restart', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  let at = 1000;
  let app = await createApp({ logger: false, database: connection, now: () => at });
  apps.push(app);
  try {
    const { automation } = activate(app);
    at = 21000;
    connection.client.exec(
      "CREATE TRIGGER fail_pause BEFORE UPDATE ON experience_sessions BEGIN SELECT RAISE(ABORT, 'session disk fault'); END",
    );
    app.riff.runtime.panic('test');
    expect(app.riff.repo.state().panic).toBe(true);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    at = 999000;
    app = await createApp({ logger: false, database: connection, now: () => at });
    apps.push(app);
    expect(app.riff.runtime.panicked).toBe(true);
    expect(app.riff.runtime.running()).toEqual([]);
    connection.client.exec('DROP TRIGGER fail_pause');
    app.riff.runtime.resume();
    expect(app.riff.repo.session(automation.id)?.snapshot.phase).toBe('running');
    expect(app.riff.repo.session(automation.id)?.snapshot.remainingMs).toBe(100000);
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
  }
});

const BATTLE =
  'Tomato Battle: viewers join Red with !red or Blue with !blue, then use !throw to throw tomatoes. Give each participant 3 throws for a 120 second round; the team with the highest score wins.';
const GOAL =
  'Community Goal: everyone uses !grow to contribute hearts, with 3 contributions per participant in a 120 second round. Work together toward a collective goal of 5 points.';
it('authors a preserving edit, reviews private comparisons, retains chat during review and audits new command play', async () => {
  const app = await createApp({ logger: false, now: () => 1000 });
  apps.push(app);
  const first = await generated(app, BATTLE);
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { 'x-riff-request': '1' }, payload });
  expect(
    (
      await post(`/api/versions/${first.id}/approve`, {
        artifactId: first.artifactId,
        expectedActiveVersionId: null,
      })
    ).statusCode,
  ).toBe(200);
  await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
  await app.riff.runtime.handleChat(chat('one', 'alice', '!throw'));
  const edited = await generated(
    app,
    'Change the command to !splat, keep everyone’s teams and scores, and give each player two additional throws.',
    first.id,
  );
  expect(edited.evidence).toMatchObject({
    migration: {
      source: expect.any(String),
      ok: true,
      snapshots: ['empty', 'populated', 'exhausted', 'paused', 'finished'],
    },
  });
  const preview = await post(`/api/versions/${edited.id}/transition/preview`, {
    boundary: 'immediate',
  });
  expect(preview.statusCode).toBe(200);
  const t = preview.json().transition;
  expect(t.evidence.comparison.provenance).toBe('synthetic');
  expect(t.evidence.migration.after).toMatchObject({
    scores: { red: 1 },
    participants: { alice: { remaining: 4, teamId: 'red' } },
  });
  await app.riff.runtime.handleChat(chat('during-review', 'alice', '!throw'));
  expect(
    (
      await post(`/api/transitions/${t.id}/approve`, {
        evidenceId: t.evidenceId,
        artifactId: t.plan.targetArtifactId,
        expectedActiveVersionId: t.sourceVersionId,
        sessionId: t.sourceSessionId,
        boundary: 'immediate',
      })
    ).statusCode,
  ).toBe(200);
  expect(app.riff.repo.session(first.automationId)?.snapshot).toMatchObject({
    scores: { red: 2 },
    participants: { alice: { remaining: 3, contributions: 2, teamId: 'red' } },
  });
  expect((await app.riff.runtime.handleChat(chat('old', 'alice', '!throw')))[0]?.code).toBe(
    'UNRELATED',
  );
  expect((await app.riff.runtime.handleChat(chat('new', 'alice', '!splat')))[0]?.code).toBe(
    'ACCEPTED',
  );
  expect((await app.riff.studio.auditSession(first.automationId)).status).toBe('verified');
});
async function generated(app: RiffApp, intent: string, baseVersionId: string | null = null) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/compile-runs',
    headers: { 'x-riff-request': '1' },
    payload: { intent, baseVersionId },
  });
  expect(response.statusCode).toBe(202);
  const id = response.json<{ id: string }>().id;
  for (let i = 0; i < 200; i++) {
    const run = app.riff.authoring.runs().find((r) => r.id === id);
    if (run?.result) {
      expect(run.result.status).toBe('ready');
      const version = app.riff.repo.version(run.result.versionId!);
      expect(version).toBeDefined();
      return version!;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Generation did not finish');
}
it.each([
  [BATTLE, '!red', '!throw', 'red'],
  [GOAL, null, '!grow', 'community'],
])('generates, verifies, approves and plays %s', async (intent, joinCommand, command, score) => {
  const app = await createApp({ logger: false, now: () => 1000 });
  apps.push(app);
  const version = await generated(app, intent!);
  const approve = await app.inject({
    method: 'POST',
    url: `/api/versions/${version.id}/approve`,
    headers: { 'x-riff-request': '1' },
    payload: { artifactId: version.artifactId, expectedActiveVersionId: null },
  });
  expect(approve.statusCode).toBe(200);
  if (joinCommand) await app.riff.runtime.handleChat(chat('join', 'alice', joinCommand));
  expect((await app.riff.runtime.handleChat(chat('one', 'alice', command!)))[0]?.code).toBe(
    'ACCEPTED',
  );
  expect(app.riff.repo.session(version.automationId)?.snapshot.scores[score!]).toBe(1);
  const studio = (await app.inject({ method: 'GET', url: '/api/studio' })).json();
  expect(studio.automations[0].session.scores[score!]).toBe(1);
  if (!joinCommand) {
    await app.riff.runtime.handleChat(chat('two', 'alice', command!));
    await app.riff.runtime.handleChat(chat('three', 'alice', command!));
    expect((await app.riff.runtime.handleChat(chat('four', 'alice', command!)))[0]?.code).toBe(
      'RESOURCE_LIMIT',
    );
    await app.riff.runtime.handleChat(chat('bob-1', 'bob', command!));
    await app.riff.runtime.handleChat(chat('bob-2', 'bob', command!));
    expect(app.riff.repo.session(version.automationId)?.snapshot).toMatchObject({
      phase: 'finished',
      winner: 'community',
      outcome: 'goal',
      scores: { community: 5 },
    });
  }
});
it('preserves progress for compatible edits and requires reset consent for changed rules and rollback', async () => {
  const app = await createApp({ logger: false, now: () => 1000 });
  apps.push(app);
  const first = await generated(app, BATTLE);
  const approve = (
    versionId: string,
    artifactId: string | null,
    expected: string | null,
    resetSession?: boolean,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/versions/${versionId}/approve`,
      headers: { 'x-riff-request': '1' },
      payload: {
        artifactId,
        expectedActiveVersionId: expected,
        ...(resetSession === undefined ? {} : { resetSession }),
      },
    });
  expect((await approve(first.id, first.artifactId, null)).statusCode).toBe(200);
  await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
  await app.riff.runtime.handleChat(chat('score', 'alice', '!throw'));
  const initial = app.riff.repo.session(first.automationId)!;
  const compatible = await generated(app, 'Make it stars instead of tomatoes.', first.id);
  expect((await approve(compatible.id, compatible.artifactId, first.id)).statusCode).toBe(200);
  expect(app.riff.repo.session(first.automationId)?.snapshot.scores.red).toBe(1);
  expect(app.riff.repo.session(first.automationId)?.id).toBe(initial.id);
  const changed = await generated(
    app,
    'Give each participant 5 throws for a 120 second round.',
    compatible.id,
  );
  expect((await approve(changed.id, changed.artifactId, compatible.id)).statusCode).toBe(409);
  expect(app.riff.repo.automation(first.automationId)?.activeVersionId).toBe(compatible.id);
  expect(app.riff.repo.session(first.automationId)?.snapshot.scores.red).toBe(1);
  expect((await approve(changed.id, changed.artifactId, compatible.id, true)).statusCode).toBe(200);
  expect(app.riff.repo.session(first.automationId)?.id).not.toBe(initial.id);
  const rollback = (resetSession: boolean) =>
    app.inject({
      method: 'POST',
      url: `/api/automations/${first.automationId}/rollback`,
      headers: { 'x-riff-request': '1' },
      payload: { resetSession },
    });
  expect((await rollback(false)).statusCode).toBe(409);
  expect((await rollback(true)).statusCode).toBe(200);
});
it('a failed semantic transaction preserves resources and permits retry after recovery', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  const app = await createApp({ logger: false, database: connection, now: () => 1000 });
  apps.push(app);
  try {
    const { automation } = activate(app);
    await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
    const before = app.riff.repo.session(automation.id)!.snapshot;
    connection.client.exec(
      "CREATE TRIGGER fail_admission BEFORE INSERT ON session_outbox BEGIN SELECT RAISE(ABORT,'storage fault'); END",
    );
    expect((await app.riff.runtime.handleChat(chat('retry', 'alice', '!throw')))[0]?.code).toBe(
      'STOPPED',
    );
    expect(app.riff.repo.session(automation.id)?.snapshot).toMatchObject({
      phase: 'paused',
      participants: before.participants,
      scores: before.scores,
      id: before.id,
    });
    expect(app.riff.repo.hasSessionEvent(before.id, 'retry')).toBe(false);
    connection.client.exec('DROP TRIGGER fail_admission');
    app.riff.studio.resumeAutomation(automation.id);
    expect((await app.riff.runtime.handleChat(chat('retry', 'alice', '!throw')))[0]?.code).toBe(
      'ACCEPTED',
    );
    expect(app.riff.repo.session(automation.id)?.snapshot.scores.red).toBe(1);
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
  }
});
it('finishes an expired round exactly once during startup recovery', async () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  let at = 1000;
  let app = await createApp({ logger: false, database: connection, now: () => at });
  apps.push(app);
  try {
    const { automation } = activate(app);
    await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
    await app.riff.runtime.handleChat(chat('score', 'alice', '!throw'));
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    at = 999000;
    app = await createApp({ logger: false, database: connection, now: () => at });
    apps.push(app);
    expect(app.riff.repo.session(automation.id)?.snapshot).toMatchObject({
      phase: 'finished',
      winner: 'red',
      outcome: 'deadline',
      scores: { red: 1, blue: 0 },
    });
    const revision = app.riff.repo.session(automation.id)?.revision;
    await app.riff.runtime.tick();
    expect(app.riff.repo.session(automation.id)?.revision).toBe(revision);
  } finally {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    connection.close();
  }
});

it('does not score an old Twitch event again after an explicit new session', async () => {
  const app = await createApp({ logger: false, now: () => 1000 });
  apps.push(app);
  const { automation } = activate(app);
  await app.riff.runtime.handleChat(chat('old-join', 'alice', '!red'));
  await app.riff.runtime.handleChat(chat('old-score', 'alice', '!throw'));
  app.riff.studio.resetSession(automation.id);
  await app.riff.runtime.handleChat(chat('new-join', 'alice', '!red'));
  expect((await app.riff.runtime.handleChat(chat('old-score', 'alice', '!throw')))[0]?.code).toBe(
    'DUPLICATE',
  );
  expect(app.riff.repo.session(automation.id)?.snapshot.scores.red).toBe(0);
});

it('quarantining guest code preserves resources and freezes round time', async () => {
  let at = 1000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const { automation } = activate(app, `()=>{throw Error('guest fault')}`);
  await app.riff.runtime.handleChat(chat('join', 'alice', '!red'));
  at = 21000;
  expect((await app.riff.runtime.handleChat(chat('bad', 'alice', '!throw')))[0]?.code).toBe(
    'INCIDENT',
  );
  expect(app.riff.repo.session(automation.id)?.snapshot).toMatchObject({
    phase: 'paused',
    remainingMs: 100000,
    scores: { red: 0, blue: 0 },
    participants: { alice: { remaining: 3, contributions: 0 } },
  });
});
