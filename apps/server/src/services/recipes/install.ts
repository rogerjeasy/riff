import { SDK_VERSION, type RecipePackage } from '@riff/sdk';
import { TRIGGERS, TWITCH_FEATURE_SCOPES } from '@riff/twitch';
import { blockersFor, commandsOf } from './contract.js';

/**
 * F27 install-link preview: pure compatibility and authority computation for one pinned
 * edition against this channel. Nothing here reads or writes storage.
 */
type Manifest = RecipePackage['manifest'];
export type Eligibility = 'affiliate' | 'partner' | 'ineligible' | 'unknown';
/** Host-side Twitch facts; scopes only, never tokens. */
export interface TwitchAccess {
  connected: boolean;
  scopes: readonly string[];
  eligibility: Eligibility;
}
export type CheckStatus = 'ok' | 'blocked' | 'consent' | 'warn';
export interface CompatibilityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Same-origin consent link, present only for `consent` checks. */
  grantUrl?: string;
}
export interface ScopeRow {
  field: string;
  label: string;
  /** Null when nothing comparable is installed. */
  before: string | null;
  after: string;
  changed: boolean;
}

const NATIVE: Record<string, keyof typeof TWITCH_FEATURE_SCOPES> = {
  polls: 'polls',
  'chat.announce': 'announcements',
  shoutout: 'shoutouts',
};
const ELIGIBILITY_GATED = new Set(['polls', 'predictions']);

/** Every check the guided install shows; `blocked` entries prevent installation. */
export function compatibilityFor(
  pack: RecipePackage,
  allowed: readonly string[],
  access: TwitchAccess,
  commandConflict: string | null,
): { installable: boolean; sdkVersion: string; checks: CompatibilityCheck[] } {
  const manifest = pack.manifest as unknown as Record<string, unknown> & Partial<Manifest>;
  const checks: CompatibilityCheck[] = [];
  const sdk = String(manifest.sdkVersion ?? 'missing').slice(0, 40);
  const sdkOk = sdk === SDK_VERSION || sdk === '0.3.0';
  checks.push({
    id: 'sdk',
    label: `SDK ${sdk}`,
    status: sdkOk ? 'ok' : 'blocked',
    detail: sdkOk
      ? `Runs on this installation (SDK ${SDK_VERSION}).`
      : `This installation runs SDK ${SDK_VERSION} and cannot run SDK ${sdk}. Ask the author for a compatible edition.`,
  });
  const has = (scopes: readonly string[]) => scopes.every((scope) => access.scopes.includes(scope));
  const capabilities = Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as unknown[]).map((item) => String(item).slice(0, 40))
    : [];
  for (const capability of capabilities) {
    const id = `capability:${capability}`;
    if (!allowed.includes(capability)) {
      checks.push({
        id,
        label: `Capability ${capability}`,
        status: 'blocked',
        detail: 'Not enabled for recipe installs on this channel. Nothing is substituted.',
      });
      continue;
    }
    const native = NATIVE[capability];
    if (native && !has(TWITCH_FEATURE_SCOPES[native]))
      checks.push({
        id,
        label: `Capability ${capability}`,
        status: 'consent',
        detail: 'Needs Twitch consent before it can act on your channel.',
        grantUrl: `/auth/twitch?feature=${native}`,
      });
    else if (ELIGIBILITY_GATED.has(capability) && access.eligibility === 'ineligible')
      checks.push({
        id,
        label: `Capability ${capability}`,
        status: 'blocked',
        detail: 'Twitch offers this only to Affiliate and Partner channels.',
      });
    else checks.push({ id, label: `Capability ${capability}`, status: 'ok', detail: 'Available.' });
  }
  if (!capabilities.length)
    checks.push({
      id: 'capabilities',
      label: 'Capabilities',
      status: 'blocked',
      detail: 'The recipe declares no capabilities.',
    });
  const trigger = manifest.trigger;
  if (trigger?.kind === 'points.redeem') {
    const scopes = TRIGGERS['points.redeem'].scopes;
    checks.push(
      access.eligibility === 'ineligible'
        ? {
            id: 'trigger',
            label: 'Channel Points trigger',
            status: 'blocked',
            detail: 'Channel Points need an Affiliate or Partner channel.',
          }
        : has(scopes)
          ? {
              id: 'trigger',
              label: 'Channel Points trigger',
              status: access.eligibility === 'unknown' ? 'warn' : 'ok',
              detail:
                access.eligibility === 'unknown'
                  ? 'Consent granted; Twitch eligibility is not confirmed yet.'
                  : 'Consent granted.',
            }
          : {
              id: 'trigger',
              label: 'Channel Points trigger',
              status: 'consent',
              detail: 'Needs Channel Points consent before redemptions can reach it.',
              grantUrl: '/auth/twitch?features=channel-points',
            },
    );
  } else if (trigger?.kind === 'twitch.event' && trigger.event) {
    const kind = trigger.event.kind;
    const scopes = kind in TRIGGERS ? TRIGGERS[kind as keyof typeof TRIGGERS].scopes : [];
    checks.push(
      has(scopes)
        ? {
            id: 'trigger',
            label: `Twitch ${kind} trigger`,
            status: 'ok',
            detail: 'Consent granted.',
          }
        : {
            id: 'trigger',
            label: `Twitch ${kind} trigger`,
            status: 'consent',
            detail: `Needs consent for ${kind} events before they can reach it.`,
            grantUrl: `/auth/twitch?triggers=${encodeURIComponent(kind)}`,
          },
    );
  } else if (trigger) {
    checks.push({
      id: 'trigger',
      label: 'Chat trigger',
      status: access.connected ? 'ok' : 'warn',
      detail: access.connected
        ? 'Reads chat with the user:read:chat consent you already granted.'
        : 'Connect Twitch before it can read chat. Rehearsal works without it.',
      ...(access.connected ? {} : { grantUrl: '/auth/twitch' }),
    });
  }
  if (commandConflict)
    checks.push({ id: 'command', label: 'Command', status: 'blocked', detail: commandConflict });
  // Remaining structural problems the specific checks above do not already describe.
  for (const blocker of blockersFor(pack, [...allowed])) {
    if (/^Unsupported (SDK|capability)|^Missing capability/.test(blocker)) continue;
    checks.push({
      id: `manifest:${checks.length}`,
      label: 'Rules',
      status: 'blocked',
      detail: blocker,
    });
  }
  return {
    installable: !checks.some((check) => check.status === 'blocked'),
    sdkVersion: sdk,
    checks,
  };
}

