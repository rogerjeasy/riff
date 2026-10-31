export type TwitchErrorCode =
  /** Twitch refused the request (4xx other than 401/403); retrying will not help. */
  | 'TWITCH_REJECTED'
  /** The token is missing, expired or revoked; the user must reconnect. */
  | 'TWITCH_UNAUTHORIZED'
  /** The token lacks a required scope or the user lacks authority. */
  | 'TWITCH_FORBIDDEN'
  /** Twitch was unreachable, rate limited or failing (5xx) after bounded retries. */
  | 'TWITCH_UNAVAILABLE'
  /** Twitch answered with a body that does not match the documented shape. */
  | 'TWITCH_INVALID_RESPONSE'
  /** The caller built a request this package refuses to send. */
  | 'TWITCH_INVALID_REQUEST';

/** Structured, log-safe detail. Never contains tokens, secrets or request bodies. */
export interface TwitchErrorDetail {
  readonly endpoint?: string;
  readonly status?: number;
  readonly attempts?: number;
  readonly twitchMessage?: string;
  readonly retryAfterMs?: number;
  readonly issues?: readonly string[];
}

/**
 * Typed error for every Twitch boundary failure. `message` is user-safe;
 * `detail` is for logs and is built only from status codes and Twitch's own
 * error text, never from credentials.
 */
export class TwitchError extends Error {
  override readonly name = 'TwitchError';
  readonly code: TwitchErrorCode;
  readonly detail: TwitchErrorDetail;

  constructor(code: TwitchErrorCode, message: string, detail: TwitchErrorDetail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** Map a non-retryable HTTP status to a typed error. */
export function errorForStatus(
  status: number,
  endpoint: string,
  twitchMessage: string | undefined,
  attempts = 1,
): TwitchError {
  const detail: TwitchErrorDetail = {
    endpoint,
    status,
    attempts,
    ...(twitchMessage === undefined ? {} : { twitchMessage }),
  };
  if (status === 401)
    return new TwitchError(
      'TWITCH_UNAUTHORIZED',
      'Twitch did not accept the saved authorization. Reconnect the Twitch account.',
      detail,
    );
  if (status === 403)
    return new TwitchError(
      'TWITCH_FORBIDDEN',
      'Twitch says this account lacks a required permission. Reconnect and approve the requested scopes.',
      detail,
    );
  if (status === 429 || status >= 500)
    return new TwitchError(
      'TWITCH_UNAVAILABLE',
      'Twitch is busy or unavailable right now. Try again in a moment.',
      detail,
    );
  return new TwitchError('TWITCH_REJECTED', 'Twitch rejected the request.', detail);
}
