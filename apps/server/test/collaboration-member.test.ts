import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { artifactIdentity } from '@riff/sandbox';
import { migrateConnection } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createSealer } from '../src/services/auth/secrets.js';
import { createCoordinator } from '../src/services/collaboration/coordinator.js';
import { createCollaborationMember } from '../src/services/collaboration/member.js';
import type { PeerTransport } from '../src/services/collaboration/transport.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function setup() {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  cleanup.push(() => database.close());
  const repo = forChannel(database, 'home');
  repo.ensure('Owner');
  repo.updateState({ twitchUserId: '100' });
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../packages/compiler/fixtures/stateful-experiences.json', import.meta.url),
      'utf8',
    ),
  );
  const output = fixture.records.find((r: { intent: string }) =>
    r.intent.startsWith('Community Goal'),
  ).output;
  const version = repo.insertVersion({
    automationId: repo.createAutomation('Shared goal').id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: output.source, manifest: output.manifest }),
    title: 'Shared goal',
    intent: 'Shared goal',
    source: output.source,
    manifest: output.manifest,
    tests: output.tests,
    behavior: {},
    assumptions: [],
    evidence: { verification: { ok: true }, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  let at = 1000;
  const coordinator = createCoordinator({ database, repo, now: () => at });
  cleanup.push(() => coordinator.close());
  const roles = [
    {
      id: 'repair',
      label: 'Repair shields',
      channelId: '100',
      command: '!repair',
      required: true,
      fields: ['score', 'remaining', 'contributions'],
    },
    {
      id: 'steer',
      label: 'Steer ship',
      channelId: '200',
      command: '!steer',
      required: true,
      fields: ['score'],
    },
  ];
  const peer: PeerTransport = async (_origin, token, action, body) => {
    switch (action) {
      case 'review':
        return coordinator.review(token);
      case 'approve':
        return coordinator.approve(token, (body as { digest: string }).digest);
      case 'heartbeat':
        return coordinator.heartbeat(token);
      case 'input':
        return coordinator.input(token, body);
      case 'leave':
        coordinator.leave(token);
        return { ok: true };
    }
  };
  return {
    database,
    repo,
    version,
    coordinator,
    roles,
    peer,
    advance: (ms: number) => {
      at += ms;
    },
  };
}
it('reviews and verifies privately, approves exact authority, and fences delayed output after stop', async () => {
  const s = setup();
  const session = await s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const received: unknown[] = [];
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport: s.peer,
    publish: (p) => received.push(p),
    now: () => 1000,
  });
  cleanup.push(() => member.close());
  const review = await member.review('https://coordinator.example', invite.token);
  expect(review.verification.ok).toBe(true);
  expect(received.filter(Boolean)).toHaveLength(0);
  await expect(member.approve('0'.repeat(64))).rejects.toThrow();
  await member.approve(review.contract.digest);
  expect(member.status().state).toBe('connected');
  expect(JSON.stringify(member.status())).not.toContain(invite.token);
  member.stop('Local emergency stop');
  expect(received.at(-1)).toBeNull();
  expect(member.status().state).toBe('stopped');
  await member.poll();
  expect(received.at(-1)).toBeNull();
}, 30000);

it('refuses invitations for another Twitch channel and never approves them', async () => {
  const s = setup();
  const session = await s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '999',
    ready: () => true,
    blocked: () => false,
    transport: s.peer,
    publish() {},
  });
  cleanup.push(() => member.close());
  await expect(member.review('https://coordinator.example', invite.token)).rejects.toThrow(
    'channel',
  );
  expect(
    s.coordinator.view(session.contract.id).members.find((m) => m.roleId === 'steer')?.approved,
  ).toBe(false);
}, 30000);

