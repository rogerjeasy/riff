import { z } from 'zod';
import { TwitchError, errorForStatus, type TwitchRefusalReason } from './errors.js';
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

/**
 * Documented request bounds for polls, announcements and shoutouts.
 * Sources: https://dev.twitch.tv/docs/api/reference/#create-poll (title ≤ 60, 2–5 choices
 * of ≤ 25, duration 15–1800 s), #send-chat-announcement (≤ 500 characters, one every
 * 2 seconds) and #send-a-shoutout (once every 2 minutes; same target once every 60 minutes).
 */
export const TWITCH_FEATURE_LIMITS = Object.freeze({
  poll: {
    titleLength: 60,
    choiceLength: 25,
    choices: { min: 2, max: 5 },
    durationSeconds: { min: 15, max: 1800 },
  },
  announcement: { messageLength: 500, intervalMs: 2000 },
  shoutout: { globalCooldownMs: 2 * 60_000, sameTargetCooldownMs: 60 * 60_000 },
});
/** Docs: "Possible case-sensitive values are: blue green orange purple primary (default)". */
export const ANNOUNCEMENT_COLORS = ['blue', 'green', 'orange', 'purple', 'primary'] as const;
export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number];
/** Documented poll statuses (Get Polls response). */
export const POLL_STATUSES = [
  'ACTIVE',
  'COMPLETED',
  'TERMINATED',
  'ARCHIVED',
  'MODERATED',
  'INVALID',
] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

export interface CreatePollInput {
  readonly broadcasterId: string;
  readonly title: string;
  readonly choices: readonly string[];
  readonly durationSeconds: number;
}
export interface HelixPollChoice {
  readonly id: string;
  readonly title: string;
  readonly votes: number;
  readonly channelPointsVotes: number;
}
export interface HelixPoll {
  readonly id: string;
  readonly broadcasterId: string;
  readonly title: string;
  readonly choices: readonly HelixPollChoice[];
  readonly status: PollStatus;
  readonly durationSeconds: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
export interface CreatePollResult {
  readonly poll: HelixPoll;
  /** True when an ambiguous failure was resolved by finding the poll already running. */
  readonly recovered: boolean;
}
export interface SendAnnouncementInput {
  readonly broadcasterId: string;
  readonly moderatorId: string;
  readonly message: string;
  readonly color?: AnnouncementColor;
}
export interface SendShoutoutInput {
  readonly fromBroadcasterId: string;
  readonly toBroadcasterId: string;
  readonly moderatorId: string;
}

export interface HelixClient {
  /** Start a poll; ambiguous failures are resolved by an idempotency read, never a blind retry. */
  createPoll(input: CreatePollInput): Promise<CreatePollResult>;
  /** Newest polls first, or exactly the requested ids (≤ 20). */
  getPolls(query: {
    broadcasterId: string;
    ids?: readonly string[];
    first?: number;
  }): Promise<readonly HelixPoll[]>;
  /** End an ACTIVE poll, keeping results visible (TERMINATED) or hiding them (ARCHIVED). */
  endPoll(input: {
    broadcasterId: string;
    id: string;
    status: 'TERMINATED' | 'ARCHIVED';
  }): Promise<HelixPoll>;
  sendChatAnnouncement(input: SendAnnouncementInput): Promise<void>;
  sendShoutout(input: SendShoutoutInput): Promise<void>;
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

// https://dev.twitch.tv/docs/api/reference/#get-polls (response body; shared by create/end)
const pollSchema = z.looseObject({
  id: z.string().min(1),
  broadcaster_id: z.string().min(1),
  title: z.string(),
  choices: z.array(
    z.looseObject({
      id: z.string().min(1),
      title: z.string(),
      votes: z.number().int().nonnegative(),
      channel_points_votes: z.number().int().nonnegative(),
    }),
  ),
  status: z.enum(POLL_STATUSES),
  duration: z.number().int(),
  started_at: z.string(),
  ended_at: z.string().nullable().optional(),
});
const pollListResponse = z.looseObject({ data: z.array(pollSchema) });
type PollPayload = z.infer<typeof pollSchema>;
const toPoll = (poll: PollPayload): HelixPoll => ({
  id: poll.id,
  broadcasterId: poll.broadcaster_id,
  title: poll.title,
  choices: poll.choices.map((choice) => ({
    id: choice.id,
    title: choice.title,
    votes: choice.votes,
    channelPointsVotes: choice.channel_points_votes,
  })),
  status: poll.status,
  durationSeconds: poll.duration,
  startedAt: poll.started_at,
  endedAt: poll.ended_at ?? null,
});

const hasControl = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
/** Length by code point, so an emoji counts once. */
const length = (value: string) => [...value].length;
const ID = /^[0-9]{1,32}$/;

/** Refine a generic status error with the endpoint's documented refusal text. */
function refine(error: unknown, endpoint: string): unknown {
  if (!(error instanceof TwitchError) || error.detail.endpoint !== endpoint) return error;
  const status = error.detail.status;
  const text = (error.detail.twitchMessage ?? '').toLowerCase();
  const as = (
    code: TwitchError['code'],
    message: string,
    reason: TwitchRefusalReason,
  ): TwitchError => new TwitchError(code, message, { ...error.detail, reason });
  // All three endpoints document "The user access token is missing the … scope" as a 401.
  if (status === 401 && text.includes('scope'))
    return as(
      'TWITCH_FORBIDDEN',
      'Twitch says this feature was not granted. Grant it again from Twitch features.',
      'missing_scope',
    );
  if (endpoint === 'POST /polls') {
    if (status === 400 && text.includes('already has a poll'))
      return as(
        'TWITCH_REJECTED',
        'A poll is already running on this channel. End it or wait for it to finish.',
        'poll_active',
      );
    if (status === 400 && text.includes('automod'))
      return as(
        'TWITCH_REJECTED',
        'Twitch AutoMod rejected a poll choice. Reword it and try again.',
        'content_refused',
      );
    // UNVERIFIED: the reference does not document the response for channels that are not
    // Affiliates or Partners; the Polls guide only states eligibility. Treat 403 as that.
    if (status === 403)
      return as(
        'TWITCH_FORBIDDEN',
        'Twitch polls are available to Affiliates and Partners only.',
        'not_eligible',
      );
  }
  if (endpoint === 'PATCH /polls' && status === 400 && text.includes('must be active'))
    return as('TWITCH_REJECTED', 'That poll has already ended.', 'poll_not_active');
  if (endpoint === 'POST /chat/announcements') {
    if (status === 429)
      return as(
        'TWITCH_REJECTED',
        'Twitch allows one announcement every 2 seconds. Wait a moment and try again.',
        'cooldown',
      );
    if (status === 400 && text.includes('review'))
      return as(
        'TWITCH_REJECTED',
        'Twitch did not accept this announcement text. Reword it and try again.',
        'content_refused',
      );
  }
  if (endpoint === 'POST /chat/shoutouts') {
    if (status === 429)
      return as(
        'TWITCH_REJECTED',
        'Shoutouts are on cooldown: one every 2 minutes, and the same channel once an hour.',
        'cooldown',
      );
    if (status === 400 && text.includes('themselves'))
      return as('TWITCH_REJECTED', 'A channel cannot shout itself out.', 'self_shoutout');
    if (status === 400 && (text.includes('not streaming') || text.includes('viewers')))
      return as(
        'TWITCH_REJECTED',
        'Shoutouts work only while you are live with at least one viewer.',
        'not_live',
      );
    if (status === 403 && text.includes('not one of'))
      return as(
        'TWITCH_FORBIDDEN',
        'The connected account is not a moderator of this channel.',
        'not_moderator',
      );
    if (status === 403)
      return as(
        'TWITCH_FORBIDDEN',
        'Twitch does not allow a shoutout to that channel.',
        'target_refused',
      );
  }
  if (status === 400)
    return as('TWITCH_REJECTED', 'Twitch rejected the request as invalid.', 'invalid');
  return error;
}
function refuse(message: string, endpoint: string): TwitchError {
  return new TwitchError('TWITCH_INVALID_REQUEST', message, { endpoint, reason: 'invalid' });
}

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
    method: 'GET' | 'POST' | 'PATCH',
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

