import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { ToolRefusal, type BotTransport } from '../../services/production/contract.js';
const object = z.record(z.string(), z.unknown());
const helloSchema = z.object({
  request: z.literal('Hello'),
  authentication: z.object({
    salt: z.string().min(1).max(512),
    challenge: z.string().min(1).max(512),
  }),
});
/** Streamer.bot >=0.2.5 authenticated WebSocket protocol; no arbitrary request surface. */
export function createBotTransport(
  event: (raw: unknown) => void,
  onClose: () => void,
): BotTransport {
  let socket: WebSocket | null = null;
  let ready = false;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    ready = false;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ToolRefusal('Streamer.bot disconnected.'));
    }
    pending.clear();
    onClose();
  };
  function request(requestName: string, fields: Record<string, unknown> = {}) {
    const target = socket;
    if (!target || target.readyState !== WebSocket.OPEN || pending.size >= 16)
      return Promise.reject(new ToolRefusal('Streamer.bot unavailable.'));
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new ToolRefusal('Streamer.bot request timed out; it was not retried.'));
        }, 4000);
      pending.set(id, { resolve, reject, timer });
      target.send(JSON.stringify({ request: requestName, id, ...fields }), (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new ToolRefusal('Streamer.bot write failed; it was not retried.'));
        }
      });
    });
  }
  return {
    async connect(url, password) {
      const target = new WebSocket(url, {
        handshakeTimeout: 4000,
        maxPayload: 65536,
        followRedirects: false,
      });
      socket = target;
      await new Promise<void>((resolve, reject) => {
        let settled = false,
          authenticating = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            target.terminate();
            reject(new ToolRefusal('Streamer.bot authentication timed out.'));
          }
        }, 4000);
        const rejectConnect = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(
              new ToolRefusal(
                'Streamer.bot could not authenticate. Check the password and that WebSocket authentication is enabled (Streamer.bot 0.2.5+).',
              ),
            );
          }
        };
        target.on('error', () => {
          rejectConnect();
          fail();
        });
        target.on('close', () => {
          rejectConnect();
          fail();
        });
        target.on('message', (data) => {
          let raw: Record<string, unknown>;
          try {
            raw = object.parse(JSON.parse(data.toString()));
          } catch {
            return;
          }
          if (typeof raw.id === 'string' && pending.has(raw.id)) {
            const p = pending.get(raw.id);
            if (!p) return;
            pending.delete(raw.id);
            clearTimeout(p.timer);
            if (raw.status === 'ok') p.resolve(raw);
            else p.reject(new ToolRefusal('Streamer.bot rejected the request.'));
            return;
          }
          if (!settled && !authenticating && raw.request === 'Hello') {
            authenticating = true;
            const hello = helloSchema.safeParse(raw);
            if (!hello.success) {
              rejectConnect();
              target.close();
              return;
            }
            const secret = createHash('sha256')
              .update(password + hello.data.authentication.salt)
              .digest('base64');
            const authentication = createHash('sha256')
              .update(secret + hello.data.authentication.challenge)
              .digest('base64');
            void request('Authenticate', { authentication })
              .then(() => request('Subscribe', { events: { Custom: ['Event'] } }))
              .then(
                () => {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    ready = true;
                    resolve();
                  }
                },
                () => {
                  rejectConnect();
                  target.close();
                },
              );
            return;
          }
          if (ready) {
            const packet = z
              .object({
                event: z.object({ source: z.literal('Custom'), type: z.literal('Event') }),
                data: z.unknown(),
              })
              .safeParse(raw);
            if (packet.success) event(packet.data.data);
          }
        });
      });
    },
    disconnect() {
      ready = false;
      socket?.terminate();
      socket = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new ToolRefusal('Streamer.bot disconnected.'));
      }
      pending.clear();
    },
    async actions() {
      const result = await request('GetActions');
      return z
        .object({
          // Bounded by the 64 KiB frame cap; the service filters for display.
          actions: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
        })
        .parse(result)
        .actions.map(({ id, name, enabled }) => ({ id, name, enabled }));
    },
    async invoke(actionId, args) {
      if (!ready) throw new ToolRefusal('Streamer.bot is not authenticated.');
      await request('DoAction', { action: { id: actionId }, args });
    },
  };
}