it('discards a heartbeat response completed after local leave', async () => {
  const s = setup();
  const session = s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const received: unknown[] = [];
  let release: (() => void) | undefined;
  let waiting: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let delay = false;
  const transport: PeerTransport = async (...args) => {
    const result = await s.peer(...args);
    if (delay && args[2] === 'heartbeat') {
      waiting?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return result;
  };
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport,
    publish: (p) => received.push(p),
  });
  cleanup.push(() => member.close());
  await member.review('https://coordinator.example', invite.token);
  await member.approve(session.contract.digest);
  delay = true;
  const pending = member.poll();
  await started;
  member.stop();
  release?.();
  await pending;
  expect(received.at(-1)).toBeNull();
  expect(member.status().state).toBe('stopped');
}, 30000);

it('rejects public fields outside the reviewed role grant and clears prior output', async () => {
  const s = setup();
  const session = s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  let corrupt = false;
  const received: unknown[] = [];
  const transport: PeerTransport = async (...args) => {
    const result = await s.peer(...args);
    return corrupt && args[2] === 'heartbeat' ? { ...(result as object), remaining: 500 } : result;
  };
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport,
    publish: (p) => received.push(p),
  });
  cleanup.push(() => member.close());
  await member.review('https://coordinator.example', invite.token);
  await member.approve(session.contract.digest);
  corrupt = true;
  await member.poll();
  expect(member.status().state).toBe('paused');
  expect(received.at(-1)).not.toHaveProperty('remaining');
}, 30000);

