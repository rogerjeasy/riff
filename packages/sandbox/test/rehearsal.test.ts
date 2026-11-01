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
    expect(full.timeline[0]?.decision?.effects[0]?.x).toBeGreaterThan(0);
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
