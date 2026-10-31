import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  EFFECT_LIMITS,
  HOST_LIMITS,
  type AllowanceSnapshot,
  type DecisionCode,
  type ExecutionDecision,
  type ExecutionMode,
  type ProjectileEffect,
} from '@riff/sdk';
import { z } from 'zod';
import { instrumentHandler } from './instrument.js';
import { artifactSchema, eventSchema, effectSchema } from './contract.js';

export const DECISION_MESSAGES: Record<DecisionCode, string> = {
  ACCEPTED: 'Accepted. The effect was staged.',
  UNRELATED: 'Not this command, so it was ignored.',
  AUDIENCE: 'This viewer is not in the eligible audience.',
  VIEWER_LIMIT: 'This viewer has used their allowance for the current window.',
  CHANNEL_LIMIT: 'The channel effect budget for this minute is used up.',
  DUPLICATE: 'Already processed this exact event, so no second effect.',
  INVALID_EVENT: 'Invalid, out-of-order or cross-channel event.',
  INCIDENT: 'The handler broke a rule; this version was quarantined and its effects discarded.',
  DISABLED: 'This version is quarantined after an incident.',
  CAPACITY: 'This rehearsal is full. Reset to start a fresh one.',
  STOPPED: 'Stopped; nothing was sent.',
};
const workerReply = z
  .object({
    type: z.literal('result'),
    id: z.number().int(),
    ok: z.boolean(),
    effects: z.array(effectSchema).max(EFFECT_LIMITS.perEvent),
    cpuMicros: z.number().nonnegative(),
    fault: z.string().max(200).nullable(),
  })
  .strict();
type WorkerReply = z.infer<typeof workerReply>;

/**
 * Host-owned admission counters. Live hosts share one instance across every version of
 * an automation so edits and rollbacks never reset a viewer's allowance.
 */
export interface AdmissionState {
  channelId: string;
  lastAt: number;
  viewers: Map<string, number[]>;
  effects: number[];
  seen: Map<string, number>;
}
export function createAdmissionState(): AdmissionState {
  return { channelId: '', lastAt: -1, viewers: new Map(), effects: [], seen: new Map() };
}
/** Optional channel-wide ceiling shared by all automations on one channel. */
export interface ChannelBudget {
  effects: number[];
  perMinute: number;
}
export interface Incident {
  eventId: string;
  fault: string;
}
export interface EngineOptions {
  seed: number;
  mode?: ExecutionMode;
  admission?: AdmissionState;
  channelBudget?: ChannelBudget;
  onIncident?: (incident: Incident) => void;
}
export type ExecutionEngine = ReturnType<typeof createEngine>;

/** Canonical identity of an artifact under the current host policy. */
export function artifactIdentity(candidate: unknown): string {
  const artifact = artifactSchema.parse(candidate);
  return createHash('sha256')
    .update(JSON.stringify({ artifact, limits: HOST_LIMITS, policy: 2 }))
    .digest('hex');
}
/** Exact command match after trimming and lowercasing; no suffixes are accepted. */
export function matchesCommand(text: string, command: string) {
  return text.trim().toLowerCase() === command.toLowerCase();
}

