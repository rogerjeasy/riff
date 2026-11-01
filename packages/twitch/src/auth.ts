import { z } from 'zod';
import { TwitchError, errorForStatus } from './errors.js';
import { issuePaths, readJson, twitchMessageOf, type FetchLike } from './http.js';
import { TRIGGERS } from './triggers.js';

// Endpoints per https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow
// and https://dev.twitch.tv/docs/authentication/validate-tokens/.
export const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

/**
 * Minimal scopes to read chat over EventSub WebSockets as the broadcaster:
 * `channel.chat.message` "Requires user:read:chat scope from the chatting user".
 */
export const CHAT_READ_SCOPES: readonly string[] = TRIGGERS['chat.message'].scopes;

/**
 * Feature consent for Riff-managed Channel Points rewards: create/update/delete rewards,
 * update redemption status and receive `points.redeem` (all "channel:manage:redemptions").
 */
export const CHANNEL_POINTS_SCOPES: readonly string[] = TRIGGERS['points.redeem'].scopes;
/**
 * Create/End Prediction require "channel:manage:predictions" (Get accepts it too).
 * https://dev.twitch.tv/docs/api/predictions/: "Running predictions is available to
 * partners and affiliates only."
 */
export const PREDICTION_SCOPES: readonly string[] = ['channel:manage:predictions'];

export interface TwitchTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires, as reported by Twitch. */
  readonly expiresIn: number;
  readonly scopes: readonly string[];
  readonly tokenType: string;
}

export interface TokenValidation {
  /** Null for app access tokens (per the validate docs). */
  readonly userId: string | null;
  /** Lowercase login; null for app access tokens. */
  readonly login: string | null;
  readonly scopes: readonly string[];
  readonly expiresIn: number;
  readonly clientId: string;
}

/** Build the authorization code grant URL to redirect the broadcaster to. */
export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  forceVerify?: boolean;
}): string {
  if (options.state.length === 0)
    throw new TwitchError('TWITCH_INVALID_REQUEST', 'An OAuth state value is required.');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    // Docs: "A space-delimited list of scopes ... You must URL encode the list."
    scope: options.scopes.join(' '),
    state: options.state,
  });
  if (options.forceVerify !== undefined) params.set('force_verify', String(options.forceVerify));
  return `${TWITCH_AUTHORIZE_URL}?${params.toString()}`;
}

// The docs show `scope` both as an array and as a single string; accept either.
const scopeField = z
  .union([z.array(z.string()), z.string()])
  .transform((value) => (Array.isArray(value) ? value : value.split(' ').filter(Boolean)));

const tokenResponse = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().nonnegative(),
  scope: scopeField.optional(),
  token_type: z.string(),
});

const validateResponse = z.looseObject({
  client_id: z.string().min(1),
  login: z.string().nullable(),
  scopes: z.array(z.string()),
  user_id: z.string().nullable(),
  expires_in: z.number().int().nonnegative(),
});

async function send(
  fetchImpl: FetchLike,
  endpoint: string,
  init: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, init);
  } catch {
    throw new TwitchError('TWITCH_UNAVAILABLE', 'Could not reach Twitch. Try again in a moment.', {
      endpoint,
    });
  }
  const body = await readJson(response);
  if (!response.ok) throw errorForStatus(response.status, endpoint, twitchMessageOf(body));
  return { response, body };
}

async function postToken(fetchImpl: FetchLike, form: URLSearchParams): Promise<TwitchTokenSet> {
  // Token exchange and refresh are never retried: codes are single-use and a
  // refresh may already have rotated the refresh token.
  const { body } = await send(fetchImpl, TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success)
    throw new TwitchError(
      'TWITCH_INVALID_RESPONSE',
      'Twitch returned an unexpected token response.',
      {
        endpoint: TWITCH_TOKEN_URL,
        issues: issuePaths(parsed.error),
      },
    );
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
    scopes: parsed.data.scope ?? [],
    tokenType: parsed.data.token_type,
  };
}

/** Exchange an authorization code for a user access token and refresh token. */
export function exchangeCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetch: FetchLike;
}): Promise<TwitchTokenSet> {
  return postToken(
    options.fetch,
    new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      grant_type: 'authorization_code',
      redirect_uri: options.redirectUri,
    }),
  );
}

/** Refresh a user access token. Store the returned refresh token; it may rotate. */
export function refreshAccessToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch: FetchLike;
}): Promise<TwitchTokenSet> {
  return postToken(
    options.fetch,
    new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    }),
  );
}

/** Validate an access token (required at startup and hourly per Twitch). */
export async function validateAccessToken(options: {
  accessToken: string;
  fetch: FetchLike;
}): Promise<TokenValidation> {
  const { body } = await send(options.fetch, TWITCH_VALIDATE_URL, {
    method: 'GET',
    headers: { Authorization: `OAuth ${options.accessToken}` },
  });
  const parsed = validateResponse.safeParse(body);
  if (!parsed.success)
    throw new TwitchError(
      'TWITCH_INVALID_RESPONSE',
      'Twitch returned an unexpected token validation response.',
      { endpoint: TWITCH_VALIDATE_URL, issues: issuePaths(parsed.error) },
    );
  return {
    userId: parsed.data.user_id,
    login: parsed.data.login,
    scopes: parsed.data.scopes,
    expiresIn: parsed.data.expires_in,
    clientId: parsed.data.client_id,
  };
}
