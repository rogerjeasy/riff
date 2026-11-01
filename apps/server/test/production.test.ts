import { afterEach, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { compileOffline } from '@riff/compiler';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createProductionService } from '../src/services/production/service.js';
import type { ObsTransport, BotTransport } from '../src/services/production/contract.js';
const dispose: (() => void)[] = [];
afterEach(() => dispose.splice(0).forEach((close) => close()));
function setup() {
  const db = openDatabase(':memory:');
  migrate(db.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(db, 'test');
  repo.ensure('Test');
  const inputs = new Map<string, Record<string, unknown>>();
  const obs: ObsTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    scenes: vi.fn(async () => ['Main', 'Private']),
    input: vi.fn(async (_scene, name) => inputs.get(name) ?? null),
    write: vi.fn(async (_scene, name, settings, create) => {
      if (create && inputs.has(name)) throw Error('exists');
      inputs.set(name, settings);
    }),
    remove: vi.fn(async (_scene, name) => {
      inputs.delete(name);
    }),
  };
  const bot: BotTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    actions: vi.fn(async () => [{ id: 'action-1', name: 'Celebrate', enabled: true }]),
    invoke: vi.fn(async () => {}),
  };
  let handler: (raw: unknown) => void = () => {};
  let obsClose: () => void = () => {};
  let blocked = false;
  let clock = 100000;
  const control = vi.fn();
  const service = createProductionService({
    database: db,
    repo,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => 'https://riff.example/overlay/?key=private-overlay-key',
    blocked: () => blocked,
    control,
    now: () => clock,
    obsFactory: (onClose) => {
      obsClose = onClose;
      return obs;
    },
    botFactory: (event) => {
      handler = event;
      return bot;
    },
  });
  dispose.push(() => {
    service.close();
    db.close();
  });
  return {
    db,
    repo,
    obs,
    bot,
    service,
    inputs,
    control,
    event: (event: unknown) => handler(event),
    loseObs: () => obsClose(),
    block: () => {
      blocked = true;
      service.stop();
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
async function connect(s: ReturnType<typeof setup>, kind: 'obs' | 'streamerbot') {
  await s.service.connect({
    kind,
    url: kind === 'obs' ? 'ws://127.0.0.1:4455' : 'ws://127.0.0.1:8080',
    password: 'test-password-value',
    discover: true,
  });
}
function active(s: ReturnType<typeof setup>) {
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
  s.repo.activate(v.automationId, v.id);
  return v;
}
it('keeps credentials sealed and setup requires exact review, visible test and explicit live confirmation', async () => {
  const s = setup();
  await connect(s, 'obs');
  expect(JSON.stringify(s.service.view())).not.toContain('test-password-value');
  const stored = s.db.client.prepare('select value from production_state').get() as {
    value: string;
  };
  expect(stored.value).not.toContain('test-password-value');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  expect(s.obs.write).not.toHaveBeenCalled();
  const hash = s.service.view().obsReview!.digest;
  await expect(s.service.applyObs('bad')).rejects.toThrow();
  await s.service.applyObs(hash);
  expect(s.inputs.get('Riff')?.url).toBe('https://riff.example/production-test');
  expect(JSON.stringify(s.service.view())).not.toContain('private-overlay-key');
  await s.service.confirmObs(hash);
  expect(s.inputs.get('Riff')?.url).toContain('/overlay/');
  await s.service.rollbackObs(hash);
  expect(s.inputs.has('Riff')).toBe(false);
});
it('refuses arbitrary OBS inputs and changed settings before confirm or rollback', async () => {
  const s = setup();
  await connect(s, 'obs');
  s.inputs.set('Camera', { url: 'https://unrelated.example', width: 100 });
  await expect(
    s.service.reviewObs({ sceneName: 'Main', inputName: 'Camera', width: 1920, height: 1080 }),
  ).rejects.toThrow();
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  const hash = s.service.view().obsReview!.digest;
  await s.service.applyObs(hash);
  s.inputs.set('Riff', { url: 'https://unrelated.example' });
  await expect(s.service.confirmObs(hash)).rejects.toThrow();
  await expect(s.service.rollbackObs(hash)).rejects.toThrow();
});
it('fences in-flight setup at panic and never starts another external operation', async () => {
  const s = setup();
  await connect(s, 'obs');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  const hash = s.service.view().obsReview!.digest;
  s.block();
  await expect(s.service.applyObs(hash)).rejects.toThrow();
  expect(s.obs.write).not.toHaveBeenCalled();
});
it('maps only exact approved versions and rejects duplicate, self-origin and old causal events', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    {
      id: 'start',
      eventName: 'Start challenge',
      versionId: v.id,
      control: 'start',
      actionId: 'action-1',
    },
  ]);
  const hash = s.service.view().mappingReview!.digest;
  s.service.approveMappings(hash);
  // Approval consumes the review, so it cannot be offered or approved a second time.
  expect(s.service.view().mappingReview).toBeNull();
  expect(s.service.view().mappings).toHaveLength(1);
  const event = {
    eventName: 'Start challenge',
    args: {
      riff: { eventId: 'one', causalId: 'cause-1', origin: 'external', hops: 0, at: 100000 },
    },
  };
  await s.service.receive(event);
  await s.service.receive(event);
  expect(s.control).toHaveBeenCalledTimes(1);
  await s.service.receive({ ...event, args: { riff: { ...event.args.riff, eventId: 'two' } } });
  expect(s.control).toHaveBeenCalledTimes(1);
  await s.service.receive({
    ...event,
    args: {
      riff: {
        ...event.args.riff,
        eventId: 'three',
        causalId: 'three',
        origin: s.service.view().origin,
      },
    },
  });
  expect(s.control).toHaveBeenCalledTimes(1);
  s.repo.updateVersion(v.id, { incident: 'unsafe' });
  await s.service.receive({
    ...event,
    args: { riff: { ...event.args.riff, eventId: 'four', causalId: 'four' } },
  });
  expect(s.control).toHaveBeenCalledTimes(1);
});
it('import stages only supported mappings and lists executable native formats as unsupported', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  s.service.importConfiguration({
    format: 'riff-production',
    version: 1,
    mappings: [
      { id: 'one', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
    ],
  });
  expect(s.service.view().mappings).toEqual([]);
  expect(s.service.view().mappingReview?.differences.length).toBeGreaterThan(0);
  s.service.importConfiguration({ format: 'firebot', scripts: ['never execute'] });
  expect(s.service.view().mappingReview?.unsupported.length).toBeGreaterThan(0);
  expect(() => s.service.approveMappings(s.service.view().mappingReview!.digest)).toThrow();
});
it('panic remains synchronous and safe when transport cleanup throws', async () => {
  const s = setup();
  await connect(s, 'obs');
  vi.mocked(s.obs.disconnect).mockImplementation(() => {
    throw Error('cleanup');
  });
  expect(() => s.block()).not.toThrow();
  expect(s.service.view().connections.obs.status).toBe('disconnected');
});
it('does not ignore connection loss after mapping review changes operation epochs', async () => {
  const s = setup();
  const close = vi.fn();
  const service = createProductionService({
    database: s.db,
    repo: s.repo,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => 'https://riff.example/overlay/',
    blocked: () => false,
    control: () => {},
    botFactory: (_event, onClose) => {
      close.mockImplementation(onClose);
      return s.bot;
    },
  });
  dispose.unshift(() => service.close());
  await service.connect({
    kind: 'streamerbot',
    url: 'ws://127.0.0.1:8080',
    password: 'test-password-value',
    discover: true,
  });
  const v = active(s);
  service.reviewMappings([
    { id: 'x', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
  ]);
  service.approveMappings(service.view().mappingReview!.digest);
  close();
  expect(service.view().connections.streamerbot.status).toBe('error');
  expect(service.view().mappings).toEqual([]);
});
it('does not silently discard scripts embedded beside a supported import format', async () => {
  const s = setup();
  await connect(s, 'streamerbot');
  s.service.importConfiguration({
    format: 'riff-production',
    version: 1,
    mappings: [],
    scripts: ['do not execute'],
  });
  expect(s.service.view().mappingReview?.unsupported.length).toBeGreaterThan(0);
  expect(() => s.service.approveMappings(s.service.view().mappingReview!.digest)).toThrow();
});
it('does not dispatch late OBS work after disconnect during discovery', async () => {
  const s = setup();
  let resolve!: (scenes: string[]) => void;
  vi.mocked(s.obs.scenes).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const connecting = connect(s, 'obs');
  await vi.waitFor(() => expect(s.obs.scenes).toHaveBeenCalled());
  s.service.disconnect('obs');
  resolve(['Main']);
  await expect(connecting).rejects.toThrow();
  expect(s.service.view().connections.obs.status).toBe('disconnected');
  expect(s.obs.write).not.toHaveBeenCalled();
});
it('keeps receipts across reconnect and restart without replaying duplicate control', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  const mappings = [
    { id: 'x', eventName: 'Start', versionId: v.id, control: 'start' as const, actionId: null },
  ];
  s.service.reviewMappings(mappings);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  const event = {
    eventName: 'Start',
    args: { riff: { eventId: 'one', causalId: 'one', origin: 'external', hops: 0, at: 100000 } },
  };
  await s.service.receive(event);
  s.service.disconnect('streamerbot');
  await connect(s, 'streamerbot');
  s.service.reviewMappings(mappings);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  await s.service.receive(event);
  expect(s.control).toHaveBeenCalledTimes(1);
});
it('does not inherit another channel production credentials or mappings', async () => {
  const s = setup();
  await connect(s, 'obs');
  const other = forChannel(s.db, 'other');
  other.ensure('Other');
  const isolated = createProductionService({
    database: s.db,
    repo: other,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => 'https://other.example/overlay/',
    blocked: () => false,
    control: () => {},
  });
  dispose.unshift(() => isolated.close());
  expect(isolated.view().connections.obs.status).toBe('disconnected');
  expect(isolated.view().mappings).toEqual([]);
  expect(isolated.view().origin).not.toBe(s.service.view().origin);
});
function finished(
  s: ReturnType<typeof setup>,
  version: ReturnType<typeof active>,
  id = 'finished-round',
) {
  s.repo.replaceSession({
    automationId: version.automationId,
    versionId: version.id,
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
it('sends a completed-round action once, even after receipt expiry and concurrent observer calls', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    { id: 'one', eventName: 'Start', versionId: v.id, control: 'start', actionId: 'action-1' },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  finished(s, v);
  let resolve!: () => void;
  vi.mocked(s.bot.invoke).mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const observing = s.service.observe();
  await vi.waitFor(() => expect(s.bot.invoke).toHaveBeenCalledTimes(1));
  await s.service.observe();
  expect(s.bot.invoke).toHaveBeenCalledTimes(1);
  resolve();
  await observing;
  vi.mocked(s.bot.invoke).mockResolvedValue();
  s.advance(700000);
  await s.service.observe();
  expect(s.bot.invoke).toHaveBeenCalledTimes(1);
});
it('does not replay a round that was already finished before bridge approval', async () => {
  const s = setup(),
    v = active(s);
  finished(s, v);
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    { id: 'one', eventName: 'Start', versionId: v.id, control: 'start', actionId: 'action-1' },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  await s.service.observe();
  expect(s.bot.invoke).not.toHaveBeenCalled();
});
it('rejects a same-host overlay belonging to another scoped key and unclaimed diagnostic sources', async () => {
  const s = setup();
  await connect(s, 'obs');
  s.inputs.set('Another channel', {
    url: 'https://riff.example/overlay/?key=another-channel-key',
    width: 1920,
    height: 1080,
  });
  await expect(
    s.service.reviewObs({
      sceneName: 'Main',
      inputName: 'Another channel',
      width: 1920,
      height: 1080,
    }),
  ).rejects.toThrow(/Riff browser source/);
  s.inputs.set('Unclaimed diagnostic', {
    url: 'https://riff.example/production-test',
    width: 1920,
    height: 1080,
  });
  await expect(
    s.service.reviewObs({
      sceneName: 'Main',
      inputName: 'Unclaimed diagnostic',
      width: 1920,
      height: 1080,
    }),
  ).rejects.toThrow(/Riff browser source/);
  await s.service.reviewObs({
    sceneName: 'Main',
    inputName: 'Owned test',
    width: 1920,
    height: 1080,
  });
  await s.service.applyObs(s.service.view().obsReview!.digest);
  await expect(
    s.service.reviewObs({ sceneName: 'Main', inputName: 'Owned test', width: 1280, height: 720 }),
  ).resolves.toBeTruthy();
  expect(JSON.stringify(s.service.view())).not.toContain('private-overlay-key');
});

it.each(['confirm', 'rollback'] as const)(
  'preserves applied OBS authority across bot review and approval for %s',
  async (operation) => {
    const s = setup(),
      v = active(s);
    await connect(s, 'obs');
    await connect(s, 'streamerbot');
    const original = { url: 'https://riff.example/overlay/?key=private-overlay-key' };
    s.inputs.set('Riff', original);
    await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
    const hash = s.service.view().obsReview!.digest;
    await s.service.applyObs(hash);
    s.service.reviewMappings([
      { id: 'start', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
    ]);
    s.service.approveMappings(s.service.view().mappingReview!.digest);
    if (operation === 'confirm') {
      await s.service.confirmObs(hash);
      expect(s.service.view().obsReview?.status).toBe('live');
    }
    await s.service.rollbackObs(hash);
    expect(s.inputs.get('Riff')).toEqual(original);
    expect(s.service.view().mappings).toHaveLength(1);
  },
);
it('bot reconnect preserves the OBS diagnostic and rollback snapshot', async () => {
  const s = setup();
  await connect(s, 'obs');
  await connect(s, 'streamerbot');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  const hash = s.service.view().obsReview!.digest;
  await s.service.applyObs(hash);
  await connect(s, 'streamerbot');
  expect(s.service.view().obsReview?.status).toBe('test');
  await s.service.confirmObs(hash);
  await s.service.rollbackObs(hash);
  expect(s.inputs.has('Riff')).toBe(false);
});
it('OBS reconnect fences OBS setup while retaining approved bot control', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'obs');
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    { id: 'start', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  const hash = s.service.view().obsReview!.digest;
  await connect(s, 'obs');
  await expect(s.service.applyObs(hash)).rejects.toThrow();
  expect(s.service.view().mappings).toHaveLength(1);
  await s.service.receive({
    eventName: 'Start',
    args: {
      riff: {
        eventId: 'still-authorized',
        causalId: 'still-authorized',
        origin: 'external',
        hops: 0,
        at: 100000,
      },
    },
  });
  expect(s.control).toHaveBeenCalledWith(v.id, 'start');
});
it.each(['obs', 'streamerbot', 'mapping', 'panic'] as const)(
  'scopes in-flight bot dispatch revocation for %s',
  async (change) => {
    const s = setup(),
      first = active(s),
      second = active(s);
    await connect(s, 'obs');
    await connect(s, 'streamerbot');
    const mappings = [first, second].map((v, i) => ({
      id: 'mapping-' + i,
      eventName: 'Start-' + i,
      versionId: v.id,
      control: 'start' as const,
      actionId: 'action-1',
    }));
    s.service.reviewMappings(mappings);
    s.service.approveMappings(s.service.view().mappingReview!.digest);
    finished(s, first, 'first-round');
    finished(s, second, 'second-round');
    let release!: () => void;
    vi.mocked(s.bot.invoke).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = s.service.observe();
    await vi.waitFor(() => expect(s.bot.invoke).toHaveBeenCalledTimes(1));
    if (change === 'mapping') {
      s.service.reviewMappings(mappings);
      s.service.approveMappings(s.service.view().mappingReview!.digest);
    } else if (change === 'panic') s.block();
    else await connect(s, change);
    release();
    await pending;
    expect(s.bot.invoke).toHaveBeenCalledTimes(change === 'obs' ? 2 : 1);
    if (change === 'obs') expect(s.service.view().mappings).toHaveLength(2);
  },
);

const signal = (id: string, eventName = 'Start', at = 100000) => ({
  eventName,
  args: { riff: { eventId: id, causalId: id, origin: 'external', hops: 0, at } },
});

it.each(['connection loss', 'disconnect'] as const)(
  'keeps the sealed rollback snapshot across OBS %s and restores the original after reconnect',
  async (cause) => {
    const s = setup();
    await connect(s, 'obs');
    const original = { url: 'https://riff.example/overlay/?key=private-overlay-key', css: 'x' };
    s.inputs.set('Riff', original);
    await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
    const hash = s.service.view().obsReview!.digest;
    await s.service.applyObs(hash);
    if (cause === 'disconnect') s.service.disconnect('obs');
    else s.loseObs();
    expect(s.service.view().obsReview?.status).toBe('test');
    await connect(s, 'obs');
    await expect(s.service.confirmObs(hash)).rejects.toThrow(/stale/i);
    await expect(s.service.applyObs(hash)).rejects.toThrow(/stale/i);
    await s.service.rollbackObs(hash);
    expect(s.inputs.get('Riff')).toEqual(original);
    expect(s.service.view().obsReview?.status).toBe('rolled-back');
  },
);
it('still refuses rollback after reconnect when the source changed outside Riff', async () => {
  const s = setup();
  await connect(s, 'obs');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  const hash = s.service.view().obsReview!.digest;
  await s.service.applyObs(hash);
  s.loseObs();
  s.inputs.set('Riff', { url: 'https://unrelated.example' });
  await connect(s, 'obs');
  await expect(s.service.rollbackObs(hash)).rejects.toThrow(/changed outside/);
  expect(s.inputs.get('Riff')).toEqual({ url: 'https://unrelated.example' });
});
it('re-reviews the owned diagnostic source after an OBS reconnect', async () => {
  const s = setup();
  await connect(s, 'obs');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  await s.service.applyObs(s.service.view().obsReview!.digest);
  s.loseObs();
  await connect(s, 'obs');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1280, height: 720 });
  expect(s.service.view().obsReview).toMatchObject({ status: 'review', operation: 'update' });
});
it('drops an unapplied OBS review on connection loss', async () => {
  const s = setup();
  await connect(s, 'obs');
  await s.service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  s.loseObs();
  expect(s.service.view().obsReview).toBeNull();
  expect(s.service.view().connections.obs.reason).toMatch(/Connection lost/);
});

