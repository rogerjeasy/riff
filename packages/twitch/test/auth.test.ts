import { describe, expect, it } from 'vitest';
import {
  CHAT_READ_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  validateAccessToken,
} from '../src/auth.js';
import { TwitchError } from '../src/errors.js';
import type { FetchLike } from '../src/http.js';
import { fixture } from './support.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function respond(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<TwitchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TwitchError) return error;
    throw error;
  }
  throw new Error('expected a TwitchError');
}

describe('Twitch OAuth', () => {
  it('reads chat with exactly the documented scope', () => {
    expect(CHAT_READ_SCOPES).toEqual(['user:read:chat']);
  });

  it('builds the authorization code grant URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'fake-client-id',
        redirectUri: 'http://localhost:8787/auth/twitch/callback',
        scopes: [...CHAT_READ_SCOPES, 'channel:bot'],
        state: 'c3ab8aa609ea11e793ae92361f002671',
        forceVerify: true,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'fake-client-id',
      redirect_uri: 'http://localhost:8787/auth/twitch/callback',
      scope: 'user:read:chat channel:bot',
      state: 'c3ab8aa609ea11e793ae92361f002671',
      force_verify: 'true',
    });
    expect(url.search).toContain('scope=user%3Aread%3Achat+channel%3Abot');
  });

  it('omits force_verify unless requested and requires state', () => {
    const url = buildAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'http://localhost/cb',
      scopes: CHAT_READ_SCOPES,
      state: 's',
    });
    expect(new URL(url).searchParams.has('force_verify')).toBe(false);
    expect(() =>
      buildAuthorizeUrl({
        clientId: 'c',
        redirectUri: 'http://localhost/cb',
        scopes: CHAT_READ_SCOPES,
        state: '',
      }),
    ).toThrow(TwitchError);
  });

  it('exchanges an authorization code with a form-encoded POST', async () => {
    const { fetch, calls } = respond(fixture('oauth.token.authorization-code.json'));
    const tokens = await exchangeCode({
      clientId: 'fake-client-id',
      clientSecret: 'fake-secret',
      code: 'gulfwdmys5lsm6qyz4xiz9q32l10',
      redirectUri: 'http://localhost:3000',
      fetch,
    });
    expect(calls[0]?.url).toBe('https://id.twitch.tv/oauth2/token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body)))).toEqual({
      client_id: 'fake-client-id',
      client_secret: 'fake-secret',
      code: 'gulfwdmys5lsm6qyz4xiz9q32l10',
      grant_type: 'authorization_code',
      redirect_uri: 'http://localhost:3000',
    });
    expect(tokens).toEqual({
      accessToken: 'fake-access-token-code',
      refreshToken: 'fake-refresh-token-code',
      expiresIn: 14124,
      scopes: ['channel:moderate', 'chat:edit', 'chat:read'],
      tokenType: 'bearer',
    });
  });

  it('refreshes a token and accepts both documented scope shapes', async () => {
    const array = respond(fixture('oauth.token.refresh.json'));
    const refreshed = await refreshAccessToken({
      clientId: 'fake-client-id',
      clientSecret: 'fake-secret',
      refreshToken: 'fake/refresh+token=',
      fetch: array.fetch,
    });
    expect(Object.fromEntries(new URLSearchParams(String(array.calls[0]?.init?.body)))).toEqual({
      client_id: 'fake-client-id',
      client_secret: 'fake-secret',
      grant_type: 'refresh_token',
      refresh_token: 'fake/refresh+token=',
    });
    expect(refreshed.refreshToken).toBe('fake-refresh-token-rotated');
    expect(refreshed.scopes).toEqual(['channel:read:subscriptions', 'channel:manage:polls']);

    const single = respond(fixture('oauth.token.string-scope.json'));
    const tokens = await refreshAccessToken({
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetch: single.fetch,
    });
    expect(tokens.scopes).toEqual(['channel:read:subscriptions']);
  });

  it('surfaces a failed refresh as a typed error without the token', async () => {
    const { fetch, calls } = respond(fixture('oauth.token.refresh-error.json'), 400);
    const error = await rejection(
      refreshAccessToken({
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'secret-refresh',
        fetch,
      }),
    );
    expect(calls).toHaveLength(1);
    expect(error.code).toBe('TWITCH_REJECTED');
    expect(error.detail.twitchMessage).toBe('Invalid refresh token');
    expect(error.message + JSON.stringify(error.detail)).not.toContain('secret-refresh');
  });

  it('rejects token responses missing required fields', async () => {
    const body = fixture('oauth.token.authorization-code.json');
    delete body['access_token'];
    const { fetch } = respond(body);
    const error = await rejection(
      exchangeCode({
        clientId: 'c',
        clientSecret: 's',
        code: 'x',
        redirectUri: 'http://localhost',
        fetch,
      }),
    );
    expect(error.code).toBe('TWITCH_INVALID_RESPONSE');
  });

  it('validates an access token', async () => {
    const { fetch, calls } = respond(fixture('oauth.validate.json'));
    const result = await validateAccessToken({ accessToken: 'secret-access', fetch });
    expect(calls[0]?.url).toBe('https://id.twitch.tv/oauth2/validate');
    expect(calls[0]?.init?.headers).toEqual({ Authorization: 'OAuth secret-access' });
    expect(result).toEqual({
      userId: '141981764',
      login: 'twitchdev',
      scopes: ['channel:read:subscriptions'],
      expiresIn: 5520838,
      clientId: 'fake-client-id',
    });
  });

  it('maps an invalid token to TWITCH_UNAUTHORIZED without echoing it', async () => {
    const { fetch } = respond(fixture('oauth.validate-invalid.json'), 401);
    const error = await rejection(validateAccessToken({ accessToken: 'secret-access', fetch }));
    expect(error.code).toBe('TWITCH_UNAUTHORIZED');
    expect(error.detail.twitchMessage).toBe('invalid access token');
    expect(error.message + JSON.stringify(error.detail)).not.toContain('secret-access');
  });
});
