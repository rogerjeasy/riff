import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createEventSubClient, type EventSubClient } from '../src/eventsub.js';
import { messages } from './support.js';

let server: WebSocketServer | undefined;
let client: EventSubClient | undefined;

afterEach(async () => {
  client?.stop();
  if (server) {
    for (const socket of server.clients) socket.terminate();
    server.close();
    await once(server, 'close');
  }
  server = undefined;
  client = undefined;
});

it('drives the default ws transport against a local mock server', async () => {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.on('connection', (socket) => {
    socket.send(JSON.stringify(messages.welcome('local-session', 600)));
    socket.send(JSON.stringify(messages.chatNotification('local-delivery')));
  });

  const received = new Promise<{ sessionId: string; messageId: string }>((resolve) => {
    let sessionId = '';
    client = createEventSubClient({
      url: `ws://127.0.0.1:${port}/ws`,
      onWelcome: (id) => {
        sessionId = id;
      },
      onNotification: (n) => resolve({ sessionId, messageId: n.messageId }),
      onRevocation: () => undefined,
    });
    client.start();
  });

  await expect(received).resolves.toEqual({
    sessionId: 'local-session',
    messageId: 'local-delivery',
  });
});
