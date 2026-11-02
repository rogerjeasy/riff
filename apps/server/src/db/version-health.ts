import { createHash } from 'node:crypto';
import { artifactIdentity } from '@riff/sandbox';
import { z } from 'zod';
import type { versions } from './schema.js';

const evidenceSchema = z.object({
  verification: z.object({ ok: z.boolean() }),
  intent: z.array(
    z.object({ status: z.enum(['match', 'mismatch', 'assumed', 'preserved', 'changed']) }),
  ),
});
/** Canonical JSON: sorted keys, undefined dropped exactly as JSON.stringify does. */
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * Stable identity of the evidence a reviewer sees: the verification (test) report, intent
 * checks and any migration/rehearsal results. Approval binds it alongside the artifact.
 */
export const reportDigest = (evidence: unknown) =>
  createHash('sha256').update(canonical(evidence)).digest('hex');

/** The report identity the reviewer must name; stored at verification, derived for legacy rows. */
export const reportHashOf = (row: Pick<typeof versions.$inferSelect, 'reportHash' | 'evidence'>) =>
  row.reportHash ?? reportDigest(row.evidence);

/** Complete host approval predicate, shared by review and the final activation transaction. */
export function versionApprovalBlockers(
  row: typeof versions.$inferSelect,
  panic: boolean,
): string[] {
  const blockers: string[] = [];
  if (!['candidate', 'approved', 'superseded'].includes(row.status))
    blockers.push(`This version is ${row.status}.`);
  if (['approved', 'superseded'].includes(row.status) && row.approvedAt === null)
    blockers.push('This version has no recorded prior approval.');
  const evidence = evidenceSchema.safeParse(row.evidence);
  if (!evidence.success || !evidence.data.verification.ok)
    blockers.push('Verification did not pass.');
  if (!evidence.success || evidence.data.intent.some((check) => check.status === 'mismatch'))
    blockers.push('The candidate does not match what you asked for.');
  if (row.reportHash !== null && row.reportHash !== reportDigest(row.evidence))
    blockers.push('The test report changed after verification. Verify this version again.');
  try {
    if (
      !row.artifactId ||
      artifactIdentity({ source: row.source, manifest: row.manifest }) !== row.artifactId
    )
      blockers.push('The evidence no longer matches this exact artifact.');
  } catch {
    blockers.push('The artifact no longer validates under the current host policy.');
  }
  if (panic) blockers.push('Everything is stopped. Resume the channel first.');
  return blockers;
}