/** Create isolated host state. Example: const engine = createEngine(artifact, { seed: 42 }). */
export function createEngine(candidate: unknown, options: EngineOptions) {
  const artifact = artifactSchema.parse(candidate);
  const program = instrumentHandler(artifact.source);
  const seed = z.number().int().min(1).max(0xffff_ffff).parse(options.seed);
  const mode: ExecutionMode = options.mode ?? 'preview';
  const artifactId = artifactIdentity(artifact);
  const state = options.admission ?? createAdmissionState();
  const { trigger, limits } = artifact.manifest;
  let disabled = false;
  let stopped = false;
  let incident: Incident | null = null;
  let worker: Worker | undefined;
  let ready: Promise<boolean> | undefined;
  let jobs = 0;
  let abortActive: (() => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let lastCpuMicros = 0;

  const allowance = (history: number[], at: number): AllowanceSnapshot => ({
    used: history.length,
    max: trigger.maxPerViewer,
    windowMs: trigger.windowMs,
    nextAt: history.length ? (history[0] ?? at) + trigger.windowMs : null,
  });
  const decision = (
    id: string,
    code: DecisionCode,
    extra: {
      effects?: ProjectileEffect[];
      viewerId?: string;
      at?: number;
      allowance?: AllowanceSnapshot;
      reason?: string;
    } = {},
  ): ExecutionDecision => ({
    eventId: id,
    artifactId,
    code,
    reason: extra.reason ?? DECISION_MESSAGES[code],
    effects: extra.effects ?? [],
    mode,
    viewerId: extra.viewerId ?? null,
    at: extra.at ?? null,
    allowance: extra.allowance ?? null,
  });

  function spawn(): Promise<boolean> {
    const next = new Worker(new URL('./guest-worker.js', import.meta.url), {
      workerData: { artifact, program },
      execArgv: [],
    });
    next.unref();
    // Uncaught worker errors surface as 'exit'; never let them crash the host.
    next.on('error', () => undefined);
    worker = next;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), HOST_LIMITS.workerStartupMs);
      next.once('message', (raw: unknown) => {
        clearTimeout(timeout);
        resolve(
          z
            .object({ type: z.literal('ready') })
            .strict()
            .safeParse(raw).success,
        );
      });
      next.once('error', () => resolve(false));
      next.once('exit', () => resolve(false));
    });
  }
  function discardWorker() {
    const current = worker;
    worker = undefined;
    ready = undefined;
    void current?.terminate();
  }
  async function execute(event: z.infer<typeof eventSchema>, eventSeed: number) {
    ready ??= spawn();
    if (!(await ready) || !worker) {
      discardWorker();
      return null;
    }
    const current = worker;
    const id = ++jobs;
    return new Promise<WorkerReply | null>((resolve) => {
      let settled = false;
      const finish = (reply: WorkerReply | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        current.off('message', onMessage);
        current.off('exit', onExit);
        abortActive = undefined;
        resolve(reply);
      };
      const onMessage = (raw: unknown) => {
        const parsed = workerReply.safeParse(raw);
        if (parsed.success && parsed.data.id === id) finish(parsed.data);
        else if (!parsed.success) finish(null);
      };
      const onExit = () => finish(null);
      // A wall-clock overrun means the worker may be wedged: kill it, never reuse it.
      const timeout = setTimeout(() => {
        discardWorker();
        finish(null);
      }, HOST_LIMITS.wallTimeoutMs);
      abortActive = () => {
        discardWorker();
        finish(null);
      };
      current.on('message', onMessage);
      current.once('exit', onExit);
      current.postMessage({ id, event, seed: eventSeed });
    });
  }
  function forget(at: number) {
    if (mode === 'live') {
      for (const [id, seenAt] of state.seen) {
        if (seenAt > at - HOST_LIMITS.dedupeWindowMs && state.seen.size < 50_000) break;
        state.seen.delete(id);
      }
    }
  }

  async function run(raw: unknown): Promise<ExecutionDecision> {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      const id = z.object({ id: z.string().max(100) }).safeParse(raw);
      return decision(id.success ? id.data.id : '', 'INVALID_EVENT');
    }
    const event = parsed.data;
    const base = { viewerId: event.viewerId, at: event.at };
    if (stopped) return decision(event.id, 'STOPPED', base);
    if (disabled) return decision(event.id, 'DISABLED', base);
    if (state.channelId && state.channelId !== event.channelId)
      return decision(event.id, 'INVALID_EVENT', base);
    if (state.seen.has(event.id)) return decision(event.id, 'DUPLICATE', base);
    if (event.at < state.lastAt) return decision(event.id, 'INVALID_EVENT', base);
    forget(event.at);
    if (mode === 'preview' && state.seen.size >= HOST_LIMITS.previewEvents)
      return decision(event.id, 'CAPACITY', base);
    state.channelId = event.channelId;
    state.lastAt = event.at;
    state.seen.set(event.id, event.at);
    if (!matchesCommand(event.text, trigger.command)) return decision(event.id, 'UNRELATED', base);
    if (!event.roles.some((role) => trigger.audience.includes(role)))
      return decision(event.id, 'AUDIENCE', base);
    const history = (state.viewers.get(event.viewerId) ?? []).filter(
      (at) => at > event.at - trigger.windowMs,
    );
    state.viewers.set(event.viewerId, history);
    if (history.length >= trigger.maxPerViewer)
      return decision(event.id, 'VIEWER_LIMIT', {
        ...base,
        allowance: allowance(history, event.at),
      });
    state.effects = state.effects.filter((at) => at > event.at - 60_000);
    const shared = options.channelBudget;
    if (shared) shared.effects = shared.effects.filter((at) => at > event.at - 60_000);
    const remaining = Math.min(
      limits.effectsPerMinute - state.effects.length,
      shared ? shared.perMinute - shared.effects.length : Infinity,
    );
    if (remaining <= 0)
      return decision(event.id, 'CHANNEL_LIMIT', {
        ...base,
        allowance: allowance(history, event.at),
      });
    const eventSeed =
      createHash('sha256').update(`${seed}:${event.id}`).digest().readUInt32LE() || 1;
    const reply = await execute(event, eventSeed);
    if (stopped) return decision(event.id, 'STOPPED', base);
    if (reply) lastCpuMicros = reply.cpuMicros;
    if (!reply?.ok || reply.effects.length > limits.effectsPerEvent) {
      disabled = true;
      discardWorker();
      incident = {
        eventId: event.id,
        fault: reply?.fault ?? 'Exceeded the wall-clock, startup or worker limits',
      };
      options.onIncident?.(incident);
      return decision(event.id, 'INCIDENT', {
        ...base,
        reason: `${DECISION_MESSAGES.INCIDENT} Cause: ${incident.fault}.`,
      });
    }
    if (reply.effects.length > remaining)
      return decision(event.id, 'CHANNEL_LIMIT', {
        ...base,
        allowance: allowance(history, event.at),
      });
    if (reply.effects.length) {
      history.push(event.at);
      state.effects.push(...reply.effects.map(() => event.at));
      shared?.effects.push(...reply.effects.map(() => event.at));
    }
    return decision(event.id, 'ACCEPTED', {
      ...base,
      effects: reply.effects,
      allowance: allowance(history, event.at),
    });
  }
  return {
    artifactId,
    mode,
    get status(): 'ready' | 'quarantined' | 'stopped' {
      return stopped ? 'stopped' : disabled ? 'quarantined' : 'ready';
    },
    get incident() {
      return incident;
    },
    get lastCpuMicros() {
      return lastCpuMicros;
    },
    /** Serialize admission and run the guest. Example: await engine.dispatch(event). */
    dispatch(event: unknown): Promise<ExecutionDecision> {
      const next = queue.then(() => run(event));
      queue = next.catch(() => undefined);
      return next;
    },
    /** Pre-start the worker so the first event does not pay WASM startup. */
    async warm() {
      ready ??= spawn();
      return ready;
    },
    /** Fence queued and in-flight effects and release the worker. Example: engine.stop(). */
    stop() {
      stopped = true;
      abortActive?.();
      discardWorker();
    },
  };
}

/** Private rehearsal engine. Example: const engine = createPreviewEngine(artifact, 42). */
export function createPreviewEngine(candidate: unknown, seed: number) {
  return createEngine(candidate, { seed, mode: 'preview' });
}
