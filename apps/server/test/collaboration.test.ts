import { afterEach, expect, it } from 'vitest';
import { artifactIdentity } from '@riff/sandbox';
import type { PermissionManifest } from '@riff/sdk';
import { migrateConnection } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createCoordinator } from '../src/services/collaboration/coordinator.js';
import type { SharedRole } from '../src/services/collaboration/contract.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const roles: SharedRole[] = [
  {
    id: 'repair',
    label: 'Shield repair',
    channelId: '100',
    command: '!repair',
    required: true,
    fields: ['score', 'remaining', 'contributions'],
  },
  {
    id: 'steer',
    label: 'Navigation',
    channelId: '200',
    command: '!steer',
    required: true,
    fields: ['score'],
  },
];
const manifest: PermissionManifest = {
  sdkVersion: '0.4.0',
  capabilities: ['session', 'overlay'],
  trigger: { command: '!help', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
  experience: {
    version: 1,
    title: 'Ship',
    durationMs: 120000,
    maxParticipants: 256,
    teams: [],
    resource: { name: 'actions', perParticipant: 3 },
    contribution: { command: '!help', points: 1 },
    objective: { kind: 'collective-goal', target: 20 },
  },
};
function setup(handler?: string) {
  let at = 1000;
  const database = openDatabase(':memory:');
  migrateConnection(database);
  cleanups.push(() => database.close());
  const repo = forChannel(database, 'home');
  repo.ensure('Home');
  repo.updateState({ twitchUserId: '100' });
  const artifact = {
    source:
      handler ??
      `async (event,riff)=>{await riff.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});}`,
    manifest,
  };
  const version = repo.insertVersion({
    automationId: repo.createAutomation('Ship').id,
    parentVersionId: null,
    artifactId: artifactIdentity(artifact),
    title: 'Ship',
    intent: 'Ship',
    ...artifact,
    tests: ['happy', 'limit', 'negative'].map((kind) => ({
      name: kind,
      kind,
      steps: [
        {
          viewer: 'alice',
          roles: ['viewer'],
          text: kind === 'negative' ? 'hello' : '!help',
          at: 0,
          id: 'one',
          expect: kind === 'negative' ? 'UNRELATED' : 'ACCEPTED',
          effects: kind === 'negative' ? 0 : 1,
        },
      ],
    })),
    behavior: {},
    assumptions: [],
    evidence: { verification: { ok: true }, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  const coordinator = createCoordinator({ database, repo, now: () => at });
  cleanups.push(() => coordinator.close());
  const contract = coordinator.create(version.id, roles).contract;
  const a = coordinator.invite(contract.id, 'repair');
  const b = coordinator.invite(contract.id, 'steer');
  return {
    database,
    repo,
    version,
    coordinator,
    contract,
    a,
    b,
    now: (value: number) => {
      at = value;
    },
  };
}
const event = (id: string, channelId = '100', text = '!repair') => ({
  id,
  channelId,
  viewerId: 'viewer-1',
  roles: ['viewer'] as const,
  text,
  sourceChannelId: channelId,
  sourceMessageId: id,
});
function start(f: ReturnType<typeof setup>) {
  f.coordinator.approve(f.a.token, f.contract.digest);
  f.coordinator.approve(f.b.token, f.contract.digest);
  return f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'start');
}
it('requires exact consent from every channel and protects scoped views', () => {
  const f = setup();
  expect(f.coordinator.review(f.a.token)).toEqual({ contract: f.contract, roleId: 'repair' });
  expect(() => f.coordinator.approve(f.a.token, '0'.repeat(64))).toThrow();
  expect(() => f.coordinator.control(f.contract.id, 0, 'start')).toThrow();
  f.coordinator.approve(f.a.token, f.contract.digest);
  expect(() =>
    f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'start'),
  ).toThrow();
  expect(() => f.coordinator.heartbeat(f.b.token)).toThrow();
  f.coordinator.approve(f.b.token, f.contract.digest);
  const current = f.coordinator.view(f.contract.id);
  expect(f.coordinator.control(f.contract.id, current.revision, 'start').status).toBe('running');
  expect(() => f.coordinator.control(f.contract.id, current.revision, 'pause')).toThrow();
  const projection = f.coordinator.heartbeat(f.b.token);
  expect(projection).toMatchObject({ roleId: 'steer', status: 'running', score: 0 });
  expect(projection).not.toHaveProperty('remaining');
  expect(projection).not.toHaveProperty('contributions');
  expect(JSON.stringify(projection)).not.toMatch(/participants|viewer-1|token|source|manifest/);
});
it('counts source input once, rejects echoes and foreign roles, keeps channel participant allowances independent', async () => {
  const f = setup();
  start(f);
  expect((await f.coordinator.input(f.a.token, event('one'))).code).toBe('ACCEPTED');
  expect(
    (await f.coordinator.input(f.a.token, { ...event('another-envelope'), sourceMessageId: 'one' }))
      .code,
  ).toBe('DUPLICATE');
  expect(
    (
      await f.coordinator.input(f.b.token, {
        ...event('echo', '200', '!repair'),
        sourceChannelId: '100',
        sourceMessageId: 'one',
      })
    ).code,
  ).toBe('IGNORED');
  expect(() => f.coordinator.input(f.a.token, event('foreign', '200', '!steer'))).toThrow();
  expect((await f.coordinator.input(f.a.token, event('two'))).code).toBe('ACCEPTED');
  expect((await f.coordinator.input(f.a.token, event('three'))).code).toBe('ACCEPTED');
  expect((await f.coordinator.input(f.a.token, event('four'))).code).toBe('RESOURCE_LIMIT');
  expect((await f.coordinator.input(f.b.token, event('five', '200', '!steer'))).code).toBe(
    'ACCEPTED',
  );
  expect(f.coordinator.heartbeat(f.a.token)).toMatchObject({ score: 4, contributions: 3 });
});
it('revokes departures immediately and pauses required sessions without losing progress', async () => {
  const f = setup();
  start(f);
  await f.coordinator.input(f.a.token, event('one'));
  f.coordinator.leave(f.b.token);
  expect(f.coordinator.view(f.contract.id).status).toBe('paused');
  expect(() => f.coordinator.heartbeat(f.b.token)).toThrow();
  expect(() => f.coordinator.input(f.b.token, event('after', '200', '!steer'))).toThrow();
  const next = f.coordinator.invite(f.contract.id, 'steer');
  f.coordinator.approve(next.token, f.contract.digest);
  expect(f.coordinator.view(f.contract.id).status).toBe('paused');
  f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'resume');
  expect(f.coordinator.heartbeat(next.token).score).toBe(1);
});
it('expires leases before a late heartbeat and pauses after restart with durable deduplication', async () => {
  const f = setup();
  start(f);
  await f.coordinator.input(f.a.token, event('one'));
  f.now(11001);
  expect(f.coordinator.heartbeat(f.a.token).status).toBe('paused');
  f.coordinator.heartbeat(f.b.token);
  f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'resume');
  f.coordinator.close();
  const recovered = createCoordinator({ database: f.database, repo: f.repo, now: () => 11002 });
  cleanups.push(() => recovered.close());
  expect(recovered.view(f.contract.id).status).toBe('paused');
  recovered.heartbeat(f.a.token);
  recovered.heartbeat(f.b.token);
  recovered.control(f.contract.id, recovered.view(f.contract.id).revision, 'resume');
  expect((await recovered.input(f.a.token, event('one'))).code).toBe('DUPLICATE');
  expect(recovered.heartbeat(f.a.token).score).toBe(1);
});
it('never commits an in-flight contribution after emergency stop', async () => {
  const f = setup();
  start(f);
  const pending = f.coordinator.input(f.a.token, event('one'));
  f.coordinator.stop('Emergency stop');
  expect((await pending).code).toBe('STOPPED');
  expect(f.coordinator.heartbeat(f.a.token)).toMatchObject({ status: 'paused', score: 0 });
});
it('expires invitations and rejects altered roles, artifacts and foreign tenant sessions', () => {
  const f = setup();
  f.now(901001);
  expect(() => f.coordinator.approve(f.a.token, f.contract.digest)).toThrow();
  expect(() =>
    f.coordinator.create(f.version.id, [roles[0]!, { ...roles[1]!, channelId: '100' }]),
  ).toThrow();
  f.database.client
    .prepare('UPDATE versions SET source = ? WHERE id = ?')
    .run('async()=>{}', f.version.id);
  expect(() => f.coordinator.create(f.version.id, roles)).toThrow();
  const foreign = forChannel(f.database, 'foreign');
  foreign.ensure('Other');
  const other = createCoordinator({ database: f.database, repo: foreign });
  cleanups.push(() => other.close());
  expect(() => other.view(f.contract.id)).toThrow();
  expect(() => other.review(f.b.token)).toThrow();
});
it('keeps the stop latched when persistence fails and recovers only through explicit control', async () => {
  const f = setup();
  start(f);
  f.database.client.exec(
    "CREATE TRIGGER reject_shared_update BEFORE UPDATE ON collaboration_sessions BEGIN SELECT RAISE(FAIL, 'disk failed'); END;",
  );
  expect(() => f.coordinator.stop('Emergency stop')).not.toThrow();
  f.database.client.exec('DROP TRIGGER reject_shared_update;');
  expect(f.coordinator.heartbeat(f.a.token).status).toBe('paused');
  expect((await f.coordinator.input(f.a.token, event('after-stop'))).code).toBe('STOPPED');
  f.coordinator.heartbeat(f.b.token);
  f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'resume');
  expect((await f.coordinator.input(f.a.token, event('after-resume'))).code).toBe('ACCEPTED');
});
it('rolls back progress when receipt storage fails and retains no uncommitted contribution', async () => {
  const f = setup();
  start(f);
  f.database.client.exec(
    "CREATE TRIGGER reject_shared_receipt BEFORE INSERT ON collaboration_receipts BEGIN SELECT RAISE(FAIL, 'disk failed'); END;",
  );
  await expect(f.coordinator.input(f.a.token, event('failed'))).rejects.toThrow(
    'could not be saved',
  );
  expect(f.coordinator.heartbeat(f.a.token)).toMatchObject({
    status: 'paused',
    score: 0,
    contributions: 0,
  });
});
it('continues only after a preapproved optional departure and rejects the old credential', async () => {
  const f = setup();
  const optional = f.coordinator.create(f.version.id, [
    roles[0]!,
    { ...roles[1]!, required: false },
  ]);
  const a = f.coordinator.invite(optional.contract.id, 'repair');
  const b = f.coordinator.invite(optional.contract.id, 'steer');
  f.coordinator.approve(a.token, optional.contract.digest);
  f.coordinator.approve(b.token, optional.contract.digest);
  f.coordinator.control(
    optional.contract.id,
    f.coordinator.view(optional.contract.id).revision,
    'start',
  );
  f.coordinator.leave(b.token);
  expect(f.coordinator.heartbeat(a.token).status).toBe('running');
  expect(() => f.coordinator.heartbeat(b.token)).toThrow();
  expect((await f.coordinator.input(a.token, event('one'))).code).toBe('ACCEPTED');
});
it('bounds queued requests and receipt retention without evicting dedupe history', async () => {
  const f = setup();
  start(f);
  const jobs = Array.from({ length: 128 }, (_, i) =>
    f.coordinator.input(f.a.token, event(`pending-${i}`)),
  );
  expect(() => f.coordinator.input(f.a.token, event('overflow'))).toThrow('queue is full');
  f.coordinator.stop('Queue stopped');
  await Promise.all(jobs);
  f.coordinator.heartbeat(f.a.token);
  f.coordinator.heartbeat(f.b.token);
  f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'resume');
  const insert = f.database.client.prepare(
    'INSERT INTO collaboration_receipts (channel_id, session_id, event_id, code, at) VALUES (?, ?, ?, ?, ?)',
  );
  f.database.client.transaction(() => {
    for (let i = 0; i < 10000; i++)
      insert.run('home', f.contract.id, `past-${i}`, 'ACCEPTED', 1000);
  })();
  expect((await f.coordinator.input(f.a.token, event('history-full'))).code).toBe('CAPACITY');
  expect(f.coordinator.view(f.contract.id).status).toBe('paused');
  expect(
    f.database.client.prepare('SELECT count(*) AS n FROM collaboration_receipts').get(),
  ).toEqual({ n: 10000 });
});
it('freezes the shared clock at the required lease deadline even when detection runs late', () => {
  const f = setup();
  start(f);
  f.now(50000);
  expect(f.coordinator.heartbeat(f.a.token)).toMatchObject({ status: 'paused', remaining: 110000 });
});
it('does not run two shared sessions concurrently', () => {
  const f = setup();
  start(f);
  const second = f.coordinator.create(f.version.id, roles);
  for (const role of roles) {
    const invitation = f.coordinator.invite(second.contract.id, role.id);
    f.coordinator.approve(invitation.token, second.contract.digest);
  }
  expect(() =>
    f.coordinator.control(
      second.contract.id,
      f.coordinator.view(second.contract.id).revision,
      'start',
    ),
  ).toThrow('other shared session');
});

