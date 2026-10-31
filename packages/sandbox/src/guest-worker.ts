import { threadCpuUsage } from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';
import {
  DefaultIntrinsics,
  getQuickJS,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { HOST_LIMITS } from '@riff/sdk';
import { z } from 'zod';
import { artifactSchema, eventSchema, effectSchema } from './contract.js';

// One worker serves one engine (one artifact, one mode). The WASM module is loaded
// once, but every job gets a brand-new QuickJS runtime and context that is disposed
// afterwards: no heap, global, closure or handle survives into the next event.
const init = z
  .object({ artifact: artifactSchema, program: z.string().max(131072) })
  .strict()
  .parse(workerData);
const job = z.object({ id: z.number().int(), event: eventSchema, seed: z.number().int() }).strict();
type Effect = z.infer<typeof effectSchema>;

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
      if (effects.length >= init.artifact.manifest.limits.effectsPerEvent) {
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
    // The host installs the only bridge, then removes its global alias. Guest source
    // is an expression, compiled by QuickJS itself; it is never evaluated by Node.
    const setup = context.evalCode(`
      const riff = (() => {
        const emit = __emit;
        delete globalThis.__emit;
        let seed = ${input.seed} >>> 0;
        const util = Object.freeze({ now: () => ${input.event.at}, random: () => {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          return (seed >>> 0) / 4294967296;
        }});
        return Object.freeze({util, overlay: Object.freeze({emit: async value => emit(JSON.stringify(value))})});
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
    return { ok: true, effects, cpuMicros: usage.user + usage.system, fault: null };
  } catch (error) {
    return {
      ok: false,
      effects: [],
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
      cpuMicros: 0,
      fault: 'Invalid job',
    });
    return;
  }
  parentPort?.postMessage({ type: 'result', id: parsed.data.id, ...execute(engine, parsed.data) });
});
parentPort?.postMessage({ type: 'ready' });
