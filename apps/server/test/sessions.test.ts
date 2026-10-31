import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrateConnection } from '../src/app.js';
import { forChannel } from '../src/db/repositories/studio.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const definition = {
  version: 1 as const,
  title: 'Community Goal',
  durationMs: 120000,
  maxParticipants: 256,
  teams: [],
  resource: { name: 'contributions', perParticipant: 3 },
  contribution: { command: '!grow', points: 1 },
  objective: { kind: 'collective-goal' as const, target: 5 },
};
const snapshot = {
  id: 'session-a',
  phase: 'running' as const,
  startedAt: 1000,
  deadlineAt: 121000,
  remainingMs: 120000,
  updatedAt: 1000,
  revision: 0,
  participants: {},
  scores: { community: 0 },
  winner: null,
  outcome: null,
};
function seed(repo: ReturnType<typeof forChannel>) {
  repo.ensure('Home');
  const automation = repo.createAutomation('Goal');
  const version = repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: 'a'.repeat(64),
    title: 'Goal',
    intent: 'A goal',
    source: '()=>{}',
    manifest: {},
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  repo.activate(automation.id, version.id);
  return { automation, version };
}
it('commits state, event identity and outbox atomically and preserves them on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'riff-session-test-'));
  directories.push(directory);
  const path = join(directory, 'session.db');
  let connection = openDatabase(path);
  migrateConnection(connection);
  let repo = forChannel(connection, 'home');
  const { automation, version } = seed(repo);
  repo.replaceSession({ automationId: automation.id, versionId: version.id, definition, snapshot });
  const next = {
    ...snapshot,
    revision: 1,
    updatedAt: 1001,
    remainingMs: 119999,
    scores: { community: 1 },
    participants: { alice: { teamId: null, remaining: 2, contributions: 1 } },
  };
  const event = {
    id: 'event-a',
    channelId: 'twitch-channel',
    viewerId: 'alice',
    roles: ['viewer' as const],
    text: '!grow',
    at: 1001,
  };
  const decision = {
    eventId: event.id,
    artifactId: 'a'.repeat(64),
    mode: 'live' as const,
    code: 'ACCEPTED' as const,
    reason: 'accepted',
    effects: [{ kind: 'projectile' as const, asset: 'heart' as const, x: 0.5 }],
    viewerId: 'alice',
    at: 1001,
    allowance: null,
    session: next,
  };
  expect(
    repo.commitSession({
      automationId: automation.id,
      versionId: version.id,
      expectedRevision: 0,
      snapshot: next,
      event,
      decision,
      viewer: 'Alice',
    }),
  ).toBe(true);
  expect(
    repo.commitSession({
      automationId: automation.id,
      versionId: version.id,
      expectedRevision: 0,
      snapshot: next,
      event,
      decision,
      viewer: 'Alice',
    }),
  ).toBe(false);
  connection.close();
  connection = openDatabase(path);
  repo = forChannel(connection, 'home');
  try {
    expect(repo.session(automation.id)?.snapshot).toEqual(next);
    expect(repo.hasSessionEvent(snapshot.id, 'event-a')).toBe(true);
    expect(repo.sessionOutbox(automation.id)).toHaveLength(1);
    expect(forChannel(connection, 'other').session(automation.id)).toBeUndefined();
    expect(forChannel(connection, 'other').hasSessionEvent(snapshot.id, 'event-a')).toBe(false);
  } finally {
    connection.close();
  }
});
it('a failing outbox insert rolls back the state and duplicate journal', () => {
  const connection = openDatabase(':memory:');
  migrateConnection(connection);
  const repo = forChannel(connection, 'home');
  try {
    const { automation, version } = seed(repo);
    repo.replaceSession({
      automationId: automation.id,
      versionId: version.id,
      definition,
      snapshot,
    });
    connection.client.exec(
      "CREATE TRIGGER reject_outbox BEFORE INSERT ON session_outbox BEGIN SELECT RAISE(ABORT, 'disk fault'); END",
    );
    const next = {
      ...snapshot,
      revision: 1,
      scores: { community: 1 },
      participants: { alice: { teamId: null, remaining: 2, contributions: 1 } },
    };
    const event = {
      id: 'event-a',
      channelId: 'channel',
      viewerId: 'alice',
      roles: ['viewer' as const],
      text: '!grow',
      at: 1001,
    };
    const decision = {
      eventId: event.id,
      artifactId: 'a'.repeat(64),
      mode: 'live' as const,
      code: 'ACCEPTED' as const,
      reason: 'ok',
      effects: [{ kind: 'projectile' as const, asset: 'heart' as const, x: 0.5 }],
      viewerId: 'alice',
      at: 1001,
      allowance: null,
      session: next,
    };
    expect(() =>
      repo.commitSession({
        automationId: automation.id,
        versionId: version.id,
        expectedRevision: 0,
        snapshot: next,
        event,
        decision,
        viewer: 'Alice',
      }),
    ).toThrow('disk fault');
    expect(repo.session(automation.id)?.snapshot).toEqual(snapshot);
    expect(repo.hasSessionEvent(snapshot.id, event.id)).toBe(false);
    expect(repo.sessionOutbox(automation.id)).toEqual([]);
  } finally {
    connection.close();
  }
});
