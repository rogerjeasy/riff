import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const doubles = vi.hoisted(() => ({
  // Mirrors obs-websocket-js 5.x: the Hello (with `authentication`) is emitted as an
  // event, and connect() resolves with Hello+Identified data WITHOUT `authentication`.
  hello: { rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } } as Record<
    string,
    unknown
  >,
  obsConnect: vi.fn(),
  obsDisconnect: vi.fn(async () => {}),
  obsCall: vi.fn(),
  wsSent: [] as Record<string, unknown>[],
  authentication: true,
  socket: null as null | { emit: (type: string, data?: unknown) => void },
}));
vi.mock('obs-websocket-js', () => ({
  OBSWebSocket: class {
    listeners = new Map<string, { fn: (data: unknown) => void; once: boolean }[]>();
    on(type: string, fn: (data: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, once: false }]);
      return this;
    }
    once(type: string, fn: (data: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, once: true }]);
      return this;
    }
    off(type: string, fn: (data: unknown) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn),
      );
      return this;
    }
    emit(type: string, data: unknown) {
      const current = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        current.filter((l) => !l.once),
      );
      for (const l of current) l.fn(data);
    }
    async connect(...args: unknown[]) {
      await doubles.obsConnect(...args);
      this.emit('Hello', doubles.hello);
      const rest = { ...doubles.hello };
      delete rest.authentication;
      return { ...rest, negotiatedRpcVersion: 1 };
    }
    disconnect = doubles.obsDisconnect;
    call = doubles.obsCall;
  },
}));
vi.mock('ws', () => ({
  default: class {
    static OPEN = 1;
    readyState = 1;
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    constructor() {
      doubles.socket = this;
      queueMicrotask(() =>
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              request: 'Hello',
              ...(doubles.authentication
                ? { authentication: { salt: 'salt', challenge: 'challenge' } }
                : {}),
            }),
          ),
        ),
      );
    }
    on(type: string, fn: (...args: unknown[]) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
      return this;
    }
    emit(type: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(type) ?? []) fn(...args);
    }
    send(data: string, callback: (error?: Error) => void) {
      const packet = JSON.parse(data) as Record<string, unknown>;
      doubles.wsSent.push(packet);
      callback();
      queueMicrotask(() =>
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              id: packet.id,
              status: 'ok',
              ...(packet.request === 'GetActions'
                ? { actions: [{ id: 'one', name: 'Selected action', enabled: true }] }
                : {}),
            }),
          ),
        ),
      );
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
    terminate() {
      this.close();
    }
  },
}));
import { createObsTransport } from '../src/adapters/obs/client.js';
import { createBotTransport } from '../src/adapters/streamer-bot/client.js';
const closes: (() => void)[] = [];
afterEach(() => {
  closes.splice(0).forEach((f) => f());
  vi.clearAllMocks();
  doubles.wsSent = [];
  doubles.authentication = true;
  doubles.hello = { rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } };
});
it('authenticates bot with the documented challenge and subscribes only to custom events', async () => {
  const event = vi.fn(),
    client = createBotTransport(event, () => {});
  closes.push(() => client.disconnect());
  await client.connect('ws://127.0.0.1:8080', 'synthetic-password');
  const secret = createHash('sha256').update('synthetic-passwordsalt').digest('base64');
  expect(doubles.wsSent[0]).toMatchObject({
    request: 'Authenticate',
    authentication: createHash('sha256')
      .update(secret + 'challenge')
      .digest('base64'),
  });
  expect(doubles.wsSent[1]).toMatchObject({ request: 'Subscribe', events: { Custom: ['Event'] } });
  expect(await client.actions()).toEqual([{ id: 'one', name: 'Selected action', enabled: true }]);
  doubles.socket!.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        event: { source: 'Custom', type: 'Event' },
        data: { eventName: 'Start', args: {} },
      }),
    ),
  );
  expect(event).toHaveBeenCalledWith({ eventName: 'Start', args: {} });
  doubles.socket!.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        event: { source: 'Twitch', type: 'ChatMessage' },
        data: { text: 'ignored' },
      }),
    ),
  );
  expect(event).toHaveBeenCalledTimes(1);
  await client.invoke('one', { riff: { origin: 'host' } });
  expect(doubles.wsSent.at(-1)).toMatchObject({
    request: 'DoAction',
    action: { id: 'one' },
    args: { riff: { origin: 'host' } },
  });
});
it('refuses unauthenticated bot servers before subscribing or invoking actions', async () => {
  doubles.authentication = false;
  const client = createBotTransport(
    () => {},
    () => {},
  );
  closes.push(() => client.disconnect());
  await expect(client.connect('ws://127.0.0.1:8080', 'synthetic-password')).rejects.toThrow(
    /authenticate/,
  );
  expect(doubles.wsSent).toEqual([]);
});
it('requires authenticated OBS RPC1 and creates only a browser source', async () => {
  const client = createObsTransport(() => {});
  await client.connect('ws://127.0.0.1:4455', 'synthetic-password');
  expect(doubles.obsConnect).toHaveBeenCalledWith('ws://127.0.0.1:4455', 'synthetic-password', {
    rpcVersion: 1,
    eventSubscriptions: 0,
  });
  await client.write(
    'Main',
    'Riff',
    { url: 'https://riff.example/production-test', width: 1920, height: 1080 },
    true,
  );
  expect(doubles.obsCall).toHaveBeenCalledWith('CreateInput', {
    sceneName: 'Main',
    inputName: 'Riff',
    inputKind: 'browser_source',
    inputSettings: { url: 'https://riff.example/production-test', width: 1920, height: 1080 },
    sceneItemEnabled: true,
  });
});
it('refuses OBS servers whose Hello does not require authentication', async () => {
  doubles.hello = { rpcVersion: 1 };
  const client = createObsTransport(() => {});
  await expect(client.connect('ws://127.0.0.1:4455', 'synthetic-password')).rejects.toThrow(
    /authentication/i,
  );
  expect(doubles.obsDisconnect).toHaveBeenCalled();
});
it('refuses an input also referenced by an unselected scene', async () => {
  doubles.obsCall.mockImplementation(async (name: string) => {
    if (name === 'GetSceneList')
      return { scenes: [{ sceneName: 'Main' }, { sceneName: 'Private' }] };
    if (name === 'GetSceneItemList')
      return { sceneItems: [{ sourceName: 'Riff', sceneItemId: 1 }] };
    return {
      inputKind: 'browser_source',
      inputSettings: { url: 'https://riff.example/overlay/', width: 1920, height: 1080 },
    };
  });
  const client = createObsTransport(() => {});
  await expect(client.input('Main', 'Riff')).rejects.toThrow(/another scene/);
});
it('rollback removes only the reviewed scene item, never a global source', async () => {
  doubles.obsCall.mockResolvedValue({ sceneItems: [{ sourceName: 'Riff', sceneItemId: 7 }] });
  const client = createObsTransport(() => {});
  await client.remove('Main', 'Riff');
  expect(doubles.obsCall).toHaveBeenCalledWith('RemoveSceneItem', {
    sceneName: 'Main',
    sceneItemId: 7,
  });
  expect(doubles.obsCall).not.toHaveBeenCalledWith('RemoveInput', expect.anything());
});
it('restores an accepted sparse original OBS snapshot through the real adapter after setup', async () => {
  const { openDatabase } = await import('../src/db/client.js');
  const { forChannel } = await import('../src/db/repositories/studio.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const { fileURLToPath } = await import('node:url');
  const { createProductionService } = await import('../src/services/production/service.js');
  const database = openDatabase(':memory:');
  migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(database, 'restore');
  repo.ensure('Restore');
  const original = { url: 'https://riff.example/overlay/?key=owned-overlay' };
  let settings: Record<string, unknown> = { ...original };
  doubles.obsCall.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'GetSceneList') return { scenes: [{ sceneName: 'Main' }] };
    if (name === 'GetSceneItemList')
      return { sceneItems: [{ sourceName: 'Riff', sceneItemId: 1 }] };
    if (name === 'GetInputSettings')
      return { inputKind: 'browser_source', inputSettings: structuredClone(settings) };
    if (name === 'SetInputSettings') {
      settings = structuredClone(args.inputSettings as Record<string, unknown>);
      return {};
    }
    throw Error('Unexpected OBS operation');
  });
  const service = createProductionService({
    database,
    repo,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => original.url,
    blocked: () => false,
    control: () => {},
    obsFactory: createObsTransport,
  });
  closes.push(() => {
    service.close();
    database.close();
  });
  await service.connect({
    kind: 'obs',
    url: 'ws://127.0.0.1:4455',
    password: 'synthetic-password',
    discover: true,
  });
  await service.reviewObs({ sceneName: 'Main', inputName: 'Riff', width: 1920, height: 1080 });
  const hash = service.view().obsReview!.digest;
  expect(service.view().obsReview?.before).toMatchObject({ width: null, height: null });
  await service.applyObs(hash);
  expect(settings.url).toContain('/production-test');
  await service.rollbackObs(hash);
  expect(settings).toEqual(original);
  expect(doubles.obsCall).toHaveBeenLastCalledWith('SetInputSettings', {
    inputName: 'Riff',
    inputSettings: original,
    overlay: false,
  });
});
