import { threadCpuUsage } from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';
import { DefaultIntrinsics, getQuickJS, type QuickJSHandle } from 'quickjs-emscripten';
import { HOST_LIMITS } from '@riff/sdk';
import { z } from 'zod';
import { artifactSchema, eventSchema, effectSchema } from './contract.js';

const input = z
  .object({
    artifact: artifactSchema,
    event: eventSchema,
    seed: z.number().int(),
    program: z.string().max(131072),
  })
  .parse(workerData);
const engine = await getQuickJS();
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
const effects: z.infer<typeof effectSchema>[] = [];
let fault = false;
let ok = false;
let calls = 0;
const observations: QuickJSHandle[] = [];
try {
  const reportFault = context.newFunction('fault', () => {
    fault = true;
    return context.undefined;
  });
  context.setProp(context.global, '__riffFault', reportFault);
  reportFault.dispose();
  const observe = context.newFunction('observe', (value) => {
    if (observations.length >= HOST_LIMITS.observedResultsPerEvent) {
      fault = true;
      throw new Error('Call result budget exceeded');
    }
    observations.push(value.dup());
    return value;
  });
  context.setProp(context.global, '__riffObserve', observe);
  observe.dispose();
  const emit = context.newFunction('emit', (value) => {
    calls++;
    if (
      calls > HOST_LIMITS.bridgeCallsPerEvent ||
      !input.artifact.manifest.capabilities.includes('overlay') ||
      effects.length >= input.artifact.manifest.limits.effectsPerEvent
    ) {
      fault = true;
      throw new Error('Capability or resource limit rejected');
    }
    const serialized = context.getString(value);
    if (serialized.length > 1024) {
      fault = true;
      throw new Error('Payload too large');
    }
    try {
      effects.push(effectSchema.parse(JSON.parse(serialized)));
    } catch {
      fault = true;
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
  parentPort?.postMessage({ type: 'ready' });
  started = threadCpuUsage();
  const result = context.unwrapResult(context.evalCode(`'use strict'; ${input.program}`));
  try {
    let jobs = 0;
    while (runtime.hasPendingJob()) {
      if (++jobs > HOST_LIMITS.pendingJobsPerEvent || exhausted())
        throw new Error('Job budget exceeded');
      const job = runtime.executePendingJobs(1);
      if (job.error) {
        job.error.dispose();
        throw new Error('Guest job failed');
      }
    }
    for (const observation of observations) {
      const observed = context.getPromiseState(observation);
      if (observed.type === 'pending') throw new Error('Detached pending work');
      if (observed.type === 'rejected') {
        observed.error.dispose();
        throw new Error('Detached rejection');
      }
      if (!observed.notAPromise) observed.value.dispose();
    }
    const state = context.getPromiseState(result);
    if (state.type === 'pending') throw new Error('Unsettled handler');
    if (state.type === 'rejected') {
      state.error.dispose();
      throw new Error('Handler rejected');
    }
    if (!state.notAPromise) state.value.dispose();
    if (fault) throw new Error('Bridge rejected');
    ok = true;
  } finally {
    result.dispose();
  }
} catch {
  ok = false;
} finally {
  for (const observation of observations) observation.dispose();
  context.dispose();
  runtime.dispose();
}
parentPort?.postMessage({ ok, effects: ok ? effects : [] });
parentPort?.close();
