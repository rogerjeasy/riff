import WebSocket from 'ws';
import { z } from 'zod';

/**
 * EventSub WebSocket client. Lifecycle per
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/ and AGENTS §2.4.
 */
export const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';
/** Delivery ids are remembered this long; repeats inside the window are dropped. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** Watchdog = this factor × the announced `keepalive_timeout_seconds`. */
export const KEEPALIVE_WATCHDOG_FACTOR = 1.5;

/** The minimal socket surface the client needs; `ws` is adapted to it by default. */
export interface EventSubSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}
export type EventSubWebSocketConstructor = new (url: string) => EventSubSocket;

export type EventSubState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface EventSubStateDetail {
  readonly sessionId?: string;
  /** True when Twitch moved an existing session (subscriptions carried over). */
  readonly resumed?: boolean;
  readonly reason?: 'session_reconnect' | 'closed' | 'keepalive_timeout' | 'welcome_timeout';
  readonly closeCode?: number;
  readonly delayMs?: number;
  readonly attempt?: number;
}

export interface EventSubNotification {
  /** Envelope `metadata.message_id`. */
  readonly messageId: string;
  readonly subscriptionType: string;
  readonly subscriptionVersion: string;
  /** Raw `payload.event`; validate it with the matching normalizer. */
  readonly event: unknown;
  /** Host receive time from `now()`, epoch milliseconds. */
  readonly receivedAt: number;
}

export interface EventSubRevocation {
  readonly type: string;
  /** Reason, e.g. `user_removed`, `authorization_revoked`, `version_removed`. */
  readonly status: string;
  readonly version: string;
  readonly subscriptionId: string;
}

export type TimerHandle = unknown;

export interface EventSubClientOptions {
  /** Default {@link EVENTSUB_WEBSOCKET_URL}; use `ws://127.0.0.1:8080/ws` for the Twitch CLI mock server. */
  readonly url?: string;
  /** Optional `keepalive_timeout_seconds` query parameter (Twitch accepts 10–600). */
  readonly keepaliveTimeoutSeconds?: number;
  /** Called once per fresh session; the host creates subscriptions against `sessionId`. */
  readonly onWelcome: (sessionId: string) => void | Promise<void>;
  readonly onNotification: (notification: EventSubNotification) => void;
  readonly onRevocation: (revocation: EventSubRevocation) => void;
  readonly onState?: (state: EventSubState, detail?: EventSubStateDetail) => void;
  /** Failures from `onWelcome` or the callbacks; the connection keeps running. */
  readonly onError?: (error: unknown) => void;
  readonly WebSocket?: EventSubWebSocketConstructor;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
  readonly random?: () => number;
  /** First reconnect delay before jitter. Default 1 s. */
  readonly backoffBaseMs?: number;
  /** Cap for the reconnect delay. Default 30 s. */
  readonly backoffMaxMs?: number;
  /** How long a new socket may take to deliver `session_welcome`. Default 10 s. */
  readonly welcomeTimeoutMs?: number;
}

export interface EventSubClient {
  start(): void;
  stop(): void;
  /** Session id of the connection currently delivering events, if any. */
  readonly sessionId: string | null;
}

const metadataSchema = z.looseObject({
  message_id: z.string().min(1),
  message_type: z.string(),
  message_timestamp: z.string(),
});
const envelopeSchema = z.looseObject({ metadata: metadataSchema, payload: z.unknown() });
const welcomeSchema = z.looseObject({
  session: z.looseObject({
    id: z.string().min(1),
    keepalive_timeout_seconds: z.number().positive(),
  }),
});
const reconnectSchema = z.looseObject({
  session: z.looseObject({
    reconnect_url: z
      .string()
      .refine((value) => /^wss?:\/\//.test(value), { message: 'reconnect_url must be ws(s)' }),
  }),
});
const subscriptionMetadataSchema = metadataSchema.extend({
  subscription_type: z.string().min(1),
  subscription_version: z.string().min(1),
});
const subscriptionSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  type: z.string(),
  version: z.string(),
});
const notificationPayloadSchema = z.looseObject({
  subscription: subscriptionSchema,
  event: z.looseObject({}),
});
const revocationPayloadSchema = z.looseObject({ subscription: subscriptionSchema });

/** Adapts `ws` (which auto-answers Twitch pings with pongs) to {@link EventSubSocket}. */
class NodeEventSubSocket implements EventSubSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly #socket: WebSocket;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.on('open', () => this.onopen?.(undefined));
    this.#socket.on('message', (data, isBinary) =>
      this.onmessage?.({ data: isBinary ? data : data.toString() }),
    );
    this.#socket.on('close', (code, reason) => this.onclose?.({ code, reason: reason.toString() }));
    this.#socket.on('error', (error) => this.onerror?.(error));
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  let bytes: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data))
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes !== null) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  return null;
}

