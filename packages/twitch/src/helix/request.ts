import type { z } from 'zod';
import { TwitchError } from '../errors.js';
import { issuePaths } from '../http.js';

export type HelixMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export interface HelixRequestOptions {
  /**
   * Retry 5xx answers. Defaults to true; non-idempotent creations pass false because a
   * server error may follow an applied mutation (AGENTS §2.4). 429 is always retried.
   */
  readonly retryServerErrors?: boolean;
  /** Override the client's retry ceiling; 0 attempts a mutation exactly once. */
  readonly retries?: number;
}
/** The single transport built by `createHelixClient`; endpoint modules only shape paths and bodies. */
export type HelixRequest = (
  method: HelixMethod,
  path: string,
  endpointName: string,
  body?: unknown,
  options?: HelixRequestOptions,
) => Promise<unknown>;

export function invalidRequest(message: string, endpoint: string): TwitchError {
  return new TwitchError('TWITCH_INVALID_REQUEST', message, { endpoint });
}

/** Parse a response or fail with a typed error that never echoes values. */
export function parseResponse<T extends z.ZodType>(
  schema: T,
  payload: unknown,
  endpoint: string,
): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new TwitchError('TWITCH_INVALID_RESPONSE', 'Twitch returned an unexpected response.', {
      endpoint,
      issues: issuePaths(parsed.error),
    });
  return parsed.data;
}

/** Build a query string from repeated parameters, omitting undefined values. */
export function query(params: readonly (readonly [string, string | undefined])[]): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) if (value !== undefined) search.append(key, value);
  return search.size ? `?${search.toString()}` : '';
}
