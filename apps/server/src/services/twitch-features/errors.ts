import { TwitchError } from '@riff/twitch';

export type RiffErrorCode =
  | 'NOT_CONNECTED'
  | 'SCOPE_MISSING'
  | 'FEATURE_DISABLED'
  | 'NOT_ELIGIBLE'
  | 'POLICY_DENIED'
  | 'LIMIT_EXCEEDED'
  | 'COOLDOWN'
  | 'POLL_ACTIVE'
  | 'NO_ACTIVE_POLL'
  | 'STOPPED'
  | 'INVALID_REQUEST'
  | 'TWITCH_REJECTED'
  | 'TWITCH_UNAVAILABLE';

/** Typed failure: `message` is user-safe and says what to do; `detail` is for logs only. */
export class RiffError extends Error {
  override readonly name = 'RiffError';
  constructor(
    readonly code: RiffErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const HTTP_STATUS: Record<RiffErrorCode, number> = {
  NOT_CONNECTED: 409,
  SCOPE_MISSING: 403,
  FEATURE_DISABLED: 409,
  NOT_ELIGIBLE: 403,
  POLICY_DENIED: 403,
  LIMIT_EXCEEDED: 429,
  COOLDOWN: 429,
  POLL_ACTIVE: 409,
  NO_ACTIVE_POLL: 409,
  STOPPED: 423,
  INVALID_REQUEST: 400,
  TWITCH_REJECTED: 422,
  TWITCH_UNAVAILABLE: 503,
};

/** Map a Twitch boundary failure to a typed Riff error without leaking Twitch internals. */
export function fromTwitch(error: unknown): RiffError {
  if (error instanceof RiffError) return error;
  if (!(error instanceof TwitchError))
    return new RiffError('TWITCH_UNAVAILABLE', 'Twitch could not be reached. Try again shortly.');
  const detail = { endpoint: error.detail.endpoint, status: error.detail.status };
  switch (error.detail.reason) {
    case 'missing_scope':
      return new RiffError('SCOPE_MISSING', error.message, detail);
    case 'not_eligible':
      return new RiffError('NOT_ELIGIBLE', error.message, detail);
    case 'poll_active':
      return new RiffError('POLL_ACTIVE', error.message, detail);
    case 'poll_not_active':
      return new RiffError('NO_ACTIVE_POLL', error.message, detail);
    case 'cooldown':
      return new RiffError('COOLDOWN', error.message, detail);
    case 'invalid':
      return new RiffError(
        error.code === 'TWITCH_INVALID_REQUEST' ? 'INVALID_REQUEST' : 'TWITCH_REJECTED',
        error.message,
        detail,
      );
    case undefined:
      break;
    default:
      return new RiffError('TWITCH_REJECTED', error.message, detail);
  }
  if (error.code === 'TWITCH_UNAUTHORIZED')
    return new RiffError(
      'NOT_CONNECTED',
      'Twitch no longer accepts the saved sign-in. Reconnect Twitch, then try again.',
      detail,
    );
  if (error.code === 'TWITCH_FORBIDDEN')
    return new RiffError('SCOPE_MISSING', error.message, detail);
  if (error.code === 'TWITCH_REJECTED')
    return new RiffError('TWITCH_REJECTED', error.message, detail);
  if (error.code === 'TWITCH_INVALID_REQUEST')
    return new RiffError('INVALID_REQUEST', error.message, detail);
  return new RiffError(
    'TWITCH_UNAVAILABLE',
    'Twitch is unavailable or returned something unexpected. Nothing was retried; check Twitch before trying again.',
    detail,
  );
}
