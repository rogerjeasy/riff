import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkIntent,
  compileOffline,
  compileOutputSchema,
  PROMPT_VERSION,
  type ManifestView,
} from '@riff/compiler';
import { hostScenarios, verifyCandidate } from '@riff/sandbox';
import type { PermissionManifest } from '@riff/sdk';
import { ruleCopy } from '../src/services/participation/copy.js';
import { publicTests } from '../src/services/recipes/contract.js';
import { verifyAuthoredCandidate } from '../src/services/authoring/verify-migration.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../packages/compiler/fixtures/stateful-formats.json', import.meta.url),
    'utf8',
  ),
) as {
  provenance: { transport: string; model: string | null; promptVersion: string };
  records: { intent: string; output: unknown }[];
};

describe('recorded version 3 formats through the full verification pipeline', () => {
  it('keeps truthful offline provenance and replays deterministically', () => {
    expect(fixture.provenance).toMatchObject({
      transport: 'offline',
      model: null,
      promptVersion: PROMPT_VERSION,
    });
    expect(fixture.records).toHaveLength(3);
    for (const record of fixture.records)
      expect(compileOutputSchema.parse(record.output)).toEqual(
        compileOffline({ intent: record.intent, base: null }),
      );
  });
  it.each(fixture.records.map((record) => [record.intent, record] as const))(
    '%s passes manifest, static, generated and independent host stages',
    async (_name, record) => {
      const output = compileOutputSchema.parse(record.output);
      expect(output.kind).toBe('candidate');
      const manifest = output.manifest as PermissionManifest;
      expect(manifest.experience?.version).toBe(3);
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
      // The host suite is derived from the canonical definition, not from generated tests.
      expect(report.host.length).toBe(hostScenarios(manifest).length);
      expect(report.host.length).toBeGreaterThanOrEqual(4);
    },
    120_000,
  );
});

describe('version 3 formats on stream and in shared recipes', () => {
  const manifestOf = (index: number) =>
    compileOutputSchema.parse(fixture.records[index]?.output).manifest as PermissionManifest;
  it('explains bounded commands in every reviewed language without a ranking', () => {
    const mural = ruleCopy(manifestOf(0), 'en');
    expect(mural.instructions.join(' ')).toContain('!paint <cell> <color>');
    expect(mural.objective).toBe('Everyone creates it together; no ranking');
    expect(ruleCopy(manifestOf(1), 'fr').instructions.join(' ')).toContain(
      'Tempo → Instrument → Mood',
    );
    expect(ruleCopy(manifestOf(2), 'de').instructions.join(' ')).toContain('!a / !b / !c');
    expect(ruleCopy(manifestOf(2), 'es').objective).toBe(
      'Lo crean todos juntos, sin clasificación',
    );
  });
  it('shares only bounded format arguments; any other chat becomes a fixed marker', () => {
    const manifest = manifestOf(0);
    const tests = [
      ...(compileOutputSchema.parse(fixture.records[0]?.output).tests as unknown[]).slice(0, 2),
      {
        name: 'x',
        kind: 'happy',
        steps: [
          {
            id: 'a',
            viewer: 'ann',
            roles: ['viewer'],
            text: '!paint B3 Red',
            at: 0,
            expect: 'ACCEPTED',
            effects: 1,
          },
          {
            id: 'b',
            viewer: 'ann',
            roles: ['viewer'],
            text: '!paint b3 my-handle',
            at: 1,
            expect: 'INVALID_CHOICE',
            effects: 0,
          },
          {
            id: 'c',
            viewer: 'ann',
            roles: ['viewer'],
            text: 'hello',
            at: 2,
            expect: 'UNRELATED',
            effects: 0,
          },
        ],
      },
    ];
    const shared = publicTests(tests, '!paint', [], manifest.experience) as {
      steps: { text: string }[];
    }[];
    expect(shared[2]?.steps.map((step) => step.text)).toEqual([
      '!paint b3 red',
      'synthetic unrelated input',
      'synthetic unrelated input',
    ]);
  });
  it('checks preserving migrations against host-populated format snapshots', async () => {
    const output = compileOutputSchema.parse(fixture.records[0]?.output);
    const manifest = structuredClone(output.manifest) as PermissionManifest;
    manifest.experience!.title = 'Bigger Mural';
    const report = await verifyAuthoredCandidate(
      {
        source: output.source ?? '',
        manifest,
        tests: output.tests,
        migrationSource: '(input) => input.snapshot',
      },
      output.manifest,
    );
    expect(report.failureReport).toBeNull();
    expect(report.migration?.snapshots.length).toBeGreaterThan(0);
  }, 120_000);
});