it('keeps a trapped shared artifact quarantined across resume and coordinator restart', async () => {
  const f = setup('async () => { throw new Error("guest fault"); }');
  start(f);
  expect((await f.coordinator.input(f.a.token, event('trap'))).code).toBe('INCIDENT');
  expect(() =>
    f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'resume'),
  ).toThrow('execution incident');
  f.coordinator.close();
  const recovered = createCoordinator({ database: f.database, repo: f.repo, now: () => 2000 });
  cleanups.push(() => recovered.close());
  recovered.heartbeat(f.a.token);
  recovered.heartbeat(f.b.token);
  expect(() =>
    recovered.control(f.contract.id, recovered.view(f.contract.id).revision, 'resume'),
  ).toThrow('execution incident');
});

it('rechecks every required lease after queued execution before committing a contribution', async () => {
  const f = setup();
  start(f);
  f.now(9000);
  f.coordinator.heartbeat(f.a.token);
  const pending = f.coordinator.input(f.a.token, event('late-execution'));
  await Promise.resolve();
  f.now(12000); // own lease valid, required partner's lease expired during execution
  const result = await pending;
  expect(result.code).toBe('STOPPED');
  expect(f.coordinator.heartbeat(f.a.token)).toMatchObject({ score: 0, status: 'paused' });
});

