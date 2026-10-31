import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChannelRepository } from '../db/repositories/studio.js';
import type { Hub } from '../services/hub.js';
import type { OverlayBroker } from '../services/overlay/broker.js';
import type { TwitchConnection } from '../services/twitch/connection.js';
import { isSameOrigin } from './guard.js';

const keyMatches = (expected: string, given: string) =>
  expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));

/** Console push (same-origin) and read-only overlay sockets (bearer key in the URL). */
export function registerRealtimeRoutes(
  app: FastifyInstance,
  deps: { hub: Hub; overlay: OverlayBroker; repo: ChannelRepository; twitch: TwitchConnection },
) {
  app.get('/ws/console', { websocket: true }, (socket, request) => {
    if (!isSameOrigin(request)) {
      socket.close(4003, 'Use the Riff console');
      return;
    }
    const unsubscribe = deps.hub.subscribe((message) => socket.send(JSON.stringify(message)));
    socket.send(JSON.stringify({ v: 1, type: 'twitch', payload: deps.twitch.status }));
    socket.on('close', unsubscribe);
    // The console never sends commands over this socket; mutations use guarded HTTP.
    socket.on('message', () => undefined);
  });
  app.get('/ws/overlay', { websocket: true }, (socket, request) => {
    const query = z.object({ key: z.string().max(64) }).safeParse(request.query);
    if (!query.success || !keyMatches(deps.repo.state().overlayKey, query.data.key)) {
      socket.close(4001, 'Invalid overlay key');
      return;
    }
    deps.overlay.attach(socket, deps.repo.channelId);
    deps.hub.publish('studio', null);
    socket.on('close', () => {
      deps.overlay.detach(socket);
      deps.hub.publish('studio', null);
    });
    // Overlay sockets are read-only: anything received is ignored.
    socket.on('message', () => undefined);
  });
}
