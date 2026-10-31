import type { PermissionManifest } from '@riff/sdk';
import type { IntentCheck } from '@riff/compiler';
import type { VerificationReport } from '@riff/sandbox';
import { classifySessionTransition } from '@riff/sandbox';
import { describeAudience, describeWindow } from '@riff/compiler';
import type { VersionRow } from '../../db/repositories/studio.js';
import { versionApprovalBlockers } from '../../db/version-health.js';

export interface Evidence {
  verification: VerificationReport;
  intent: IntentCheck[];
  migration?: { source: string; ok: boolean; snapshots: string[]; failure: string | null };
}
export interface Change {
  field: string;
  label: string;
  from: string;
  to: string;
  /** Whether this change grants the interaction more or less authority. */
  authority: 'more' | 'less' | 'same';
}

const audienceRank = (roles: string[]) =>
  roles.includes('viewer')
    ? 4
    : roles.includes('subscriber')
      ? 3
      : roles.includes('moderator')
        ? 2
        : 1;

/** Plain-language difference between the active version and a candidate. */
export function diffVersions(from: VersionRow | undefined, to: VersionRow): Change[] {
  if (!from || from.id === to.id) return [];
  const a = from.manifest as PermissionManifest;
  const b = to.manifest as PermissionManifest;
  const changes: Change[] = [];
  const push = (
    field: string,
    label: string,
    x: string,
    y: string,
    authority: Change['authority'],
  ) => {
    if (x !== y) changes.push({ field, label, from: x, to: y, authority });
  };
  const cmp = (x: number, y: number): Change['authority'] =>
    y > x ? 'more' : y < x ? 'less' : 'same';
  push('command', 'Command', a.trigger.command, b.trigger.command, 'same');
  push(
    'audience',
    'Who can trigger it',
    describeAudience(a.trigger.audience),
    describeAudience(b.trigger.audience),
    cmp(
      audienceRank(a.trigger.audience) + a.trigger.audience.length / 10,
      audienceRank(b.trigger.audience) + b.trigger.audience.length / 10,
    ),
  );
  push(
    'maxPerViewer',
    'Per-viewer allowance',
    String(a.trigger.maxPerViewer),
    String(b.trigger.maxPerViewer),
    cmp(a.trigger.maxPerViewer, b.trigger.maxPerViewer),
  );
  push(
    'windowMs',
    'Rolling window',
    describeWindow(a.trigger.windowMs),
    describeWindow(b.trigger.windowMs),
    cmp(b.trigger.windowMs, a.trigger.windowMs),
  );
  push(
    'effectsPerEvent',
    'Effects per message',
    String(a.limits.effectsPerEvent),
    String(b.limits.effectsPerEvent),
    cmp(a.limits.effectsPerEvent, b.limits.effectsPerEvent),
  );
  push(
    'effectsPerMinute',
    'Effects per minute',
    String(a.limits.effectsPerMinute),
    String(b.limits.effectsPerMinute),
    cmp(a.limits.effectsPerMinute, b.limits.effectsPerMinute),
  );
  push(
    'capabilities',
    'Capabilities',
    a.capabilities.join(', ') || 'none',
    b.capabilities.join(', ') || 'none',
    b.capabilities.some((c) => !a.capabilities.includes(c)) ? 'more' : 'same',
  );
  if (JSON.stringify(a.experience ?? null) !== JSON.stringify(b.experience ?? null))
    changes.push({
      field: 'experience',
      label:
        a.experience &&
        b.experience &&
        classifySessionTransition(a.experience, b.experience) !== 'reset-required'
          ? 'Session rules (reviewed migration required)'
          : 'Session rules (explicit reset required)',
      from: a.experience ? JSON.stringify(a.experience) : 'No shared session',
      to: b.experience ? JSON.stringify(b.experience) : 'No shared session',
      authority: 'same',
    });
  if (from.source !== to.source)
    changes.push({
      field: 'source',
      label: 'Handler code',
      from: 'previous',
      to: 'changed',
      authority: 'same',
    });
  return changes;
}

/** Why a version cannot be approved right now; empty means it can. */
export const approvalBlockers = versionApprovalBlockers;

export function versionView(row: VersionRow, active: VersionRow | undefined, panic: boolean) {
  return {
    ...row,
    evidence: row.evidence as Evidence,
    changes: diffVersions(active, row),
    blockers: [
      ...approvalBlockers(row, panic),
      ...(active && active.id !== row.id && active.artifactId === row.artifactId
        ? [`Identical to live v${active.number}: approving would change nothing.`]
        : []),
    ],
  };
}
export type VersionView = ReturnType<typeof versionView>;
