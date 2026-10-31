import { artifactIdentity } from '@riff/sandbox';
import { z } from 'zod';
import type { versions } from './schema.js';

const evidenceSchema = z.object({
  verification: z.object({ ok: z.boolean() }),
  intent: z.array(
    z.object({ status: z.enum(['match', 'mismatch', 'assumed', 'preserved', 'changed']) }),
  ),
});
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
