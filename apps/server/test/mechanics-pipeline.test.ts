import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkIntent,
  compileOffline,
  compileOutputSchema,
  type ManifestView,
} from '@riff/compiler';
import { hostScenarios, verifyCandidate } from '@riff/sandbox';
import type { PermissionManifest } from '@riff/sdk';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../packages/compiler/fixtures/stateful-mechanics.json', import.meta.url),
    'utf8',
  ),
) as {
  provenance: { transport: string; model: string | null; promptVersion: string };
  records: { intent: string; output: unknown }[];
};

describe('recorded version 2 mechanics through the full verification pipeline', () => {
  it('keeps truthful offline provenance and replays deterministically', () => {
    expect(fixture.provenance).toMatchObject({ transport: 'offline', model: null });
    expect(fixture.records).toHaveLength(4);
    for (const record of fixture.records)
      expect(compileOutputSchema.parse(record.output)).toEqual(
        compileOffline({ intent: record.intent, base: null }),
      );
  });
  it.each(fixture.records.map((record) => [record.intent.split(':')[0], record] as const))(
    '%s passes manifest, static, generated and independent host stages',
    async (_name, record) => {
      const output = compileOutputSchema.parse(record.output);
      expect(output.kind).toBe('candidate');
      const manifest = output.manifest as PermissionManifest;
      expect(manifest.experience?.version).toBe(2);
      expect(
        checkIntent(record.intent, {
          source: output.source ?? '',
          manifest: output.manifest as ManifestView,
        }).filter((check) => check.status === 'mismatch'),
      ).toEqual([]);
      const report = await verifyCandidate({
        source: output.source ?? '',
        manifest: output.manifest,
        tests: output.tests,
      });
      expect(report.stages.filter((stage) => stage.status !== 'passed')).toEqual([]);
      expect(report.ok).toBe(true);
      // The host suite is derived from the canonical definition, not from generated tests.
      expect(report.host.length).toBe(hostScenarios(manifest).length);
      expect(report.host.length).toBeGreaterThanOrEqual(6);
    },
    120_000,
  );
});
