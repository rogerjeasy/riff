import { parentPort, workerData } from 'node:worker_threads';
import { threadCpuUsage } from 'node:process';
import { DefaultIntrinsics, getQuickJS } from 'quickjs-emscripten';
import { MIGRATION_LIMITS } from './transition.js';
const init = workerData as { source: string; input: string };
const engine = await getQuickJS();
parentPort?.once('message', () => {
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(MIGRATION_LIMITS.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  const started = threadCpuUsage();
  runtime.setInterruptHandler(() => {
    const t = threadCpuUsage(started);
    return t.user + t.system >= MIGRATION_LIMITS.cpuMs * 1000;
  });
  const context = runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });
  try {
    // No callbacks or capability bridge is installed. Disable constructor recovery as
    // well as global code generation; freeze all input recursively before invocation.
    const program = `'use strict';
   const input=JSON.parse(${JSON.stringify(init.input)});
   const freeze=x=>{if(x&&typeof x==='object'){for(const k of Object.keys(x))freeze(x[k]);Object.freeze(x);}return x;};freeze(input);
   for(const fn of [function(){},async function(){},function*(){},async function*(){}]){Object.defineProperty(Object.getPrototypeOf(fn),'constructor',{value:undefined,writable:false,configurable:false});Object.freeze(Object.getPrototypeOf(fn));}
   globalThis.eval=undefined;globalThis.Function=undefined;Math.random=undefined;Object.freeze(Math);Object.freeze(globalThis);
   const migration=(${init.source});
   (async()=>JSON.stringify(await migration(input)))();`;
    // Dynamic import has no loader, but reject it outright even in unreachable paths.
    if (/\bimport\s*\(/.test(init.source)) throw new Error('Dynamic import forbidden');
    const result = context.evalCode(program);
    if (result.error) {
      result.error.dispose();
      throw new Error('Migration trapped');
    }
    try {
      let jobs = 0;
      while (runtime.hasPendingJob()) {
        if (++jobs > MIGRATION_LIMITS.jobs) throw new Error('Async budget exceeded');
        const pending = runtime.executePendingJobs(1);
        if (pending.error) {
          pending.error.dispose();
          throw new Error('Async migration failed');
        }
      }
      const state = context.getPromiseState(result.value);
      if (state.type !== 'fulfilled') {
        if (state.type === 'rejected') state.error.dispose();
        throw new Error('Migration did not settle');
      }
      const json = context.getString(state.value);
      state.value.dispose();
      if (Buffer.byteLength(json) > MIGRATION_LIMITS.outputBytes)
        throw new Error('Output budget exceeded');
      parentPort?.postMessage({ ok: true, json });
    } finally {
      result.value.dispose();
    }
  } catch {
    parentPort?.postMessage({ ok: false });
  } finally {
    context.dispose();
    runtime.dispose();
  }
});
parentPort?.postMessage('ready');
