import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { ToolRefusal, type BotTransport } from '../../services/production/contract.js';

/**
 * Firebot v5 local HTTP API (`/api/v1`, default port 7472) plus its root WebSocket
 * event stream. Checked against crowbartools/Firebot `src/server/api/v1/v1-router.ts`,
 * `effects-api-controller.ts`, `custom-variable-api-controller.ts`,
 * `commands-api-controller.ts`, `websocket-server-manager.ts` and
 * `effects/builtin/send-custom-websocket-event.ts` (November 1, 2026).
 *
 * Firebot's API has no authentication of its own, so the service only accepts
 * local/private endpoints and this adapter authenticates inbound events with a
 * creator-chosen event key carried in each custom event's `riff.key`. Outbound
 * operations are limited to the preset effect lists and custom variables found by
 * the latest discovery; there is no generic request surface.
 */
const REQUEST_TIMEOUT_MS = 4000;
const MAX_PENDING = 16;
const MAX_BODY = 256 * 1024;
const HEARTBEAT_MS = 15000;

const statusSchema = z.object({ connections: z.object({ chat: z.boolean() }).passthrough() });
const presetsSchema = z.array(
  z
    .object({ id: z.string(), name: z.string(), args: z.array(z.string()).optional() })
    .passthrough(),
);
const variablesSchema = z.record(z.string(), z.unknown());
const commandsSchema = z.array(z.object({ id: z.string(), trigger: z.string() }).passthrough());
const frameSchema = z
  .object({ type: z.string(), id: z.unknown().optional(), name: z.string(), data: z.unknown() })
  .passthrough();

const keyDigest = (key: string) => createHash('sha256').update(key, 'utf8').digest();

/** Replace variables may arrive as numeric text (for example a quoted `$unixTimestamp`). */
const numeric = (value: unknown) =>
  typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
/** Firebot's `$unixTimestamp` is epoch seconds (moment `unix()`); Riff uses milliseconds. */
const epochMs = (raw: unknown) => {
  const value = numeric(raw);
  return typeof value === 'number' && value > 0 && value < 1e12 ? Math.round(value * 1000) : value;
};

export interface FirebotOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  heartbeatMs?: number;
}