  const client: HelixClient = {
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

    async createPoll(input) {
      const endpoint = 'POST /polls';
      const limits = TWITCH_FEATURE_LIMITS.poll;
      const title = input.title.trim();
      const choices = input.choices.map((choice) => choice.trim());
      if (!ID.test(input.broadcasterId)) throw refuse('A broadcaster id is required.', endpoint);
      if (!title || length(title) > limits.titleLength || hasControl(title))
        throw refuse(`Poll questions need 1–${limits.titleLength} characters.`, endpoint);
      if (choices.length < limits.choices.min || choices.length > limits.choices.max)
        throw refuse(`Polls need ${limits.choices.min}–${limits.choices.max} choices.`, endpoint);
      if (choices.some((c) => !c || length(c) > limits.choiceLength || hasControl(c)))
        throw refuse(`Each poll choice needs 1–${limits.choiceLength} characters.`, endpoint);
      if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length)
        throw refuse('Poll choices must be different from each other.', endpoint);
      if (
        !Number.isInteger(input.durationSeconds) ||
        input.durationSeconds < limits.durationSeconds.min ||
        input.durationSeconds > limits.durationSeconds.max
      )
        throw refuse(
          `Polls run ${limits.durationSeconds.min}–${limits.durationSeconds.max} seconds.`,
          endpoint,
        );
      let payload: unknown;
      try {
        // A mutation: never retried blindly (AGENTS §2.4). Ambiguous outcomes are
        // resolved below by reading the newest poll.
        payload = await request(
          'POST',
          '/polls',
          endpoint,
          {
            broadcaster_id: input.broadcasterId,
            title,
            choices: choices.map((choice) => ({ title: choice })),
            duration: input.durationSeconds,
          },
          0,
        );
      } catch (error) {
        if (!(error instanceof TwitchError) || error.code !== 'TWITCH_UNAVAILABLE')
          throw refine(error, endpoint);
        const [latest] = await client.getPolls({ broadcasterId: input.broadcasterId, first: 1 });
        const same =
          latest?.status === 'ACTIVE' &&
          latest.title === title &&
          latest.choices.length === choices.length &&
          latest.choices.every((choice, i) => choice.title === choices[i]);
        if (latest && same) return { poll: latest, recovered: true };
        throw error;
      }
      const parsed = pollListResponse.safeParse(payload);
      if (!parsed.success) throw invalid(endpoint, parsed.error);
      const [poll] = parsed.data.data;
      if (!poll)
        throw new TwitchError(
          'TWITCH_INVALID_RESPONSE',
          'Twitch returned an unexpected response.',
          { endpoint },
        );
      return { poll: toPoll(poll), recovered: false };
    },

