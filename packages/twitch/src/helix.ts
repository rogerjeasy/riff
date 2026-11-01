import { z } from 'zod';
import { TwitchError, errorForStatus } from './errors.js';
import { issuePaths, readJson, twitchMessageOf, type FetchLike } from './http.js';

/**
 * The only place in Riff that builds Helix requests (AGENTS §2.4).
 * Docs: https://dev.twitch.tv/docs/api/reference/
 */
export const HELIX_BASE_URL = 'https://api.twitch.tv/helix';

export interface HelixClientOptions {
  readonly clientId: string;
  /** Returns the current user access token; called before every attempt. */
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: FetchLike;
  /** Override for the Twitch CLI mock server, e.g. `http://127.0.0.1:8080`. */
  readonly baseUrl?: string;
  /** Retries after the first attempt, for 429 and 5xx only. Default 3. */
  readonly maxRetries?: number;
  /** Base for exponential backoff. Default 500 ms. */
  readonly backoffBaseMs?: number;
  /** Longest single wait; a longer `Ratelimit-Reset` gives up instead. Default 30 s. */
  readonly maxDelayMs?: number;
  /** Per-attempt timeout. Default 10 s. A timed-out attempt is never retried. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface CreateEventSubSubscriptionInput {
  readonly type: string;
  readonly version: string;
  readonly condition: Readonly<Record<string, string>>;
  readonly sessionId: string;
}

export interface EventSubSubscription {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly version: string;
  readonly condition: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly transport: { readonly method: string; readonly sessionId?: string };
  readonly cost: number;
}

export interface CreateEventSubSubscriptionResult {
  readonly subscription: EventSubSubscription;
  readonly total: number;
  readonly totalCost: number;
  readonly maxTotalCost: number;
}

export interface HelixUser {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly type: string;
  readonly broadcasterType: string;
  readonly description: string;
  readonly profileImageUrl: string;
  readonly offlineImageUrl: string;
  readonly createdAt: string;
}

export interface SendChatMessageInput {
  readonly broadcasterId: string;
  /** Must match the user in the access token. */
  readonly senderId: string;
  /** Docs: "limited to a maximum of 500 characters". */
  readonly message: string;
  readonly replyParentMessageId?: string;
}

export interface SendChatMessageResult {
  readonly messageId: string;
  readonly isSent: boolean;
  readonly dropReason: { readonly code: string; readonly message: string } | null;
}

/** Docs: "The message is limited to a maximum of 500 characters." */
export const MAX_CHAT_MESSAGE_LENGTH = 500;

export interface HelixClient {
  /**
   * POST /chat/messages with a user access token carrying `user:write:chat`.
   * A mutation: it is attempted exactly once and never retried.
   */
  sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult>;
  createEventSubSubscription(
    input: CreateEventSubSubscriptionInput,
  ): Promise<CreateEventSubSubscriptionResult>;
  getUsers(query: {
    ids?: readonly string[];
    logins?: readonly string[];
  }): Promise<readonly HelixUser[]>;
}

// https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription (response body)
const subscriptionSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  type: z.string(),
  version: z.string(),
  condition: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  transport: z.looseObject({ method: z.string(), session_id: z.string().optional() }),
  cost: z.number(),
});
const createSubscriptionResponse = z.looseObject({
  data: z.array(subscriptionSchema).min(1),
  total: z.number(),
  total_cost: z.number(),
  max_total_cost: z.number(),
});

// https://dev.twitch.tv/docs/api/reference/#get-users (response body; email is optional)
const userSchema = z.looseObject({
  id: z.string().min(1),
  login: z.string(),
  display_name: z.string(),
  type: z.string(),
  broadcaster_type: z.string(),
  description: z.string(),
  profile_image_url: z.string(),
  offline_image_url: z.string(),
  created_at: z.string(),
});
const getUsersResponse = z.looseObject({ data: z.array(userSchema) });

// https://dev.twitch.tv/docs/api/reference/#send-chat-message (response body)
const sendChatMessageResponse = z.looseObject({
  data: z
    .array(
      z.looseObject({
        message_id: z.string(),
        is_sent: z.boolean(),
        drop_reason: z.looseObject({ code: z.string(), message: z.string() }).nullish(),
      }),
    )
    .min(1),
});