interface Connection {
  readonly socket: EventSubSocket;
  /** `fresh` sessions need subscriptions; `reconnect` sessions inherit them. */
  readonly kind: 'fresh' | 'reconnect';
  sessionId: string | null;
  watchdogMs: number;
  timer: TimerHandle | null;
  closed: boolean;
}

export function createEventSubClient(options: EventSubClientOptions): EventSubClient {
  const SocketCtor = options.WebSocket ?? NodeEventSubSocket;
  const now = options.now ?? Date.now;
  const schedule =
    options.setTimeout ??
    ((callback: () => void, ms: number): TimerHandle => setTimeout(callback, ms));
  const cancel =
    options.clearTimeout ??
    ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const backoffBaseMs = options.backoffBaseMs ?? 1000;
  const backoffMaxMs = options.backoffMaxMs ?? 30_000;
  const welcomeTimeoutMs = options.welcomeTimeoutMs ?? 10_000;

  const freshUrl = (() => {
    const url = new URL(options.url ?? EVENTSUB_WEBSOCKET_URL);
    if (options.keepaliveTimeoutSeconds !== undefined)
      url.searchParams.set('keepalive_timeout_seconds', String(options.keepaliveTimeoutSeconds));
    return url.toString();
  })();

  let running = false;
  /** The welcomed connection delivering events. */
  let active: Connection | null = null;
  /** A connection that has not yet been welcomed (fresh attempt or Twitch-directed reconnect). */
  let pending: Connection | null = null;
  let retryTimer: TimerHandle | null = null;
  let failures = 0;
  const seen = new Map<string, number>();

  const emitState = (state: EventSubState, detail?: EventSubStateDetail) => {
    safely(() => options.onState?.(state, detail));
  };

  function safely(callback: () => unknown): void {
    try {
      const result = callback();
      if (result instanceof Promise) result.catch((error: unknown) => options.onError?.(error));
    } catch (error) {
      options.onError?.(error);
    }
  }

  function armWatchdog(connection: Connection, ms: number, reason: EventSubStateDetail['reason']) {
    if (connection.timer !== null) cancel(connection.timer);
    connection.timer = schedule(() => {
      connection.timer = null;
      if (!running || connection.closed) return;
      teardown(connection);
      if (connection === active) activeLost(reason);
      else if (connection === pending) pendingLost(reason);
    }, ms);
  }

  function teardown(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.timer !== null) cancel(connection.timer);
    connection.timer = null;
    const { socket } = connection;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      // Already closed or never opened; nothing else to release.
    }
  }

  /** The event stream is gone: back off, then build a fresh session (subscriptions recreated). */
  function lost(reason: EventSubStateDetail['reason'], closeCode?: number): void {
    if (!running || retryTimer !== null) return;
    const exponential = Math.min(backoffMaxMs, backoffBaseMs * 2 ** failures);
    const delayMs = Math.round(exponential / 2 + random() * (exponential / 2));
    failures += 1;
    emitState('reconnecting', {
      ...(reason === undefined ? {} : { reason }),
      ...(closeCode === undefined ? {} : { closeCode }),
      delayMs,
      attempt: failures,
    });
    retryTimer = schedule(() => {
      retryTimer = null;
      if (running) open(freshUrl, 'fresh');
    }, delayMs);
  }

  function open(url: string, kind: Connection['kind']): void {
    if (kind === 'fresh') emitState('connecting');
    let socket: EventSubSocket;
    try {
      socket = new SocketCtor(url);
    } catch (error) {
      options.onError?.(error);
      if (kind === 'fresh' || active === null) lost('closed');
      return;
    }
    const connection: Connection = {
      socket,
      kind,
      sessionId: null,
      watchdogMs: welcomeTimeoutMs,
      timer: null,
      closed: false,
    };
    if (pending !== null) teardown(pending);
    pending = connection;
    socket.onmessage = (event) => handleFrame(connection, event.data);
    socket.onclose = (event) => handleClose(connection, event.code);
    socket.onerror = () => {
      // `close` always follows `error`; recovery happens there.
    };
    armWatchdog(connection, welcomeTimeoutMs, 'welcome_timeout');
  }

  function handleClose(connection: Connection, code: number): void {
    if (connection.closed) return;
    teardown(connection);
    if (connection === pending) pendingLost('closed', code);
    else if (connection === active) activeLost('closed', code);
  }

  function activeLost(reason: EventSubStateDetail['reason'], closeCode?: number): void {
    active = null;
    // A Twitch-directed successor may still welcome us (its welcome timer guards it).
    if (pending !== null && pending.kind === 'reconnect') return;
    if (pending !== null) teardown(pending);
    pending = null;
    lost(reason, closeCode);
  }

  function pendingLost(reason: EventSubStateDetail['reason'], closeCode?: number): void {
    pending = null;
    if (active === null) lost(reason, closeCode);
  }

  function handleFrame(connection: Connection, data: unknown): void {
    if (!running || connection.closed) return;
    const text = frameText(data);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return;
    const { metadata, payload } = envelope.data;

    switch (metadata.message_type) {
      case 'session_welcome':
        return handleWelcome(connection, payload);
      case 'session_keepalive':
        return touch(connection);
      case 'session_reconnect':
        return handleReconnect(connection, payload);
      case 'notification':
        return handleNotification(connection, json, payload);
      case 'revocation':
        return handleRevocation(connection, json, payload);
      default:
        // Unknown message types are ignored, not fatal.
        return;
    }
  }

  function touch(connection: Connection): void {
    if (connection.sessionId === null) return;
    armWatchdog(connection, connection.watchdogMs, 'keepalive_timeout');
  }

  function handleWelcome(connection: Connection, payload: unknown): void {
    if (connection !== pending) return;
    const parsed = welcomeSchema.safeParse(payload);
    if (!parsed.success) return;
    const { id, keepalive_timeout_seconds } = parsed.data.session;
    connection.sessionId = id;
    connection.watchdogMs = keepalive_timeout_seconds * 1000 * KEEPALIVE_WATCHDOG_FACTOR;
    pending = null;
    const previous = active;
    active = connection;
    // Docs: do not close the old connection until the new one is welcomed.
    if (previous !== null) teardown(previous);
    failures = 0;
    armWatchdog(connection, connection.watchdogMs, 'keepalive_timeout');
    if (connection.kind === 'reconnect') {
      // Twitch carried the subscriptions over; never recreate them here.
      emitState('connected', { sessionId: id, resumed: true });
      return;
    }
    emitState('connected', { sessionId: id });
    safely(() => options.onWelcome(id));
  }

  function handleReconnect(connection: Connection, payload: unknown): void {
    if (connection !== active) return;
    touch(connection);
    if (pending !== null) return;
    const parsed = reconnectSchema.safeParse(payload);
    if (!parsed.success) return;
    emitState('reconnecting', { reason: 'session_reconnect' });
    // Docs: "Use the reconnect URL as is; do not modify it."
    open(parsed.data.session.reconnect_url, 'reconnect');
  }

  function firstDelivery(messageId: string): boolean {
    const at = now();
    for (const [id, expires] of seen) {
      if (expires > at) break;
      seen.delete(id);
    }
    if (seen.has(messageId)) return false;
    seen.set(messageId, at + DEDUPE_WINDOW_MS);
    return true;
  }

  function handleNotification(connection: Connection, json: unknown, payload: unknown): void {
    if (connection.sessionId === null) return;
    const envelope = z.looseObject({ metadata: subscriptionMetadataSchema }).safeParse(json);
    const body = notificationPayloadSchema.safeParse(payload);
    touch(connection);
    if (!envelope.success || !body.success) return;
    const { metadata } = envelope.data;
    if (!firstDelivery(metadata.message_id)) return;
    const notification: EventSubNotification = {
      messageId: metadata.message_id,
      subscriptionType: metadata.subscription_type,
      subscriptionVersion: metadata.subscription_version,
      event: body.data.event,
      receivedAt: now(),
    };
    safely(() => options.onNotification(notification));
  }

  function handleRevocation(connection: Connection, json: unknown, payload: unknown): void {
    if (connection.sessionId === null) return;
    const envelope = z.looseObject({ metadata: subscriptionMetadataSchema }).safeParse(json);
    const body = revocationPayloadSchema.safeParse(payload);
    touch(connection);
    if (!envelope.success || !body.success) return;
    if (!firstDelivery(envelope.data.metadata.message_id)) return;
    const { subscription } = body.data;
    const revocation: EventSubRevocation = {
      type: subscription.type,
      status: subscription.status,
      version: subscription.version,
      subscriptionId: subscription.id,
    };
    safely(() => options.onRevocation(revocation));
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      open(freshUrl, 'fresh');
    },
    stop() {
      if (!running) return;
      running = false;
      if (retryTimer !== null) cancel(retryTimer);
      retryTimer = null;
      if (pending !== null) teardown(pending);
      if (active !== null) teardown(active);
      pending = null;
      active = null;
      emitState('stopped');
    },
    get sessionId() {
      return active?.sessionId ?? null;
    },
  };
}