it('requires explicit resume after failed state writes even if storage later recovers', async () => {
  const f = setup();
  start(f);
  f.database.client.exec(
    "CREATE TRIGGER fail_shared_write BEFORE UPDATE ON collaboration_sessions BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END",
  );
  await expect(f.coordinator.input(f.a.token, event('write-failed'))).rejects.toThrow(
    'could not be saved',
  );
  f.database.client.exec('DROP TRIGGER fail_shared_write');
  const later = await f.coordinator.input(f.a.token, event('after-recovery'));
  expect(later.code).toBe('STOPPED');
  expect(later.projection.score).toBe(0);
});

it('quarantines an execution incident before persistence even when writes fail', async () => {
  const f = setup('async () => { throw new Error("guest fault"); }');
  start(f);
  f.database.client.exec(
    "CREATE TRIGGER fail_incident_write BEFORE UPDATE ON collaboration_sessions BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END",
  );
  await expect(
    f.coordinator.input(f.a.token, event('incident-with-failed-write')),
  ).rejects.toThrow();
  f.database.client.exec('DROP TRIGGER fail_incident_write');
  const next = await f.coordinator.input(f.a.token, event('must-not-reexecute'));
  expect(next.code).toBe('STOPPED');
  expect(next.projection.status).toBe('paused');
  expect(() =>
    f.coordinator.control(f.contract.id, f.coordinator.view(f.contract.id).revision, 'resume'),
  ).toThrow('execution incident');
  f.coordinator.close();
  const recovered = createCoordinator({ database: f.database, repo: f.repo, now: () => 2000 });
  cleanups.push(() => recovered.close());
  recovered.heartbeat(f.a.token);
  recovered.heartbeat(f.b.token);
  expect(() =>
    recovered.control(f.contract.id, recovered.view(f.contract.id).revision, 'resume'),
  ).toThrow('execution incident');
});
it('says exactly who the round is waiting for instead of a stale creation message', () => {
  const f = setup();
  expect(f.coordinator.view(f.contract.id).reason).toBe(
    'Waiting for Shield repair, Navigation to approve and connect.',
  );
  f.coordinator.approve(f.a.token, f.contract.digest);
  expect(f.coordinator.view(f.contract.id).reason).toBe(
    'Waiting for Navigation to approve and connect.',
  );
  f.coordinator.approve(f.b.token, f.contract.digest);
  expect(f.coordinator.heartbeat(f.b.token).reason).toBe(
    'Every channel approved. The host can start the round.',
  );
});
