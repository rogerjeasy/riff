import { threadCpuUsage } from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';
import {
  DefaultIntrinsics,
  getQuickJS,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { ACTION_CAPABILITY, HOST_LIMITS, TWITCH_ACTION_LIMITS } from '@riff/sdk';
import { z } from 'zod';
import { sessionSnapshotSchema } from './session.js';
import { actionSchema, artifactSchema, eventSchema, effectSchema } from './contract.js';

// One worker serves one engine (one artifact, one mode). The WASM module is loaded
// once, but every job gets a brand-new QuickJS runtime and context that is disposed
// afterwards: no heap, global, closure or handle survives into the next event.
const init = z
  .object({ artifact: artifactSchema, program: z.string().max(131072) })
  .strict()
  .parse(workerData);
const job = z
  .object({
    id: z.number().int(),
    event: eventSchema,
    seed: z.number().int(),
    session: sessionSnapshotSchema.nullable(),
  })
  .strict();
type Effect = z.infer<typeof effectSchema>;
type Action = z.infer<typeof actionSchema>;

function execute(engine: QuickJSWASMModule, input: z.infer<typeof job>) {
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(HOST_LIMITS.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  let started: ReturnType<typeof threadCpuUsage> | undefined;
  const exhausted = () => {
    if (!started) return false;
    const usage = threadCpuUsage(started);
    return usage.user + usage.system >= HOST_LIMITS.handlerDeadlineMs * 1000;
  };
  // Measure the worker's own CPU so scheduler pauses or other workers do not
  // consume this handler's allowance. The parent independently bounds wall time.
  runtime.setInterruptHandler(exhausted);
  const context = runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });
  const effects: Effect[] = [];
  const actions: Action[] = [];
  const observations: QuickJSHandle[] = [];
  let fault: string | null = null;
  let calls = 0;
  try {
    const reportFault = context.newFunction('fault', () => {
      fault ??= 'Handler raised an error';
      return context.undefined;
    });
    context.setProp(context.global, '__riffFault', reportFault);
    reportFault.dispose();
    const observe = context.newFunction('observe', (value) => {
      if (observations.length >= HOST_LIMITS.observedResultsPerEvent) {
        fault ??= 'Call result budget exceeded';
        throw new Error('Call result budget exceeded');
      }
      observations.push(value.dup());
      return value;
    });
    context.setProp(context.global, '__riffObserve', observe);
    observe.dispose();
    const emit = context.newFunction('emit', (value) => {
      calls++;
      if (calls > HOST_LIMITS.bridgeCallsPerEvent) {
        fault ??= 'Bridge call budget exceeded';
        throw new Error('Capability or resource limit rejected');
      }
      if (!init.artifact.manifest.capabilities.includes('overlay')) {
        fault ??= 'Used undeclared capability overlay';
        throw new Error('Capability or resource limit rejected');
      }
      if (effects.length + actions.length >= init.artifact.manifest.limits.effectsPerEvent) {
        fault ??= 'Exceeded declared effects per event';
        throw new Error('Capability or resource limit rejected');
      }
      const serialized = context.getString(value);
      if (serialized.length > 1024) {
        fault ??= 'Effect payload too large';
        throw new Error('Payload too large');
      }
      try {
        effects.push(effectSchema.parse(JSON.parse(serialized)));
      } catch {
        fault ??= 'Effect failed validation';
        throw new Error('Invalid effect');
      }
      return context.undefined;
    });
    context.setProp(context.global, '__emit', emit);
    emit.dispose();
    // Native Twitch actions are staged, never executed here: manifest → per-event limits.
    // Channel budgets and Twitch hard caps are applied later by the live host only.
    const act = context.newFunction('act', (value) => {
      calls++;
      const serialized = context.getString(value);
      let action: Action;
      try {
        if (serialized.length > 2048) throw new Error('Payload too large');
        action = actionSchema.parse(JSON.parse(serialized));
      } catch {
        fault ??= 'Native Twitch action failed validation';
        throw new Error('Invalid action');
      }
      const capability = ACTION_CAPABILITY[action.kind];
      if (calls > HOST_LIMITS.bridgeCallsPerEvent) {
        fault ??= 'Bridge call budget exceeded';
        throw new Error('Capability or resource limit rejected');
      }
      if (!init.artifact.manifest.capabilities.includes(capability)) {
        fault ??= `Used undeclared capability ${capability}`;
        throw new Error('Capability or resource limit rejected');
      }
      const sameFamily = actions.filter((a) => ACTION_CAPABILITY[a.kind] === capability).length;
      if (
        actions.length >= TWITCH_ACTION_LIMITS.perEvent ||
        effects.length + actions.length >= init.artifact.manifest.limits.effectsPerEvent ||
        (capability !== 'chat.announce' && sameFamily >= 1)
      ) {
        fault ??= 'Exceeded native Twitch actions per event';
        throw new Error('Capability or resource limit rejected');
      }
      actions.push(action);
      return context.undefined;
    });
    context.setProp(context.global, '__act', act);
    act.dispose();
    const snapshot = context.newFunction('snapshot', () => {
      calls++;
      if (
        calls > HOST_LIMITS.bridgeCallsPerEvent ||
        !init.artifact.manifest.capabilities.includes('session') ||
        !input.session
      ) {
        fault ??= 'Undeclared or unavailable session capability';
        throw new Error(fault);
      }
      return context.newString(JSON.stringify(input.session));
    });
    context.setProp(context.global, '__sessionSnapshot', snapshot);
    snapshot.dispose();
    // The host installs the only bridge, then removes its global alias. Guest source
    // is an expression, compiled by QuickJS itself; it is never evaluated by Node.
    const setup = context.evalCode(`
      const riff = (() => {
        const emit = __emit;
        const act = __act;
        delete globalThis.__act;
        const stage = value => act(JSON.stringify(value));
        const polls = Object.freeze({
          start: async poll => stage({...(poll && typeof poll === 'object' ? poll : {}), kind: 'poll.start'}),
          end: async () => stage({kind: 'poll.end'}),
        });
        const chat = Object.freeze({
          announce: async a => stage({...(a && typeof a === 'object' ? a : {}), kind: 'announce'}),
        });
        const shoutout = Object.freeze({
          send: async target => stage({...(target && typeof target === 'object' ? target : {}), kind: 'shoutout'}),
        });
        const snapshot = __sessionSnapshot;
        delete globalThis.__sessionSnapshot;
        const freeze = value => {
          if(value && typeof value === 'object') {for(const key of Object.keys(value)) freeze(value[key]);Object.freeze(value);}
          return value;
        };
        const session = Object.freeze({snapshot: () => freeze(JSON.parse(snapshot()))});
        delete globalThis.__emit;
        let seed = ${input.seed} >>> 0;
        const util = Object.freeze({ now: () => ${input.event.at}, random: () => {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          return (seed >>> 0) / 4294967296;
        }});
        return Object.freeze({util, session, polls, chat, shoutout, overlay: Object.freeze({emit: async value => emit(JSON.stringify(value))})});
      })();
      const event = Object.freeze(${JSON.stringify(input.event)});
      for (const fn of [function(){}, async function(){}, function*(){}, async function*(){}]) {
        Object.defineProperty(Object.getPrototypeOf(fn), 'constructor', {value:undefined, writable:false, configurable:false});
        Object.freeze(Object.getPrototypeOf(fn));
      }
      globalThis.eval = undefined;
      globalThis.Function = undefined;
      Math.random = undefined;
      Object.freeze(Math);
      Object.freeze(globalThis);
    `);
    context.unwrapResult(setup).dispose();
    started = threadCpuUsage();
    const evaluated = context.evalCode(`'use strict'; ${init.program}`);
    if (evaluated.error) {
      evaluated.error.dispose();
      throw new Error(exhausted() ? 'CPU budget exceeded' : 'Handler threw or exceeded memory');
    }
    const result = evaluated.value;
    try {
      let jobs = 0;
      while (runtime.hasPendingJob()) {
        if (++jobs > HOST_LIMITS.pendingJobsPerEvent) throw new Error('Async job budget exceeded');
        if (exhausted()) throw new Error('CPU budget exceeded');
        const pending = runtime.executePendingJobs(1);
        if (pending.error) {
          pending.error.dispose();
          throw new Error(exhausted() ? 'CPU budget exceeded' : 'Async handler work failed');
        }
      }
      for (const observation of observations) {
        const observed = context.getPromiseState(observation);
        if (observed.type === 'pending') throw new Error('Left detached work pending');
        if (observed.type === 'rejected') {
          observed.error.dispose();
          throw new Error(fault ?? 'Detached work rejected');
        }
        if (!observed.notAPromise) observed.value.dispose();
      }
      const state = context.getPromiseState(result);
      if (state.type === 'pending') throw new Error('Handler never settled');
      if (state.type === 'rejected') {
        state.error.dispose();
        throw new Error(fault ?? 'Handler rejected');
      }
      if (!state.notAPromise) state.value.dispose();
      if (fault) throw new Error(fault);
    } finally {
      result.dispose();
    }
    const usage = threadCpuUsage(started);
    return { ok: true, effects, actions, cpuMicros: usage.user + usage.system, fault: null };
  } catch (error) {
    return {
      ok: false,
      effects: [],
      actions: [],
      cpuMicros: started ? (({ user, system }) => user + system)(threadCpuUsage(started)) : 0,
      fault: fault ?? (error instanceof Error ? error.message.slice(0, 160) : 'Execution failed'),
    };
  } finally {
    for (const observation of observations) observation.dispose();
    context.dispose();
    runtime.dispose();
  }
}

const engine = await getQuickJS();
parentPort?.on('message', (raw: unknown) => {
  const parsed = job.safeParse(raw);
  if (!parsed.success) {
    parentPort?.postMessage({
      type: 'result',
      id: -1,
      ok: false,
      effects: [],
      actions: [],
      cpuMicros: 0,
      fault: 'Invalid job',
    });
    return;
  }
  parentPort?.postMessage({ type: 'result', id: parsed.data.id, ...execute(engine, parsed.data) });
});
parentPort?.postMessage({ type: 'ready' });
