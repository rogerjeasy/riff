import { TWITCH_ACTION_LIMITS, type TwitchAction } from '@riff/sdk';
import { TWITCH_FEATURE_SCOPES, type HelixClient, type HelixPoll } from '@riff/twitch';
import type { z } from 'zod';
import {
  emptyState,
  FEATURE_CAPABILITY,
  FEATURES,
  HISTORY_LIMIT,
  SHOUTOUT_POLICY_LIMITS,
  storedSchema,
  type announceBody,
  type Feature,
  type HistoryEntry,
  type pollBody,
  type PollSnapshot,
  type StoredTwitchFeatures,
} from './contract.js';
import { fromTwitch, RiffError } from './errors.js';
import type { TwitchFeaturesRepository } from '../../db/repositories/twitch-features.js';

export type HelixPort = Pick<
  HelixClient,
  'createPoll' | 'getPolls' | 'endPoll' | 'sendChatAnnouncement' | 'sendShoutout' | 'getUsers'
>;
export type Origin = 'manual' | 'automation';
/** The raid that produced a decision, from the authenticated, normalized EventSub event. */
export interface RaidContext {
  /** `from_broadcaster_user_id`: the only channel a raid-triggered shoutout may target. */
  id: string;
  login: string | null;
  displayName: string;
}
export type FeatureState =
  'not-connected' | 'needs-grant' | 'disabled' | 'checking' | 'ineligible' | 'ready';
export interface FeatureStatus {
  feature: Feature;
  capability: string;
  scope: string;
  state: FeatureState;
  message: string;
  usedBy: { automationId: string; title: string; live: boolean }[];
}
export interface AutomationUse {
  automationId: string;
  title: string;
  capabilities: readonly string[];
  live: boolean;
}
interface ActivityEntry {
  kind: 'decision' | 'incident' | 'control';
  automationId: string | null;
  code: string;
  message: string;
}
const HOUR = 3_600_000;
const POLL_REFRESH_MS = 5000;

/**
 * Native Twitch polls, announcements and shoutouts (F21/F23). Every call — manual or
 * staged by an approved automation — passes feature consent/eligibility, the channel
 * budget and Twitch's documented hard caps here before one Helix request is made.
 * Previews never reach this service. Panic fences queued work in memory first, then
 * ends the poll Riff started.
 */