it('stages mapping reviews without disabling live mappings until approval', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  const live = {
    id: 'a',
    eventName: 'Start',
    versionId: v.id,
    control: 'start' as const,
    actionId: null,
  };
  s.service.reviewMappings([live]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  s.service.reviewMappings([{ ...live, id: 'b', eventName: 'Pause', control: 'pause' }]);
  expect(s.service.view().mappings).toEqual([live]);
  await s.service.receive(signal('during-review'));
  expect(s.control).toHaveBeenCalledWith(v.id, 'start');
  s.service.importConfiguration({ format: 'firebot', scripts: ['never'] });
  expect(s.service.view().mappings).toEqual([live]);
  s.service.importConfiguration({
    format: 'riff-production',
    version: 1,
    mappings: [{ ...live, id: 'b', eventName: 'Pause', control: 'pause' }],
  });
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  expect(s.service.view().mappings.map((m) => m.id)).toEqual(['b']);
});
it('discards a pending mapping review by digest without touching approved mappings', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  const live = {
    id: 'a',
    eventName: 'Start',
    versionId: v.id,
    control: 'start' as const,
    actionId: null,
  };
  s.service.reviewMappings([live]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  s.service.reviewMappings([]);
  const hash = s.service.view().mappingReview!.digest;
  expect(() => s.service.discardMappings('0'.repeat(64))).toThrow(/stale|changed/i);
  s.service.discardMappings(hash);
  expect(s.service.view().mappingReview).toBeNull();
  expect(s.service.view().mappings).toEqual([live]);
  expect(() => s.service.approveMappings(hash)).toThrow();
});
it('describes added, removed and changed mappings against the approved set', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  const a = {
      id: 'a',
      eventName: 'Start',
      versionId: v.id,
      control: 'start' as const,
      actionId: null,
    },
    gone = { ...a, id: 'gone', eventName: 'Old' };
  s.service.reviewMappings([a, gone]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  s.service.importConfiguration({
    format: 'riff-production',
    version: 1,
    mappings: [
      { ...a, control: 'pause', actionId: 'action-1' },
      { ...a, id: 'new', eventName: 'Fresh' },
    ],
  });
  const differences = s.service.view().mappingReview!.differences.join('\n');
  expect(differences).toMatch(/Add "Fresh"/);
  expect(differences).toMatch(/Remove "Old"/);
  expect(differences).toMatch(/Change "Start".*start → pause/);
  expect(differences).toMatch(/Celebrate/);
  expect(differences).not.toMatch(/Start" →|undefined/);
});
it('reports per-mapping problems for a valid document naming a non-current version', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  const stale = '00000000-0000-4000-8000-000000000000';
  s.service.importConfiguration({
    format: 'riff-production',
    version: 1,
    mappings: [
      { id: 'ok', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
      { id: 'old', eventName: 'Old', versionId: stale, control: 'start', actionId: null },
      { id: 'act', eventName: 'Act', versionId: v.id, control: 'pause', actionId: 'missing' },
    ],
  });
  const review = s.service.view().mappingReview!;
  expect(review.mappings).toHaveLength(3);
  expect(review.unsupported).toHaveLength(2);
  expect(review.unsupported[0]).toMatch(/"old".*current/);
  expect(review.unsupported[1]).toMatch(/"act".*missing/);
  expect(() => s.service.approveMappings(review.digest)).toThrow();
});
it('explains what is wrong with a riff-production document that fails the schema', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  const many = Array.from({ length: 21 }, (_, i) => ({
    id: 'm' + i,
    eventName: 'E' + i,
    versionId: v.id,
    control: 'start',
    actionId: null,
  }));
  s.service.importConfiguration({ format: 'riff-production', version: 1, mappings: many });
  let text = s.service.view().mappingReview!.unsupported.join(' ');
  expect(text).toMatch(/21 mappings.*20/);
  expect(text).not.toMatch(/native/i);
  s.service.importConfiguration({ format: 'riff-production', version: 2, mappings: [] });
  text = s.service.view().mappingReview!.unsupported.join(' ');
  expect(text).toMatch(/version 2/);
  s.service.importConfiguration({
    format: 'riff-production',
    version: 1,
    mappings: [],
    scripts: ['x'],
  });
  text = s.service.view().mappingReview!.unsupported.join(' ');
  expect(text).toMatch(/"scripts".*not executed/);
});