    async getPolls(query) {
      const endpoint = 'GET /polls';
      const ids = query.ids ?? [];
      if (!ID.test(query.broadcasterId)) throw refuse('A broadcaster id is required.', endpoint);
      // Docs: "You may specify a maximum of 20 IDs"; page size 1–20.
      if (ids.length > 20) throw refuse('At most 20 polls can be requested at once.', endpoint);
      const params = new URLSearchParams({ broadcaster_id: query.broadcasterId });
      for (const id of ids) params.append('id', id);
      if (query.first !== undefined)
        params.set('first', String(Math.min(20, Math.max(1, Math.trunc(query.first)))));
      let payload: unknown;
      try {
        payload = await request('GET', `/polls?${params.toString()}`, endpoint);
      } catch (error) {
        throw refine(error, endpoint);
      }
      const parsed = pollListResponse.safeParse(payload);
      if (!parsed.success) throw invalid(endpoint, parsed.error);
      return parsed.data.data.map(toPoll);
    },

    async endPoll(input) {
      const endpoint = 'PATCH /polls';
      if (!ID.test(input.broadcasterId) || !input.id)
        throw refuse('A broadcaster and poll id are required.', endpoint);
      let payload: unknown;
      try {
        // Ending converges: an already-ended poll answers 400 "must be active", so a
        // transient-failure retry cannot apply twice.
        payload = await request('PATCH', '/polls', endpoint, {
          broadcaster_id: input.broadcasterId,
          id: input.id,
          status: input.status,
        });
      } catch (error) {
        throw refine(error, endpoint);
      }
      const parsed = pollListResponse.safeParse(payload);
      if (!parsed.success) throw invalid(endpoint, parsed.error);
      const [poll] = parsed.data.data;
      if (!poll)
        throw new TwitchError(
          'TWITCH_INVALID_RESPONSE',
          'Twitch returned an unexpected response.',
          { endpoint },
        );
      return toPoll(poll);
    },

    async sendChatAnnouncement(input) {
      const endpoint = 'POST /chat/announcements';
      const message = input.message.trim();
      if (!ID.test(input.broadcasterId) || !ID.test(input.moderatorId))
        throw refuse('A broadcaster and moderator id are required.', endpoint);
      // Twitch silently truncates longer text; refuse so the creator sees exactly what is sent.
      if (
        !message ||
        length(message) > TWITCH_FEATURE_LIMITS.announcement.messageLength ||
        hasControl(message)
      )
        throw refuse('Announcements need 1–500 characters without control characters.', endpoint);
      if (input.color !== undefined && !ANNOUNCEMENT_COLORS.includes(input.color))
        throw refuse('That announcement color is not available.', endpoint);
      const params = new URLSearchParams({
        broadcaster_id: input.broadcasterId,
        moderator_id: input.moderatorId,
      });
      try {
        // for_source_only is refused with a user access token (HTTP 400), so it is never
        // sent. 429 is the announcement cooldown, and a 5xx may already have posted: no retry.
        await request(
          'POST',
          `/chat/announcements?${params.toString()}`,
          endpoint,
          { message, ...(input.color ? { color: input.color } : {}) },
          0,
        );
      } catch (error) {
        throw refine(error, endpoint);
      }
    },

    async sendShoutout(input) {
      const endpoint = 'POST /chat/shoutouts';
      if (
        !ID.test(input.fromBroadcasterId) ||
        !ID.test(input.toBroadcasterId) ||
        !ID.test(input.moderatorId)
      )
        throw refuse('Shoutouts need valid broadcaster ids.', endpoint);
      if (input.fromBroadcasterId === input.toBroadcasterId)
        throw new TwitchError('TWITCH_INVALID_REQUEST', 'A channel cannot shout itself out.', {
          endpoint,
          reason: 'self_shoutout',
        });
      const params = new URLSearchParams({
        from_broadcaster_id: input.fromBroadcasterId,
        to_broadcaster_id: input.toBroadcasterId,
        moderator_id: input.moderatorId,
      });
      try {
        // 429 is a documented cooldown and a 5xx may already have applied: never retried.
        await request('POST', `/chat/shoutouts?${params.toString()}`, endpoint, undefined, 0);
      } catch (error) {
        throw refine(error, endpoint);
      }
    },
  };
  return client;
}
