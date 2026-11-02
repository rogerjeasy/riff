import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  buildAuthorizeUrl,
  CHAT_READ_SCOPES,
  CHAT_WRITE_SCOPES,
  CHANNEL_POINTS_SCOPES,
  PREDICTION_SCOPES,
  normalizeRedemption,
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
  TWITCH_FEATURE_SCOPES,
  validateAccessToken,
  type EventSubClient,
  type EventTriggerName,
  type FetchLike,
  type HelixClient,
  type NormalizedRedemption,
  type TwitchFeature as NativeTwitchFeature,
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
/** Optional feature consent requested on top of chat (F22). */
export type TwitchFeature = 'channel-points' | 'predictions';
/** Every consentable feature: F22 Channel Points/Predictions and F21/F23 native actions. */
export type ConsentFeature = TwitchFeature | NativeTwitchFeature;
const FEATURE_SCOPES: Record<ConsentFeature, readonly string[]> = {
  'channel-points': CHANNEL_POINTS_SCOPES,
  predictions: PREDICTION_SCOPES,
  ...TWITCH_FEATURE_SCOPES,
};
/** Authenticated Helix access for host services; never handed to guest code. */
export interface TwitchApi {
  helix: HelixClient;
  broadcasterId: string;
  scopes: readonly string[];
}

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
  /** Request `user:write:chat` at sign-in only when the creator opted into chat replies. */
  wantsChatWrite?: () => boolean;
  onRedemption?: (redemption: NormalizedRedemption) => void;
  /** F23: an incoming raid, recorded for the "raiders only" shoutout policy. */
  onRaid?: (raider: { id: string; login: string; displayName: string }) => void;
  /** Event families host features need even without a live interaction (raids for F23). */
  hostTriggers?: () => readonly EventTriggerName[];
}) {
  const { config, repo, hub, runtime, sealer } = deps;
  /** Families to subscribe: those live interactions use plus those host features need. */
  const wantedTriggers = () => [
    ...new Set([...runtime.eventTriggers(), ...(deps.hostTriggers?.() ?? [])]),
  ];
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const pendingStates = new Map<string, number>();
  let client: EventSubClient | null = null;
  let redemptions: 'unrequested' | 'subscribed' | 'failed' = 'unrequested';
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
    redemptions = 'unrequested';
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
        // Redemptions are optional: a failure leaves chat working and is shown in the console.
        if (CHANNEL_POINTS_SCOPES.every((scope) => readTokens()?.scopes.includes(scope))) {
          const points = TRIGGERS['points.redeem'];
          try {
            await helixClient.createEventSubSubscription({
              type: points.type,
              version: points.version,
              condition: triggerCondition('points.redeem', broadcasterId),
              sessionId: welcomed,
            });
            redemptions = 'subscribed';
          } catch (error) {
            redemptions = 'failed';
            deps.log?.(
              `Redemption subscription failed: ${error instanceof Error ? error.message : 'unknown'}`,
            );
          }
        }
        setStatus({ state: 'connected', login: login() });
        await syncEventSubscriptions();
      },
      onNotification(notification) {
        if (notification.subscriptionType === TRIGGERS['points.redeem'].type) {
          const redemption = normalizeRedemption(notification.event, {
            messageId: notification.messageId,
            receivedAt: notification.receivedAt,
          });
          if (redemption && redemption.channelId === broadcasterId) deps.onRedemption?.(redemption);
          return;
        }
        const name = triggerForSubscription(
          notification.subscriptionType,
          notification.subscriptionVersion,
        );
        if (name && name !== 'chat.message' && name !== 'points.redeem') {
          const event = normalizeTwitchEvent(name, notification.event, {
            messageId: notification.messageId,
            receivedAt: notification.receivedAt,
          });
          if (!event || event.channelId !== broadcasterId) return;
          // F23 "raiders only" shoutout policy: remember who raided, independent of whether
          // any interaction reacts to raids.
          if (event.kind === 'raid' && event.viewerLogin)
            deps.onRaid?.({
              id: event.viewerId,
              login: event.viewerLogin,
              displayName: event.viewerName,
            });
          void runtime.handleTwitchEvent({
            id: event.id,
            channelId: event.channelId,
            viewerId: event.viewerId,
            viewerName: event.viewerName,
            viewerLogin: event.viewerLogin,
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
        if (name === 'points.redeem') {
          // Losing redemptions must not stop chat; the Channel Points panel shows it.
          redemptions = 'failed';
          hub.publish('twitch', status);
          return;
        }
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
    for (const name of wantedTriggers()) {
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
    const used = new Set(wantedTriggers());
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
    /** Host-only Helix access, or null when not connected. */
    api(): TwitchApi | null {
      const tokens = readTokens();
      const broadcasterId = repo.state().twitchUserId;
      if (!helix || !tokens || !broadcasterId) return null;
      return { helix, broadcasterId, scopes: tokens.scopes };
    },
    /** Granted scopes, without exposing tokens. */
    scopes(): readonly string[] {
      return readTokens()?.scopes ?? [];
    },
    get redemptions() {
      return redemptions;
    },
    /**
     * Start OAuth. Previously granted scopes are always kept, and each optional feature
     * (Channel Points, Predictions, polls, announcements, shoutouts) and F19 event family
     * (subs, gifts, resubs, cheers, raids) adds only its own scope.
     */
    beginAuthorization(
      features: readonly ConsentFeature[] = [],
      triggers: readonly EventTriggerName[] = [],
    ) {
      if (!config) throw new Error('Twitch is not configured');
      const state = randomBytes(16).toString('base64url');
      pendingStates.set(state, Date.now() + 10 * 60_000);
      // Keep previously granted feature consent when adding another feature.
      const scopes = [
        ...new Set([
          ...CHAT_READ_SCOPES,
          ...(deps.wantsChatWrite?.() ? CHAT_WRITE_SCOPES : []),
          ...(readTokens()?.scopes ?? []),
          ...features.flatMap((feature) => FEATURE_SCOPES[feature]),
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
    /** Scopes on the sealed token; never the token itself. */
    grantedScopes(): string[] {
      return readTokens()?.scopes ?? [];
    },
    identity(): { userId: string; login: string | null } | null {
      const state = repo.state();
      return state.twitchUserId && readTokens()
        ? { userId: state.twitchUserId, login: state.twitchLogin }
        : null;
    },
    /** A Helix client on the broadcaster's token, or null when not connected. */
    helix(): HelixClient | null {
      if (!config || !sealer || !readTokens()) return null;
      return createHelixClient({
        clientId: config.clientId,
        getAccessToken: accessToken,
        fetch: doFetch,
        ...(config.helixBaseUrl ? { baseUrl: config.helixBaseUrl } : {}),
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
    /** Whether host system replies can be sent: connected with `user:write:chat`. */
    chatReplies(): { available: boolean; reason: string | null } {
      if (!config || !sealer) return { available: false, reason: 'Twitch is not configured.' };
      const tokens = readTokens();
      if (!tokens || !repo.state().twitchUserId)
        return { available: false, reason: 'Connect Twitch to send chat replies.' };
      if (!CHAT_WRITE_SCOPES.every((scope) => tokens.scopes.includes(scope)))
        return {
          available: false,
          reason: 'Reconnect Twitch and approve “Send chat messages” (user:write:chat).',
        };
      if (status.state !== 'connected' || !helix)
        return { available: false, reason: 'Twitch chat is not connected right now.' };
      return { available: true, reason: null };
    },
    /** Host-owned system reply as the broadcaster. Generated code never reaches this. */
    async sendChat(message: string, replyParentMessageId?: string) {
      const broadcasterId = repo.state().twitchUserId;
      if (!helix || !broadcasterId || !this.chatReplies().available)
        throw new Error('Chat replies are unavailable.');
      const result = await helix.sendChatMessage({
        broadcasterId,
        senderId: broadcasterId,
        message,
        ...(replyParentMessageId ? { replyParentMessageId } : {}),
      });
      if (!result.isSent) throw new Error('Twitch dropped the chat reply.');
    },
    disconnect() {
      client?.stop();
      client = null;
      helix = null;
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
