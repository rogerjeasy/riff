import { afterEach, expect, it, vi } from 'vitest';
import { scenarioSchema, resultSchema } from '../src/console/rehearsal/contracts.js';
import { api } from '../src/lib/api.js';
afterEach(() => vi.unstubAllGlobals());
it('guards revision mutations and propagates stale errors without changing input', async () => {
  const fetcher = vi.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ code: 'STALE', message: 'Reload the saved scenario.' }),
  }));
  vi.stubGlobal('fetch', fetcher);
  await expect(api.rehearsalDeleteScenario('s', 3)).rejects.toMatchObject({ code: 'STALE' });
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/rehearsals/scenarios/s',
    expect.objectContaining({
      method: 'DELETE',
      body: '{"expectedRevision":3}',
      headers: { 'Content-Type': 'application/json', 'x-riff-request': '1' },
    }),
  );
  await expect(
    api.rehearsalRun('s', { expectedRevision: 3, versionId: 'v', through: 0, freshStart: true }),
  ).rejects.toMatchObject({ code: 'STALE' });
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/rehearsals/scenarios/s/run',
    expect.objectContaining({
      body: '{"expectedRevision":3,"versionId":"v","through":0,"freshStart":true}',
    }),
  );
});
it('rejects malformed oversized and unknown rehearsal response content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ scenarios: Array(51).fill({}) }) })),
  );
  await expect(api.rehearsalScenarios()).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scenario: {
          version: 1,
          seed: 42,
          initialAt: 0,
          initialSession: null,
          steps: [],
          expectations: [],
          provenance: { kind: 'synthetic' },
          source: 'untrusted',
        },
      }),
    })),
  );
  await expect(api.rehearsalPreset('v', 'proof', 42)).rejects.toThrow();
});
it('accepts the exact normalized role/time domain, and rejects result byte overflow', () => {
  const base = {
    version: 1,
    seed: 42,
    initialAt: 0,
    initialSession: null,
    steps: [
      {
        kind: 'chat',
        key: 'one',
        event: {
          id: 'e',
          channelId: 'c',
          viewerId: 'v',
          roles: [],
          text: 'hello',
          at: Number.MAX_SAFE_INTEGER - 7_200_001,
        },
      },
    ],
    expectations: [],
    provenance: { kind: 'synthetic' },
  };
  expect(scenarioSchema.safeParse(base).success).toBe(true);
  const result = {
    contractVersion: 1,
    artifactId: 'a'.repeat(64),
    scenarioHash: 'b'.repeat(64),
    evidenceHash: 'c'.repeat(64),
    seed: 42,
    initialAt: 0,
    provenance: { kind: 'synthetic' },
    through: 0,
    totalSteps: 0,
    status: 'passed',
    timeline: [],
    cursor: { at: 0, session: null, stateDigest: 'd'.repeat(64), decision: null },
    checks: [
      {
        id: 'check',
        stepKey: 'one',
        category: 'expectation',
        kind: 'decision',
        expected: 'x'.repeat(262145),
        actual: null,
        status: 'failed',
        summary: 'too large',
      },
    ],
  };
  expect(resultSchema.safeParse(result).success).toBe(false);
});
