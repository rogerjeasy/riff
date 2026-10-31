import { describe, expect, it } from 'vitest';
import {
  analyzeSource,
  createAdmissionState,
  createEngine,
  hostScenarios,
  verifyCandidate,
} from '@riff/sandbox';
import { CAPABILITIES, EXAMPLES } from '@riff/sdk';

const manifest = {
  sdkVersion: '0.3.0' as const,
  capabilities: ['overlay' as const],
  trigger: {
    command: '!tomato',
    audience: ['viewer' as const],
    maxPerViewer: 3,
    windowMs: 60_000,
  },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const source = `async (event, riff) => { await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() }); }`;
const step = (
  id: string,
  viewer: string,
  text: string,
  at: number,
  expect: string,
  effects: number,
  roles = ['viewer'],
) => ({
  id,
  viewer,
  roles,
  text,
  at,
  expect,
  effects,
});
const tests = [
  { name: 'one throw', kind: 'happy', steps: [step('a', 'alice', '!tomato', 0, 'ACCEPTED', 1)] },
  {
    name: 'fourth throw blocked',
    kind: 'limit',
    steps: [
      step('a', 'alice', '!tomato', 0, 'ACCEPTED', 1),
      step('b', 'alice', '!tomato', 1, 'ACCEPTED', 1),
      step('c', 'alice', '!tomato', 2, 'ACCEPTED', 1),
      step('d', 'alice', '!tomato', 3, 'VIEWER_LIMIT', 0),
    ],
  },
  {
    name: 'unrelated chat',
    kind: 'negative',
    steps: [step('a', 'alice', 'hello', 0, 'UNRELATED', 0)],
  },
];
const event = (id: string, at = 0, viewerId = 'alice', text = '!tomato') => ({
  id,
  at,
  viewerId,
  channelId: 'channel-a',
  roles: ['viewer'],
  text,
});

describe('static analysis', () => {
  it('records used capabilities and accepts the reference handler', () => {
    const result = analyzeSource(source, manifest);
    expect(result.capabilitiesUsed).toEqual(['overlay']);
    expect(result.findings).toEqual([]);
  });
  it.each([
    ['ambient clock', `() => Date.now()`, 'no-ambient'],
    ['ambient randomness', `() => Math.random()`, 'no-ambient'],
    ['network', `() => fetch('https://x')`, 'no-ambient'],
    ['unbounded loop', `() => { while (true) {} }`, 'bounded-loops'],
    ['open for loop', `() => { for (;;) {} }`, 'bounded-loops'],
    ['huge literal', `() => '${'x'.repeat(501)}'`, 'small-literals'],
    ['statement smuggling', `x => x); globalThis.y = 1; (0`, 'handler-shape'],
    ['dynamic import', `() => import('node:fs')`, 'no-import'],
  ])('rejects %s', (_name, guest, rule) => {
    const { findings } = analyzeSource(guest, manifest);
    expect(findings.some((finding) => finding.rule === rule && finding.severity === 'error')).toBe(
      true,
    );
  });
  it('rejects undeclared capabilities and warns on unused ones', () => {
    expect(
      analyzeSource(source, { ...manifest, capabilities: [] }).findings.map((f) => f.rule),
    ).toContain('declared-capabilities');
    expect(analyzeSource(`() => {}`, manifest).findings).toEqual([
      expect.objectContaining({ severity: 'warning', rule: 'least-privilege' }),
    ]);
  });
});

describe('verification pipeline', () => {
  it('passes a correct candidate through every stage with real reports', async () => {
    const report = await verifyCandidate({ source, manifest, tests });
    expect(report.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ['manifest', 'passed'],
      ['static', 'passed'],
      ['compile', 'passed'],
      ['generated', 'passed'],
      ['host', 'passed'],
    ]);
    expect(report.ok).toBe(true);
    expect(report.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(report.generated).toHaveLength(3);
    expect(report.host.length).toBeGreaterThanOrEqual(5);
    expect(report.failureReport).toBeNull();
  }, 30_000);
  it('fails closed on inflated authority and skips later stages', async () => {
    const report = await verifyCandidate({
      source,
      manifest: { ...manifest, capabilities: ['chat.say'] },
      tests,
    });
    expect(report.ok).toBe(false);
    expect(report.stages[0]?.status).toBe('failed');
    expect(report.stages.slice(1).every((stage) => stage.status === 'skipped')).toBe(true);
    expect(report.failureReport).toContain('manifest');
  });
  it('rejects too few or non-covering generated tests', async () => {
    const report = await verifyCandidate({ source, manifest, tests: tests.slice(0, 2) });
    expect(report.ok).toBe(false);
    expect(report.stages.find((stage) => stage.id === 'generated')?.status).toBe('failed');
  });
  it('catches a generated test whose expectation disagrees with the host', async () => {
    const wrong = structuredClone(tests);
    wrong[1]!.steps[3]!.expect = 'ACCEPTED';
    wrong[1]!.steps[3]!.effects = 1;
    const report = await verifyCandidate({ source, manifest, tests: wrong });
    expect(report.ok).toBe(false);
    expect(report.failureReport).toMatch(/expected ACCEPTED\/1 effects, got VIEWER_LIMIT\/0/);
    expect(report.failureReport!.length).toBeLessThanOrEqual(4096);
  }, 30_000);
  it('host checks fail a handler that ignores the command intent', async () => {
    const silent = `async () => {}`;
    const report = await verifyCandidate({ source: silent, manifest, tests });
    expect(report.ok).toBe(false);
    expect(report.host.some((result) => !result.passed)).toBe(true);
  }, 30_000);
  it('derives role checks for restricted audiences', () => {
    const scenarios = hostScenarios({
      ...manifest,
      trigger: { ...manifest.trigger, audience: ['subscriber'] },
    });
    expect(scenarios.some((scenario) => scenario.kind === 'role')).toBe(true);
  });
});

describe('live execution semantics', () => {
  it('normalizes command case and whitespace but rejects suffixes', async () => {
    const engine = createEngine({ source, manifest }, { seed: 1 });
    expect((await engine.dispatch(event('a', 0, 'alice', '  !TOMATO  '))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('b', 1, 'alice', '!tomatoes'))).code).toBe('UNRELATED');
    engine.stop();
  });
  it('keeps viewer allowance across versions that share admission state', async () => {
    const admission = createAdmissionState();
    const v1 = createEngine({ source, manifest }, { seed: 1, mode: 'live', admission });
    for (let i = 0; i < 3; i++)
      expect((await v1.dispatch(event(`a${i}`, i))).code).toBe('ACCEPTED');
    v1.stop();
    const v2 = createEngine(
      { source: source.replace("'tomato'", "'star'"), manifest },
      { seed: 1, mode: 'live', admission },
    );
    const blocked = await v2.dispatch(event('a3', 10));
    expect(blocked.code).toBe('VIEWER_LIMIT');
    expect(blocked.mode).toBe('live');
    expect(blocked.allowance).toEqual({ used: 3, max: 3, windowMs: 60_000, nextAt: 60_000 });
    expect((await v2.dispatch(event('a0', 11))).code).toBe('DUPLICATE');
    v2.stop();
  });
  it('enforces a shared channel budget across automations', async () => {
    const channelBudget = { effects: [] as number[], perMinute: 1 };
    const a = createEngine({ source, manifest }, { seed: 1, mode: 'live', channelBudget });
    const b = createEngine({ source, manifest }, { seed: 1, mode: 'live', channelBudget });
    expect((await a.dispatch(event('x', 0))).code).toBe('ACCEPTED');
    expect((await b.dispatch(event('y', 1, 'bob'))).code).toBe('CHANNEL_LIMIT');
    a.stop();
    b.stop();
  });
  it('reports incidents with a cause and keeps a warm worker fast', async () => {
    const incidents: string[] = [];
    const engine = createEngine(
      { source: `() => { while (Date) {} }`, manifest },
      { seed: 1, onIncident: (incident) => incidents.push(incident.fault) },
    );
    const result = await engine.dispatch(event('a'));
    expect(result.code).toBe('INCIDENT');
    expect(incidents).toHaveLength(1);
    expect(engine.status).toBe('quarantined');

    const fast = createEngine(
      { source, manifest: { ...manifest, trigger: { ...manifest.trigger, maxPerViewer: 100 } } },
      { seed: 1 },
    );
    await fast.warm();
    const started = performance.now();
    for (let i = 0; i < 20; i++) await fast.dispatch(event(`f${i}`, i, `viewer${i}`));
    expect((performance.now() - started) / 20).toBeLessThan(40);
    fast.stop();
  });
  it('caps a private rehearsal with an explicit capacity decision', async () => {
    const engine = createEngine(
      { source, manifest: { ...manifest, trigger: { ...manifest.trigger, command: '!x' } } },
      { seed: 1 },
    );
    for (let i = 0; i < 256; i++) await engine.dispatch(event(`e${i}`, i, 'alice', 'chat'));
    expect((await engine.dispatch(event('full', 300))).code).toBe('CAPACITY');
    engine.stop();
  });
});

describe('curated SDK examples', () => {
  it.each(EXAMPLES.map((example) => [example.name, example] as const))(
    '%s passes static analysis and the host policy suite',
    async (_name, example) => {
      expect(analyzeSource(example.source, example.manifest).findings).toEqual([]);
      const report = await verifyCandidate({
        source: example.source,
        manifest: example.manifest,
        tests: [],
      });
      expect(report.stages.find((stage) => stage.id === 'host')?.status).toBe('passed');
    },
    30_000,
  );
  it('the sandbox bridge enables exactly the SDK capability set', () => {
    expect([...CAPABILITIES]).toEqual(['overlay', 'session']);
    expect(analyzeSource(EXAMPLES[0]!.source, EXAMPLES[0]!.manifest).capabilitiesUsed).toEqual([
      'overlay',
    ]);
  });
});