export function createFirebotTransport(
  event: (raw: unknown) => void,
  onClose: () => void,
  options: FirebotOptions = {},
): BotTransport {
  const fetcher = options.fetch ?? fetch;
  let base: string | null = null;
  let key: Buffer | null = null;
  let socket: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let inflight = 0;
  let abort = new AbortController();
  /** Exactly the action identifiers returned by the latest discovery. */
  const allowed = new Set<string>();

  function fail() {
    const wasOpen = ready || socket !== null;
    ready = false;
    allowed.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    abort.abort();
    if (wasOpen && !closed) {
      closed = true;
      onClose();
    }
  }

  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    if (!base) throw new ToolRefusal('Firebot is not connected.');
    if (inflight >= MAX_PENDING) throw new ToolRefusal('Too many Firebot requests are pending.');
    inflight++;
    try {
      let response: Response;
      try {
        const init: RequestInit = {
          method,
          redirect: 'error',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        };
        if (body !== undefined) {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        response = await fetcher(`${base}/api/v1${path}`, init);
      } catch {
        throw new ToolRefusal(
          'Firebot did not answer. Check that Firebot is running with its HTTP server on (default port 7472); the request was not retried.',
        );
      }
      const text = await response.text();
      if (text.length > MAX_BODY) throw new ToolRefusal('Firebot sent an oversized response.');
      if (!response.ok) throw new ToolRefusal('Firebot rejected the request.');
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ToolRefusal('Firebot sent a response Riff could not read.');
      }
    } finally {
      inflight--;
    }
  }

  function receive(data: WebSocket.RawData) {
    let frame: z.infer<typeof frameSchema>;
    try {
      const parsed = frameSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    if (!ready || frame.type !== 'event' || !frame.name.startsWith('custom-event:')) return;
    const eventName = frame.name.slice('custom-event:'.length);
    if (!eventName.trim() || eventName.length > 120) return;
    const riff = z.object({ riff: z.record(z.string(), z.unknown()) }).safeParse(frame.data)
      .data?.riff;
    const presented = typeof riff?.key === 'string' ? keyDigest(riff.key) : null;
    if (!riff || !key || !presented || !timingSafeEqual(presented, key)) {
      event({ eventName, unauthenticated: true });
      return;
    }
    // The key authenticates the origin and never leaves the adapter.
    const meta: Record<string, unknown> = {
      ...riff,
      hops: numeric(riff.hops),
      at: epochMs(riff.at),
    };
    delete meta.key;
    event({ eventName, args: { riff: meta } });
  }

  return {
    async connect(url, eventKey) {
      closed = false;
      abort = new AbortController();
      base = url.replace(/\/+$/, '');
      key = keyDigest(eventKey);
      const status = statusSchema.safeParse(await request('GET', '/status').catch(() => null));
      if (!status.success) {
        base = null;
        throw new ToolRefusal(
          'That endpoint did not answer like Firebot v5. Check the address (default http://127.0.0.1:7472) and that Firebot is running.',
        );
      }
      const wsUrl = new URL(base);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.pathname = '/';
      const target = new WebSocket(wsUrl.toString(), {
        handshakeTimeout: REQUEST_TIMEOUT_MS,
        maxPayload: 65536,
        followRedirects: false,
      });
      socket = target;
      await new Promise<void>((resolve, reject) => {
        let settled = false,
          alive = true;
        const id = randomUUID();
        const refuse = (message: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          target.terminate();
          socket = null;
          reject(new ToolRefusal(message));
        };
        const timer = setTimeout(
          () => refuse('Firebot did not accept the event subscription in time.'),
          REQUEST_TIMEOUT_MS,
        );
        target.on('open', () =>
          target.send(JSON.stringify({ type: 'invoke', id, name: 'subscribe-events', data: null })),
        );
        target.on('error', () => {
          refuse('Firebot event connection failed.');
          fail();
        });
        target.on('close', () => {
          refuse('Firebot closed the event connection.');
          fail();
        });
        target.on('pong', () => {
          alive = true;
        });
        target.on('message', (data) => {
          if (settled) return receive(data);
          try {
            const reply = frameSchema.parse(JSON.parse(data.toString()));
            if (reply.type !== 'response' || reply.id !== id) return;
            if (reply.name !== 'success') return refuse('Firebot refused the event subscription.');
          } catch {
            return;
          }
          settled = true;
          clearTimeout(timer);
          ready = true;
          heartbeat = setInterval(() => {
            if (!alive) {
              target.terminate();
              return;
            }
            alive = false;
            target.ping();
          }, options.heartbeatMs ?? HEARTBEAT_MS);
          heartbeat.unref?.();
          resolve();
        });
      });
    },
    disconnect() {
      closed = true;
      ready = false;
      allowed.clear();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      abort.abort();
      socket?.terminate();
      socket = null;
      base = null;
      key = null;
    },
    async actions() {
      if (!ready) throw new ToolRefusal('Firebot is not connected.');
      const presets = presetsSchema.parse(await request('GET', '/effects/preset'));
      const variables = Object.keys(
        variablesSchema.parse(await request('GET', '/custom-variables')),
      );
      const out = [
        ...presets.map((p) => ({
          id: `preset:${p.id}`,
          name: `Run preset “${p.name}”`,
          enabled: true,
        })),
        ...variables.map((name) => ({
          id: `variable:${name}`,
          name: `Set variable “${name}”`,
          enabled: true,
        })),
      ];
      allowed.clear();
      for (const action of out) allowed.add(action.id);
      return out;
    },
    async commands() {
      if (!ready) throw new ToolRefusal('Firebot is not connected.');
      return commandsSchema
        .parse(await request('GET', '/commands/custom'))
        .map(({ id, trigger }) => ({ id, trigger }));
    },
    async invoke(actionId, args) {
      if (!ready) throw new ToolRefusal('Firebot is not connected.');
      if (!allowed.has(actionId))
        throw new ToolRefusal('That Firebot action was not discovered on this connection.');
      const riff = z.record(z.string(), z.unknown()).safeParse(args.riff).data ?? {};
      const [kind, ...rest] = actionId.split(':');
      const target = encodeURIComponent(rest.join(':'));
      if (kind === 'preset') {
        // Preset list arguments are flat ($presetListArg[name]); forward causal metadata
        // so a Firebot effect that sends a custom event back can keep loop protection.
        await request('POST', `/effects/preset/${target}/run`, {
          username: 'Riff',
          args: {
            riffEventId: riff.eventId,
            riffCausalId: riff.causalId,
            riffOrigin: riff.origin,
            riffHops: riff.hops,
            riffAt: riff.at,
          },
        });
        return;
      }
      if (kind === 'variable') {
        await request('POST', `/custom-variables/${target}`, { data: { riff }, ttl: 0 });
        return;
      }
      throw new ToolRefusal('Only preset effect lists and custom variables can be used.');
    },
  };
}
