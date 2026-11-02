import { randomUUID } from 'node:crypto';
import type { ProductionBotKind, ProductionKind } from '@riff/sdk';
import { createObsTransport } from '../../adapters/obs/client.js';
import { createBotTransport } from '../../adapters/streamer-bot/client.js';
import { createFirebotTransport } from '../../adapters/firebot/client.js';
import {
  FIREBOT_KEY_MIN,
  ProductionError,
  connectSchema,
  connectionUrl,
  discoveryLimits,
  firebotUrl,
  type ConnectInput,
} from './contract.js';
import { disconnected, explain, toolName, type Runtime } from './runtime.js';

const fits = (value: string) => value.trim().length > 0 && value.length <= discoveryLimits.name;

/** Keeps the first bounded, displayable entries instead of refusing the whole tool. */
function bounded<T>(items: T[], limit: number, ok: (item: T) => boolean) {
  const kept = items.filter(ok).slice(0, limit);
  return { kept, skipped: items.length - kept.length };
}
function skippedReason(count: number, noun: string, limit: number) {
  if (!count) return null;
  return `Connected. ${count} ${noun}${count === 1 ? ' was' : 's were'} not listed: names must be 1–${discoveryLimits.name} characters and only the first ${limit} are shown.`;
}

export function createConnections(
  rt: Runtime,
  onBotEvent: (raw: unknown, kind: ProductionBotKind) => void,
) {
  const { deps, state, connections } = rt;
  async function connect(input: ConnectInput) {
    const body = connectSchema.parse(input),
      kind = body.kind,
      url = kind === 'firebot' ? firebotUrl(body.url) : connectionUrl(body.url);
    if (kind === 'firebot' && body.password.length < FIREBOT_KEY_MIN)
      throw new ProductionError(
        'INVALID',
        `Use a Firebot event key of at least ${FIREBOT_KEY_MIN} characters; it authenticates events Firebot sends to Riff.`,
      );
    if (!rt.sealer)
      throw new ProductionError('DENIED', 'Configure RIFF_SECRET before production setup.');
    return rt.work(kind, async () => {
      rt.revoke(kind, { ...disconnected(), status: 'connecting', reason: null, url });
      const stamp = rt.stampFor(kind),
        session = randomUUID();
      // Before discovery completes, failures surface through connect's rejection.
      const onClose = () => {
        if (state.session[kind] !== session) return;
        let applied = false;
        try {
          applied = kind === 'obs' && !!rt.read().setup?.expectedSealed;
        } catch {
          /* Storage failure must not stop the fence below. */
        }
        rt.revoke(kind, {
          ...disconnected(),
          status: 'error',
          reason: applied
            ? 'Connection lost. Reconnect to review again; undo of the applied source remains available.'
            : 'Connection lost. Reconnect and review permissions again.',
        });
      };
      try {
        if (kind === 'obs') {
          const client = (deps.obsFactory ?? createObsTransport)(onClose);
          state.obs = client;
          await client.connect(url, body.password);
          rt.fence(stamp);
          const scenes = bounded(await client.scenes(), discoveryLimits.scenes, fits);
          rt.fence(stamp);
          connections.obs = {
            status: 'connected',
            reason: skippedReason(scenes.skipped, 'scene', discoveryLimits.scenes),
            url,
            scenes: scenes.kept,
            actions: [],
          };
        } else {
          const factory =
            kind === 'firebot'
              ? (deps.firebotFactory ?? createFirebotTransport)
              : (deps.botFactory ?? createBotTransport);
          const client = factory((raw) => onBotEvent(raw, kind), onClose);
          rt.setBot(kind, client);
          await client.connect(url, body.password);
          rt.fence(stamp);
          const actions = bounded(
            await client.actions(),
            discoveryLimits.actions,
            (a) => fits(a.id) && fits(a.name),
          );
          rt.fence(stamp);
          const commands = client.commands
            ? bounded(
                (await client.commands()).map((c) => c.trigger),
                discoveryLimits.actions,
                fits,
              ).kept
            : null;
          rt.fence(stamp);
          connections[kind] = {
            status: 'connected',
            reason: skippedReason(actions.skipped, 'action', discoveryLimits.actions),
            url,
            scenes: [],
            actions: actions.kept,
            ...(commands ? { commands } : {}),
          };
        }
        state.session[kind] = session;
      } catch (error) {
        if (rt.isCurrent(stamp))
          rt.revoke(kind, {
            ...disconnected(),
            status: 'error',
            reason: `Connection to ${toolName[kind]} failed: ${explain(
              error,
              'verify the endpoint, the password and that authentication is enabled.',
            )}`,
          });
        throw error;
      }
      return rt.view();
    });
  }
  function disconnect(kind: ProductionKind) {
    rt.revoke(kind, disconnected('Disconnected. Reconnect and review permissions again.'));
    return rt.view();
  }
  return { connect, disconnect };
}
