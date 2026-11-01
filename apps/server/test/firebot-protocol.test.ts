import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { createFirebotTransport } from '../src/adapters/firebot/client.js';
import { ToolRefusal } from '../src/services/production/contract.js';

/**
 * Minimal in-process Firebot v5 server: the documented /api/v1 HTTP routes and the
 * root WebSocket (`invoke subscribe-events` → `response success`, then `event` frames).
 * Shapes mirror crowbartools/Firebot src/server (checked November 1, 2026).
 */
const servers: { http: Server; ws: WebSocketServer }[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      ({ http, ws }) =>
        new Promise<void>((resolve) => {
          for (const client of ws.clients) client.terminate();
          ws.close();
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    ),
  );
});

async function firebotServer(
  options: { status?: unknown; subscribe?: 'ok' | 'error' | 'silent' } = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let socket: WebSocket | null = null;
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      calls.push({ method: req.method ?? '', path, body: raw ? JSON.parse(raw) : null });
      const json = (code: number, value: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (path === '/api/v1/status')
        return json(200, options.status ?? { connections: { chat: true } });
      if (path === '/api/v1/effects/preset')
        return json(200, [
          { id: 'preset-confetti', name: 'Confetti', args: ['winner'] },
          { id: 'preset-scene', name: 'Scene swap', args: [] },
        ]);
      if (path === '/api/v1/custom-variables')
        return json(200, { riffRound: { t: 0, v: 'idle' }, otherVar: { t: 0, v: 1 } });
      if (path === '/api/v1/commands/custom')
        return json(200, [{ id: 'cmd-1', trigger: '!tomato', description: 'Throw' }]);
      if (path.startsWith('/api/v1/effects/preset/') && req.method === 'POST')
        return json(200, { status: 'success' });
      if (path.startsWith('/api/v1/custom-variables/') && req.method === 'POST')
        return json(201, undefined);
      json(404, { status: 'error', message: 'not found' });
    });
  });
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', (client: WebSocket) => {
    socket = client;
    client.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { type: string; id: string; name: string };
      if (message.type !== 'invoke' || message.name !== 'subscribe-events') return;
      if (options.subscribe === 'silent') return;
      client.send(
        JSON.stringify({
          type: 'response',
          id: message.id,
          name: options.subscribe === 'error' ? 'error' : 'success',
          data: null,
        }),
      );
    });
  });
  servers.push({ http, ws });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    emit: (name: string, data: unknown) =>
      socket?.send(JSON.stringify({ type: 'event', name, data })),
    drop: () => socket?.terminate(),
  };
}

const KEY = 'synthetic-firebot-event-key';

it('discovers presets, variables and commands then invokes only discovered actions', async () => {
  const fb = await firebotServer();
  const client = createFirebotTransport(vi.fn(), vi.fn());
  await client.connect(fb.url, KEY);
  const actions = await client.actions();
  expect(actions).toEqual([
    { id: 'preset:preset-confetti', name: 'Run preset “Confetti”', enabled: true },
    { id: 'preset:preset-scene', name: 'Run preset “Scene swap”', enabled: true },
    { id: 'variable:riffRound', name: 'Set variable “riffRound”', enabled: true },
    { id: 'variable:otherVar', name: 'Set variable “otherVar”', enabled: true },
  ]);
  expect(await client.commands!()).toEqual([{ id: 'cmd-1', trigger: '!tomato' }]);

  const riff = { eventId: 'e1', causalId: 'c1', origin: 'riff-origin', hops: 1, at: 123 };
  await client.invoke('preset:preset-confetti', { riff });
  const preset = fb.calls.find((c) => c.path === '/api/v1/effects/preset/preset-confetti/run');
  expect(preset?.method).toBe('POST');
  expect(preset?.body).toEqual({
    username: 'Riff',
    args: {
      riffEventId: 'e1',
      riffCausalId: 'c1',
      riffOrigin: 'riff-origin',
      riffHops: 1,
      riffAt: 123,
    },
  });
  await client.invoke('variable:riffRound', { riff });
  const variable = fb.calls.find((c) => c.path === '/api/v1/custom-variables/riffRound');
  expect(variable?.body).toEqual({ data: { riff }, ttl: 0 });

  // Allowlist: nothing outside discovery, and no generic request surface.
  await expect(client.invoke('preset:never-listed', { riff })).rejects.toBeInstanceOf(ToolRefusal);
  await expect(client.invoke('/api/v1/viewers', { riff })).rejects.toBeInstanceOf(ToolRefusal);
  expect(fb.calls.some((c) => c.path.includes('never-listed') || c.path.includes('viewers'))).toBe(
    false,
  );
  client.disconnect();
});

it('subscribes to events and forwards only key-authenticated custom events', async () => {
  const fb = await firebotServer();
  const event = vi.fn();
  const client = createFirebotTransport(event, vi.fn());
  await client.connect(fb.url, KEY);
  fb.emit('custom-event:Start challenge', {
    riff: {
      eventId: 'one',
      causalId: 'cause',
      origin: 'firebot',
      hops: '0',
      // `$unixTimestamp` in Firebot is epoch seconds; quoted text is also accepted.
      at: '1793550000',
      key: KEY,
    },
  });
  fb.emit('custom-event:Start challenge', {
    riff: { eventId: 'two', causalId: 'cause2', origin: 'firebot', hops: 0, at: 1, key: 'wrong' },
  });
  fb.emit('custom-variable:updated', { name: 'x' });
  await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(2));
  // Seconds are normalized to epoch milliseconds; the key never leaves the adapter.
  expect(event).toHaveBeenNthCalledWith(1, {
    eventName: 'Start challenge',
    args: {
      riff: { eventId: 'one', causalId: 'cause', origin: 'firebot', hops: 0, at: 1793550000000 },
    },
  });
  expect(event).toHaveBeenNthCalledWith(2, { eventName: 'Start challenge', unauthenticated: true });
  client.disconnect();
});

it('reports a closed socket so the service can fence the connector', async () => {
  const fb = await firebotServer();
  const onClose = vi.fn();
  const client = createFirebotTransport(vi.fn(), onClose);
  await client.connect(fb.url, KEY);
  fb.drop();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  await expect(client.invoke('preset:preset-confetti', {})).rejects.toBeInstanceOf(ToolRefusal);
});

it('refuses a server that is not Firebot or refuses the event subscription', async () => {
  const notFirebot = await firebotServer({ status: { hello: 'world' } });
  await expect(
    createFirebotTransport(vi.fn(), vi.fn()).connect(notFirebot.url, KEY),
  ).rejects.toThrow(/Firebot/);
  const refused = await firebotServer({ subscribe: 'error' });
  await expect(createFirebotTransport(vi.fn(), vi.fn()).connect(refused.url, KEY)).rejects.toThrow(
    /event/i,
  );
});
