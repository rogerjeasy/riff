import { afterEach, expect, it } from 'vitest';
import { artifactIdentity } from '@riff/sandbox';
import type { ExperienceDefinition, PermissionManifest } from '@riff/sdk';
import { migrateConnection } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { collaborationRepository } from '../src/db/repositories/collaboration.js';
import { createCoordinator } from '../src/services/collaboration/coordinator.js';
import {
  SHARED_LIMITS,
  sharedPresentation,
  type SharedRole,
} from '../src/services/collaboration/contract.js';

/** F36 gaps: distinct role mechanics, version 2 rules, continuation choices, raid handoff. */
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const v2: ExperienceDefinition = {
  version: 2,
  title: 'Ship',
  durationMs: 120000,
  maxParticipants: 256,
  teams: [],
  resource: { name: 'actions', perParticipant: 3 },
  contribution: { command: '!help', points: 1 },
  objective: { kind: 'collective-goal', target: 20 },
  mechanics: {
    match: null,
    health: null,
    burst: {
      command: '!boost',
      label: 'Warp boost',
      participants: 2,
      windowMs: 10000,
      points: 5,
      limit: 3,
      shieldMs: 0,
    },
    milestones: [
      { id: 'half', label: 'Halfway', score: 2, unlock: { command: '!fire', points: 3 } },
    ],
  },
};
const distinct: SharedRole[] = [
  {
    id: 'repair',
    label: 'Shield repair',
    channelId: '100',
    command: '!repair',
    required: true,
    action: 'contribute',
    fields: ['score', 'contributions'],
  },
  {
    id: 'steer',
    label: 'Navigation',
    channelId: '200',
    command: '!steer',
    required: true,
    action: 'burst',
    fields: ['score', 'mechanics'],
  },
  {
    id: 'guns',
    label: 'Gunnery',
    channelId: '300',
    command: '!guns',
    required: false,
    action: 'unlock:half',
    fields: ['score', 'mechanics'],
  },
];
function setup(
  options: {
    experience?: ExperienceDefinition;
    roles?: SharedRole[];
    raidHandoff?: boolean;
  } = {},
) {
  let at = 1000;
  let panicked = false;
  const database = openDatabase(':memory:');
  migrateConnection(database);
  cleanups.push(() => database.close());
  const repo = forChannel(database, 'home');
  repo.ensure('Home');
  repo.updateState({ twitchUserId: '100' });
  const manifest: PermissionManifest = {
    sdkVersion: '0.4.0',
    capabilities: ['session', 'overlay'],
    trigger: { command: '!help', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
    experience: options.experience ?? v2,
  };
  const artifact = { source: `async (event,riff)=>{}`, manifest };
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
          effects: 0,
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
  const coordinator = createCoordinator({
    database,
    repo,
    now: () => at,
    blocked: () => panicked,
  });
  cleanups.push(() => coordinator.close());
  const roles = options.roles ?? distinct;
  const contract = coordinator.create(version.id, roles, options.raidHandoff ?? false).contract;
  const tokens = Object.fromEntries(
    roles.map((role) => [role.id, coordinator.invite(contract.id, role.id).token]),
  );
  const f = {
    database,
    repo,
    version,
    coordinator,
    contract,
    tokens,
    now: (value: number) => {
      at = value;
    },
    panic: (value: boolean) => {
      panicked = value;
    },
    revision: () => coordinator.view(contract.id).revision,
    control: (action: Parameters<typeof coordinator.control>[2]) =>
      coordinator.control(contract.id, f.revision(), action),
    start() {
      for (const token of Object.values(tokens)) coordinator.approve(token, contract.digest);
      return f.control('start');
    },
  };
  return f;
}
const chat = (id: string, channelId: string, text: string, viewerId = 'viewer-1') => ({
  id,
  channelId,
  viewerId,
  roles: ['viewer'] as const,
  text,
  sourceChannelId: channelId,
  sourceMessageId: id,
});

it('gives each channel its own command, instructions and mechanic within the definition', async () => {
  const f = setup();
  expect(f.start().status).toBe('running');
  const guide = (id: string) => sharedPresentation(f.contract, id).instructions;
  expect(guide('repair')).toContain('3 actions per person');
  expect(guide('steer')).toContain('2 different viewers within 10s trigger Warp boost (+5 points)');
  expect(guide('guns')).toContain('unlocks after Halfway · +3 points');
  // Gunnery is locked until the shared score reaches the milestone.
  expect((await f.coordinator.input(f.tokens.guns!, chat('g0', '300', '!guns'))).code).toBe(
    'LOCKED',
  );
  // Navigation steers: a two-viewer burst adds 5 points, a contribution adds 1.
  await f.coordinator.input(f.tokens.steer!, chat('s1', '200', '!steer', 'a'));
  const burst = await f.coordinator.input(f.tokens.steer!, chat('s2', '200', '!steer', 'b'));
  expect(burst.projection).toMatchObject({ score: 5, bursts: 1, tier: 1 });
  const repaired = await f.coordinator.input(f.tokens.repair!, chat('r1', '100', '!repair'));
  expect(repaired.projection).toMatchObject({ score: 6, contributions: 1 });
  expect(repaired.projection.bursts).toBeUndefined();
  // A channel's command never triggers another role's mechanic.
  expect((await f.coordinator.input(f.tokens.repair!, chat('r2', '100', '!steer'))).code).toBe(
    'UNRELATED',
  );
  const fired = await f.coordinator.input(f.tokens.guns!, chat('g1', '300', '!guns'));
  expect(fired.code).toBe('ACCEPTED');
  expect(fired.projection.score).toBe(9);
});

it('validates role actions and excludes version 2 rules that do not fit one shared pool', () => {
  const v1: ExperienceDefinition = {
    ...v2,
    version: 1,
    mechanics: undefined,
  };
  delete (v1 as { mechanics?: unknown }).mechanics;
  expect(() => setup({ experience: v1 })).toThrow('command from the approved definition');
  expect(() =>
    setup({
      roles: distinct.map((r) => ({ ...r, action: r.id === 'repair' ? 'burst' : r.action })),
    }),
  ).toThrow('reach the shared objective');
  expect(() =>
    setup({
      roles: distinct.map((r) => ({ ...r, action: r.id === 'guns' ? 'unlock:none' : r.action })),
    }),
  ).toThrow('command from the approved definition');
  expect(() =>
    setup({
      experience: {
        ...v2,
        mechanics: { ...v2.mechanics!, match: { rounds: 3, intermissionMs: 0 } },
      },
    }),
  ).toThrow('best-of-N');
  // A burst objective needs a channel that can trigger the burst.
  const burstGoal = { ...v2, objective: { kind: 'burst' as const, target: 2 } };
  expect(() =>
    setup({
      experience: burstGoal,
      roles: distinct.map((r) => ({ ...r, action: r.id === 'steer' ? 'contribute' : r.action })),
    }),
  ).toThrow('reach the shared objective');
  expect(setup({ experience: burstGoal }).contract.roles).toHaveLength(3);
});

it('lets the host wait for a lost required channel and resumes when it returns', () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.steer!);
  let view = f.coordinator.view(f.contract.id);
  expect(view).toMatchObject({ status: 'paused', lost: ['steer'], waitUntil: null });
  expect(view.reason).toContain('Navigation left');
  view = f.control('wait');
  expect(view.reason).toContain('waiting up to 2 minutes for Navigation');
  expect(view.waitUntil).toBe(1000 + 120000);
  // Members see the same explicit state.
  expect(f.coordinator.heartbeat(f.tokens.repair!)).toMatchObject({
    status: 'paused',
    reason: view.reason,
  });
  const again = f.coordinator.invite(f.contract.id, 'steer');
  f.now(5000);
  f.coordinator.heartbeat(f.tokens.repair!);
  f.coordinator.approve(again.token, f.contract.digest);
  view = f.coordinator.view(f.contract.id);
  expect(view.status).toBe('running');
  expect(view.decisions.map((d) => d.code)).toEqual(['POLICY_WAIT', 'POLICY_RESUMED']);
});