it('runs two independently stored channels through authenticated HTTP and counts echoed chat once', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerMutationGuard } = await import('../src/routes/guard.js');
  const { registerCollaborationRoutes } = await import('../src/routes/collaboration.js');
  const { createPeerTransport } = await import('../src/services/collaboration/transport.js');
  const s = setup();
  const otherDb = openDatabase(':memory:');
  migrateConnection(otherDb);
  cleanup.push(() => otherDb.close());
  const otherRepo = forChannel(otherDb, 'home');
  otherRepo.ensure('Other');
  otherRepo.updateState({ twitchUserId: '200' });
  const ownerHttp = Fastify();
  const receiverHttp = Fastify();
  const bridge: typeof fetch = async (url, options) => {
    const target = new URL(String(url));
    const response = await ownerHttp.inject({
      method: 'POST',
      url: target.pathname,
      payload: String(options?.body ?? '{}'),
      headers: Object.fromEntries(new Headers(options?.headers).entries()),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  const published: unknown[] = [];
  const ownerMember = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-owner'),
    identity: () => '100',
    ready: () => true,
    blocked: () => false,
    transport: s.peer,
    publish() {},
  });
  const receiver = createCollaborationMember({
    database: otherDb,
    repo: otherRepo,
    sealer: createSealer('different-key-material-for-shared-receiver'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport: createPeerTransport(bridge),
    publish: (p) => published.push(p),
  });
  const otherCoordinator = createCoordinator({
    database: otherDb,
    repo: otherRepo,
    now: () => 1000,
  });
  cleanup.push(
    () => otherCoordinator.close(),
    () => ownerMember.close(),
    () => receiver.close(),
  );
  registerMutationGuard(ownerHttp);
  registerMutationGuard(receiverHttp);
  registerCollaborationRoutes(ownerHttp, {
    coordinator: s.coordinator,
    member: ownerMember,
    identity: () => '100',
    publicUrl: 'https://coordinator.example',
    configured: true,
    ready: () => true,
  });
  registerCollaborationRoutes(receiverHttp, {
    coordinator: otherCoordinator,
    member: receiver,
    identity: () => '200',
    publicUrl: 'https://receiver.example',
    configured: true,
    ready: () => true,
  });
  const post = (app: typeof ownerHttp, path: string, body: object) =>
    app.inject({
      method: 'POST',
      url: `/api/collaboration${path}`,
      payload: body,
      headers: { 'x-riff-request': '1' },
    });
  try {
    const created = await post(ownerHttp, '/create', { versionId: s.version.id, roles: s.roles });
    expect(created.statusCode).toBe(200);
    const contract = created.json().session.contract;
    const invite = (
      await post(ownerHttp, '/invite', { sessionId: contract.id, roleId: 'steer' })
    ).json();
    const reviewed = await post(receiverHttp, '/review', {
      origin: invite.origin,
      token: invite.token,
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(published.filter(Boolean)).toHaveLength(0);
    expect((await post(receiverHttp, '/approve', { digest: contract.digest })).statusCode).toBe(
      200,
    );
    expect((await post(ownerHttp, '/review-owner', { sessionId: contract.id })).statusCode).toBe(
      200,
    );
    expect((await post(ownerHttp, '/approve', { digest: contract.digest })).statusCode).toBe(200);
    const view = s.coordinator.view(contract.id);
    expect(
      (
        await post(ownerHttp, '/control', {
          sessionId: contract.id,
          expectedRevision: view.revision,
          action: 'start',
        })
      ).statusCode,
    ).toBe(200);
    const command = {
      id: 'envelope-one',
      sourceMessageId: 'original-one',
      sourceChannelId: '200',
      channelId: '200',
      viewerId: 'viewer',
      viewerName: 'PRIVATE VIEWER NAME',
      text: '!steer',
      roles: ['viewer' as const],
      source: 'twitch' as const,
    };
    await receiver.input(command);
    await receiver.input({ ...command, id: 'new-delivery-same-source' });
    await receiver.input({ ...command, id: 'echo', sourceChannelId: '100' });
    await receiver.settled();
    await receiver.poll();
    expect(receiver.status().projection?.score).toBe(1);
    expect(JSON.stringify(published)).not.toMatch(
      /PRIVATE VIEWER|participants|token|source|manifest/,
    );
    const row = otherDb.client.prepare('SELECT sealed FROM collaboration_connections').get() as {
      sealed: string;
    };
    expect(row.sealed).not.toContain(invite.token);
    expect(otherRepo.versions()).toHaveLength(0);
    const staleRevision = s.coordinator.view(contract.id).revision;
    await post(receiverHttp, '/leave', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(published.at(-1)).toBeNull();
    expect(s.coordinator.view(contract.id).status).toBe('paused');
    expect(
      (
        await post(ownerHttp, '/control', {
          sessionId: contract.id,
          expectedRevision: staleRevision,
          action: 'resume',
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await receiverHttp.close();
    await ownerHttp.close();
  }
}, 30000);

it('revokes uncertain approval when the remote approved but its response was lost', async () => {
  const s = setup();
  const session = s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const transport: PeerTransport = async (...args) => {
    const result = await s.peer(...args);
    if (args[2] === 'approve') throw new Error('Response lost');
    return result;
  };
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport,
    publish() {},
  });
  cleanup.push(() => member.close());
  await member.review('https://coordinator.example', invite.token);
  await expect(member.approve(session.contract.digest)).rejects.toThrow();
  await new Promise((resolve) => setImmediate(resolve));
  expect(() => s.coordinator.heartbeat(invite.token)).toThrow();
  expect(member.status().state).toBe('stopped');
}, 30000);

it('rejects an active local command conflict before granting shared membership', async () => {
  const s = setup();
  const session = s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const receiverDb = openDatabase(':memory:');
  migrateConnection(receiverDb);
  cleanup.push(() => receiverDb.close());
  const receiverRepo = forChannel(receiverDb, 'home');
  receiverRepo.ensure('Receiver');
  const local = receiverRepo.createAutomation('Local command');
  receiverRepo.insertVersion({
    ...s.version,
    automationId: local.id,
    artifactId: null,
    manifest: {
      ...session.contract.artifact.manifest,
      trigger: { ...session.contract.artifact.manifest.trigger, command: '!steer' },
      experience: {
        ...session.contract.artifact.manifest.experience!,
        contribution: { command: '!steer', points: 1 },
      },
    },
  });
  const localVersion = receiverRepo.versions(local.id)[0]!;
  receiverRepo.activate(local.id, localVersion.id);
  const member = createCollaborationMember({
    database: receiverDb,
    repo: receiverRepo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport: s.peer,
    publish() {},
  });
  cleanup.push(() => member.close());
  await member.review('https://coordinator.example', invite.token);
  await expect(member.approve(session.contract.digest)).rejects.toThrow('command');
  expect(
    s.coordinator.view(session.contract.id).members.find((m) => m.roleId === 'steer')?.approved,
  ).toBe(false);
}, 30000);

it('refuses changes to approved public guidance even when the peer echoes the pinned digest', async () => {
  const s = setup();
  const session = s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  let replacement: Record<string, unknown> = {};
  const transport: PeerTransport = async (...args) => {
    const result = await s.peer(...args);
    return args[2] === 'heartbeat' ? { ...(result as object), ...replacement } : result;
  };
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport,
    publish() {},
  });
  cleanup.push(() => member.close());
  await member.review('https://coordinator.example', invite.token);
  await member.approve(session.contract.digest);
  for (const change of [
    { instructions: 'Type !unapproved instead' },
    { title: 'UNAPPROVED TITLE' },
    { roleLabel: 'UNAPPROVED ROLE' },
    { target: 999 },
  ]) {
    replacement = change;
    await member.poll();
    expect(member.status().state).toBe('paused');
    expect(member.status().projection?.instructions).not.toContain('!unapproved');
    expect(member.status().projection?.title).not.toContain('UNAPPROVED');
    expect(member.status().projection?.roleLabel).not.toContain('UNAPPROVED');
    expect(member.status().projection?.target).not.toBe(999);
  }
}, 30000);

it('withdraws member output when local membership reads fail without a detached rejection', async () => {
  const s = setup();
  const session = s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const published: unknown[] = [];
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport: s.peer,
    publish: (p) => published.push(p),
  });
  cleanup.push(() => member.close());
  await member.review('https://coordinator.example', invite.token);
  await member.approve(session.contract.digest);
  const automations = s.repo.automations;
  s.repo.automations = () => {
    throw new Error('Local read unavailable');
  };
  try {
    await expect(member.poll()).resolves.toBeUndefined();
    expect(member.status().state).toBe('stopped');
    expect(published.at(-1)).toBeNull();
  } finally {
    s.repo.automations = automations;
  }
}, 30000);

it('never holds the channel chat pipeline while a shared contribution is in flight', async () => {
  const s = setup();
  const session = await s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  let calls = 0;
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    // The coordinator answers review/approve, then goes silent for chat input.
    transport: (origin, token, action, body, signal) => {
      if (action !== 'input') return s.peer(origin, token, action, body, signal);
      calls++;
      return new Promise(() => undefined);
    },
    publish: () => undefined,
    now: () => 1000,
  });
  cleanup.push(() => member.close());
  const review = await member.review('https://coordinator.example', invite.token);
  await member.approve(review.contract.digest);
  const claimed = await Promise.race([
    member.input({
      id: 'one',
      sourceMessageId: 'one',
      sourceChannelId: '200',
      channelId: '200',
      viewerId: 'viewer',
      viewerName: 'Viewer',
      text: '!steer',
      roles: ['viewer'],
      source: 'twitch',
    }),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
  ]);
  expect(claimed).toBe(true);
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls).toBe(1);
}, 30000);

it('labels the local view with partner roles from the approved agreement only', async () => {
  const s = setup();
  const session = await s.coordinator.create(s.version.id, s.roles);
  const invite = s.coordinator.invite(session.contract.id, 'steer');
  const published: unknown[] = [];
  const member = createCollaborationMember({
    database: s.database,
    repo: s.repo,
    sealer: createSealer('test-key-material-for-shared-session-members'),
    identity: () => '200',
    ready: () => true,
    blocked: () => false,
    transport: s.peer,
    publish: (p) => published.push(p),
    now: () => 1000,
  });
  cleanup.push(() => member.close());
  const review = await member.review('https://coordinator.example', invite.token);
  await member.approve(review.contract.digest);
  expect(member.status().projection?.partners).toEqual(['Repair shields']);
  expect(published.at(-1)).toMatchObject({ partners: ['Repair shields'] });
}, 30000);
