import type { Decision, DecisionCode, Manifest, Role } from '../lib/types.js';

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
};
export const tone = (code: string | null): 'good' | 'warn' | 'bad' | 'muted' =>
  code === 'ACCEPTED' ||
  code === 'APPROVED' ||
  code === 'RESUMED' ||
  code === 'RESUME' ||
  code === 'ROLLBACK'
    ? 'good'
    : code === 'INCIDENT' || code === 'DISABLED' || code === 'PANIC'
      ? 'bad'
      : code === 'UNRELATED' || code === 'DUPLICATE' || code === 'STOPPED' || code === 'PAUSED'
        ? 'muted'
        : 'warn';

/** One plain-language sentence explaining a host decision. */
export function explain(
  decision: Decision,
  text: string,
  viewer: string,
  manifest: Manifest,
): string {
  const t = manifest.trigger;
  const n = decision.effects.length;
  const a = decision.allowance;
  const asset = decision.effects[0]?.asset ?? 'effect';
  switch (decision.code) {
    case 'ACCEPTED':
      if (manifest.experience)
        return `${viewer}: ${decision.reason} ${decision.effects.length ? `${decision.effects.length} visual effect${decision.effects.length === 1 ? '' : 's'}.` : 'No visual effect.'}`;
      return `${viewer} typed ${t.command} — ${n === 1 ? `a ${asset} flies` : `${n} ${asset}s fly`}. ${a ? `${a.used} of ${a.max} used this ${formatWindow(t.windowMs)}.` : ''}`;
    case 'VIEWER_LIMIT':
      return `${viewer} already used ${t.maxPerViewer} of ${t.maxPerViewer} in the last ${formatWindow(t.windowMs)}${a?.nextAt != null && decision.at != null ? ` — next one in ${formatClock(a.nextAt - decision.at)}` : ''}. Nothing thrown; the interaction keeps running.`;
    case 'AUDIENCE':
      return `${viewer} can’t trigger this — only ${audienceLabel(t.audience)} can.`;
    case 'UNRELATED':
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