it('reports an expired wait and keeps the round paused for an explicit choice', () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.steer!);
  f.control('wait');
  f.now(1000 + 120001);
  const view = f.coordinator.view(f.contract.id);
  expect(view.status).toBe('paused');
  expect(view.waitUntil).toBeNull();
  expect(view.reason).toContain('did not return in time');
  expect(view.decisions.map((d) => d.code)).toEqual(['POLICY_WAIT', 'POLICY_WAIT_EXPIRED']);
});

it('continues without a lost channel only when the rest can still reach the objective', async () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.repair!); // the only contributing role
  expect(() => f.control('continue')).toThrow('cannot reach the shared objective');
  const g = setup();
  g.start();
  g.coordinator.leave(g.tokens.steer!);
  const view = g.control('continue');
  expect(view.status).toBe('running');
  expect(view.members.find((m) => m.roleId === 'steer')).toMatchObject({ dropped: true });
  expect(view.decisions.map((d) => d.code)).toEqual(['POLICY_CONTINUE']);
  // The dropped membership is revoked and no longer gates play.
  expect(() => g.coordinator.heartbeat(g.tokens.steer!)).toThrow();
  g.now(9000);
  g.coordinator.heartbeat(g.tokens.repair!);
  expect(g.coordinator.view(g.contract.id).status).toBe('running');
  expect((await g.coordinator.input(g.tokens.repair!, chat('r', '100', '!repair'))).code).toBe(
    'ACCEPTED',
  );
});

