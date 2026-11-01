import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { createObsTransport } from '../src/adapters/obs/client.js';
import { createBotTransport } from '../src/adapters/streamer-bot/client.js';

// obs-websocket-js resolves its msgpack build under Node (the `import`/`require`
// export conditions), so the fake server speaks `obswebsocket.msgpack` using the
// exact codec the library ships with.
const require = createRequire(import.meta.url);
const msgpack = createRequire(require.resolve('obs-websocket-js'))('@msgpack/msgpack') as {
  encode: (value: unknown) => Uint8Array;
  decode: (value: Uint8Array) => unknown;
};

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(options: ConstructorParameters<typeof WebSocketServer>[0] = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}
const sha = (value: string) => createHash('sha256').update(value).digest('base64');
const expectedAuth = (password: string, salt: string, challenge: string) =>
  sha(sha(password + salt) + challenge);

/** Minimal obs-websocket v5 server: Hello (op 0) → Identify (1) → Identified (2) → Requests (6/7). */
async function obsServer(options: { password: string | null }) {
  const salt = 'synthetic-salt',
    challenge = 'synthetic-challenge';
  const seen: { op: number; d: Record<string, unknown> }[] = [];
  const { server, port } = await listen({
    handleProtocols: (protocols) =>
      protocols.has('obswebsocket.msgpack') ? 'obswebsocket.msgpack' : false,
  });
  server.on('connection', (socket: WebSocket) => {
    const send = (op: number, d: Record<string, unknown>) =>
      socket.send(Buffer.from(msgpack.encode({ op, d })));
    send(0, {
      obsWebSocketVersion: '5.5.0',
      rpcVersion: 1,
      ...(options.password ? { authentication: { salt, challenge } } : {}),
    });
    let identified = false;
    socket.on('message', (data: Buffer) => {
      const message = msgpack.decode(new Uint8Array(data)) as {
        op: number;
        d: Record<string, unknown>;
      };
      seen.push(message);
      if (message.op === 1) {
        if (
          options.password &&
          message.d.authentication !== expectedAuth(options.password, salt, challenge)
        ) {
          socket.close(4009, 'Authentication failed.');
          return;
        }
        identified = true;
        send(2, { negotiatedRpcVersion: 1 });
        return;
      }
      if (message.op === 6 && identified) {
        const { requestId, requestType } = message.d as { requestId: string; requestType: string };
        send(7, {
          requestType,
          requestId,
          requestStatus: { result: requestType === 'GetSceneList', code: 100 },
          responseData:
            requestType === 'GetSceneList'
              ? { scenes: [{ sceneName: 'Main', sceneIndex: 0 }, { sceneName: 'Be right back' }] }
              : undefined,
        });
      }
    });
  });
  return { url: `ws://127.0.0.1:${port}`, seen, salt, challenge };
}

it('authenticates the real OBS client against an obs-websocket v5 server and discovers scenes', async () => {
  const obs = await obsServer({ password: 'synthetic-obs-password' });
  const onClose = vi.fn();
  const client = createObsTransport(onClose);
  await client.connect(obs.url, 'synthetic-obs-password');
  const identify = obs.seen.find((m) => m.op === 1);
  expect(identify?.d).toEqual({
    rpcVersion: 1,
    eventSubscriptions: 0,
    authentication: expectedAuth('synthetic-obs-password', obs.salt, obs.challenge),
  });
  expect(await client.scenes()).toEqual(['Main', 'Be right back']);
  client.disconnect();
});

it('refuses an OBS server with authentication disabled', async () => {
  const obs = await obsServer({ password: null });
  const client = createObsTransport(() => {});
  await expect(client.connect(obs.url, 'synthetic-obs-password')).rejects.toThrow(
    /authentication/i,
  );
});

it('reports a rejected OBS password in plain language', async () => {
  const obs = await obsServer({ password: 'the-real-password' });
  const client = createObsTransport(() => {});
  await expect(client.connect(obs.url, 'wrong-password')).rejects.toThrow(/password/i);
});

/** Minimal Streamer.bot WebSocket server (Hello → Authenticate → Subscribe → requests). */
async function botServer(password: string) {
  const salt = 'bot-salt',
    challenge = 'bot-challenge';
  const seen: Record<string, unknown>[] = [];
  const { server, port } = await listen();
  let socket: WebSocket | null = null;
  server.on('connection', (ws: WebSocket) => {
    socket = ws;
    let authenticated = false;
    ws.send(
      JSON.stringify({
        timestamp: '2026-11-01T00:00:00Z',
        session: 'synthetic-session',
        request: 'Hello',
        info: { name: 'Streamer.bot', version: '0.2.5' },
        authentication: { salt, challenge },
      }),
    );
    ws.on('message', (data: Buffer) => {
      const packet = JSON.parse(data.toString()) as Record<string, unknown>;
      seen.push(packet);
      const reply = (fields: Record<string, unknown> = {}) =>
        ws.send(JSON.stringify({ id: packet.id, status: 'ok', ...fields }));
      if (packet.request === 'Authenticate') {
        authenticated = packet.authentication === expectedAuth(password, salt, challenge);
        if (authenticated) reply();
        else ws.send(JSON.stringify({ id: packet.id, status: 'error', error: 'Bad auth' }));
        return;
      }
      if (!authenticated) {
        ws.close();
        return;
      }
      if (packet.request === 'GetActions')
        reply({
          actions: [
            { id: 'celebrate', name: 'Celebrate', enabled: true, group: '', subactions_count: 1 },
          ],
          count: 1,
        });
      else reply();
    });
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    seen,
    emit: (packet: unknown) => socket?.send(JSON.stringify(packet)),
  };
}

it('authenticates the real Streamer.bot client, subscribes, lists, invokes and receives custom events', async () => {
  const bot = await botServer('synthetic-bot-password');
  const event = vi.fn();
  const client = createBotTransport(event, () => {});
  await client.connect(bot.url, 'synthetic-bot-password');
  expect(bot.seen[0]).toMatchObject({
    request: 'Authenticate',
    authentication: expectedAuth('synthetic-bot-password', 'bot-salt', 'bot-challenge'),
  });
  expect(bot.seen[1]).toMatchObject({ request: 'Subscribe', events: { Custom: ['Event'] } });
  expect(await client.actions()).toEqual([{ id: 'celebrate', name: 'Celebrate', enabled: true }]);
  await client.invoke('celebrate', { riff: { origin: 'host' } });
  expect(bot.seen.at(-1)).toMatchObject({
    request: 'DoAction',
    action: { id: 'celebrate' },
    args: { riff: { origin: 'host' } },
  });
  bot.emit({ timestamp: 't', event: { source: 'Twitch', type: 'ChatMessage' }, data: {} });
  bot.emit({
    timestamp: 't',
    event: { source: 'Custom', type: 'Event' },
    data: { eventName: 'Start', args: { riff: { eventId: 'e' } } },
  });
  await vi.waitFor(() =>
    expect(event).toHaveBeenCalledWith({ eventName: 'Start', args: { riff: { eventId: 'e' } } }),
  );
  expect(event).toHaveBeenCalledTimes(1);
  client.disconnect();
});

it('refuses a Streamer.bot password the server rejects', async () => {
  const bot = await botServer('the-real-password');
  const client = createBotTransport(
    () => {},
    () => {},
  );
  await expect(client.connect(bot.url, 'wrong-password')).rejects.toThrow(/authenticate/i);
  expect(bot.seen.some((p) => p.request === 'Subscribe')).toBe(false);
});
