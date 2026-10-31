import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  buildAuthorizeUrl,
  CHAT_READ_SCOPES,
  createEventSubClient,
  createHelixClient,
  exchangeCode,
  normalizeChatMessage,
  refreshAccessToken,
  TRIGGERS,
  validateAccessToken,
  type EventSubClient,
  type FetchLike,
} from '@riff/twitch';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import type { Hub } from '../hub.js';
import type { LiveRuntime } from '../live/runtime.js';
import type { Sealer } from '../auth/secrets.js';

const tokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});
type Tokens = z.infer<typeof tokenSchema>;

export interface TwitchConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  eventSubUrl: string | null;
  helixBaseUrl: string | null;
}
export type TwitchStatus =
  | { state: 'unconfigured' }
  | { state: 'disconnected' }
  | { state: 'connecting' | 'connected' | 'reconnecting'; login: string | null }
  | { state: 'error'; login: string | null; message: string };

/**
 * Owns the broadcaster's Twitch authorization and the EventSub chat subscription.
 * Chat identity and roles come only from authenticated EventSub payloads.
 */
export function createTwitchConnection(deps: {
  config: TwitchConfig | null;
  repo: ChannelRepository;
  hub: Hub;
  runtime: LiveRuntime;
  sealer: Sealer | null;
  fetch?: FetchLike;
  log?: (message: string) => void;
}) {
  const { config, repo, hub, runtime, sealer } = deps;
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const pendingStates = new Map<string, number>();
  let client: EventSubClient | null = null;
  let status: TwitchStatus =
    config && sealer ? { state: 'disconnected' } : { state: 'unconfigured' };
  const setStatus = (next: TwitchStatus) => {
    status = next;
    hub.publish('twitch', next);
  };
  const login = () => repo.state().twitchLogin;

  function readTokens(): Tokens | null {
    const sealed = repo.state().twitchTokens;
    if (!sealed || !sealer) return null;
    try {
      return tokenSchema.parse(sealer.open(sealed));
    } catch {
      return null;
    }
  }
  async function accessToken(): Promise<string> {
    const tokens = readTokens();
    if (!tokens || !config || !sealer) throw new Error('Twitch is not connected');
    if (tokens.expiresAt - Date.now() > 120_000) return tokens.accessToken;
    // Refresh proactively; a failure pauses the integration and surfaces an incident.
    const next = await refreshAccessToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: tokens.refreshToken,
      fetch: doFetch,
    });
    const sealed: Tokens = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: Date.now() + next.expiresIn * 1000,
      scopes: [...next.scopes],
    };
    repo.updateState({ twitchTokens: sealer.seal(sealed) });
    return sealed.accessToken;
  }

  function connect() {
    if (!config || !sealer) return;
    const state = repo.state();
    if (!state.twitchUserId || !readTokens()) return;
    client?.stop();
    const broadcasterId = state.twitchUserId;
    const helix = createHelixClient({
      clientId: config.clientId,
      getAccessToken: accessToken,
      fetch: doFetch,
      ...(config.helixBaseUrl ? { baseUrl: config.helixBaseUrl } : {}),
    });
    setStatus({ state: 'connecting', login: login() });
    client = createEventSubClient({
      ...(config.eventSubUrl ? { url: config.eventSubUrl } : {}),
      async onWelcome(sessionId) {
        const trigger = TRIGGERS['chat.message'];
        await helix.createEventSubSubscription({
          type: trigger.type,
          version: trigger.version,
          condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId },
          sessionId,
        });
        setStatus({ state: 'connected', login: login() });
      },
      onNotification(notification) {
        if (notification.subscriptionType !== TRIGGERS['chat.message'].type) return;
        const message = normalizeChatMessage(notification.event, {
          messageId: notification.messageId,
          receivedAt: notification.receivedAt,
        });
        if (!message || message.channelId !== broadcasterId) return;
        void runtime.handleChat({
          id: message.id,
          channelId: message.channelId,
          viewerId: message.viewerId,
          viewerName: message.viewerName,
          roles: [...message.roles],
          text: message.text,
          source: 'twitch',
        });
      },
      onRevocation(revocation) {
        setStatus({
          state: 'error',
          login: login(),
          message: `Twitch revoked the chat subscription (${revocation.status}). Reconnect Twitch.`,
        });
      },
      onState(next) {
        if (next === 'reconnecting') setStatus({ state: 'reconnecting', login: login() });
      },
      onError(error) {
        deps.log?.(`EventSub error: ${error instanceof Error ? error.message : 'unknown'}`);
        setStatus({
          state: 'error',
          login: login(),
          message: 'Could not subscribe to chat. Check the Twitch app and reconnect.',
        });
      },
    });
    client.start();
  }

  return {
    get status(): TwitchStatus {
      return status;
    },
    configured: Boolean(config && sealer),
    beginAuthorization() {
      if (!config) throw new Error('Twitch is not configured');
      const state = randomBytes(16).toString('base64url');
      pendingStates.set(state, Date.now() + 10 * 60_000);
      return buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes: CHAT_READ_SCOPES,
        state,
        forceVerify: true,
      });
    },
    async completeAuthorization(code: string, state: string) {
      if (!config || !sealer) throw new Error('Twitch is not configured');
      const expected = [...pendingStates.entries()].find(
        ([value, expires]) =>
          expires > Date.now() &&
          value.length === state.length &&
          timingSafeEqual(Buffer.from(value), Buffer.from(state)),
      );
      if (!expected) throw new Error('This sign-in link expired. Start again from Riff.');
      pendingStates.delete(expected[0]);
      const tokens = await exchangeCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri: config.redirectUri,
        fetch: doFetch,
      });
      const identity = await validateAccessToken({
        accessToken: tokens.accessToken,
        fetch: doFetch,
      });
      if (!identity.userId) throw new Error('Twitch did not return a user for this sign-in.');
      repo.updateState({
        twitchUserId: identity.userId,
        twitchLogin: identity.login,
        twitchTokens: sealer.seal({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
          scopes: [...tokens.scopes],
        } satisfies Tokens),
      });
      connect();
      return identity.login;
    },
    start: connect,
    disconnect() {
      client?.stop();
      client = null;
      repo.updateState({ twitchTokens: null, twitchUserId: null, twitchLogin: null });
      setStatus(config && sealer ? { state: 'disconnected' } : { state: 'unconfigured' });
    },
    close() {
      client?.stop();
      client = null;
    },
  };
}
export type TwitchConnection = ReturnType<typeof createTwitchConnection>;
