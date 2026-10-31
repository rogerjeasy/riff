import { expect, it } from 'vitest';
import { getQuickJS } from 'quickjs-emscripten';

it('loads the installed WASM engine and disposes a trusted diagnostic context', async () => {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  const context = runtime.newContext();
  try {
    const value = context.unwrapResult(context.evalCode('20 + 22'));
    try {
      expect(context.getNumber(value)).toBe(42);
    } finally {
      value.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
});
