import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { versions } from '../src/db/schema.js';
import { reportDigest } from '../src/db/version-health.js';

const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
const headers = { 'x-riff-request': '1' };
const apps: RiffApp[] = [];
const databases: DatabaseConnection[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) database.close();
});

async function candidate() {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  databases.push(database);
  const app = await createApp({ logger: false, database });
  apps.push(app);
  const started = await app.inject({
    method: 'POST',
    url: '/api/compile-runs',
    headers,
    payload: { intent: TOMATO, baseVersionId: null },
  });
  const id = started.json<{ id: string }>().id;
  for (let i = 0; i < 200; i++) {
    const versionId = app.riff.authoring.runs().find((r) => r.id === id)?.result?.versionId;
    if (versionId) return { app, database, version: app.riff.repo.version(versionId)! };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('generation did not finish');
}
const approve = (app: RiffApp, versionId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/versions/${versionId}/approve`, headers, payload });

describe(
  'F06 exact-version approval binds the test report and the actor',
  { timeout: 30_000 },
  () => {
    it('stores the report hash at verification and exposes it for review', async () => {
      const { app, version } = await candidate();
      expect(version.reportHash).toMatch(/^[a-f0-9]{64}$/);
      expect(version.reportHash).toBe(reportDigest(version.evidence));
      const view = app.riff.studio.snapshot().automations[0]!.versions[0]!;
      expect(view.reportHash).toBe(version.reportHash);
      expect(view.approvedBy).toBeNull();
    });

    it('rejects an old approval body that does not name the test report', async () => {
      const { app, version } = await candidate();
      const old = await approve(app, version.id, {
        artifactId: version.artifactId,
        expectedActiveVersionId: null,
      });
      expect(old.statusCode).toBe(400);
      expect(old.json<{ message: string }>().message).toBe(
        'Approval must also name the test report you reviewed. Reload the console and review this version again.',
      );
      expect(app.riff.repo.version(version.id)?.status).toBe('candidate');
    });

    it('refuses a stale report hash and a report changed after verification', async () => {
      const { app, database, version } = await candidate();
      const stale = await approve(app, version.id, {
        artifactId: version.artifactId,
        reportHash: 'e'.repeat(64),
        expectedActiveVersionId: null,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json<{ message: string }>().message).toMatch(/test report changed/);

      // The stored report is rewritten (e.g. a different verification result): the old
      // approval request is invalid and the version itself is blocked.
      const evidence = version.evidence as { verification: { scenarios: unknown[] } };
      database.db
        .update(versions)
        .set({
          evidence: { ...evidence, verification: { ...evidence.verification, scenarios: [] } },
        })
        .where(eq(versions.id, version.id))
        .run();
      const changed = await approve(app, version.id, {
        artifactId: version.artifactId,
        reportHash: version.reportHash,
        expectedActiveVersionId: null,
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json<{ message: string }>().message).toMatch(
        /test report changed after verification/,
      );
      expect(app.riff.studio.snapshot().automations[0]!.versions[0]!.blockers).toContain(
        'The test report changed after verification. Verify this version again.',
      );
      expect(app.riff.repo.version(version.id)?.status).toBe('candidate');
    });

    it('records the console as the approving actor', async () => {
      const { app, version } = await candidate();
      const ok = await approve(app, version.id, {
        artifactId: version.artifactId,
        reportHash: version.reportHash,
        expectedActiveVersionId: null,
      });
      expect(ok.statusCode).toBe(200);
      const stored = app.riff.repo.version(version.id)!;
      expect(stored.approvedBy).toBe('console');
      expect(stored.approvedAt).not.toBeNull();
      const view = app.riff.studio.snapshot().automations[0]!.versions[0]!;
      expect(view.approvedBy).toBe('console');
    });
  },
);
