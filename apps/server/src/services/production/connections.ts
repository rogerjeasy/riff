import { randomUUID } from 'node:crypto';
import type { ProductionKind } from '@riff/sdk';
import { createObsTransport } from '../../adapters/obs/client.js';
import { createBotTransport } from '../../adapters/streamer-bot/client.js';
import {
  ProductionError,
  connectSchema,
  connectionUrl,
  discoveryLimits,
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

export function createConnections(rt: Runtime, onBotEvent: (raw: unknown) => void) {
  const { deps, state, connections } = rt;
  async function connect(input: ConnectInput) {
    const body = connectSchema.parse(input),
      url = connectionUrl(body.url),
      kind = body.kind;
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
          const client = (deps.botFactory ?? createBotTransport)(onBotEvent, onClose);
          state.bot = client;
          await client.connect(url, body.password);
          rt.fence(stamp);
          const actions = bounded(
            await client.actions(),
            discoveryLimits.actions,
            (a) => fits(a.id) && fits(a.name),
          );
          rt.fence(stamp);
          connections.streamerbot = {
            status: 'connected',
            reason: skippedReason(actions.skipped, 'action', discoveryLimits.actions),
            url,
            scenes: [],
            actions: actions.kept,
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