const roles = (list: string[] | undefined) => (list?.length ? list.join(', ') : 'nobody');
function scopeOf(manifest: Manifest): Omit<ScopeRow, 'before' | 'changed'>[] {
  const trigger = manifest.trigger;
  const source =
    trigger.kind === 'points.redeem'
      ? `Channel Points reward “${trigger.reward}”`
      : trigger.kind === 'twitch.event'
        ? `Twitch ${trigger.event.kind} event (minimum ${trigger.event.minimum})`
        : `Chat command ${trigger.command}`;
  const twitchScopes =
    trigger.kind === 'points.redeem'
      ? TRIGGERS['points.redeem'].scopes
      : trigger.kind === 'twitch.event'
        ? (TRIGGERS[trigger.event.kind as keyof typeof TRIGGERS]?.scopes ?? [])
        : ['user:read:chat'];
  const native = (manifest.capabilities ?? []).flatMap((capability) =>
    NATIVE[capability] ? [...TWITCH_FEATURE_SCOPES[NATIVE[capability]]] : [],
  );
  return [
    {
      field: 'capabilities',
      label: 'Capabilities',
      after: [...(manifest.capabilities ?? [])].sort().join(', ') || 'none',
    },
    { field: 'trigger', label: 'Trigger', after: source },
    { field: 'commands', label: 'Listens for', after: commandsOf(manifest).join(', ') },
    { field: 'audience', label: 'Audience', after: roles(trigger.audience) },
    {
      field: 'limits',
      label: 'Limits',
      after: `${trigger.maxPerViewer} per viewer per ${Math.round(trigger.windowMs / 1000)} s; ${manifest.limits?.effectsPerEvent ?? '?'} effects per event, ${manifest.limits?.effectsPerMinute ?? '?'} per minute`,
    },
    {
      field: 'experience',
      label: 'Shared session',
      after: manifest.experience
        ? `${manifest.experience.title}: ${Math.round(manifest.experience.durationMs / 1000)} s, ${manifest.experience.resource.perParticipant} ${manifest.experience.resource.name} per participant`
        : 'none',
    },
    {
      field: 'twitchScopes',
      label: 'Twitch consent',
      after: [...new Set([...twitchScopes, ...native])].join(', '),
    },
  ];
}
/** Authority the edition would hold, against nothing installed or an installed edition. */
export function scopeDiff(incoming: Manifest, installed: Manifest | null): ScopeRow[] {
  const before = installed ? scopeOf(installed) : null;
  return scopeOf(incoming).map((row, index) => {
    const prior = before?.[index]?.after ?? null;
    return { ...row, before: prior, changed: prior !== row.after };
  });
}
