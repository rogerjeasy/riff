import { afterEach, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { compileOffline } from '@riff/compiler';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createProductionService } from '../src/services/production/service.js';
import type { BotTransport } from '../src/services/production/contract.js';

const dispose: (() => void)[] = [];
afterEach(() => dispose.splice(0).forEach((close) => close()));
const KEY = 'synthetic-firebot-event-key';

function setup() {
  const db = openDatabase(':memory:');
  migrate(db.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(db, 'test');
  repo.ensure('Test');
  const fake = (actions: { id: string; name: string; enabled: boolean }[]): BotTransport => ({
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    actions: vi.fn(async () => actions),
    invoke: vi.fn(async () => {}),
  });
  const bot = fake([{ id: 'action-1', name: 'Celebrate', enabled: true }]);
  const firebot: BotTransport = {
    ...fake([
      { id: 'preset:confetti', name: 'Run preset “Confetti”', enabled: true },
      { id: 'variable:riffRound', name: 'Set variable “riffRound”', enabled: true },
    ]),
    commands: vi.fn(async () => [{ id: 'cmd', trigger: '!tomato' }]),
  };
  const handlers: Record<string, (raw: unknown) => void> = {};
  const closers: Record<string, () => void> = {};
  let blocked = false;
  const control = vi.fn();
  const service = createProductionService({
    database: db,
    repo,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => 'https://riff.example/overlay/?key=private-overlay-key',
    blocked: () => blocked,
    control,
    now: () => 100000,
    botFactory: (event, onClose) => {
      handlers.streamerbot = event;
      closers.streamerbot = onClose;
      return bot;
    },
    firebotFactory: (event, onClose) => {
      handlers.firebot = event;
      closers.firebot = onClose;
      return firebot;
    },
  });
  dispose.push(() => {
    service.close();
    db.close();
  });
  return {
    db,
    repo,
    bot,
    firebot,
    service,
    control,
    emit: (tool: 'streamerbot' | 'firebot', raw: unknown) => handlers[tool]!(raw),
    lose: (tool: 'streamerbot' | 'firebot') => closers[tool]!(),
    block: () => {
      blocked = true;
      service.stop();
    },
  };
}
type S = ReturnType<typeof setup>;
const connectFirebot = (s: S, url = 'http://127.0.0.1:7472', password = KEY) =>
  s.service.connect({ kind: 'firebot', url, password, discover: true });
const connectBot = (s: S) =>
  s.service.connect({
    kind: 'streamerbot',
    url: 'ws://127.0.0.1:8080',
    password: 'test-password-value',
    discover: true,
  });
function active(s: S) {
  const out = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  const v = s.repo.insertVersion({
    automationId: s.repo.createAutomation('Test').id,
    parentVersionId: null,
    artifactId: 'a'.repeat(64),
    title: 'Test',
    intent: 'private',
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
    behavior: out.behavior,
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  s.repo.activate(v.automationId, v.id, 'console');
  return v;
}
function finish(s: S, v: ReturnType<typeof active>, id = 'round-1') {
  s.repo.replaceSession({
    automationId: v.automationId,
    versionId: v.id,
    definition: {
      version: 1,
      title: 'Goal',
      durationMs: 1000,
      maxParticipants: 256,
      teams: [],
      resource: { name: 'points', perParticipant: 3 },
      contribution: { command: '!tomato', points: 1 },
      objective: { kind: 'collective-goal', target: 1 },
    },
    snapshot: {
      id,
      phase: 'finished',
      startedAt: 99000,
      deadlineAt: null,
      remainingMs: 0,
      updatedAt: 100000,
      revision: 1,
      participants: {},
      scores: { community: 0 },
      winner: null,
      outcome: 'deadline',
    },
  });
}
const signal = (eventId: string, eventName = 'Start') => ({
  eventName,
  args: { riff: { eventId, causalId: eventId, origin: 'firebot', hops: 0, at: 100000 } },
});

it('connects Firebot as its own connector with discovery and never stores the event key', async () => {
  const s = setup();
  await connectFirebot(s);
  const view = s.service.view();
  expect(view.connections.firebot.status).toBe('connected');
  expect(view.connections.firebot.url).toBe('http://127.0.0.1:7472/');
  expect(view.connections.firebot.actions.map((a) => a.id)).toEqual([
    'preset:confetti',
    'variable:riffRound',
  ]);
  expect(view.connections.firebot.commands).toEqual(['!tomato']);
  expect(view.connections.streamerbot.status).toBe('disconnected');
  expect(JSON.stringify(view)).not.toContain(KEY);
  const stored = s.db.client.prepare('select value from production_state').get() as {
    value: string;
  };
  expect(stored.value).not.toContain(KEY);
});

it('accepts only local or private Firebot endpoints and a strong event key', async () => {
  const s = setup();
  for (const url of [
    'http://example.com:7472',
    'https://firebot.example:7472',
    'ws://127.0.0.1:7472',
    'http://user:pw@127.0.0.1:7472',
    'http://127.0.0.1:7472/?x=1',
  ])
    await expect(connectFirebot(s, url)).rejects.toThrow();
  await expect(connectFirebot(s, 'http://127.0.0.1:7472', 'short')).rejects.toThrow(/12/);
  await connectFirebot(s, 'http://192.168.1.20:7472');
  expect(s.service.view().connections.firebot.status).toBe('connected');
});

it('scopes mappings, inbound events and round-finished actions to the mapped tool', async () => {
  const s = setup(),
    v = active(s);
  await connectFirebot(s);
  await connectBot(s);
  s.service.reviewMappings([
    {
      id: 'fb',
      tool: 'firebot',
      eventName: 'Start',
      versionId: v.id,
      control: 'start',
      actionId: 'preset:confetti',
    },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  // The same event name from another tool is not this mapping.
  s.emit('streamerbot', signal('sb-1'));
  await vi.waitFor(() =>
    expect(s.service.view().recent[0]?.message).toMatch(/no approved mapping/),
  );
  expect(s.control).not.toHaveBeenCalled();
  s.emit('firebot', { eventName: 'Start', unauthenticated: true });
  await vi.waitFor(() => expect(s.service.view().recent[0]?.message).toMatch(/event key/));
  expect(s.control).not.toHaveBeenCalled();
  s.emit('firebot', signal('fb-1'));
  await vi.waitFor(() => expect(s.control).toHaveBeenCalledWith(v.id, 'start'));
  s.emit('firebot', signal('fb-1'));
  await vi.waitFor(() => expect(s.service.view().recent[0]?.code).toBe('DUPLICATE'));
  expect(s.control).toHaveBeenCalledTimes(1);

  finish(s, v);
  await s.service.observe();
  await s.service.observe();
  expect(s.firebot.invoke).toHaveBeenCalledTimes(1);
  expect(s.bot.invoke).not.toHaveBeenCalled();
  const [actionId, args] = vi.mocked(s.firebot.invoke).mock.calls[0]!;
  expect(actionId).toBe('preset:confetti');
  expect(args).toMatchObject({ riff: { origin: s.service.view().origin, hops: 1 } });
});

it('refuses a Firebot mapping whose action was not discovered and requires Firebot for approval', async () => {
  const s = setup(),
    v = active(s);
  await connectFirebot(s);
  expect(() =>
    s.service.reviewMappings([
      {
        id: 'fb',
        tool: 'firebot',
        eventName: 'Start',
        versionId: v.id,
        control: 'start',
        actionId: 'preset:unknown',
      },
    ]),
  ).toThrow(/Firebot/);
  s.service.reviewMappings([
    {
      id: 'fb',
      tool: 'firebot',
      eventName: 'Start',
      versionId: v.id,
      control: 'start',
      actionId: null,
    },
  ]);
  const digest = s.service.view().mappingReview!.digest;
  s.service.disconnect('firebot');
  // Reconnection clears bot reviews; a fresh review needs a connected Firebot.
  expect(s.service.view().mappingReview).toBeNull();
  expect(() => s.service.approveMappings(digest)).toThrow();
});

it('losing Firebot revokes only Firebot mappings; panic fences every connector', async () => {
  const s = setup(),
    v = active(s),
    w = active(s);
  await connectFirebot(s);
  await connectBot(s);
  s.service.reviewMappings([
    {
      id: 'fb',
      tool: 'firebot',
      eventName: 'Fb',
      versionId: v.id,
      control: 'start',
      actionId: null,
    },
    { id: 'sb', eventName: 'Sb', versionId: w.id, control: 'pause', actionId: null },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  s.lose('firebot');
  expect(s.service.view().connections.firebot.status).toBe('error');
  expect(s.service.view().mappings.map((m) => m.id)).toEqual(['sb']);
  s.block();
  expect(s.service.view().connections.firebot.status).toBe('disconnected');
  expect(s.service.view().connections.streamerbot.status).toBe('disconnected');
  expect(s.bot.disconnect).toHaveBeenCalled();
  expect(s.firebot.disconnect).toHaveBeenCalled();
});
