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
  async function mutate(path: string, body: unknown) {
    if (mutating.current) return false;
    mutating.current = true;
    epoch.current++;
    setBusy(true);
    setError('');
    try {
      const next = z
        .object({ state: stateSchema })
        .parse(await request('POST', '/api/production/' + path, body, controller.current?.signal));
      if (!controller.current?.signal.aborted) setState(next.state);
      return true;
    } catch (e) {
      if (!controller.current?.signal.aborted)
        setError(e instanceof Error ? e.message : 'Production operation failed.');
      return false;
    } finally {
      mutating.current = false;
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  return { state, busy, error, mutate };
}
