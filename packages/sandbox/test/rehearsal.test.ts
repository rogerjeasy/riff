import { describe, expect, it } from 'vitest';
import type { AutomationArtifact, ChatEvent, ExperienceDefinition } from '@riff/sdk';
import * as host from '@riff/sandbox';

const definition: ExperienceDefinition = {
  version: 1,
  title: 'Battle',
  durationMs: 1000,
  maxParticipants: 8,
  teams: [{ id: 'red', label: 'Red', joinCommand: '!red' }],
  resource: { name: 'tomatoes', perParticipant: 3 },
  contribution: { command: '!throw', points: 2 },
  objective: { kind: 'highest-score', target: null },
};
const artifact = (stateful = false): AutomationArtifact => ({
  source: `(e,riff)=>riff.overlay.emit({kind:'projectile',asset:'tomato',x:riff.util.random()})`,
  manifest: {
    sdkVersion: '0.4.0',
    capabilities: stateful ? ['overlay', 'session'] : ['overlay'],
    trigger: { command: '!throw', audience: ['viewer'], maxPerViewer: 3, windowMs: 1000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
    ...(stateful ? { experience: definition } : {}),
  },
});
const chat = (key: string, at: number, text = '!throw', id = key, viewerId = 'ada') => ({
  kind: 'chat' as const,
  key,
  event: { id, channelId: 'private', viewerId, roles: ['viewer'], text, at } as ChatEvent,
});
const scenario = (steps: host.RehearsalStep[] = []): host.RehearsalScenario => ({
  version: 1,
  seed: 7,
  initialAt: 0,
  initialSession: null,
  steps,
  expectations: [],
  provenance: { kind: 'synthetic' },
});

describe('private bounded rehearsal replay', () => {
  it('replays every prefix without inheriting future identities, random effects or rate history', async () => {
    const input = scenario([
      chat('one', 1),
      chat('duplicate', 2, '!throw', 'one'),
      chat('two', 3),
      chat('three', 4),
      chat('limit', 5),
      chat('renew', 1001),
      chat('old', 6),
    ]);
    const full = await host.runRehearsal({ artifact: artifact(), scenario: input });
    expect(full.timeline.map((f) => f.decision?.code)).toEqual([
      'ACCEPTED',
      'DUPLICATE',
      'ACCEPTED',
      'ACCEPTED',
      'VIEWER_LIMIT',
      'ACCEPTED',
      'INVALID_EVENT',
    ]);
    expect(full.timeline[4]?.decision?.allowance).toEqual({
      used: 3,
      max: 3,
      windowMs: 1000,
      nextAt: 1001,
    });
    expect(full.timeline[5]?.decision?.allowance?.used).toBe(3);
    for (const through of [0, 1, 3, 6, 7]) {
      const prefix = await host.runRehearsal({ artifact: artifact(), scenario: input, through });
      expect(prefix.timeline).toEqual(full.timeline.slice(0, through));
      expect(prefix.cursor.decision).toEqual(through ? full.timeline[through - 1]?.decision : null);
      expect(prefix.cursor.session).toBeNull();
    }
    expect(full).toEqual(await host.runRehearsal({ artifact: artifact(), scenario: input }));
    expect(full.timeline[0]?.decision?.effects).toEqual([
      { kind: 'projectile', asset: 'tomato', x: 0.7325348288286477 },
    ]);
  });

  it('retains controls, state, admission and deadlines in the same private engine', async () => {
    const input = scenario([
      chat('join', 1, '!red'),
      chat('throw', 2),
      { kind: 'pause', key: 'pause', at: 100 },
      chat('paused', 10000),
      { kind: 'resume', key: 'resume', at: 11000 },
      chat('duplicate', 11001, '!throw', 'throw'),
      chat('again', 11002),
      { kind: 'advance', key: 'end', at: 11900 },
      chat('late', 11901),
    ]);
    input.expectations = [
      { id: 'score', stepKey: 'again', kind: 'score', teamId: 'red', value: 4 },
      { id: 'remaining', stepKey: 'again', kind: 'remaining', viewerId: 'ada', value: 1 },
      { id: 'phase', stepKey: 'end', kind: 'phase', value: 'finished' },
    ];
    const full = await host.runRehearsal({ artifact: artifact(true), scenario: input });
    expect(full.status).toBe('passed');
    expect(full.timeline.map((f) => f.decision?.code ?? f.kind)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'pause',
      'SESSION_PAUSED',
      'resume',
      'DUPLICATE',
      'ACCEPTED',
      'advance',
      'SESSION_FINISHED',
    ]);
    expect(full.cursor.session).toMatchObject({
      phase: 'finished',
      scores: { red: 4 },
      participants: { ada: { remaining: 1 } },
    });
    expect(
      full.timeline.every((f) => !('session' in f) && !('session' in (f.decision ?? {}))),
    ).toBe(true);
    const prefix = await host.runRehearsal({
      artifact: artifact(true),
      scenario: input,
      through: 7,
    });
    expect(prefix.timeline).toEqual(full.timeline.slice(0, 7));
    expect(prefix.cursor.session).toMatchObject({
      phase: 'running',
      deadlineAt: 11900,
      scores: { red: 4 },
    });
    expect(prefix.checks.find((c) => c.id === 'expect:phase')?.status).toBe('pending');
  });

  it('starts from a validated cloned snapshot and isolates injected objects across async dispatch', async () => {
    const initial = host.createSessionSnapshot(definition, 0, 'round');
    const input = {
      ...scenario([chat('join', 1, '!red'), chat('throw', 2)]),
      initialSession: initial,
    };
    const candidate = artifact(true);
    const pending = host.runRehearsal({ artifact: candidate, scenario: input });
    initial.scores.red = 999;
    input.steps[0] = chat('injected', 1, '!unrelated');
    candidate.source = '()=>{throw Error("injected")}';
    expect((await pending).cursor.session).toMatchObject({ id: 'round', scores: { red: 2 } });
    const zero = await host.runRehearsal({
      artifact: artifact(true),
      scenario: scenario(),
      through: 0,
    });
    expect(zero.cursor.session).toMatchObject({
      phase: 'running',
      startedAt: 0,
      scores: { red: 0 },
    });
    const bad = host.createSessionSnapshot(definition, 0);
    bad.participants.ada = { teamId: 'red', remaining: 9, contributions: 0 };
    await expect(
      host.runRehearsal({
        artifact: artifact(true),
        scenario: { ...scenario(), initialSession: bad },
      }),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SESSION' });
    await expect(
      host.runRehearsal({
        artifact: artifact(),
        scenario: { ...scenario(), initialSession: host.createSessionSnapshot(definition, 0) },
      }),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SESSION' });
  });

  it('distinguishes quota outcomes and creator expectations from automatic safety failures', async () => {
    const input = scenario([chat('one', 1), chat('two', 2), chat('three', 3), chat('four', 4)]);
    input.expectations = [
      { id: 'wanted', stepKey: 'four', kind: 'decision', value: 'ACCEPTED' },
      { id: 'effect', stepKey: 'four', kind: 'effects', value: 1 },
    ];
    const run = await host.runRehearsal({ artifact: artifact(), scenario: input });
    expect(run.status).toBe('failed');
    expect(run.checks.filter((c) => c.status === 'failed')).toMatchObject([
      { id: 'expect:wanted', category: 'expectation', stepKey: 'four', actual: 'VIEWER_LIMIT' },
      { id: 'expect:effect', category: 'expectation', actual: 0 },
    ]);
    const broken = { ...artifact(), source: '()=>{throw Error("broken")}' };
    const failed = await host.runRehearsal({
      artifact: broken,
      scenario: scenario([chat('boom', 1)]),
    });
    expect(failed.checks.filter((c) => c.status === 'failed')).toMatchObject([
      { id: 'auto:boom:quarantine', category: 'invariant', actual: 'INCIDENT' },
    ]);
  });

  it('strictly enforces input bounds, unique keys and expectations, bytes and control time', async () => {
    for (const value of [
      { ...scenario(), seed: 0 },
      { ...scenario(), seed: 0x100000000 },
      { ...scenario(), extra: true },
      scenario(Array.from({ length: 121 }, (_, i) => chat(`k${i}`, i))),
      scenario([chat('same', 1), chat('same', 2)]),
      scenario([chat('later', 10), { kind: 'advance', key: 'rewind', at: 9 }]),
      {
        ...scenario(),
        expectations: [{ id: 'missing', stepKey: 'absent', kind: 'effects', value: 0 }],
      },
    ])
      expect(host.rehearsalScenarioSchema.safeParse(value).success).toBe(false);
    const large = scenario(
      Array.from({ length: 120 }, (_, i) =>
        chat(`k${i}`, i, '🙂'.repeat(250), `i${i}`, 'v'.repeat(100)),
      ),
    );
    expect(host.rehearsalScenarioSchema.safeParse(large).success).toBe(false);
    await expect(
      host.runRehearsal({ artifact: artifact(), scenario: scenario(), through: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(
      host.runRehearsal({
        artifact: artifact(),
        scenario: scenario([{ kind: 'pause', key: 'pause', at: 1 }]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCENARIO' });
    const advancing = scenario([{ kind: 'advance', key: 'advance', at: 10 }, chat('old', 9)]);
    expect(
      (await host.runRehearsal({ artifact: artifact(), scenario: advancing })).timeline[1]?.decision
        ?.code,
    ).toBe('INVALID_EVENT');
  });

  it('uses canonical scenario hashes and binds deterministic evidence to the artifact and cursor', async () => {
    const input = scenario([chat('one', 1)]);
    const first = await host.runRehearsal({ artifact: artifact(), scenario: input });
    // Reorder top-level insertion only; nested event keys remain intact.
    const { seed, ...rest } = input;
    const second = await host.runRehearsal({ artifact: artifact(), scenario: { seed, ...rest } });
    expect(first.scenarioHash).toBe(second.scenarioHash);
    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(
      (await host.runRehearsal({ artifact: artifact(), scenario: input, through: 0 })).evidenceHash,
    ).not.toBe(first.evidenceHash);
    expect(
      (await host.runRehearsal({ artifact: { ...artifact(), source: '()=>{}' }, scenario: input }))
        .artifactId,
    ).not.toBe(first.artifactId);
  });

  it('aborts before and during an operation', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      host.runRehearsal({ artifact: artifact(), scenario: scenario(), signal: before.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    const during = new AbortController();
    const pending = host.runRehearsal({
      artifact: artifact(),
      scenario: scenario([chat('one', 1)]),
      signal: during.signal,
    });
    during.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

it('summarizes semantic host state without artifact or timing telemetry in its digest', async () => {
  const input = scenario([chat('join', 1, '!red'), chat('throw', 2)]);
  const first = await host.runRehearsal({ artifact: artifact(true), scenario: input });
  const second = await host.runRehearsal({
    artifact: {
      ...artifact(true),
      source: `async (e,riff)=>{ await riff.overlay.emit({kind:'projectile',asset:'heart',x:0.5}); }`,
    },
    scenario: input,
  });
  expect(first.artifactId).not.toBe(second.artifactId);
  expect(first.timeline.map((f) => f.stateDigest)).toEqual(
    second.timeline.map((f) => f.stateDigest),
  );
  const failed = await host.runRehearsal({
    artifact: { ...artifact(), source: '()=>{throw Error("broken")}' },
    scenario: scenario([chat('boom', 1), { kind: 'advance', key: 'after', at: 2 }]),
  });
  expect(failed.checks.find((c) => c.id === 'auto:after:quarantine')).toMatchObject({
    status: 'failed',
    actual: 'quarantined',
  });
});

describe('bounded counterexample reduction', () => {
  it('removes noise but keeps the three throws causing a fourth expected accepted failure', async () => {
    const input = scenario([
      chat('noise', 0, 'hello'),
      chat('one', 1),
      chat('other', 2, 'hello'),
      chat('two', 3),
      chat('three', 4),
      chat('four', 5),
      chat('tail', 6, 'hello'),
    ]);
    input.expectations = [
      { id: 'noise-check', stepKey: 'noise', kind: 'decision', value: 'UNRELATED' },
      { id: 'fourth', stepKey: 'four', kind: 'decision', value: 'ACCEPTED' },
    ];
    const reduced = await host.minimizeCounterexample({
      artifact: artifact(),
      scenario: input,
      checkId: 'expect:fourth',
    });
    expect(reduced.scenario.steps.map((s) => s.key)).toEqual(['one', 'two', 'three', 'four']);
    expect(reduced.run.checks.find((c) => c.id === 'expect:fourth')).toMatchObject({
      status: 'failed',
      actual: 'VIEWER_LIMIT',
      expected: 'ACCEPTED',
    });
    expect(reduced.scenario.expectations).toEqual([
      { id: 'fourth', stepKey: 'four', kind: 'decision', value: 'ACCEPTED' },
    ]);
    expect(reduced.scenario.provenance).toMatchObject({ kind: 'synthetic-derivative' });
    expect(reduced.removedSteps).toBe(3);
    expect(reduced.budgetStopped).toBe(false);
    expect(input.steps).toHaveLength(7);
    expect(reduced.attempts).toBeLessThanOrEqual(24);
    expect(reduced.dispatchedSteps).toBeLessThanOrEqual(2400);
    expect(
      (await host.runRehearsal({ artifact: artifact(), scenario: reduced.scenario })).evidenceHash,
    ).toBe(reduced.run.evidenceHash);
  }, 60000);

  it('retains the prerequisite delivery and cannot substitute a later incident for the selected failure', async () => {
    const input = scenario([
      chat('noise', 0, 'hello'),
      chat('first', 1, '!throw', 'same'),
      chat('selected', 2, '!throw', 'same'),
      chat('later-incident', 3, '!throw', 'bad', 'bad'),
    ]);
    input.expectations = [
      { id: 'duplicate', stepKey: 'selected', kind: 'decision', value: 'ACCEPTED' },
    ];
    const candidate = {
      ...artifact(),
      source: `(e,riff)=>{if(e.viewerId==='bad')throw Error('later');return riff.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});}`,
    };
    const reduced = await host.minimizeCounterexample({
      artifact: candidate,
      scenario: input,
      checkId: 'expect:duplicate',
    });
    expect(reduced.scenario.steps.map((s) => s.key)).toEqual(['first', 'selected']);
    expect(reduced.run.checks.filter((c) => c.status === 'failed')).toMatchObject([
      { id: 'expect:duplicate', actual: 'DUPLICATE' },
    ]);
    expect(reduced.failure).toMatchObject({
      id: 'expect:duplicate',
      stepKey: 'selected',
      actual: 'DUPLICATE',
    });
  });

  it('rejects missing or passing checks and propagates cancellation', async () => {
    const input = scenario([chat('one', 1)]);
    await expect(
      host.minimizeCounterexample({ artifact: artifact(), scenario: input, checkId: 'absent' }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECK' });
    await expect(
      host.minimizeCounterexample({
        artifact: artifact(),
        scenario: input,
        checkId: 'auto:one:quarantine',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECK' });
    const abort = new AbortController();
    const pending = host.minimizeCounterexample({
      artifact: artifact(),
      scenario: input,
      checkId: 'absent',
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('stops reduction within both budgets and charges the baseline and final validation', async () => {
    const input = scenario(Array.from({ length: 120 }, (_, i) => chat(`s${i}`, i, '!other')));
    // All noise is removable; exact counters include the original and final replay.
    input.expectations = [{ id: 'selected', stepKey: 's119', kind: 'effects', value: 1 }];
    const reduced = await host.minimizeCounterexample({
      artifact: artifact(),
      scenario: input,
      checkId: 'expect:selected',
    });
    expect(reduced.scenario.steps.map((s) => s.key)).toEqual(['s119']);
    expect(reduced.attempts).toBe(9);
    expect(reduced.dispatchedSteps).toBe(241);
    expect(reduced.budgetStopped).toBe(false);
    expect(reduced.run.checks.find((c) => c.id === 'expect:selected')?.actual).toBe(0);
  });
});

describe('manifest-based rehearsal presets', () => {
  it('builds bounded deterministic synthetic presets with actual expected host outcomes', async () => {
    for (const preset of [
      'proof',
      'crowd-burst',
      'duplicate-delivery',
      'late-arrival',
      'exhaustion',
      'deadline',
    ] as const) {
      for (const stateful of [false, true]) {
        const candidate = artifact(stateful);
        const input = host.createRehearsalPreset(candidate, preset, 7);
        expect(input).toEqual(host.createRehearsalPreset(candidate, preset, 7));
        expect(input.steps.length).toBeLessThanOrEqual(120);
        expect(input.provenance).toEqual({ kind: 'synthetic' });
        const result = await host.runRehearsal({ artifact: candidate, scenario: input });
        expect(result.status, `${preset}/${stateful}`).toBe('passed');
        const codes = result.timeline.flatMap((f) => (f.decision ? [f.decision.code] : []));
        if (preset === 'duplicate-delivery') expect(codes).toContain('DUPLICATE');
        if (preset === 'exhaustion')
          expect(codes).toContain(stateful ? 'RESOURCE_LIMIT' : 'VIEWER_LIMIT');
        if (preset === 'deadline' && stateful)
          expect(result.cursor.session?.phase).toBe('finished');
      }
    }
  });

  it('caps high-participant exhaustion before execution and rejects unsupported preset names', () => {
    const candidate = artifact(true);
    candidate.manifest.experience = {
      ...definition,
      resource: { name: 'tomatoes', perParticipant: 100 },
    };
    const input = host.createRehearsalPreset(candidate, 'exhaustion', 0xffff_ffff);
    expect(input.steps).toHaveLength(102);
    expect(() =>
      host.createRehearsalPreset(candidate, 'unsupported' as host.RehearsalPreset, 7),
    ).toThrow();
    expect(() => host.createRehearsalPreset(candidate, 'proof', 0)).toThrow();
  });
});

it('reserves final validation when the step budget stops a failure needing every contribution', async () => {
  const input = scenario([
    ...Array.from({ length: 119 }, (_, i) => chat(`s${i}`, i + 1, '!throw', `s${i}`, `v${i % 2}`)),
    { kind: 'advance', key: 'selected', at: 120 },
  ]);
  input.expectations = [
    { id: 'all-points', stepKey: 'selected', kind: 'score', teamId: 'community', value: 0 },
  ];
  const candidate = artifact(true);
  candidate.manifest.experience = {
    ...definition,
    teams: [],
    resource: { name: 'tomatoes', perParticipant: 100 },
  };
  const reduced = await host.minimizeCounterexample({
    artifact: candidate,
    scenario: input,
    checkId: 'expect:all-points',
  });
  expect(reduced.budgetStopped).toBe(true);
  expect(reduced.scenario.steps).toHaveLength(120);
  expect(reduced.attempts).toBeLessThanOrEqual(24);
  expect(reduced.dispatchedSteps).toBeLessThanOrEqual(2400);
  expect(reduced.run.checks.find((c) => c.id === 'expect:all-points')).toMatchObject({
    status: 'failed',
    actual: 238,
  });
}, 60000);

it('honors early cooperative completion and late participant capacity in presets', async () => {
  const cooperative = artifact(true);
  cooperative.manifest.experience = {
    ...definition,
    teams: [],
    objective: { kind: 'collective-goal', target: 2 },
  };
  for (const preset of ['exhaustion', 'late-arrival'] as const) {
    expect(
      (
        await host.runRehearsal({
          artifact: cooperative,
          scenario: host.createRehearsalPreset(cooperative, preset, 7),
        })
      ).status,
    ).toBe('passed');
  }
  const limited = artifact(true);
  limited.manifest.experience = { ...definition, maxParticipants: 1 };
  expect(
    (
      await host.runRehearsal({
        artifact: limited,
        scenario: host.createRehearsalPreset(limited, 'late-arrival', 7),
      })
    ).timeline.at(-1)?.decision?.code,
  ).toBe('NOT_JOINED');
  expect(
    (
      await host.runRehearsal({
        artifact: limited,
        scenario: host.createRehearsalPreset(limited, 'late-arrival', 7),
      })
    ).status,
  ).toBe('passed');
});

it('stops at 24 replays when the replay budget is tighter than the step budget', async () => {
  const input = scenario([
    ...Array.from({ length: 39 }, (_, i) => chat(`s${i}`, i + 1, '!throw', `s${i}`, `v${i % 2}`)),
    { kind: 'advance', key: 'selected', at: 40 },
  ]);
  input.expectations = [
    { id: 'all-points', stepKey: 'selected', kind: 'score', teamId: 'community', value: 0 },
  ];
  const candidate = artifact(true);
  candidate.manifest.experience = {
    ...definition,
    teams: [],
    resource: { name: 'tomatoes', perParticipant: 100 },
  };
  const reduced = await host.minimizeCounterexample({
    artifact: candidate,
    scenario: input,
    checkId: 'expect:all-points',
  });
  expect(reduced.budgetStopped).toBe(true);
  expect(reduced.attempts).toBe(24);
  expect(reduced.dispatchedSteps).toBeLessThan(2400);
  expect(reduced.run.checks.find((c) => c.id === 'expect:all-points')?.actual).toBe(78);
}, 60000);
