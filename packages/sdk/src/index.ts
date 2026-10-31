/** Public SDK version. This foundation does not expose executable capabilities yet. */
export const SDK_VERSION = '0.1.0' as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Public policy ceilings; trusted hosts may impose stricter operational limits. */
export const HOST_LIMITS = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  handlerDeadlineMs: 50,
  wallTimeoutMs: 2000,
  bridgeCallsPerEvent: 25,
  stateBytes: 1024 * 1024,
});
