import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  buildAuthorizeUrl,
  CHAT_READ_SCOPES,
  createEventSubClient,
  createHelixClient,
  EVENT_TRIGGER_NAMES,
  exchangeCode,
  missingScopes,
  normalizeChatMessage,
  normalizeTwitchEvent,
  refreshAccessToken,
  scopesForTriggers,
  triggerCondition,
  triggerForSubscription,
  TRIGGERS,
  validateAccessToken,
  type EventSubClient,
  type EventTriggerName,
  type FetchLike,
  type HelixClient,
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
 * F19 per-family view for the console: whether a live interaction needs it, whether
 * consent was granted, and the EventSub subscription state on the current session.
 */
export interface TwitchTriggerStatus {
  name: EventTriggerName;
  label: string;
  eventSubType: string;
  version: string;
  docs: string;
  consent: string;
  scopes: string[];
  missingScopes: string[];
  /** A live interaction listens to this family. */
  inUse: boolean;
  subscription:
    'active' | 'pending' | 'missing-consent' | 'failed' | 'revoked' | 'idle' | 'offline';
  message: string | null;
}
interface SubscriptionState {
  state: 'pending' | 'active' | 'failed' | 'revoked';
  message: string | null;
}

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
  onStatus?: (status: TwitchStatus) => void;
}) {
  const { config, repo, hub, runtime, sealer } = deps;
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const pendingStates = new Map<string, number>();
  let client: EventSubClient | null = null;
  let helix: HelixClient | null = null;
  let sessionId: string | null = null;
  let broadcaster: string | null = null;
  // Per-session EventSub state for platform triggers; reset on every fresh session.
  const eventSubs = new Map<EventTriggerName, SubscriptionState>();
  let status: TwitchStatus =
    config && sealer ? { state: 'disconnected' } : { state: 'unconfigured' };
  const setStatus = (next: TwitchStatus) => {
    status = next;
    deps.onStatus?.(next);
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
    broadcaster = broadcasterId;
    sessionId = null;
    eventSubs.clear();
    const helixClient = createHelixClient({
      clientId: config.clientId,
      getAccessToken: accessToken,
      fetch: doFetch,
      ...(config.helixBaseUrl ? { baseUrl: config.helixBaseUrl } : {}),
    });
    helix = helixClient;
    setStatus({ state: 'connecting', login: login() });
    client = createEventSubClient({
      ...(config.eventSubUrl ? { url: config.eventSubUrl } : {}),
      async onWelcome(welcomed) {
        // A fresh session: Twitch holds no subscriptions for it yet.
        sessionId = welcomed;
        eventSubs.clear();
        const trigger = TRIGGERS['chat.message'];
        await helixClient.createEventSubSubscription({
          type: trigger.type,
          version: trigger.version,
          condition: triggerCondition('chat.message', broadcasterId),
          sessionId: welcomed,
        });
        setStatus({ state: 'connected', login: login() });
        await syncEventSubscriptions();
      },
      onNotification(notification) {
        const name = triggerForSubscription(
          notification.subscriptionType,
          notification.subscriptionVersion,
        );
        if (name && name !== 'chat.message') {
          const event = normalizeTwitchEvent(name, notification.event, {
            messageId: notification.messageId,
            receivedAt: notification.receivedAt,
          });
          if (!event || event.channelId !== broadcasterId) return;
          void runtime.handleTwitchEvent({
            id: event.id,
            channelId: event.channelId,
            viewerId: event.viewerId,
            viewerName: event.viewerName,
            text: event.text,
            twitch: {
              kind: event.kind,
              amount: event.amount,
              tier: event.tier,
              anonymous: event.anonymous,
              gift: event.gift,
            },
            source: 'twitch',
          });
          return;
        }
        if (notification.subscriptionType !== TRIGGERS['chat.message'].type) return;
        const message = normalizeChatMessage(notification.event, {
          messageId: notification.messageId,
          receivedAt: notification.receivedAt,
        });
        if (!message || message.channelId !== broadcasterId) return;
        void runtime.handleChat({
          id: message.id,
          channelId: message.channelId,
          sourceChannelId: message.sourceChannelId,
          sourceMessageId: message.sourceMessageId,
          viewerId: message.viewerId,
          viewerName: message.viewerName,
          roles: [...message.roles],
          text: message.text,
          source: 'twitch',
        });
      },
      onRevocation(revocation) {
        const name = triggerForSubscription(revocation.type, revocation.version);
        if (name && name !== 'chat.message') {
          // Losing one event family must not stop chat; surface it on that family.
          eventSubs.set(name, {
            state: 'revoked',
            message: `Twitch revoked this subscription (${revocation.status}). Reconnect Twitch to grant access again.`,
          });
          hub.publish('twitch', status);
          return;
        }
        setStatus({
          state: 'error',
          login: login(),
          message: `Twitch revoked the chat subscription (${revocation.status}). Reconnect Twitch.`,
        });
      },
      onState(next, detail) {
        if (next === 'reconnecting') setStatus({ state: 'reconnecting', login: login() });
        // A Twitch-directed reconnect carries subscriptions over to the new session id.
        if (next === 'connected' && detail?.resumed && detail.sessionId) {
          sessionId = detail.sessionId;
          setStatus({ state: 'connected', login: login() });
        }
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

  /** One pass: create each missing subscription live interactions need and consent allows. */
  async function syncOnce(): Promise<void> {
    const granted = readTokens()?.scopes ?? [];
    for (const name of runtime.eventTriggers()) {
      const current = eventSubs.get(name)?.state;
      if (current === 'active' || current === 'pending' || current === 'revoked') continue;
      if (missingScopes(name, granted).length) continue;
      const id = sessionId;
      const target = broadcaster;
      const api = helix;
      if (!id || !target || !api) return;
      const trigger = TRIGGERS[name];
      eventSubs.set(name, { state: 'pending', message: null });
      try {
        await api.createEventSubSubscription({
          type: trigger.type,
          version: trigger.version,
          condition: triggerCondition(name, target),
          sessionId: id,
        });
        if (sessionId === id) eventSubs.set(name, { state: 'active', message: null });
      } catch (error) {
        deps.log?.(
          `EventSub ${trigger.type} error: ${error instanceof Error ? error.message : 'unknown'}`,
        );
        if (sessionId === id)
          eventSubs.set(name, {
            state: 'failed',
            message: 'Twitch refused this subscription. Reconnect Twitch, then try again.',
          });
      }
      hub.publish('twitch', status);
    }
  }
  let syncing: Promise<void> | null = null;
  let again = false;
  /**
   * Create missing EventSub subscriptions for the platform triggers live interactions
   * use. Idempotent per session; families without consent stay `missing-consent`.
   * Calls during a pass schedule exactly one more pass instead of racing it.
   */
  function syncEventSubscriptions(): Promise<void> {
    if (syncing) {
      again = true;
      return syncing;
    }
    const tracked = (async () => {
      do {
        again = false;
        await syncOnce();
      } while (again);
    })().finally(() => {
      syncing = null;
    });
    syncing = tracked;
    return tracked;
  }
  // Activation, pause and rollback publish `studio`; follow them to subscribe on demand.
  const unsubscribe = hub.subscribe((message) => {
    if (message.type === 'studio' && sessionId) syncEventSubscriptions().catch(() => undefined);
  });

  function triggerStatus(): TwitchTriggerStatus[] {
    const granted = readTokens()?.scopes ?? [];
    const used = new Set(runtime.eventTriggers());
    const connected = status.state === 'connected' && sessionId !== null;
    return EVENT_TRIGGER_NAMES.map((name) => {
      const trigger = TRIGGERS[name];
      const missing = missingScopes(name, granted);
      const sub = eventSubs.get(name);
      const subscription: TwitchTriggerStatus['subscription'] = sub
        ? sub.state
        : !connected
          ? 'offline'
          : missing.length
            ? 'missing-consent'
            : 'idle';
      return {
        name,
        label: trigger.label,
        eventSubType: trigger.type,
        version: trigger.version,
        docs: trigger.docs,
        consent: trigger.consent,
        scopes: [...trigger.scopes],
        missingScopes: missing,
        inUse: used.has(name),
        subscription,
        message: sub?.message ?? null,
      };
    });
  }

  return {
    get status(): TwitchStatus {
      return status;
    },
    /** F19 platform trigger availability, consent and EventSub state. */
    triggers: triggerStatus,
    syncEventSubscriptions,
    configured: Boolean(config && sealer),
    /**
     * Authorization URL for chat plus the requested platform triggers. Already granted
     * scopes are kept so adding a family never silently drops earlier consent.
     */
    beginAuthorization(triggers: readonly EventTriggerName[] = []) {
      if (!config) throw new Error('Twitch is not configured');
      const state = randomBytes(16).toString('base64url');
      pendingStates.set(state, Date.now() + 10 * 60_000);
      const scopes = [
        ...new Set([
          ...CHAT_READ_SCOPES,
          ...(readTokens()?.scopes ?? []),
          ...scopesForTriggers(triggers),
        ]),
      ];
      return buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes,
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
      sessionId = null;
      eventSubs.clear();
      repo.updateState({ twitchTokens: null, twitchUserId: null, twitchLogin: null });
      setStatus(config && sealer ? { state: 'disconnected' } : { state: 'unconfigured' });
    },
    close() {
      unsubscribe();
      client?.stop();
      client = null;
    },
  };
}
export type TwitchConnection = ReturnType<typeof createTwitchConnection>;
