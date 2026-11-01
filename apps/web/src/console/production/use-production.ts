import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import { stateSchema, type ProductionState } from './contracts.js';
export function useProduction() {
  const [state, setState] = useState<ProductionState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null),
    epoch = useRef(0),
    mutating = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const stamp = epoch.current;
      if (!mutating.current)
        try {
          const next = z
            .object({ state: stateSchema })
            .parse(await request('GET', '/api/production', undefined, c.signal));
          if (!c.signal.aborted && stamp === epoch.current) setState(next.state);
        } catch {
          if (!c.signal.aborted && stamp === epoch.current)
            setError('Production status is unavailable. Check the host connection.');
        } finally {
          if (!c.signal.aborted) timer = setTimeout(() => void poll(), 2000);
        }
      else if (!c.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      c.abort();
      clearTimeout(timer);
      epoch.current++;
    };
  }, []);
  /**
   * One serialized production request. The response is parsed with `schema`; when it
   * carries a production state, that state replaces the polled one.
   */
  async function send<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    options: { quiet?: boolean } = {},
  ): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    if (mutating.current) return { ok: false, message: 'Another production change is running.' };
    mutating.current = true;
    epoch.current++;
    setBusy(true);
    if (!options.quiet) setError('');
    try {
      const value = schema.parse(
        await request('POST', '/api/production/' + path, body, controller.current?.signal),
      );
      const next = stateSchema.safeParse((value as { state?: unknown } | null)?.state);
      if (next.success && !controller.current?.signal.aborted) setState(next.data);
      return { ok: true, value };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Production operation failed.';
      if (!controller.current?.signal.aborted && !options.quiet) setError(message);
      return { ok: false, message };
    } finally {
      mutating.current = false;
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  async function mutate(path: string, body: unknown) {
    return (await send(path, body, z.object({ state: stateSchema }))).ok;
  }
  return { state, busy, error, mutate, send };
}
