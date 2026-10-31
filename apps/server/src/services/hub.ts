/** Console push messages. Every message is versioned; clients ignore unknown types. */
export interface ConsoleMessage {
  v: 1;
  type: 'run' | 'run-progress' | 'activity' | 'studio' | 'twitch';
  payload: unknown;
}
export type ConsoleListener = (message: ConsoleMessage) => void;

/** In-process fan-out to authenticated console sockets. */
export function createHub() {
  const listeners = new Set<ConsoleListener>();
  return {
    subscribe(listener: ConsoleListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(type: ConsoleMessage['type'], payload: unknown) {
      const message: ConsoleMessage = { v: 1, type, payload };
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          listeners.delete(listener);
        }
      }
    },
  };
}
export type Hub = ReturnType<typeof createHub>;
