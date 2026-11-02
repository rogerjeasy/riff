import { randomUUID } from 'node:crypto';
import type {
  ProductionState,
  ProductionKind,
  ProductionBotKind,
  ProductionConnection,
} from '@riff/sdk';
import type { DatabaseConnection } from '../../db/client.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import { productionRepository } from '../../db/repositories/production.js';
import { createSealer } from '../auth/secrets.js';
import {
  ProductionError,
  ToolRefusal,
  type StoredProduction,
  type ObsTransport,
  type BotTransport,
} from './contract.js';

export interface ProductionDeps {
  database: DatabaseConnection;
  repo: ChannelRepository;
  secret: string | null;
  overlayUrl: () => string;
  blocked: () => boolean;
  control: (versionId: string, action: 'start' | 'pause') => unknown;
  now?: () => number;
  obsFactory?: (onClose: () => void) => ObsTransport;
  botFactory?: (event: (raw: unknown) => void, onClose: () => void) => BotTransport;
  firebotFactory?: (event: (raw: unknown) => void, onClose: () => void) => BotTransport;
}

export const toolName: Record<ProductionKind, string> = {
  obs: 'OBS',
  streamerbot: 'Streamer.bot',
  firebot: 'Firebot',
};
export const BOT_KINDS = ['streamerbot', 'firebot'] as const satisfies readonly ProductionBotKind[];
export const KINDS = ['obs', ...BOT_KINDS] as const satisfies readonly ProductionKind[];
/** Mappings from version 1 documents have no tool and belong to Streamer.bot. */
export const toolOf = (mapping: { tool?: ProductionBotKind | undefined }): ProductionBotKind =>
  mapping.tool ?? 'streamerbot';
export const disconnected = (
  reason = 'Not connected. Connect explicitly to enable production access.',
): ProductionConnection => ({ status: 'disconnected', reason, url: null, scenes: [], actions: [] });

/** Creator-facing text for an error; unknown errors never leak internal details. */
export function explain(error: unknown, fallback: string) {
  return error instanceof ProductionError || error instanceof ToolRefusal
    ? error.message
    : fallback;
}

const OPERATION_DEADLINE_MS = 8000;

/**
 * Shared authority and storage for the production modules. Epochs fence captured
 * authority: connector changes revoke only that tool; mapping approval revokes bot
 * dispatches; panic/close revoke everything before transport cleanup.
 */
