import { useEffect, useRef, useState, type SetStateAction } from 'react';

/** Owns complete list reads and committed deltas for one private library. */
export function usePrivateLibrary<T>(
  read: (signal?: AbortSignal) => Promise<T[]>,
  label: 'Scenario' | 'Regression',
) {
  const [items, setItems] = useState<T[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  function publish(update: SetStateAction<T[]>) {
    generation.current++;
    setItems(update);
  }
  async function refresh(committed = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const own = ++generation.current;
    setRefreshError(null);
    setRefreshing(true);
    try {
      const complete = await read(controller.signal);
      if (!controller.signal.aborted && generation.current === own) publish(complete);
    } catch {
      if (!controller.signal.aborted && generation.current === own)
        setRefreshError(
          committed
            ? `${label} change committed, but library refresh failed. Retry the library to see all saved records.`
            : `${label} library refresh failed. Retry the library to see all saved records.`,
        );
    } finally {
      if (request.current === controller && !controller.signal.aborted) setRefreshing(false);
    }
  }
  function commit(update: SetStateAction<T[]>) {
    // Keep the acknowledged change usable even if its complete-list read fails.
    publish(update);
    void refresh(true);
  }
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [read, label]);
  return { items, commit, refresh, refreshError, refreshing };
}
