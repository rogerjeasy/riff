import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import { stateSchema, type RecipeState } from './contracts.js';

export type RecipeAction =
  | 'import'
  | 'remove'
  | 'profile'
  | 'adapt'
  | 'install'
  | 'export'
  | 'publish'
  | 'moderate'
  | 'restore';
export type Mutate = (
  action: RecipeAction,
  body: unknown,
  after?: (raw: Record<string, unknown>, next: RecipeState) => void,
) => Promise<void>;

/**
 * Private recipe state for the creator console. One request at a time; a request epoch
 * keeps a slow response from overwriting a newer one or reaching an unmounted panel.
 */
export function useRecipes() {
  const [state, setState] = useState<RecipeState | null>(null);
  const [busy, setBusy] = useState<RecipeAction | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false),
    epoch = useRef(0),
    working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const n = ++epoch.current;
    void request('GET', '/api/recipes', undefined, controller.signal)
      .then((raw) => {
        const next = z.object({ state: stateSchema }).parse(raw).state;
        if (mounted.current && epoch.current === n) setState(next);
      })
      .catch((e: unknown) => {
        if (mounted.current && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Recipe library unavailable.');
      });
    return () => {
      mounted.current = false;
      epoch.current++;
      controller.abort();
    };
  }, []);
  const mutate = useCallback<Mutate>(async (action, body, after) => {
    if (working.current) return;
    working.current = true;
    const n = ++epoch.current;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const raw = await request<Record<string, unknown>>('POST', `/api/recipes/${action}`, body);
      const next = z.object({ state: stateSchema }).parse(raw).state;
      if (mounted.current && epoch.current === n) {
        setState(next);
        after?.(raw, next);
      }
    } catch (e) {
      if (mounted.current && epoch.current === n)
        setError(e instanceof Error ? e.message : 'Recipe request failed.');
    } finally {
      working.current = false;
      if (mounted.current && epoch.current === n) setBusy(null);
    }
  }, []);
  return { state, busy, error, notice, setError, setNotice, mutate };
}