it('applies mapped bot events while an OBS operation is in flight', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'obs');
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    { id: 'a', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  let release!: (value: null) => void;
  vi.mocked(s.obs.input).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const reviewing = s.service.reviewObs({
    sceneName: 'Main',
    inputName: 'Riff',
    width: 1920,
    height: 1080,
  });
  await vi.waitFor(() => expect(s.obs.input).toHaveBeenCalled());
  await s.service.receive(signal('while-obs-busy'));
  expect(s.control).toHaveBeenCalledWith(v.id, 'start');
  release(null);
  await reviewing;
});
it('records rejected events in recent with a human-readable reason', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    { id: 'a', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  s.control.mockImplementation(() => new Promise(() => {}));
  for (let i = 0; i < 16; i++) void s.service.receive(signal('pending-' + i));
  await vi.waitFor(() => expect(s.control).toHaveBeenCalledTimes(16));
  await s.service.receive(signal('overflow'));
  expect(s.service.view().recent[0]!.message).toMatch(/"Start".*pending/);
  await s.service.receive(signal('unmapped', 'Unknown'));
  expect(s.service.view().recent[0]!.message).toMatch(/"Unknown".*no approved mapping/);
  s.advance(300000);
  await s.service.receive(signal('old'));
  expect(s.service.view().recent[0]!.message).toMatch(/"Start".*old/);
  await s.service.receive({ eventName: 'Start', args: {} });
  expect(s.service.view().recent[0]!.message).toMatch(/metadata/);
});
it('describes accepted events with the event name and pinned version', async () => {
  const s = setup(),
    v = active(s);
  await connect(s, 'streamerbot');
  s.service.reviewMappings([
    { id: 'a', eventName: 'Start', versionId: v.id, control: 'start', actionId: null },
  ]);
  s.service.approveMappings(s.service.view().mappingReview!.digest);
  await s.service.receive(signal('accepted'));
  expect(s.service.view().recent[0]).toMatchObject({ code: 'ACCEPTED' });
  expect(s.service.view().recent[0]!.message).toMatch(/"Start".*start.*"Test"/);
});