/** Docs: "the sum total of the number of users you may look up is 100". */
export const MAX_USERS_PER_REQUEST = 100;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createHelixClient(options: HelixClientOptions): HelixClient {
  const baseUrl = (options.baseUrl ?? HELIX_BASE_URL).replace(/\/+$/, '');
  const maxRetries = options.maxRetries ?? 3;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  /** Jittered exponential delay, or the Ratelimit-Reset wait on 429 when present. */
  function delayFor(response: Response, retry: number): number {
    const backoff = backoffBaseMs * 2 ** retry;
    const jittered = backoff / 2 + random() * (backoff / 2);
    if (response.status !== 429) return jittered;
    // Docs: "Ratelimit-Reset — A Unix epoch timestamp that identifies when your bucket is reset to full."
    const reset = Number(response.headers.get('Ratelimit-Reset'));
    if (!Number.isFinite(reset) || reset <= 0) return jittered;
    return Math.max(0, reset * 1000 - now()) + random() * backoffBaseMs;
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    endpointName: string,
    body?: unknown,
    retries = maxRetries,
  ): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await options.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Client-Id': options.clientId,
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response: Response;
      try {
        response = await options.fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Network failures and timeouts are not retried: a mutation may already
        // have been applied (AGENTS §2.4).
        throw new TwitchError(
          'TWITCH_UNAVAILABLE',
          'Could not reach Twitch. Try again in a moment.',
          {
            endpoint: endpointName,
            attempts: attempt + 1,
          },
        );
      }
      const payload = await readJson(response);
      if (response.ok) return payload;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= retries)
        throw errorForStatus(response.status, endpointName, twitchMessageOf(payload), attempt + 1);
      const delay = delayFor(response, attempt);
      if (delay > maxDelayMs)
        throw new TwitchError(
          'TWITCH_UNAVAILABLE',
          'Twitch is rate limiting requests. Try again shortly.',
          {
            endpoint: endpointName,
            status: response.status,
            attempts: attempt + 1,
            retryAfterMs: Math.ceil(delay),
          },
        );
      await sleep(delay);
    }
  }

  function invalid(endpoint: string, error: z.ZodError): TwitchError {
    return new TwitchError('TWITCH_INVALID_RESPONSE', 'Twitch returned an unexpected response.', {
      endpoint,
      issues: issuePaths(error),
    });
  }

  return {
    async sendChatMessage(input) {
      const endpoint = 'POST /chat/messages';
      if (
        !input.broadcasterId ||
        !input.senderId ||
        !input.message ||
        Array.from(input.message).length > MAX_CHAT_MESSAGE_LENGTH
      )
        throw new TwitchError('TWITCH_INVALID_REQUEST', 'This chat message cannot be sent.', {
          endpoint,
        });
      // for_source_only is omitted: the docs reject it with a user access token.
      const payload = await request(
        'POST',
        '/chat/messages',
        endpoint,
        {
          broadcaster_id: input.broadcasterId,
          sender_id: input.senderId,
          message: input.message,
          ...(input.replyParentMessageId
            ? { reply_parent_message_id: input.replyParentMessageId }
            : {}),
        },
        0,
      );
      const parsed = sendChatMessageResponse.safeParse(payload);
      if (!parsed.success) throw invalid(endpoint, parsed.error);
      const [row] = parsed.data.data;
      if (!row)
        throw new TwitchError(
          'TWITCH_INVALID_RESPONSE',
          'Twitch returned an unexpected response.',
          {
            endpoint,
          },
        );
      return {
        messageId: row.message_id,
        isSent: row.is_sent,
        dropReason: row.drop_reason
          ? { code: row.drop_reason.code, message: row.drop_reason.message }
          : null,
      };
    },

    async createEventSubSubscription(input) {
      if (!input.sessionId)
        throw new TwitchError('TWITCH_INVALID_REQUEST', 'A WebSocket session id is required.');
      const endpoint = 'POST /eventsub/subscriptions';
      const payload = await request('POST', '/eventsub/subscriptions', endpoint, {
        type: input.type,
        version: input.version,
        condition: input.condition,
        transport: { method: 'websocket', session_id: input.sessionId },
      });
      const parsed = createSubscriptionResponse.safeParse(payload);
      if (!parsed.success) throw invalid(endpoint, parsed.error);
      const [sub] = parsed.data.data;
      if (!sub)
        throw new TwitchError(
          'TWITCH_INVALID_RESPONSE',
          'Twitch returned an unexpected response.',
          { endpoint },
        );
      return {
        subscription: {
          id: sub.id,
          status: sub.status,
          type: sub.type,
          version: sub.version,
          condition: sub.condition,
          createdAt: sub.created_at,
          transport: {
            method: sub.transport.method,
            ...(sub.transport.session_id === undefined
              ? {}
              : { sessionId: sub.transport.session_id }),
          },
          cost: sub.cost,
        },
        total: parsed.data.total,
        totalCost: parsed.data.total_cost,
        maxTotalCost: parsed.data.max_total_cost,
      };
    },

    async getUsers(query) {
      const ids = query.ids ?? [];
      const logins = query.logins ?? [];
      if (ids.length + logins.length > MAX_USERS_PER_REQUEST)
        throw new TwitchError('TWITCH_INVALID_REQUEST', 'Too many users requested at once.', {
          endpoint: 'GET /users',
        });
      const params = new URLSearchParams();
      for (const id of ids) params.append('id', id);
      for (const login of logins) params.append('login', login);
      const search = params.size > 0 ? `?${params.toString()}` : '';
      const endpoint = 'GET /users';
      const payload = await request('GET', `/users${search}`, endpoint);
      const parsed = getUsersResponse.safeParse(payload);
      if (!parsed.success) throw invalid(endpoint, parsed.error);
      return parsed.data.data.map((user) => ({
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        type: user.type,
        broadcasterType: user.broadcaster_type,
        description: user.description,
        profileImageUrl: user.profile_image_url,
        offlineImageUrl: user.offline_image_url,
        createdAt: user.created_at,
      }));
    },
  };
}
