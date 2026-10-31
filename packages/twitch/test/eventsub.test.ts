import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEDUPE_WINDOW_MS,
  EVENTSUB_WEBSOCKET_URL,
  createEventSubClient,
  type EventSubClientOptions,
  type EventSubNotification,
  type EventSubRevocation,
  type EventSubState,
  type EventSubStateDetail,
} from '../src/eventsub.js';
import { normalizeChatMessage } from '../src/normalize.js';
import { FakeClock, fakeWebSocket, messages, type FakeSocket } from './support.js';

function setup(overrides: Partial<EventSubClientOptions> = {}) {
  const clock = new FakeClock();
  const { Socket, sockets } = fakeWebSocket();
  const welcomes: string[] = [];
  const notifications: EventSubNotification[] = [];
  const revocations: EventSubRevocation[] = [];
  const states: [EventSubState, EventSubStateDetail | undefined][] = [];
  const errors: unknown[] = [];
  const client = createEventSubClient({
    WebSocket: Socket,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.5,
    onWelcome: (id) => {
      welcomes.push(id);
    },
    onNotification: (n) => notifications.push(n),
    onRevocation: (r) => revocations.push(r),
    onState: (state, detail) => states.push([state, detail]),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  const socket = (index: number): FakeSocket => {
    const found = sockets[index];
    if (!found) throw new Error(`no socket ${index}`);
    return found;
  };
  return { clock, sockets, socket, client, welcomes, notifications, revocations, states, errors };
}

describe('EventSub WebSocket client', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('connects to the documented URL and hands the welcome session id to onWelcome', () => {
    t.client.start();
    expect(t.sockets).toHaveLength(1);
    expect(t.socket(0).url).toBe(EVENTSUB_WEBSOCKET_URL);
    t.socket(0).deliver(messages.welcome('session-1'));
    expect(t.welcomes).toEqual(['session-1']);
    expect(t.client.sessionId).toBe('session-1');
    expect(t.states.map(([state]) => state)).toEqual(['connecting', 'connected']);
    expect(t.states[1]?.[1]).toEqual({ sessionId: 'session-1' });
  });

  it('supports a Twitch CLI mock URL and the keepalive query parameter', () => {
    const local = setup({ url: 'ws://127.0.0.1:8080/ws', keepaliveTimeoutSeconds: 30 });
    local.client.start();
    expect(local.socket(0).url).toBe('ws://127.0.0.1:8080/ws?keepalive_timeout_seconds=30');
  });

  it('expires the watchdog at 1.5x keepalive and reconnects to a fresh session', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1', 10));
    t.clock.advance(14_000);
    t.socket(0).deliver(messages.keepalive()); // resets the 15 s watchdog
    t.clock.advance(14_999);
    expect(t.socket(0).closed).toBe(false);
    t.clock.advance(1);
    expect(t.socket(0).closed).toBe(true);
    expect(t.states.at(-1)).toEqual([
      'reconnecting',
      { reason: 'keepalive_timeout', delayMs: 750, attempt: 1 },
    ]);
    t.clock.advance(750);
    expect(t.sockets).toHaveLength(2);
    expect(t.socket(1).url).toBe(EVENTSUB_WEBSOCKET_URL);
    t.socket(1).deliver(messages.welcome('session-2'));
    expect(t.welcomes).toEqual(['session-1', 'session-2']);
  });

  it('notifications also reset the watchdog', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1', 10));
    t.clock.advance(10_000);
    t.socket(0).deliver(messages.chatNotification());
    t.clock.advance(10_000);
    expect(t.socket(0).closed).toBe(false);
  });

  it('follows session_reconnect: new socket first, old closed only after the new welcome, no new subscriptions', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    // URL from the documented reconnect example, used as is.
    t.socket(0).deliver(messages.reconnect());
    expect(t.sockets).toHaveLength(2);
    expect(t.socket(1).url).toBe('wss://eventsub.wss.twitch.tv?...');
    expect(t.socket(0).closed).toBe(false);
    expect(t.states.at(-1)).toEqual(['reconnecting', { reason: 'session_reconnect' }]);

    // The old connection keeps delivering until the new welcome.
    t.socket(0).deliver(messages.chatNotification('old-1'));
    expect(t.notifications.map((n) => n.messageId)).toEqual(['old-1']);

    t.socket(1).deliver(messages.welcome('session-2'));
    expect(t.socket(0).closed).toBe(true);
    expect(t.socket(1).closed).toBe(false);
    expect(t.welcomes).toEqual(['session-1']);
    expect(t.client.sessionId).toBe('session-2');
    expect(t.states.at(-1)).toEqual(['connected', { sessionId: 'session-2', resumed: true }]);

    t.socket(1).deliver(messages.chatNotification('new-1'));
    expect(t.notifications.map((n) => n.messageId)).toEqual(['old-1', 'new-1']);
    // The old socket's watchdog was cancelled with it.
    t.clock.advance(14_000);
    t.socket(1).deliver(messages.keepalive());
    t.clock.advance(14_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('waits for the reconnect target if Twitch closes the old socket first', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.socket(0).deliver(messages.reconnect('wss://example.invalid/ws?r=1'));
    t.socket(0).serverClose(4004);
    t.socket(1).deliver(messages.welcome('session-2'));
    expect(t.welcomes).toEqual(['session-1']);
    expect(t.sockets).toHaveLength(2);
    expect(t.client.sessionId).toBe('session-2');
  });

  it('falls back to a fresh session when the reconnect target never welcomes', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.socket(0).deliver(messages.reconnect('wss://example.invalid/ws?r=1'));
    t.clock.advance(10_000); // welcome timeout for the new socket
    expect(t.socket(1).closed).toBe(true);
    t.socket(0).serverClose(4004);
    t.clock.advance(1_000);
    expect(t.sockets).toHaveLength(3);
    t.socket(2).deliver(messages.welcome('session-3'));
    expect(t.welcomes).toEqual(['session-1', 'session-3']);
  });

  it('drops duplicate message_ids within 10 minutes, including across a reconnect', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1', 600));
    t.socket(0).deliver(messages.chatNotification('dup'));
    t.socket(0).deliver(messages.chatNotification('dup'));
    t.socket(0).deliver(messages.reconnect('wss://example.invalid/ws?r=1'));
    t.socket(1).deliver(messages.welcome('session-2', 600));
    t.socket(1).deliver(messages.chatNotification('dup'));
    expect(t.notifications).toHaveLength(1);

    t.clock.advance(DEDUPE_WINDOW_MS);
    t.socket(1).deliver(messages.chatNotification('dup'));
    expect(t.notifications).toHaveLength(2);
  });

  it('passes the subscription type, version, raw event and receive time to onNotification', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.socket(0).deliver(messages.chatNotification('delivery-1'));
    const [n] = t.notifications;
    expect(n).toMatchObject({
      messageId: 'delivery-1',
      subscriptionType: 'channel.chat.message',
      subscriptionVersion: '1',
      receivedAt: t.clock.time,
    });
    expect(
      normalizeChatMessage(n?.event, {
        messageId: n?.messageId ?? '',
        receivedAt: n?.receivedAt ?? 0,
      }),
    ).toMatchObject({ id: 'delivery-1', text: 'Hi chat', channelId: '1971641' });
  });

  it('reports revocations', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.socket(0).deliver(messages.revocation());
    expect(t.revocations).toEqual([
      {
        type: 'channel.follow',
        status: 'authorization_revoked',
        version: '1',
        subscriptionId: 'f1c2a387-161a-49f9-a165-0f21d7a4e1c4',
      },
    ]);
  });

  it('ignores invalid and unknown frames without crashing', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.socket(0).deliver('not json');
    t.socket(0).deliver(new Uint8Array([0xff, 0xfe]));
    t.socket(0).deliver({ metadata: { message_type: 'notification' } });
    t.socket(0).deliver({
      metadata: { message_id: 'x', message_type: 'brand_new', message_timestamp: 't' },
      payload: {},
    });
    t.socket(0).deliver(
      messages.chatNotification('bad', (event) => delete event['chatter_user_id']),
    );
    const missingPayload = messages.chatNotification('no-event');
    (missingPayload['payload'] as Record<string, unknown>)['event'] = 'nope';
    t.socket(0).deliver(missingPayload);
    expect(t.revocations).toHaveLength(0);
    // Envelope valid, event content unvalidated here: normalizers reject it later.
    expect(t.notifications.map((n) => n.messageId)).toEqual(['bad']);
    expect(
      normalizeChatMessage(t.notifications[0]?.event, { messageId: 'bad', receivedAt: 1 }),
    ).toBeNull();
    expect(t.errors).toEqual([]);
  });

  it('reconnects with jittered exponential backoff after unexpected closes', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.socket(0).serverClose(4005);
    expect(t.states.at(-1)).toEqual([
      'reconnecting',
      { reason: 'closed', closeCode: 4005, delayMs: 750, attempt: 1 },
    ]);
    t.clock.advance(750);
    t.socket(1).serverClose(1006);
    expect(t.states.at(-1)?.[1]).toMatchObject({ delayMs: 1500, attempt: 2 });
    t.clock.advance(1500);
    t.socket(2).serverClose(1006);
    expect(t.states.at(-1)?.[1]).toMatchObject({ delayMs: 3000, attempt: 3 });
    t.clock.advance(3000);
    t.socket(3).deliver(messages.welcome('session-4'));
    expect(t.welcomes).toEqual(['session-1', 'session-4']);
    t.socket(3).serverClose(4000);
    expect(t.states.at(-1)?.[1]).toMatchObject({ delayMs: 750, attempt: 1 });
  });

  it('caps backoff and uses the injected random source for jitter', () => {
    const low = setup({ random: () => 0, backoffBaseMs: 1000, backoffMaxMs: 4000 });
    low.client.start();
    for (let i = 0; i < 5; i += 1) {
      low.socket(i).serverClose(1006);
      const delay = low.states.at(-1)?.[1]?.delayMs ?? 0;
      low.clock.advance(delay);
    }
    const delays = low.states.filter(([s]) => s === 'reconnecting').map(([, d]) => d?.delayMs);
    expect(delays).toEqual([500, 1000, 2000, 2000, 2000]);
  });

  it('stop() closes sockets, cancels timers and never reconnects', () => {
    t.client.start();
    t.socket(0).deliver(messages.welcome('session-1'));
    t.client.stop();
    expect(t.socket(0).closed).toBe(true);
    expect(t.states.at(-1)).toEqual(['stopped', undefined]);
    expect(t.clock.pending).toBe(0);
    t.clock.advance(60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.client.sessionId).toBeNull();
  });

  it('stop() during backoff cancels the pending reconnect', () => {
    t.client.start();
    t.socket(0).serverClose(1006);
    t.client.stop();
    t.clock.advance(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it('surfaces onWelcome failures without dropping the session', async () => {
    const failing = setup({ onWelcome: vi.fn().mockRejectedValue(new Error('subscribe failed')) });
    failing.client.start();
    failing.socket(0).deliver(messages.welcome('session-1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(failing.errors).toHaveLength(1);
    expect(failing.socket(0).closed).toBe(false);
  });
});