export function createTwitchFeatureService(deps: {
  storage: TwitchFeaturesRepository;
  connection: {
    identity(): { userId: string; login: string | null } | null;
    grantedScopes(): readonly string[];
    helix(): HelixPort | null;
  };
  blocked: () => boolean;
  automations: () => readonly AutomationUse[];
  record: (entry: ActivityEntry) => void;
  /** Disable the automation that overran a channel budget (AGENTS §4). */
  disable: (automationId: string, reason: string) => void;
  changed: () => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let lastRefresh = 0;
  let closed = false;
  // Every read-modify-write of the stored row runs under one lock, so a slow Helix call
  // can never overwrite a concurrent budget, policy or toggle change with a stale copy.
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = lock.then(fn);
    lock = next.catch(() => undefined);
    return next;
  }

  function load(): StoredTwitchFeatures {
    const parsed = storedSchema.safeParse(deps.storage.get());
    // A corrupt row fails closed: shoutouts off, no remembered poll, empty budgets.
    return parsed.success ? parsed.data : emptyState();
  }
  function save(state: StoredTwitchFeatures) {
    const at = now();
    const keep = (list: number[], span: number) => list.filter((t) => t > at - span).slice(-64);
    state.windows.announcements = keep(state.windows.announcements, 60_000);
    state.windows.polls = keep(state.windows.polls, HOUR);
    state.windows.shoutouts = keep(state.windows.shoutouts, HOUR);
    state.windows.shoutoutTargets = Object.fromEntries(
      Object.entries(state.windows.shoutoutTargets).filter(
        ([, t]) => t > at - TWITCH_ACTION_LIMITS.shoutout.sameTargetCooldownMs,
      ),
    );
    state.raiders = state.raiders.filter((r) => r.at > at - SHOUTOUT_POLICY_LIMITS.raiderWindowMs);
    state.history = state.history.slice(-HISTORY_LIMIT);
    deps.storage.save(state as unknown as Record<string, unknown>);
  }
  function remember(state: StoredTwitchFeatures, entry: Omit<HistoryEntry, 'at'>) {
    state.history.push({ ...entry, at: now() });
  }

  function featureState(state: StoredTwitchFeatures, feature: Feature): [FeatureState, string] {
    const identity = deps.connection.identity();
    if (!identity) return ['not-connected', 'Connect Twitch first.'];
    const scope = TWITCH_FEATURE_SCOPES[feature][0];
    if (!deps.connection.grantedScopes().includes(scope))
      return [
        'needs-grant',
        `Grant “${scope}” on Twitch to use ${feature}. Riff asks for it only when you choose to.`,
      ];
    if (state.disabled.includes(feature))
      return ['disabled', 'Turned off in Riff. Nothing is sent until you turn it back on.'];
    if (feature === 'polls') {
      if (state.broadcasterType === null)
        return ['checking', 'Checking whether this channel can run Twitch polls…'];
      if (state.broadcasterType === '')
        return [
          'ineligible',
          'Twitch polls are available to Affiliates and Partners only. Riff’s own chat ballots still work.',
        ];
    }
    return ['ready', 'Ready.'];
  }
  async function requireReady(state: StoredTwitchFeatures, feature: Feature) {
    // Eligibility is read only once consent exists, so an ungranted feature makes no call.
    if (featureState(state, feature)[0] === 'checking') await checkEligibility(state);
    const [status, message] = featureState(state, feature);
    if (status === 'ready') return;
    const code =
      status === 'not-connected'
        ? 'NOT_CONNECTED'
        : status === 'needs-grant'
          ? 'SCOPE_MISSING'
          : status === 'disabled'
            ? 'FEATURE_DISABLED'
            : 'NOT_ELIGIBLE';
    throw new RiffError(code, message);
  }
  function helix(): HelixPort {
    const client = deps.connection.helix();
    if (!client) throw new RiffError('NOT_CONNECTED', 'Connect Twitch first.');
    return client;
  }
  function identity() {
    const id = deps.connection.identity();
    if (!id) throw new RiffError('NOT_CONNECTED', 'Connect Twitch first.');
    return id;
  }
  async function checkEligibility(state: StoredTwitchFeatures) {
    const { userId } = identity();
    try {
      const [user] = await helix().getUsers({ ids: [userId] });
      const type = user?.broadcasterType;
      state.broadcasterType = type === 'partner' || type === 'affiliate' ? type : '';
      state.eligibilityCheckedAt = now();
    } catch (error) {
      throw fromTwitch(error);
    }
  }
  function toSnapshot(
    poll: HelixPoll,
    origin: Origin,
    automationId: string | null,
    previous?: PollSnapshot | null,
  ): PollSnapshot {
    // The host clock times the poll it started; Twitch timestamps can be skewed from it.
    const started = now();
    const ended = poll.endedAt ? Date.parse(poll.endedAt) : NaN;
    return {
      id: poll.id,
      title: poll.title.slice(0, 60),
      choices: poll.choices
        .slice(0, 5)
        .map((c) => ({ id: c.id, title: c.title.slice(0, 25), votes: c.votes })),
      status: poll.status,
      startedAt: previous?.startedAt ?? started,
      endsAt: previous?.endsAt ?? started + poll.durationSeconds * 1000,
      endedAt: poll.status === 'ACTIVE' ? null : Number.isFinite(ended) ? ended : now(),
      origin,
      automationId,
      refreshedAt: now(),
    };
  }
  const pollRunning = (poll: PollSnapshot | null) =>
    !!poll && poll.status === 'ACTIVE' && poll.endsAt > now();

  /** Run one operation and record its outcome; refusals are recorded, never retried. */
  async function perform<T>(
    kind: HistoryEntry['kind'],
    origin: Origin | 'panic',
    automationId: string | null,
    op: (state: StoredTwitchFeatures) => Promise<{ value: T; message: string }>,
  ): Promise<T> {
    return exclusive(() => performNow(kind, origin, automationId, op));
  }
  async function performNow<T>(
    kind: HistoryEntry['kind'],
    origin: Origin | 'panic',
    automationId: string | null,
    op: (state: StoredTwitchFeatures) => Promise<{ value: T; message: string }>,
  ): Promise<T> {
    const state = load();
    try {
      const { value, message } = await op(state);
      remember(state, { kind, origin, outcome: 'sent', code: 'SENT', message, automationId });
      save(state);
      deps.record({ kind: 'control', automationId, code: kind.toUpperCase(), message });
      deps.changed();
      return value;
    } catch (cause) {
      const error = fromTwitch(cause);
      const failed = error.code === 'TWITCH_UNAVAILABLE';
      remember(state, {
        kind,
        origin,
        outcome: failed ? 'failed' : 'refused',
        code: error.code,
        message: error.message.slice(0, 300),
        automationId,
      });
      try {
        save(state);
      } catch {
        /* The refusal still reaches the caller. */
      }
      deps.changed();
      throw error;
    }
  }
  const fence = (origin: Origin | 'panic', started: number) => {
    if (origin !== 'panic' && (deps.blocked() || closed))
      throw new RiffError('STOPPED', 'Everything is stopped. Resume the channel first.');
    if (origin === 'automation' && started !== generation)
      throw new RiffError('STOPPED', 'Stopped before this action was sent.');
  };

  async function startPoll(
    body: z.output<typeof pollBody>,
    origin: Origin,
    automationId: string | null = null,
  ) {
    const started = generation;
    return perform('poll.start', origin, automationId, async (state) => {
      fence(origin, started);
      await requireReady(state, 'polls');
      // Channel budget, then Twitch's hard cap (one poll at a time).
      const at = now();
      if (
        state.windows.polls.filter((t) => t > at - HOUR).length >=
        TWITCH_ACTION_LIMITS.channel.pollsPerHour
      )
        throw new RiffError(
          'LIMIT_EXCEEDED',
          `This channel already ran ${TWITCH_ACTION_LIMITS.channel.pollsPerHour} polls in the last hour.`,
        );
      if (pollRunning(state.poll))
        throw new RiffError(
          'POLL_ACTIVE',
          'A poll is already running. End it or wait for it to finish before starting another.',
        );
      const { userId } = identity();
      const result = await helix().createPoll({
        broadcasterId: userId,
        title: body.title,
        choices: body.choices,
        durationSeconds: body.durationSeconds,
      });
      state.windows.polls.push(at);
      state.poll = toSnapshot(result.poll, origin, automationId);
      // Panic may have arrived while Twitch answered: end what we just started.
      if (deps.blocked() || started !== generation) void stopPollAfterPanic();
      return {
        value: state.poll,
        message: `Twitch poll “${state.poll.title}” started for ${body.durationSeconds} s${result.recovered ? ' (confirmed after a slow response)' : ''}.`,
      };
    });
  }
  async function endPoll(origin: Origin | 'panic', automationId: string | null = null) {
    const started = generation;
    return perform('poll.end', origin, automationId, async (state) => {
      fence(origin, started);
      const poll = state.poll;
      if (!pollRunning(poll) || !poll)
        throw new RiffError('NO_ACTIVE_POLL', 'No poll started by Riff is running.');
      // An automation may end only the poll that same automation started.
      if (
        origin === 'automation' &&
        (poll.origin !== 'automation' || poll.automationId !== automationId)
      )
        throw new RiffError('POLICY_DENIED', 'Automations can only end polls they started.');
      const { userId } = identity();
      try {
        const ended = await helix().endPoll({
          broadcasterId: userId,
          id: poll.id,
          status: 'TERMINATED',
        });
        state.poll = toSnapshot(ended, poll.origin, poll.automationId, poll);
      } catch (cause) {
        const error = fromTwitch(cause);
        // Already over at Twitch: converge local state instead of failing again later.
        if (error.code === 'NO_ACTIVE_POLL')
          state.poll = { ...poll, status: 'COMPLETED', endedAt: now() };
        throw error;
      }
      return {
        value: state.poll,
        message:
          origin === 'panic'
            ? `Stop everything ended the Twitch poll “${poll.title}”. Results stay visible.`
            : `Twitch poll “${poll.title}” ended early. Results stay visible.`,
      };
    });
  }
  async function stopPollAfterPanic() {
    try {
      await endPoll('panic');
    } catch {
      /* Best effort: the console shows the poll state and a manual end button. */
    }
  }
  async function announce(
    body: z.output<typeof announceBody>,
    origin: Origin,
    automationId: string | null = null,
  ) {
    const started = generation;
    return perform('announce', origin, automationId, async (state) => {
      fence(origin, started);
      await requireReady(state, 'announcements');
      const at = now();
      const recent = state.windows.announcements.filter((t) => t > at - 60_000);
      if (recent.length >= TWITCH_ACTION_LIMITS.channel.announcementsPerMinute)
        throw new RiffError(
          'LIMIT_EXCEEDED',
          `The channel announcement budget (${TWITCH_ACTION_LIMITS.channel.announcementsPerMinute} a minute) is used up. Try again in a minute.`,
        );
      const last = recent.at(-1);
      if (last !== undefined && at - last < TWITCH_ACTION_LIMITS.announcement.minIntervalMs)
        throw new RiffError(
          'COOLDOWN',
          'Twitch allows one announcement every 2 seconds. Wait a moment and try again.',
        );
      const { userId } = identity();
      // Record intent before the call: an ambiguous failure still spends budget, because
      // the announcement may have posted and is never retried.
      state.windows.announcements.push(at);
      try {
        await helix().sendChatAnnouncement({
          broadcasterId: userId,
          moderatorId: userId,
          message: body.message,
          color: body.color,
        });
      } catch (error) {
        save(state);
        throw error;
      }
      return { value: undefined, message: `Announcement sent: “${body.message.slice(0, 120)}”` };
    });
  }
  async function shoutout(login: string, origin: Origin, automationId: string | null = null) {
    const started = generation;
    return perform('shoutout', origin, automationId, async (state) => {
      fence(origin, started);
      await requireReady(state, 'shoutouts');
      const target = login.trim().toLowerCase();
      const self = identity();
      if (self.login && self.login.toLowerCase() === target)
        throw new RiffError('INVALID_REQUEST', 'A channel cannot shout itself out.');
      const policy = state.shoutout;
      const at = now();
      const approved =
        policy.mode === 'allowlist'
          ? policy.allowlist.find((c) => c.login === target)
          : policy.mode === 'raiders'
            ? state.raiders.find(
                (r) => r.login === target && r.at > at - SHOUTOUT_POLICY_LIMITS.raiderWindowMs,
              )
            : undefined;
      if (policy.mode === 'off')
        throw new RiffError(
          'POLICY_DENIED',
          'Shoutouts are off. Choose an approved list or “raiders only” in Twitch features.',
        );
      if (!approved)
        throw new RiffError(
          'POLICY_DENIED',
          policy.mode === 'allowlist'
            ? `@${target} is not on your approved shoutout list.`
            : `@${target} has not raided this channel in the last hour.`,
        );
      return deliverShoutout(state, approved, at);
    });
  }

  /**
   * Shared tail for every shoutout, chosen manually, by policy or by the raid rule: channel
   * budget, then Twitch's 2 min global and 60 min same-target cooldowns, then one Helix call.
   */
  async function deliverShoutout(
    state: StoredTwitchFeatures,
    approved: { id: string; login: string },
    at: number,
  ) {
    const self = identity();
    if (
      state.windows.shoutouts.filter((t) => t > at - HOUR).length >=
      TWITCH_ACTION_LIMITS.channel.shoutoutsPerHour
    )
      throw new RiffError(
        'LIMIT_EXCEEDED',
        `This channel already sent ${TWITCH_ACTION_LIMITS.channel.shoutoutsPerHour} shoutouts in the last hour.`,
      );
    const last = state.windows.shoutouts.at(-1);
    if (last !== undefined && at - last < TWITCH_ACTION_LIMITS.shoutout.globalCooldownMs)
      throw new RiffError(
        'COOLDOWN',
        `Twitch allows one shoutout every 2 minutes. Next one at ${new Date(last + TWITCH_ACTION_LIMITS.shoutout.globalCooldownMs).toISOString()}.`,
        { availableAt: last + TWITCH_ACTION_LIMITS.shoutout.globalCooldownMs },
      );
    const same = state.windows.shoutoutTargets[approved.id];
    if (same !== undefined && at - same < TWITCH_ACTION_LIMITS.shoutout.sameTargetCooldownMs)
      throw new RiffError(
        'COOLDOWN',
        `@${approved.login} already got a shoutout in the last hour (Twitch limit).`,
        { availableAt: same + TWITCH_ACTION_LIMITS.shoutout.sameTargetCooldownMs },
      );
    state.windows.shoutouts.push(at);
    state.windows.shoutoutTargets[approved.id] = at;
    try {
      await helix().sendShoutout({
        fromBroadcasterId: self.userId,
        toBroadcasterId: approved.id,
        moderatorId: self.userId,
      });
    } catch (error) {
      const refused = fromTwitch(error);
      // A definite refusal did not consume Twitch's cooldown; an ambiguous one might have.
      if (refused.code !== 'TWITCH_UNAVAILABLE') {
        state.windows.shoutouts.pop();
        state.windows.shoutoutTargets = Object.fromEntries(
          Object.entries(state.windows.shoutoutTargets).filter(([id]) => id !== approved.id),
        );
      }
      save(state);
      throw refused;
    }
    return { value: undefined, message: `Shoutout sent to @${approved.login}.` };
  }
  /**
   * F23 host-owned raid rule: shout out the broadcaster of the raid that triggered this
   * automation. The target comes from the normalized raid event only; it needs the
   * creator's explicit "shout out raiders automatically" consent on top of the policy.
   */
  async function raiderShoutout(raider: RaidContext, automationId: string) {
    const started = generation;
    return perform('shoutout', 'automation', automationId, async (state) => {
      fence('automation', started);
      await requireReady(state, 'shoutouts');
      if (state.shoutout.mode === 'off')
        throw new RiffError(
          'POLICY_DENIED',
          'Shoutouts are off. Choose an approved list or “raiders only” in Twitch features.',
        );
      if (!state.shoutout.autoRaid)
        throw new RiffError(
          'POLICY_DENIED',
          'Automatic raid shoutouts are off. Turn on “Shout out raiders automatically” in Twitch features.',
        );
      const self = identity();
      if (self.userId === raider.id)
        throw new RiffError('INVALID_REQUEST', 'A channel cannot shout itself out.');
      const login = (raider.login ?? raider.displayName).toLowerCase();
      return deliverShoutout(state, { id: raider.id, login }, now());
    });
  }

  /** Execute staged automation actions in order; refusals never affect the handler. */
  function dispatch(
    actions: readonly TwitchAction[],
    context: { automationId: string; viewer: string; raid?: RaidContext | undefined },
  ): Promise<void> {
    const started = generation;
    const next = queue.then(async () => {
      for (const action of actions) {
        if (started !== generation || deps.blocked() || closed) return;
        try {
          if (action.kind === 'poll.start')
            await startPoll(
              {
                title: action.title,
                choices: action.choices,
                durationSeconds: action.durationSeconds,
              },
              'automation',
              context.automationId,
            );
          else if (action.kind === 'poll.end') await endPoll('automation', context.automationId);
          else if (action.kind === 'announce')
            await announce(
              { message: action.message, color: action.color },
              'automation',
              context.automationId,
            );
          else if (action.kind === 'shoutout.raider') {
            // Defense in depth: the sandbox bound raiderId from this same raid event.
            if (!context.raid || context.raid.id !== action.raiderId)
              throw new RiffError(
                'POLICY_DENIED',
                'Automatic shoutouts may only target the channel that just raided.',
              );
            await raiderShoutout(context.raid, context.automationId);
          } else await shoutout(action.login, 'automation', context.automationId);
        } catch (cause) {
          const error = fromTwitch(cause);
          deps.record({
            kind: error.code === 'LIMIT_EXCEEDED' ? 'incident' : 'decision',
            automationId: context.automationId,
            code: error.code,
            message: `${context.viewer}’s ${action.kind} was not sent: ${error.message}`,
          });
          // Overrunning a host channel budget disables the automation that caused it.
          if (error.code === 'LIMIT_EXCEEDED') deps.disable(context.automationId, error.message);
        }
      }
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function snapshot() {
    const state = load();
    const uses = deps.automations();
    const at = now();
    const features: FeatureStatus[] = FEATURES.map((feature) => {
      const [status, message] = featureState(state, feature);
      return {
        feature,
        capability: FEATURE_CAPABILITY[feature],
        scope: TWITCH_FEATURE_SCOPES[feature][0],
        state: status,
        message,
        usedBy: uses
          .filter((u) => u.capabilities.includes(FEATURE_CAPABILITY[feature]))
          .map((u) => ({ automationId: u.automationId, title: u.title, live: u.live })),
      };
    });
    const lastShoutout = state.windows.shoutouts.at(-1);
    const lastAnnouncement = state.windows.announcements.at(-1);
    return {
      connected: !!deps.connection.identity(),
      login: deps.connection.identity()?.login ?? null,
      stopped: deps.blocked(),
      broadcasterType: state.broadcasterType,
      features,
      poll: state.poll,
      shoutout: {
        mode: state.shoutout.mode,
        autoRaid: state.shoutout.autoRaid,
        allowlist: state.shoutout.allowlist,
        raiders: state.raiders
          .filter((r) => r.at > at - SHOUTOUT_POLICY_LIMITS.raiderWindowMs)
          .map((r) => ({ login: r.login, displayName: r.displayName, at: r.at })),
        availableAt:
          lastShoutout !== undefined &&
          at - lastShoutout < TWITCH_ACTION_LIMITS.shoutout.globalCooldownMs
            ? lastShoutout + TWITCH_ACTION_LIMITS.shoutout.globalCooldownMs
            : null,
      },
      budgets: {
        announcements: {
          used: state.windows.announcements.filter((t) => t > at - 60_000).length,
          limit: TWITCH_ACTION_LIMITS.channel.announcementsPerMinute,
          windowMs: 60_000,
          availableAt:
            lastAnnouncement !== undefined &&
            at - lastAnnouncement < TWITCH_ACTION_LIMITS.announcement.minIntervalMs
              ? lastAnnouncement + TWITCH_ACTION_LIMITS.announcement.minIntervalMs
              : null,
        },
        polls: {
          used: state.windows.polls.filter((t) => t > at - HOUR).length,
          limit: TWITCH_ACTION_LIMITS.channel.pollsPerHour,
          windowMs: HOUR,
        },
        shoutouts: {
          used: state.windows.shoutouts.filter((t) => t > at - HOUR).length,
          limit: TWITCH_ACTION_LIMITS.channel.shoutoutsPerHour,
          windowMs: HOUR,
        },
      },
      history: [...state.history].reverse(),
    };
  }

  return {
    snapshot,
    startPoll: (body: z.output<typeof pollBody>) => startPoll(body, 'manual'),
    endPoll: () => endPoll('manual'),
    announce: (body: z.output<typeof announceBody>) => announce(body, 'manual'),
    shoutout: (login: string) => shoutout(login, 'manual'),
    dispatch,
    async setFeature(feature: Feature, enabled: boolean) {
      await exclusive(() => {
        const state = load();
        state.disabled = enabled
          ? state.disabled.filter((f) => f !== feature)
          : [...new Set([...state.disabled, feature])];
        save(state);
      });
      deps.record({
        kind: 'control',
        automationId: null,
        code: enabled ? 'FEATURE_ON' : 'FEATURE_OFF',
        message: `Twitch ${feature} ${enabled ? 'turned on' : 'turned off'} in Riff.`,
      });
      deps.changed();
      return snapshot();
    },
    async refreshEligibility() {
      await exclusive(async () => {
        const state = load();
        await checkEligibility(state);
        save(state);
      });
      deps.changed();
      return snapshot();
    },
    /** Resolve logins with Get Users so the policy stores stable ids, not display text. */
    async setShoutoutPolicy(
      mode: 'off' | 'allowlist' | 'raiders',
      logins: readonly string[],
      autoRaid?: boolean,
    ) {
      const unique = [...new Set(logins.map((l) => l.trim().toLowerCase()))];
      if (unique.length > SHOUTOUT_POLICY_LIMITS.allowlist)
        throw new RiffError(
          'INVALID_REQUEST',
          `Approve at most ${SHOUTOUT_POLICY_LIMITS.allowlist} channels.`,
        );
      const self = mode === 'off' && !unique.length ? null : identity();
      if (self?.login && unique.includes(self.login.toLowerCase()))
        throw new RiffError('INVALID_REQUEST', 'Your own channel cannot be on the shoutout list.');
      let allowlist: StoredTwitchFeatures['shoutout']['allowlist'] = [];
      if (unique.length) {
        let users;
        try {
          users = await helix().getUsers({ logins: unique });
        } catch (error) {
          throw fromTwitch(error);
        }
        const found = new Map(users.map((u) => [u.login.toLowerCase(), u]));
        const missing = unique.filter((l) => !found.has(l));
        if (missing.length)
          throw new RiffError(
            'INVALID_REQUEST',
            `Twitch has no channel named ${missing.map((m) => `@${m}`).join(', ')}. Check the spelling.`,
          );
        allowlist = unique.flatMap((l) => {
          const u = found.get(l);
          return u ? [{ id: u.id, login: l, displayName: u.displayName.slice(0, 60) }] : [];
        });
      }
      let automatic = false;
      await exclusive(() => {
        const state = load();
        // Turning shoutouts off also withdraws the automatic raid consent; otherwise an
        // omitted autoRaid keeps the creator's earlier choice.
        automatic = mode !== 'off' && (autoRaid ?? state.shoutout.autoRaid);
        state.shoutout = { mode, allowlist, autoRaid: automatic };
        save(state);
      });
      deps.record({
        kind: 'control',
        automationId: null,
        code: 'SHOUTOUT_POLICY',
        message:
          (mode === 'off'
            ? 'Shoutouts turned off.'
            : mode === 'raiders'
              ? 'Shoutouts limited to channels that raided in the last hour.'
              : `Shoutouts limited to ${allowlist.length} approved channel${allowlist.length === 1 ? '' : 's'}.`) +
          (automatic ? ' Raiders are shouted out automatically when an interaction asks.' : ''),
      });
      deps.changed();
      return snapshot();
    },
    /** True when the shoutout policy needs incoming raid notifications. */
    wantsRaids(): boolean {
      return load().shoutout.mode === 'raiders';
    },
    /** Remember an authenticated incoming raid for the "raiders only" shoutout policy. */
    async recordRaid(raider: { id: string; login: string; displayName: string }) {
      await exclusive(() => {
        const state = load();
        state.raiders = [
          ...state.raiders.filter((r) => r.id !== raider.id),
          { ...raider, login: raider.login.toLowerCase(), at: now() },
        ].slice(-SHOUTOUT_POLICY_LIMITS.raiders);
        save(state);
      });
      deps.changed();
    },
    /** Poll results refresh while a poll Riff started is running. */
    async tick() {
      const state = load();
      const poll = state.poll;
      if (!poll || poll.status !== 'ACTIVE' || closed) return;
      const at = now();
      if (at - lastRefresh < POLL_REFRESH_MS) return;
      lastRefresh = at;
      const client = deps.connection.helix();
      const self = deps.connection.identity();
      if (!client || !self) return;
      try {
        const [fresh] = await client.getPolls({ broadcasterId: self.userId, ids: [poll.id] });
        if (!fresh) return;
        const updated = await exclusive(() => {
          const current = load();
          if (current.poll?.id !== poll.id || current.poll.status !== 'ACTIVE') return false;
          current.poll = toSnapshot(fresh, poll.origin, poll.automationId, poll);
          save(current);
          return true;
        });
        if (updated) deps.changed();
      } catch {
        /* Results stay at their last value; the console shows when they were refreshed. */
      }
    },
    /** Fence memory first (queued automation actions are dropped), then end our poll. */
    panic(): Promise<void> {
      generation++;
      let poll: PollSnapshot | null = null;
      try {
        poll = load().poll;
      } catch {
        return Promise.resolve();
      }
      if (!pollRunning(poll)) return Promise.resolve();
      return stopPollAfterPanic();
    },
    close() {
      closed = true;
      generation++;
    },
  };
}
export type TwitchFeatureService = ReturnType<typeof createTwitchFeatureService>;
