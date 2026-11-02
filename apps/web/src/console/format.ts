import type { Decision, DecisionCode, Manifest, Role } from '../lib/types.js';
import type { TwitchEventKind } from './twitch/contracts.js';

export const formatWindow = (ms: number) =>
  ms % 3_600_000 === 0
    ? `${ms / 3_600_000} h`
    : ms % 60_000 === 0
      ? ms === 60_000
        ? 'minute'
        : `${ms / 60_000} min`
      : `${ms / 1000} s`;
export const formatDuration = (ms: number) =>
  ms % 3_600_000 === 0
    ? `${ms / 3_600_000} h`
    : ms % 60_000 === 0
      ? `${ms / 60_000} min`
      : `${ms / 1000} s`;
export const formatClock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
export const audienceLabel = (roles: Role[]) =>
  roles.includes('viewer') ? 'everyone in chat' : roles.map((r) => `${r}s`).join(' and ');
export const ago = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5
    ? 'just now'
    : s < 60
      ? `${s}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : `${Math.floor(s / 3600)}h ago`;
};
export const shortHash = (hash: string | null) =>
  hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : '—';

export const CODE_LABEL: Record<DecisionCode, string> = {
  ACCEPTED: 'Thrown',
  UNRELATED: 'Ignored',
  AUDIENCE: 'Not eligible',
  VIEWER_LIMIT: 'Limit reached',
  CHANNEL_LIMIT: 'Channel budget',
  DUPLICATE: 'Duplicate',
  INVALID_EVENT: 'Invalid',
  INCIDENT: 'Quarantined',
  DISABLED: 'Quarantined',
  CAPACITY: 'Rehearsal full',
  STOPPED: 'Stopped',
  NOT_JOINED: 'Join a team first',
  RESOURCE_LIMIT: 'Resources spent',
  SESSION_PAUSED: 'Round paused',
  SESSION_FINISHED: 'Round finished',
  ALREADY_JOINED: 'Already joined',
  PARTICIPANT_LIMIT: 'Round full',
  ELIMINATED: 'Team eliminated',
  LOCKED: 'Still locked',
  HEALTH_FULL: 'Health full',
  BURST_COUNTED: 'Already counted',
  BURST_ACTIVE: 'Shield active',
  BURST_LIMIT: 'Burst limit',
  ROUND_INTERMISSION: 'Between rounds',
  BELOW_MINIMUM: 'Below minimum',
};

const EVENT_TRIGGER_TEXT: Record<TwitchEventKind, (minimum: number) => string> = {
  subscribe: () => 'Someone subscribes',
  gift: (n) => (n > 1 ? `Someone gifts ${n}+ subs` : 'Someone gifts subs'),
  resub: (n) => (n > 1 ? `Someone resubscribes for ${n}+ months` : 'Someone resubscribes'),
  cheer: (n) => `Someone cheers ${n}+ bits`,
  raid: (n) => (n > 1 ? `A raid of ${n}+ viewers arrives` : 'A raid arrives'),
};
/** What starts an interaction, in plain words, keyed on `trigger.kind`. */
export function triggerSummary(manifest: Pick<Manifest, 'trigger'>): string {
  const trigger = manifest.trigger;
  if (trigger.kind === 'twitch.event')
    return EVENT_TRIGGER_TEXT[trigger.event.kind](trigger.event.minimum);
  if (trigger.kind === 'points.redeem') return `Someone redeems “${trigger.reward}”`;
  return `Someone types ${trigger.command}`;
}
/** Overlay instruction line; only chat triggers tell viewers to type a command. */
export function triggerInstruction(manifest: Pick<Manifest, 'trigger'>): string {
  return manifest.trigger.kind === 'twitch.event' || manifest.trigger.kind === 'points.redeem'
    ? triggerSummary(manifest)
    : `Type ${manifest.trigger.command}`;
}
export const tone = (code: string | null): 'good' | 'warn' | 'bad' | 'muted' =>
  code === 'ACCEPTED' ||
  code === 'APPROVED' ||
  code === 'RESUMED' ||
  code === 'RESUME' ||
  code === 'ROLLBACK'
    ? 'good'
    : code === 'INCIDENT' || code === 'DISABLED' || code === 'PANIC'
      ? 'bad'
      : code === 'UNRELATED' ||
          code === 'DUPLICATE' ||
          code === 'STOPPED' ||
          code === 'PAUSED' ||
          code === 'TIMER_CANCELLED'
        ? 'muted'
        : 'warn';

/** Plain-language description of one staged native Twitch action. */
export function describeAction(action: NonNullable<Decision['actions']>[number]): string {
  switch (action.kind) {
    case 'poll.start':
      return `would start the poll “${action.title}” (${action.choices.join(' / ')}) for ${action.durationSeconds} s`;
    case 'poll.end':
      return 'would end the running poll';
    case 'announce':
      return `would announce “${action.message}”`;
    case 'shoutout':
      return `would shout out @${action.login} (if your shoutout policy approves it)`;
    case 'shoutout.raider':
      return 'would shout out the channel that raided (if automatic raid shoutouts are on)';
  }
}

/** One plain-language sentence explaining a host decision. */
export function explain(
  decision: Decision,
  text: string,
  viewer: string,
  manifest: Manifest,
): string {
  const t = manifest.trigger;
  const ev = t.kind === 'twitch.event' ? t.event : null;
  const n = decision.effects.length;
  const a = decision.allowance;
  const asset = decision.effects[0]?.asset ?? 'effect';
  switch (decision.code) {
    case 'BELOW_MINIMUM':
      return `${viewer}’s ${ev?.kind ?? 'event'} is below the ${ev?.minimum ?? ''} minimum, so nothing ran.`;
    case 'ACCEPTED':
      // Rehearsals route native Twitch actions to a simulated sink; say what would happen.
      if (decision.actions?.length && decision.mode === 'preview')
        return `${ev ? `${triggerSummary(manifest)} (${viewer})` : `${viewer} typed ${t.command}`} — simulated Twitch, nothing sent: ${decision.actions.map(describeAction).join('; ')}.${n ? ` Plus ${n} visual effect${n === 1 ? '' : 's'}.` : ''}`;
      if (ev)
        return `${triggerSummary(manifest)} (${viewer}) — ${n === 1 ? `a ${asset} flies` : `${n} ${asset}s fly`}. ${a ? `${a.used} of ${a.max} used this ${formatWindow(t.windowMs)}.` : ''}`;
      if (manifest.experience)
        return `${viewer}: ${decision.reason} ${decision.effects.length ? `${decision.effects.length} visual effect${decision.effects.length === 1 ? '' : 's'}.` : 'No visual effect.'}`;
      return `${viewer} typed ${t.command} — ${n === 1 ? `a ${asset} flies` : `${n} ${asset}s fly`}. ${a ? `${a.used} of ${a.max} used this ${formatWindow(t.windowMs)}.` : ''}`;
    case 'VIEWER_LIMIT':
      return `${viewer} already used ${t.maxPerViewer} of ${t.maxPerViewer} in the last ${formatWindow(t.windowMs)}${a?.nextAt != null && decision.at != null ? ` — next one in ${formatClock(a.nextAt - decision.at)}` : ''}. Nothing thrown; the interaction keeps running.`;
    case 'AUDIENCE':
      return `${viewer} can’t trigger this — only ${audienceLabel(t.audience)} can.`;
    case 'UNRELATED':
      if (ev) return `That isn’t a ${ev.kind}, so this interaction ignored it.`;
      return `“${text.slice(0, 40)}” isn’t ${t.command}, so it was ignored.`;
    case 'DUPLICATE':
      return 'The same chat message arrived twice. It counted once and threw nothing extra.';
    case 'CHANNEL_LIMIT':
      return `The channel already showed ${manifest.limits.effectsPerMinute} effects this minute. Skipped to protect your stream.`;
    case 'CAPACITY':
      return 'This rehearsal is full. Reset it to keep testing.';
    default:
      return decision.reason;
  }
}