it('ends a paused round with final results and audits the choice', () => {
  const f = setup();
  f.start();
  f.now(20000); // every lease expires: required loss pauses at the deadline
  f.coordinator.tick();
  expect(f.coordinator.view(f.contract.id).lost).toEqual(['repair', 'steer']);
  const view = f.control('end');
  expect(view.status).toBe('finished');
  expect(view.reason).toBe('The host ended the round at 0 of 20 points.');
  expect(view.decisions.map((d) => d.code)).toEqual(['POLICY_END']);
  expect(() => f.control('end')).toThrow();
});

it('keeps local emergency stop independent of continuation choices', () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.steer!);
  f.panic(true);
  // A wait cannot be chosen while this channel is stopped; ending still can.
  expect(() => f.control('wait')).toThrow('Resume this channel');
  expect(() => f.control('continue')).toThrow('Resume this channel');
  expect(() => f.coordinator.invite(f.contract.id, 'steer')).toThrow('Resume this channel');
  expect(f.control('end').status).toBe('finished');
});

it('never auto-resumes a wait after a panic or stop, even when the channel returns', () => {
  for (const interrupt of ['panic', 'stop'] as const) {
    const f = setup();
    f.start();
    f.coordinator.leave(f.tokens.steer!);
    f.control('wait');
    const again = f.coordinator.invite(f.contract.id, 'steer');
    if (interrupt === 'panic') {
      f.panic(true);
      f.coordinator.tick(); // the blocked tick cancels the wait
      f.panic(false);
    } else f.coordinator.stop('Emergency stop');
    f.now(3000);
    f.coordinator.heartbeat(f.tokens.repair!);
    f.coordinator.approve(again.token, f.contract.digest);
    const view = f.coordinator.view(f.contract.id);
    expect(view.status).toBe('paused');
    expect(view.waitUntil).toBeNull();
    expect(view.reason).toContain('must choose again');
  }
});

it('never lets a stale wait resume a session paused for another reason', () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.steer!);
  f.control('wait');
  const again = f.coordinator.invite(f.contract.id, 'steer');
  f.coordinator.approve(again.token, f.contract.digest);
  // The returning channel answered the wait; play resumed and the marker is gone.
  expect(f.coordinator.view(f.contract.id).status).toBe('running');
  f.control('pause');
  f.coordinator.tick();
  expect(f.coordinator.view(f.contract.id)).toMatchObject({
    status: 'paused',
    reason: 'Paused by the coordinator.',
    waitUntil: null,
  });
});

it('caps host decisions and rejects a second wait while one is pending', () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.steer!);
  f.control('wait');
  expect(() => f.control('wait')).toThrow('already waiting');
  let at = 1000;
  let waits = 1;
  // Each expired wait adds one host decision and one system follow-up, all capped.
  expect(() => {
    while (waits < 40) {
      at += 120001;
      f.now(at);
      f.coordinator.tick();
      f.control('wait');
      waits++;
    }
  }).toThrow('decision limit');
  expect(waits).toBeLessThan(32);
  expect(f.coordinator.view(f.contract.id).decisions.length).toBeLessThanOrEqual(33);
});

