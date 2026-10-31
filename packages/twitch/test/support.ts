import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { EventSubSocket } from '../src/eventsub.js';

/** Load a sourced fixture without its `_source`/`_note` metadata. */
export function fixture(name: string): Record<string, unknown> {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  expect(typeof raw['_source']).toBe('string');
  const rest = { ...raw };
  delete rest['_source'];
  delete rest['_note'];
  return rest;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value as Json;

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** Doc-sourced envelopes with only ids and the fields under test changed. */
export const messages = {
  welcome(sessionId: string, keepaliveSeconds = 10, messageId = nextId()): Json {
    const m = structuredClone(fixture('session_welcome.json'));
    obj(m['metadata'])['message_id'] = messageId;
    const session = obj(obj(m['payload'])['session']);
    session['id'] = sessionId;
    session['keepalive_timeout_seconds'] = keepaliveSeconds;
    return m;
  },
  keepalive(messageId = nextId()): Json {
    const m = structuredClone(fixture('session_keepalive.json'));
    obj(m['metadata'])['message_id'] = messageId;
    return m;
  },
  reconnect(url?: string, messageId = nextId()): Json {
    const m = structuredClone(fixture('session_reconnect.json'));
    obj(m['metadata'])['message_id'] = messageId;
    if (url !== undefined) obj(obj(obj(m['payload'])['session']))['reconnect_url'] = url;
    return m;
  },
  /** The documented notification envelope carrying the documented channel.chat.message payload. */
  chatNotification(messageId = nextId(), edit?: (event: Json) => void): Json {
    const m = structuredClone(fixture('notification.json'));
    const payload = structuredClone(fixture('channel.chat.message.json'));
    if (edit) edit(obj(payload['event']));
    const metadata = obj(m['metadata']);
    metadata['message_id'] = messageId;
    metadata['subscription_type'] = 'channel.chat.message';
    metadata['subscription_version'] = '1';
    m['payload'] = payload;
    return m;
  },
  revocation(messageId = nextId()): Json {
    const m = structuredClone(fixture('revocation.json'));
    obj(m['metadata'])['message_id'] = messageId;
    return m;
  },
};

/** Deterministic timer queue for injected `setTimeout`/`clearTimeout`/`now`. */
export class FakeClock {
  time = 1_700_000_000_000;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.time;

  setTimeout = (callback: () => void, ms: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.time + ms, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  get pending(): number {
    return this.#timers.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.#timers.get(nextId);
      this.#timers.delete(nextId);
      this.time = nextAt;
      timer?.callback();
    }
    this.time = end;
  }
}

/** A fake server-side view of one WebSocket the client opened. */
export interface FakeSocket extends EventSubSocket {
  readonly url: string;
  closed: boolean;
  /** Deliver a server frame (objects are JSON-encoded). */
  deliver(frame: unknown): void;
  /** Simulate the server closing the connection. */
  serverClose(code: number): void;
}

export function fakeWebSocket() {
  const sockets: FakeSocket[] = [];
  class Socket implements FakeSocket {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    close(): void {
      this.closed = true;
    }
    deliver(frame: unknown): void {
      if (this.closed) return;
      const data =
        typeof frame === 'string' || frame instanceof Uint8Array ? frame : JSON.stringify(frame);
      this.onmessage?.({ data });
    }
    serverClose(code: number): void {
      this.closed = true;
      this.onclose?.({ code, reason: '' });
    }
  }
  return { Socket, sockets };
}
