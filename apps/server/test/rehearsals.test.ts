import type { RehearsalScenario } from '@riff/sandbox';
import { afterEach, expect, it } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';
import { EXAMPLES } from '@riff/sdk';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const scenario: RehearsalScenario = {
  version: 1,
  seed: 42,
  initialAt: 1000,
  initialSession: null,
  steps: [
    {
      kind: 'chat',
      key: 'throw',
      event: {
        id: 'one',
        channelId: 'rehearsal',
        viewerId: 'viewer-1',
        roles: ['viewer'],
        text: '!tomato',
        at: 1000,
      },
    },
  ],
  expectations: [{ id: 'accepted', stepKey: 'throw', kind: 'decision', value: 'ACCEPTED' }],
  provenance: { kind: 'synthetic' },
};
const request = (app: RiffApp, method: 'POST' | 'PUT' | 'DELETE', url: string, payload: object) =>
  app.inject({ method, url, payload, headers: { 'x-riff-request': '1' } });
function version(app: RiffApp) {
  const example = EXAMPLES[0]!;
  return app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Tomato').id,
    parentVersionId: null,
    artifactId: null,
    title: 'Tomato',
    intent: example.intent,
    source: example.source,
    manifest: example.manifest,
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
}
it('persists revision-checked scenarios and exact private prefix evidence without live writes', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const row = version(app);
  const created = await request(app, 'POST', '/api/rehearsals/scenarios', {
    name: 'Burst',
    scenario,
  });
  expect(created.statusCode).toBe(201);
  expect(created.headers['cache-control']).toBe('no-store');
  const saved = created.json().scenario;
  expect(saved.revision).toBe(0);
  const stale = await request(app, 'PUT', `/api/rehearsals/scenarios/${saved.id}`, {
    name: 'Edit',
    scenario,
    expectedRevision: 4,
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('STALE');
  const run = await request(app, 'POST', `/api/rehearsals/scenarios/${saved.id}/run`, {
    expectedRevision: 0,
    versionId: row.id,
    through: 0,
  });
  expect(run.statusCode).toBe(201);
  expect(run.json().run).toMatchObject({
    versionId: row.id,
    scenarioRevision: 0,
    result: { through: 0, status: 'incomplete' },
  });
  expect(app.riff.repo.activity()).toHaveLength(0);
  expect(app.riff.repo.session(row.automationId)).toBeUndefined();
});
it('rejects forged provenance and executable source and requires the creator mutation guard', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/rehearsals/scenarios',
        payload: { name: 'x', scenario },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await request(app, 'POST', '/api/rehearsals/scenarios', {
        name: 'x',
        scenario: {
          ...scenario,
          provenance: {
            kind: 'sanitized-recording',
            originVersionId: 'x',
            originArtifactId: 'x',
            originSessionId: 'x',
          },
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await request(app, 'POST', '/api/rehearsals/presets', {
        versionId: rowId,
        preset: 'proof',
        seed: 1,
        source: 'evil',
      })
    ).statusCode,
  ).toBe(400);
});
const rowId = '00000000-0000-4000-8000-000000000001';

it('replays matching compare inputs, pins failed side reduction and retains regressions after scenario deletion', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const row = version(app);
  const input = {
    ...scenario,
    steps: [{ kind: 'advance', key: 'noise', at: 1000 }, ...scenario.steps],
    expectations: [{ id: 'effect', stepKey: 'throw', kind: 'effects', value: 2 }],
  };
  const saved = (
    await request(app, 'POST', '/api/rehearsals/scenarios', { name: 'Fail', scenario: input })
  ).json().scenario;
  const full = await request(app, 'POST', `/api/rehearsals/scenarios/${saved.id}/run`, {
    expectedRevision: 0,
    versionId: row.id,
    compareVersionId: row.id,
  });
  expect(full.statusCode).toBe(201);
  const run = full.json().run;
  expect(run.result.status).toBe('failed');
  expect(run.comparison.evidenceHash).toBe(run.result.evidenceHash);
  expect(run.differences).toEqual([]);
  const reduced = await request(app, 'POST', `/api/rehearsals/runs/${run.id}/minimize`, {
    side: 'compare',
    checkId: 'expect:effect',
  });
  expect(reduced.statusCode).toBe(201);
  const minimal = reduced.json().run;
  expect(minimal.minimization.removedSteps).toBe(1);
  expect(minimal.scenario.steps).toHaveLength(1);
  expect(minimal.versionId).toBe(row.id);
  const retained = await request(app, 'POST', '/api/rehearsals/regressions', {
    name: 'Two effects',
    runId: minimal.id,
    checkId: 'expect:effect',
  });
  expect(retained.statusCode).toBe(201);
  const regression = retained.json().regression;
  expect(
    (await request(app, 'DELETE', `/api/rehearsals/scenarios/${saved.id}`, { expectedRevision: 0 }))
      .statusCode,
  ).toBe(200);
  expect((await app.inject(`/api/rehearsals/regressions`)).json().regressions[0].id).toBe(
    regression.id,
  );
  const rerun = await request(app, 'POST', `/api/rehearsals/regressions/${regression.id}/run`, {
    versionId: row.id,
  });
  expect(rerun.json().run.result.status).toBe('failed');
  const prefix = app.riff.rehearsal.run(run.id);
  expect(prefix.result.evidenceHash).toBe(run.result.evidenceHash);
}, 60_000);
it('pins applicable independent regressions for ordinary authoring and blocks incorrect generated tests after one repair', async () => {
  const { createOfflineTransport } = await import('@riff/compiler');
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const row = version(app);
  const saved = app.riff.rehearsal.create({
    name: 'Wrong effects',
    scenario: {
      ...scenario,
      expectations: [{ id: 'two', stepKey: 'throw', kind: 'effects', value: 2 }],
    },
  });
  const run = await app.riff.rehearsal.runScenario(saved.id, {
    expectedRevision: 0,
    versionId: row.id,
  });
  const reduced = await app.riff.rehearsal.minimize(run.id, {
    side: 'primary',
    checkId: 'expect:two',
  });
  const regression = app.riff.rehearsal.saveRegression({
    name: 'Two effects',
    runId: reduced.id,
    checkId: 'expect:two',
  });
  const job = app.riff.authoring.start({
    intent: 'Keep the interaction exactly as requested.',
    baseVersionId: row.id,
  });
  await waitFor(() => !!job.result);
  expect(job.stage).toBe('failed');
  const candidate = app.riff.repo.version(job.result!.versionId!)!;
  expect(candidate.parentVersionId).toBe(row.id);
  const evidence = candidate.evidence as {
    verification: { ok: boolean };
    rehearsal: { regressionId: string; ok: boolean }[];
  };
  expect(evidence.verification.ok).toBe(false);
  expect(evidence.rehearsal).toMatchObject([
    {
      regressionId: regression.id,
      ok: false,
      result: {
        status: 'failed',
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'expect:two', expected: 2, actual: 1, status: 'failed' }),
        ]),
      },
    },
  ]);
  expect(app.riff.repo.runs()[0]!.attempts as unknown[]).toHaveLength(2);
}, 60_000);
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 1800; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error('generation did not finish');
}

