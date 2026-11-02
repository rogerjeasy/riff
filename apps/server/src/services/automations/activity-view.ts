import { z } from 'zod';
import type { ActivityDetail } from '../../db/schema.js';
import type { ActivityRow, AutomationRow, VersionRow } from '../../db/repositories/studio.js';

const LABEL_MAX = 120;
const count = z.number().int().nonnegative().max(1_000_000);
const detailSchema = z.object({
  source: z.object({
    kind: z.enum(['chat', 'timer', 'redemption', 'twitch', 'console', 'system']),
    label: z.string().max(500),
  }),
  effects: z.object({ allowed: count, blocked: count }).optional(),
});

export type ActivityOutcome = 'accepted' | 'blocked' | 'incident' | 'info';
export type ActivitySource = ActivityDetail['source'];

/** Reader-facing activity entry: cause, exact version, outcome and effects (F16). */
export interface ActivityView {
  id: number;
  at: number;
  kind: ActivityRow['kind'];
  code: string | null;
  message: string;
  viewer: string | null;
  eventId: string | null;
  automationId: string | null;
  versionId: string | null;
  source: ActivitySource;
  /** Interaction title and version number, when the entry names one that still exists. */
  interaction: { title: string; number: number | null } | null;
  outcome: ActivityOutcome;
  /** Plain-language reason for a blocked decision or incident; null otherwise. */
  reason: string | null;
  effects: { allowed: number; blocked: number } | null;
}

const clip = (text: string) =>
  text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;

/** Rows written before structured detail existed: infer the source from stable fields. */
function inferSource(row: ActivityRow): ActivitySource {
  if (row.kind === 'control')
    return row.code?.startsWith('CHAT_')
      ? { kind: 'chat', label: 'In-chat authoring' }
      : { kind: 'console', label: 'Console' };
  if (row.kind === 'decision') {
    const timer = /^Timer “([^”]{1,80})”/.exec(row.message);
    if (timer?.[1]) return { kind: 'timer', label: timer[1] };
    if (row.viewer) return { kind: 'chat', label: row.viewer };
  }
  return { kind: 'system', label: 'Riff host' };
}

function outcomeOf(row: ActivityRow): ActivityOutcome {
  if (row.kind === 'incident' || row.code === 'INCIDENT') return 'incident';
  if (row.kind !== 'decision') return 'info';
  return row.code === 'ACCEPTED' ? 'accepted' : 'blocked';
}

/**
 * Project one stored activity row for the console. Lookups are channel-scoped by the
 * repository passed in; unknown or removed versions simply drop the interaction label.
 */
export function activityView(
  row: ActivityRow,
  lookup: {
    version(id: string): Pick<VersionRow, 'title' | 'number'> | undefined;
    automation(id: string): Pick<AutomationRow, 'title'> | undefined;
  },
): ActivityView {
  const detail = detailSchema.safeParse(row.detail);
  const source = detail.success ? detail.data.source : inferSource(row);
  const version = row.versionId ? lookup.version(row.versionId) : undefined;
  const automation = !version && row.automationId ? lookup.automation(row.automationId) : undefined;
  const outcome = outcomeOf(row);
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    code: row.code,
    message: row.message,
    viewer: row.viewer,
    eventId: row.eventId,
    automationId: row.automationId,
    versionId: version ? row.versionId : null,
    source: { kind: source.kind, label: clip(source.label) },
    interaction: version
      ? { title: clip(version.title), number: version.number }
      : automation
        ? { title: clip(automation.title), number: null }
        : null,
    outcome,
    reason: outcome === 'blocked' || outcome === 'incident' ? row.message : null,
    effects: detail.success ? (detail.data.effects ?? null) : null,
  };
}
