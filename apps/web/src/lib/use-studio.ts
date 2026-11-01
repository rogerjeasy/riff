import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import type { Activity, Progress, Run, Studio, TwitchStatus } from './types.js';

type Connection = 'connecting' | 'online' | 'offline';

/**
 * One source of truth for the console: an HTTP snapshot plus a push socket that
 * streams run progress, activity and invalidations. Reconnects with backoff.
 */
export function useStudio() {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  // Hosted instances answer SIGNED_OUT until the browser has a console session.
  const [signedOut, setSignedOut] = useState(false);
  const refreshing = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      try {
        const next = await api.studio();
        setStudio(next);
        setRuns((current) => {
          const merged = { ...current };
          for (const run of next.runs)
            merged[run.id] = { ...run, progress: current[run.id]?.progress ?? run.progress };
          return merged;
        });
        setError(null);
        setSignedOut(false);
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'SIGNED_OUT') setSignedOut(true);
        setError(cause instanceof ApiError ? cause.message : 'Could not load the studio.');
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, []);

  useEffect(() => {
    void refresh();
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const open = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws/console`);
      socket.onopen = () => {
        retry = 0;
        setConnection('online');
        void refresh();
      };
      socket.onmessage = (event) => {
        let message: { v?: number; type?: string; payload?: unknown };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        if (message.v !== 1) return;
        if (message.type === 'run') {
          const run = message.payload as Run;
          setRuns((current) => {
            const known = current[run.id]?.progress ?? [];
            return {
              ...current,
              [run.id]: {
                ...run,
                progress: known.length > run.progress.length ? known : run.progress,
              },
            };
          });
          if (run.result) void refresh();
        } else if (message.type === 'run-progress') {
          const { id, entry } = message.payload as { id: string; entry: Progress };
          setRuns((current) => {
            const run = current[id];
            return run
              ? { ...current, [id]: { ...run, progress: [...run.progress.slice(-39), entry] } }
              : current;
          });
        } else if (message.type === 'activity') {
          const entry = message.payload as Activity;
          setStudio((current) =>
            current
              ? {
                  ...current,
                  activity: [entry, ...current.activity.filter((a) => a.id !== entry.id)].slice(
                    0,
                    60,
                  ),
                }
              : current,
          );
        } else if (message.type === 'twitch') {
          const status = message.payload as TwitchStatus;
          setStudio((current) =>
            current
              ? {
                  ...current,
                  twitch: { ...status, configured: current.twitch.configured } as TwitchStatus,
                }
              : current,
          );
        } else if (message.type === 'studio') void refresh();
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnection('offline');
        retry = Math.min(retry + 1, 5);
        timer = setTimeout(open, 400 * 2 ** retry);
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [refresh]);

  return { studio, runs, connection, error, signedOut, refresh, setRuns };
}