export function createRuntime(deps: ProductionDeps) {
  const storage = productionRepository(deps.database, deps.repo.channelId),
    sealer = deps.secret ? createSealer(deps.secret) : null,
    now = deps.now ?? Date.now;
  const existing = storage.get() as (StoredProduction & { credentials?: unknown }) | undefined;
  if (!existing)
    storage.save({
      revision: 0,
      origin: randomUUID(),
      setup: null,
      mappingReview: null,
      mappings: [],
      receipts: [],
      completed: {},
    });
  else if (existing.credentials !== undefined) {
    // Earlier builds sealed connection passwords that were never reused.
    delete existing.credentials;
    storage.save(existing);
  }
  const read = () => {
    const value = storage.get();
    if (!value) throw new ProductionError('UNAVAILABLE', 'Production storage is unavailable.');
    return value;
  };
  const mutate = <T>(fn: (s: StoredProduction) => T) =>
    deps.database.client.transaction(() => {
      const s = read();
      const value = fn(s);
      s.revision++;
      storage.save(s);
      return value;
    })();
  const cipher = () => {
    if (!sealer)
      throw new ProductionError('DENIED', 'Configure RIFF_SECRET before production setup.');
    return sealer;
  };

  const epochs = { global: 0, mapping: 0, connector: { obs: 0, streamerbot: 0, firebot: 0 } };
  const state = {
    closed: false,
    busy: { obs: false, streamerbot: false, firebot: false } as Record<ProductionKind, boolean>,
    /** Random identity of each live connection; null while disconnected. */
    session: { obs: null, streamerbot: null, firebot: null } as Record<
      ProductionKind,
      string | null
    >,
    obs: null as ObsTransport | null,
    bot: null as BotTransport | null,
    firebot: null as BotTransport | null,
  };
  /** The live transport of one automation tool, or null. */
  const botFor = (kind: ProductionBotKind) => (kind === 'firebot' ? state.firebot : state.bot);
  const setBot = (kind: ProductionBotKind, client: BotTransport | null) => {
    if (kind === 'firebot') state.firebot = client;
    else state.bot = client;
  };
  const connections: Record<ProductionKind, ProductionConnection> = {
    obs: disconnected(),
    streamerbot: disconnected(),
    firebot: disconnected(),
  };
  const recent: ProductionState['recent'] = [];
  const record = (code: string, message: string) => {
    recent.unshift({ at: now(), code, message });
    recent.splice(30);
  };

  function assertRunning() {
    if (state.closed || deps.blocked())
      throw new ProductionError(
        'DENIED',
        'Production access is stopped. Resume Riff and explicitly reconnect.',
      );
  }
  const stampFor = (kind: ProductionKind, mappings = false) => ({
    kind,
    global: epochs.global,
    connector: epochs.connector[kind],
    mapping: mappings ? epochs.mapping : null,
  });
  type Stamp = ReturnType<typeof stampFor>;
  const isCurrent = (stamp: Stamp) =>
    stamp.global === epochs.global &&
    stamp.connector === epochs.connector[stamp.kind] &&
    (stamp.mapping === null || stamp.mapping === epochs.mapping);
  function fence(stamp: Stamp) {
    assertRunning();
    if (!isCurrent(stamp))
      throw new ProductionError('STALE', 'Connection or permissions changed. Review again.');
  }

  /** A changed connection never inherits that connector's unconfirmed authority. */
  function fenceGrants(kind: ProductionKind) {
    mutate((s) => {
      if (kind !== 'obs') {
        // Reviews pin every bot connection; grants are revoked only for this tool.
        s.mappingReview = null;
        s.mappings = s.mappings.filter((m) => toolOf(m) !== kind);
      } else if (s.setup && !s.setup.expectedSealed) {
        // Nothing was written; the review has no rollback value.
        s.setup = null;
      }
      // An applied setup keeps its sealed snapshots: its connection id no longer
      // matches, which fences apply/confirm while still allowing a checked rollback.
    });
  }

  /** The one path that ends a connection: fence, forget, clean up, revoke grants. */
  function revoke(kind: ProductionKind, connection: ProductionConnection) {
    epochs.connector[kind]++;
    state.session[kind] = null;
    const target = kind === 'obs' ? state.obs : botFor(kind);
    if (kind === 'obs') state.obs = null;
    else setBot(kind, null);
    connections[kind] = connection;
    try {
      target?.disconnect();
    } catch {
      /* Fencing precedes best-effort transport cleanup. */
    }
    try {
      fenceGrants(kind);
    } catch {
      // Memory authority is already fenced even if grant persistence fails.
      record(
        'UNAVAILABLE',
        `${toolName[kind]} disconnected, but its stored permissions could not be cleared. Reconnect and review again.`,
      );
    }
  }

  /** Serializes one connector's operations under a deadline; other tools keep working. */
  async function work<T>(kind: ProductionKind, fn: (stamp: Stamp) => Promise<T>): Promise<T> {
    assertRunning();
    if (state.busy[kind])
      throw new ProductionError('BUSY', `Another ${toolName[kind]} operation is running.`);
    state.busy[kind] = true;
    const stamp = stampFor(kind);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(stamp),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const message = `${toolName[kind]} did not respond within eight seconds. Inspect it before reconnecting; the request was not retried.`;
            revoke(kind, { ...disconnected(), status: 'error', reason: message });
            record('TIMEOUT', message);
            reject(new ProductionError('UNAVAILABLE', message));
          }, OPERATION_DEADLINE_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof ProductionError) throw error;
      if (error instanceof ToolRefusal) {
        record('REFUSED', `${toolName[kind]} refused the operation: ${error.message}`);
        throw new ProductionError('DENIED', error.message);
      }
      const message = `${toolName[kind]} is unavailable or rejected the request. Check its connection and selected source before trying again.`;
      record('UNAVAILABLE', message);
      throw new ProductionError('UNAVAILABLE', message);
    } finally {
      if (timer) clearTimeout(timer);
      state.busy[kind] = false;
    }
  }

  function currentVersion(id: string) {
    const v = deps.repo.version(id);
    if (
      !v ||
      v.approvedAt === null ||
      v.incident ||
      v.status !== 'active' ||
      deps.repo.automation(v.automationId)?.activeVersionId !== id
    )
      throw new ProductionError('DENIED', 'Select a current, healthy, approved version.');
    deps.repo.assertVersionLineage(id);
    return v;
  }

  /** Synchronous panic/close fence: memory authority first, cleanup best effort. */
  function stop(reason = 'Production access stopped. Resume Riff, then reconnect explicitly.') {
    epochs.global++;
    for (const kind of KINDS) {
      epochs.connector[kind]++;
      state.session[kind] = null;
      connections[kind] = disconnected(reason);
    }
    const targets = [state.obs, state.bot, state.firebot];
    state.obs = null;
    state.bot = null;
    state.firebot = null;
    for (const target of targets)
      try {
        target?.disconnect();
      } catch {
        /* Best effort after memory fence. */
      }
  }

  function view(): ProductionState {
    const s = read();
    return structuredClone({
      revision: s.revision,
      configured: !!sealer,
      origin: s.origin,
      connections,
      obsReview: s.setup?.public ?? null,
      mappingReview: s.mappingReview,
      mappings: s.mappings,
      recent,
    });
  }

  return {
    deps,
    sealer,
    now,
    read,
    mutate,
    cipher,
    epochs,
    state,
    botFor,
    setBot,
    connections,
    record,
    assertRunning,
    stampFor,
    isCurrent,
    fence,
    revoke,
    work,
    currentVersion,
    stop,
    view,
  };
}
export type Runtime = ReturnType<typeof createRuntime>;
export type Stamp = ReturnType<Runtime['stampFor']>;
