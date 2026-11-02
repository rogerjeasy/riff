import { TwitchError } from '@riff/twitch';
import type { TwitchApi, TwitchFeature } from './connection.js';

/** Typed, user-safe failures for Channel Points and Predictions services. */
export class FeatureError extends Error {
  constructor(
    readonly code:
      | 'INVALID'
      | 'NOT_FOUND'
      | 'NOT_CONNECTED'
      | 'CONSENT'
      | 'INELIGIBLE'
      | 'OWNERSHIP'
      | 'CONFLICT'
      | 'BLOCKED'
      | 'TWITCH',
    message: string,
  ) {
    super(message);
  }
}
export const FEATURE_STATUS: Record<FeatureError['code'], number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  NOT_CONNECTED: 409,
  CONSENT: 403,
  INELIGIBLE: 403,
  OWNERSHIP: 403,
  CONFLICT: 409,
  BLOCKED: 423,
  TWITCH: 502,
};

export type Eligibility = 'affiliate' | 'partner' | 'ineligible' | 'unknown';
export interface FeatureAccess {
  /** Current host Helix access; null when Twitch is not connected. */
  api: () => TwitchApi | null;
  configured: boolean;
}
export const consentUrl = (feature: TwitchFeature) => `/auth/twitch?features=${feature}`;

/**
 * Channel Points and Predictions require an Affiliate or Partner broadcaster. Twitch
 * reports it as Get Users `broadcaster_type` ("affiliate", "partner" or "").
 * Docs: https://dev.twitch.tv/docs/api/reference/#get-users
 */
export function createEligibility(access: FeatureAccess, now: () => number) {
  let cached: { broadcasterId: string; value: Eligibility; at: number } | null = null;
  return {
    get(): Eligibility {
      const api = access.api();
      return api && cached?.broadcasterId === api.broadcasterId ? cached.value : 'unknown';
    },
    async refresh(force = false): Promise<Eligibility> {
      const api = access.api();
      if (!api) return 'unknown';
      if (!force && cached?.broadcasterId === api.broadcasterId && now() - cached.at < 600_000)
        return cached.value;
      try {
        const [user] = await api.helix.getUsers({ ids: [api.broadcasterId] });
        const type = user?.broadcasterType;
        const value: Eligibility =
          type === 'affiliate' || type === 'partner' ? type : user ? 'ineligible' : 'unknown';
        cached = { broadcasterId: api.broadcasterId, value, at: now() };
        return value;
      } catch {
        return cached?.value ?? 'unknown';
      }
    },
  };
}

/** Require a connected, consented and eligible channel before any Helix mutation. */
export function requireAccess(
  access: FeatureAccess,
  scopes: readonly string[],
  eligibility: Eligibility,
  feature: TwitchFeature,
): TwitchApi {
  const api = access.api();
  if (!api) throw new FeatureError('NOT_CONNECTED', 'Connect Twitch first.');
  if (!scopes.every((scope) => api.scopes.includes(scope)))
    throw new FeatureError(
      'CONSENT',
      feature === 'channel-points'
        ? 'Approve Channel Points access on Twitch first (Connect Channel Points).'
        : 'Approve Predictions access on Twitch first (Connect Predictions).',
    );
  if (eligibility === 'ineligible')
    throw new FeatureError(
      'INELIGIBLE',
      'Twitch offers Channel Points and Predictions only to Affiliate and Partner channels.',
    );
  return api;
}

/** Translate Twitch boundary errors into user-safe feature errors. */
export function twitchFailure(error: unknown): FeatureError {
  if (error instanceof FeatureError) return error;
  if (error instanceof TwitchError) {
    if (error.code === 'TWITCH_FORBIDDEN') return new FeatureError('OWNERSHIP', error.message);
    if (error.code === 'TWITCH_INVALID_REQUEST') return new FeatureError('INVALID', error.message);
    if (error.code === 'TWITCH_REJECTED')
      return new FeatureError(
        'CONFLICT',
        error.detail.twitchMessage
          ? `Twitch rejected the request: ${error.detail.twitchMessage}`
          : 'Twitch rejected the request.',
      );
    return new FeatureError('TWITCH', error.message);
  }
  return new FeatureError('TWITCH', 'Twitch could not complete the request. Try again shortly.');
}