it('never persists connection passwords and scrubs legacy stored credentials', async () => {
  const s = setup();
  await connect(s, 'obs');
  await connect(s, 'streamerbot');
  const row = () =>
    JSON.parse(
      (s.db.client.prepare('select value from production_state').get() as { value: string }).value,
    ) as Record<string, unknown>;
  expect(row().credentials).toBeUndefined();
  s.db.client
    .prepare('update production_state set value = ?')
    .run(JSON.stringify({ ...row(), credentials: { obs: 'legacy-sealed-blob' } }));
  const restarted = createProductionService({
    database: s.db,
    repo: s.repo,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => 'https://riff.example/overlay/',
    blocked: () => false,
    control: () => {},
  });
  dispose.unshift(() => restarted.close());
  expect(row().credentials).toBeUndefined();
});

it('filters oversized discovery entries instead of refusing the connection', async () => {
  const s = setup();
  vi.mocked(s.obs.scenes).mockResolvedValue([
    'Main',
    'x'.repeat(121),
    ...Array.from({ length: 205 }, (_, i) => 'Scene ' + i),
  ]);
  await connect(s, 'obs');
  const obs = s.service.view().connections.obs;
  expect(obs.status).toBe('connected');
  expect(obs.scenes).toHaveLength(200);
  expect(obs.scenes[0]).toBe('Main');
  expect(obs.reason).toMatch(/7 scenes/);
  vi.mocked(s.bot.actions).mockResolvedValue([
    { id: 'action-1', name: 'Celebrate', enabled: true },
    { id: 'long', name: 'y'.repeat(200), enabled: true },
  ]);
  await connect(s, 'streamerbot');
  const bot = s.service.view().connections.streamerbot;
  expect(bot.actions).toEqual([{ id: 'action-1', name: 'Celebrate', enabled: true }]);
  expect(bot.reason).toMatch(/1 action/);
});
it('shows the adapter explanation when a connection is refused', async () => {
  const s = setup();
  const { ToolRefusal } = await import('../src/services/production/contract.js');
  vi.mocked(s.obs.connect).mockRejectedValueOnce(
    new ToolRefusal('OBS WebSocket authentication is disabled. Enable it, then reconnect.'),
  );
  await expect(connect(s, 'obs')).rejects.toThrow(/authentication is disabled/);
  expect(s.service.view().connections.obs.reason).toMatch(/authentication is disabled/);
});
