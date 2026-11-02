import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { request } from '../../lib/api.js';

/**
 * Poll one private console projection and run one mutation at a time. A request epoch
 * keeps a slow poll from overwriting the state a mutation just returned.
 */
export function useFeature<S extends z.ZodType>(path: string, schema: S, intervalMs = 3000) {
  type State = z.infer<S>;
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const mutating = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const stamp = epoch.current;
      if (!mutating.current && document.visibilityState !== 'hidden')
        try {
          const next = schema.parse(await request('GET', path, undefined, c.signal));
          if (!c.signal.aborted && stamp === epoch.current) {
            setState(next);
            setLoadError('');
          }
        } catch {
          if (!c.signal.aborted && stamp === epoch.current)
            setLoadError('Status is unavailable. Check the Riff server connection.');
        }
      if (!c.signal.aborted) timer = setTimeout(() => void poll(), intervalMs);
    }
    void poll();
    return () => {
      c.abort();
      clearTimeout(timer);
      epoch.current++;
    };
  }, [path, schema, intervalMs]);
  /** POST a mutation; resolves true on success. `key` names the pending action for the UI. */
  const mutate = useCallback(
    async (key: string, url: string, body: unknown = {}) => {
      if (mutating.current) return false;
      mutating.current = true;
      epoch.current++;
      setBusy(key);
      setError('');
      try {
        const next = schema.parse(await request('POST', url, body, controller.current?.signal));
        if (!controller.current?.signal.aborted) setState(next);
        return true;
      } catch (e) {
        if (!controller.current?.signal.aborted)
          setError(e instanceof Error ? e.message : 'That did not work. Try again.');
        return false;
      } finally {
        mutating.current = false;
        if (!controller.current?.signal.aborted) setBusy(null);
      }
    },
    [schema],
  );
  return { state, loadError, error, setError, busy, mutate };
}