it('hands presentation only to the channel this coordinator itself raided', () => {
  const plain = setup();
  plain.start();
  expect(plain.coordinator.recordRaid({ eventId: 'r0', toChannelId: '200' })).toEqual([]);
  expect(() =>
    plain.coordinator.handoff(plain.tokens.steer!, { eventId: 'r0', fromChannelId: '100' }),
  ).toThrow('did not opt in');

  const f = setup({ raidHandoff: true });
  f.start();
  // A member's claim alone, with no outgoing raid recorded by the coordinator, is refused.
  expect(() =>
    f.coordinator.handoff(f.tokens.steer!, { eventId: 'claimed', fromChannelId: '100' }),
  ).toThrow('has not recorded a raid');
  expect(f.coordinator.view(f.contract.id).members.some((m) => m.presenting)).toBe(false);
  // The coordinator's own EventSub sees its outgoing raid to channel 200 (Navigation).
  expect(f.coordinator.recordRaid({ eventId: 'raid-1', toChannelId: '200' })).toEqual([
    f.contract.id,
  ]);
  // A different member cannot spoof itself into the presenter seat.
  expect(() =>
    f.coordinator.handoff(f.tokens.guns!, { eventId: 'raid-1', fromChannelId: '100' }),
  ).toThrow('has not recorded a raid');
  expect(
    f.coordinator.handoff(f.tokens.steer!, { eventId: 'raid-1', fromChannelId: '100' }).presenter,
  ).toBe('Navigation');
  expect(f.coordinator.heartbeat(f.tokens.guns!).presenter).toBe('Navigation');
  // Duplicate deliveries and later raids are idempotent: one handoff per session.
  f.coordinator.recordRaid({ eventId: 'raid-1', toChannelId: '200' });
  f.coordinator.recordRaid({ eventId: 'raid-2', toChannelId: '300' });
  const view = f.coordinator.view(f.contract.id);
  expect(view.decisions.map((d) => d.code)).toEqual(['HANDOFF']);
  expect(view.members.find((m) => m.roleId === 'steer')?.presenting).toBe(true);
  // After the raid the host channel may go offline; play continues in the receiving channel.
  f.coordinator.leave(f.tokens.repair!);
  f.now(8000);
  f.coordinator.heartbeat(f.tokens.steer!);
  expect(f.coordinator.view(f.contract.id).status).toBe('running');
  // No credential moves: the host's revoked token stays revoked.
  expect(() => f.coordinator.heartbeat(f.tokens.repair!)).toThrow();
});

it('ignores outgoing raids observed while this channel is stopped', () => {
  const f = setup({ raidHandoff: true });
  f.start();
  f.panic(true);
  expect(f.coordinator.recordRaid({ eventId: 'r', toChannelId: '200' })).toEqual([]);
  f.panic(false);
  expect(() =>
    f.coordinator.handoff(f.tokens.steer!, { eventId: 'r', fromChannelId: '100' }),
  ).toThrow('has not recorded a raid');
});

it('settles a wait even when receipt history is full, and keeps ticking other sessions', () => {
  const f = setup();
  f.start();
  f.coordinator.leave(f.tokens.steer!);
  f.control('wait');
  // Fill the receipt history to its cap behind the wait.
  const store = collaborationRepository(f.database, 'home');
  store.atomic(() => {
    for (let i = store.receiptCount(f.contract.id); i < SHARED_LIMITS.receipts; i++)
      store.receipt(f.contract.id, `filler-${i}`, 'ACCEPTED', 1000);
  });
  // A second session runs while the first stays paused.
  const other = f.coordinator.create(f.version.id, distinct).contract;
  const tokens = distinct.map((r) => f.coordinator.invite(other.id, r.id).token);
  tokens.forEach((token) => f.coordinator.approve(token, other.digest));
  f.coordinator.control(other.id, f.coordinator.view(other.id).revision, 'start');
  f.now(1000 + 120001);
  expect(() => f.coordinator.tick()).not.toThrow();
  const capped = f.coordinator.view(f.contract.id);
  expect(capped).toMatchObject({ status: 'paused', waitUntil: null });
  expect(capped.reason).toContain('did not return in time');
  // The other session's leases expired too; it was still enforced (paused), not skipped.
  expect(f.coordinator.view(other.id).status).toBe('paused');
  // Host decisions stay capped by the full history.
  expect(() => f.control('wait')).toThrow('history is full');
});