it('explicit recorded repair creates a passing candidate with pinned evidence and never activates it', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../packages/compiler/fixtures/rehearsal-repair.json', import.meta.url),
      'utf8',
    ),
  );
  let captured: unknown = null;
  const app = await createApp({
    logger: false,
    transport: {
      kind: 'offline',
      model: null,
      async open(input) {
        captured = input;
        return {
          threadId: null,
          async turn() {
            return { output: fixture.output, usage: null };
          },
          async close() {},
        };
      },
    },
  });
  apps.push(app);
  const row = version(app);
  const saved = app.riff.rehearsal.create({
    name: 'Two',
    scenario: {
      ...scenario,
      expectations: [{ id: 'two', stepKey: 'throw', kind: 'effects', value: 2 }],
    },
  });
  const full = await app.riff.rehearsal.runScenario(saved.id, {
    expectedRevision: 0,
    versionId: row.id,
  });
  const reduced = await app.riff.rehearsal.minimize(full.id, {
    side: 'primary',
    checkId: 'expect:two',
  });
  const regression = app.riff.rehearsal.saveRegression({
    name: 'Two',
    runId: reduced.id,
    checkId: 'expect:two',
  });
  const response = await request(
    app,
    'POST',
    `/api/rehearsals/regressions/${regression.id}/repair`,
    { intent: 'Keep the interaction exactly as requested.' },
  );
  expect(response.statusCode).toBe(202);
  const job = app.riff.authoring.runs().find((r) => r.id === response.json().id)!;
  // The immutable selected set survives subsequent deletion, and newly added checks do not join it.
  app.riff.rehearsal.deleteRegression(regression.id);
  const later = app.riff.rehearsal.saveRegression({
    name: 'Later',
    runId: reduced.id,
    checkId: 'expect:two',
  });
  await waitFor(() => !!job.result);
  expect(job.stage).toBe('ready');
  const candidate = app.riff.repo.version(job.result!.versionId!)!;
  expect(candidate.status).toBe('candidate');
  expect(candidate.parentVersionId).toBe(row.id);
  expect(app.riff.repo.automation(row.automationId)?.activeVersionId).toBeNull();
  expect(app.riff.repo.session(row.automationId)).toBeUndefined();
  const evidence = candidate.evidence as {
    verification: { ok: boolean };
    rehearsal: { regressionId: string; ok: boolean }[];
  };
  expect(evidence.verification.ok).toBe(true);
  expect(evidence.rehearsal).toMatchObject([{ regressionId: regression.id, ok: true }]);
  expect(JSON.stringify(evidence)).not.toContain(later.id);
  expect(captured).toMatchObject({
    intent: 'Keep the interaction exactly as requested.',
    rehearsalContext: { regressions: [{ id: regression.id, expected: 2, actual: 1 }] },
  });
}, 60_000);
it('refuses explicit repair from a revoked F33 ancestor before spending another compile', async () => {
  const { createOfflineTransport } = await import('@riff/compiler');
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const brief = 'Everyone can throw a tomato with !tomato, 3 times per minute.';
  const creator = { kind: 'creator' } as const;
  app.riff.proposals.submit(
    {
      kind: 'chat',
      accountId: 'private-audience',
      displayName: 'Private audience',
      roles: ['viewer'],
    },
    { eventId: 'suggestion', text: brief },
  );
  const proposal = app.riff.proposals.snapshot().proposals[0]!;
  app.riff.proposals.moderate(creator, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
    action: 'shortlist',
  });
  const selection = app.riff.proposals.select(creator, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision + 1,
    brief,
  });
  const job = app.riff.authoring.start({
    intent: '',
    baseVersionId: null,
    selectionId: selection.id,
  });
  await waitFor(() => !!job.result);
  expect(job.stage).toBe('ready');
  const row = app.riff.repo.version(job.result!.versionId!)!;
  const saved = app.riff.rehearsal.create({
    name: 'Regression',
    scenario: {
      ...scenario,
      expectations: [{ id: 'two', stepKey: 'throw', kind: 'effects', value: 2 }],
    },
  });
  const full = await app.riff.rehearsal.runScenario(saved.id, {
    versionId: row.id,
    expectedRevision: 0,
  });
  const reduced = await app.riff.rehearsal.minimize(full.id, {
    side: 'primary',
    checkId: 'expect:two',
  });
  const regression = app.riff.rehearsal.saveRegression({
    name: 'Two',
    runId: reduced.id,
    checkId: 'expect:two',
  });
  app.riff.proposals.revokeSelection(creator, selection.id);
  const before = app.riff.repo.runs().length;
  const response = await request(
    app,
    'POST',
    `/api/rehearsals/regressions/${regression.id}/repair`,
    { intent: 'Keep the interaction exactly as requested.' },
  );
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('REVOKED');
  expect(app.riff.repo.runs()).toHaveLength(before);
}, 60_000);
it('compares effect payloads independently from semantic state and refuses prefix failure reduction', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const row = version(app);
  const other = app.riff.repo.insertVersion({
    ...row,
    parentVersionId: row.id,
    source: row.source.replace('riff.util.random()', '0.9'),
  });
  const input: RehearsalScenario = {
    ...scenario,
    steps: [...scenario.steps, { kind: 'advance', key: 'finish', at: 2000 }],
    expectations: [{ id: 'two', stepKey: 'throw', kind: 'effects', value: 2 }],
  };
  const saved = app.riff.rehearsal.create({ name: 'Compare effects', scenario: input });
  const full = await app.riff.rehearsal.runScenario(saved.id, {
    expectedRevision: 0,
    versionId: row.id,
    compareVersionId: other.id,
  });
  expect(full.artifactId).not.toBe(full.compareArtifactId);
  expect(full.differences).toEqual([
    { through: 1, key: 'throw', decision: false, effects: true, state: false },
  ]);
  const prefix = await app.riff.rehearsal.runScenario(saved.id, {
    expectedRevision: 0,
    versionId: row.id,
    through: 1,
  });
  expect(prefix.result.status).toBe('failed');
  await expect(
    app.riff.rehearsal.minimize(prefix.id, { side: 'primary', checkId: 'expect:two' }),
  ).rejects.toMatchObject({ code: 'INVALID_CHECK' });
}, 60_000);
