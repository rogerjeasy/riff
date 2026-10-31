import { describe, expect, it } from 'vitest';
import type { AutomationArtifact, ExperienceDefinition } from '@riff/sdk';
import * as host from '@riff/sandbox';

const definition: ExperienceDefinition = {
  version: 1 as const,
  title: 'Tomato Battle',
  durationMs: 1000,
  maxParticipants: 4,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'tomatoes', perParticipant: 3 },
  contribution: { command: '!throw', points: 2 },
  objective: { kind: 'highest-score' as const, target: null },
};
const source =
  "async (event, riff) => { const s = riff.session.snapshot(); await riff.overlay.emit({ kind:'projectile', asset:'tomato', x:s.scores.red > 0 ? 0.2 : 0.5 }); }";
const artifact = (
  experience: ExperienceDefinition = definition,
  handler = source,
): AutomationArtifact => ({
  source: handler,
  manifest: {
    sdkVersion: '0.4.0',
    capabilities: ['overlay', 'session'],
    trigger: { command: '!throw', audience: ['viewer'], maxPerViewer: 1, windowMs: 1000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
    experience,
  },
});
const event = (id: string, text: string, at = 1, viewerId = 'ada') => ({
  id,
  text,
  at,
  viewerId,
  channelId: 'test',
  roles: ['viewer'],
});

describe('canonical session rules', () => {
  it('validates bounded definitions and requires the canonical command', () => {
    expect(host.manifestSchema.safeParse(artifact().manifest).success).toBe(true);
    expect(
      host.manifestSchema.safeParse({
        ...artifact().manifest,
        trigger: { ...artifact().manifest.trigger, command: '!other' },
      }).success,
    ).toBe(false);
    expect(
      host.sessionDefinitionSchema.safeParse({ ...definition, maxParticipants: 257 }).success,
    ).toBe(false);
    expect(
      host.sessionDefinitionSchema.safeParse({
        ...definition,
        teams: [definition.teams[0], definition.teams[0]],
      }).success,
    ).toBe(false);
  });
  it('clones pause/resume and finishes at the exact deadline with a tie', () => {
    const initial = host.createSessionSnapshot(definition, 100, 'round');
    const paused = host.pauseSession(initial, 300);
    expect(initial.phase).toBe('running');
    expect(paused.remainingMs).toBe(800);
    expect(host.advanceSession(paused, 5000).phase).toBe('paused');
    const resumed = host.resumeSession(paused, 5000);
    expect(resumed.deadlineAt).toBe(5800);
    expect(host.advanceSession(resumed, 5800)).toMatchObject({
      phase: 'finished',
      winner: 'tie',
      outcome: 'deadline',
    });
  });
  it('joins once, spends lifetime resources, deduplicates, and determines a winner', async () => {
    const engine = host.createEngine(artifact(), {
      seed: 7,
      session: host.createSessionSnapshot(definition, 0),
    });
    try {
      expect((await engine.dispatch(event('before', '!throw'))).code).toBe('NOT_JOINED');
      expect((await engine.dispatch(event('join', '!red', 2))).code).toBe('ACCEPTED');
      expect((await engine.dispatch(event('switch', '!blue', 3))).code).toBe('ALREADY_JOINED');
      for (let i = 0; i < 3; i++)
        expect((await engine.dispatch(event(`t${i}`, '!throw', 4 + i))).code).toBe('ACCEPTED');
      expect((await engine.dispatch(event('t2', '!throw', 7))).code).toBe('DUPLICATE');
      expect((await engine.dispatch(event('four', '!throw', 8))).code).toBe('RESOURCE_LIMIT');
      expect(engine.session).toMatchObject({
        scores: { red: 6, blue: 0 },
        participants: { ada: { remaining: 0, contributions: 3 } },
      });
      expect((await engine.dispatch(event('end', '!throw', 1000))).session).toMatchObject({
        phase: 'finished',
        winner: 'red',
      });
    } finally {
      engine.stop();
    }
  });
  it('preserves semantic progress when a shared cosmetic budget is full', async () => {
    const engine = host.createEngine(artifact(), {
      seed: 7,
      channelBudget: { effects: [0], perMinute: 1 },
      session: host.createSessionSnapshot(definition, 0),
    });
    try {
      await engine.dispatch(event('join', '!red'));
      const result = await engine.dispatch(event('throw', '!throw', 2));
      expect(result).toMatchObject({
        code: 'ACCEPTED',
        effects: [],
        session: { scores: { red: 2 }, participants: { ada: { remaining: 2 } } },
      });
    } finally {
      engine.stop();
    }
  });
  it('discards a staged resource and score change on guest faults', async () => {
    const engine = host.createEngine(
      artifact(
        definition,
        "async (event, riff) => { await riff.overlay.emit({kind:'projectile',asset:'tomato',x:0.5}); throw Error('broken'); }",
      ),
      { seed: 7, session: host.createSessionSnapshot(definition, 0) },
    );
    try {
      await engine.dispatch(event('join', '!red'));
      const before = engine.session;
      expect((await engine.dispatch(event('throw', '!throw', 2))).code).toBe('INCIDENT');
      expect(engine.session).toEqual(before);
    } finally {
      engine.stop();
    }
  });
  it('freezes nested snapshots and refuses undeclared session reads', async () => {
    for (const handler of [
      '(e,riff) => { riff.session.snapshot().scores.red = 99; }',
      '(e,riff) => { riff.session.snapshot().participants.ada.remaining = 99; }',
    ]) {
      const engine = host.createEngine(artifact(definition, handler), {
        seed: 7,
        session: host.createSessionSnapshot(definition, 0),
      });
      try {
        await engine.dispatch(event('join', '!red'));
        expect((await engine.dispatch(event('t', '!throw', 2))).code).toBe('INCIDENT');
        expect(engine.session?.scores.red).toBe(0);
      } finally {
        engine.stop();
      }
    }
  });
  it('supports cooperative auto-enrollment, safe prototype identities, snapshot restore and deterministic replay', async () => {
    const cooperative = {
      ...definition,
      teams: [],
      objective: { kind: 'collective-goal' as const, target: 4 },
    };
    const play = async () => {
      const engine = host.createEngine(
        artifact(
          cooperative,
          "(e,riff) => riff.overlay.emit({kind:'projectile',asset:'heart',x:riff.util.random()})",
        ),
        { seed: 7, session: host.createSessionSnapshot(cooperative, 0) },
      );
      try {
        const first = await engine.dispatch(event('a', '!throw', 1, '__proto__'));
        const copy = engine.session!;
        copy.scores.community = 999;
        expect(engine.session?.scores.community).toBe(2);
        engine.restoreSession(first.session!);
        const second = await engine.dispatch(event('b', '!throw', 2, 'constructor'));
        expect(second.session).toMatchObject({
          phase: 'finished',
          winner: 'community',
          outcome: 'goal',
          scores: { community: 4 },
        });
        expect((await engine.dispatch(event('c', '!throw', 3))).code).toBe('SESSION_FINISHED');
        expect(() => engine.restoreSession({ ...second.session!, revision: -1 })).toThrow();
        return [first, second];
      } finally {
        engine.stop();
      }
    };
    expect(await play()).toEqual(await play());
  });
});

it('keeps paused rounds, participant capacity and join audience under host control', async () => {
  const limited = { ...definition, maxParticipants: 1 };
  const restricted = artifact(limited);
  restricted.manifest.trigger.audience = ['subscriber'];
  const engine = host.createEngine(restricted, {
    seed: 7,
    session: host.createSessionSnapshot(limited, 0),
  });
  const sub = (id: string, text: string, at: number, viewer = 'ada') => ({
    ...event(id, text, at, viewer),
    roles: ['viewer', 'subscriber'],
  });
  try {
    expect((await engine.dispatch(event('denied', '!red'))).code).toBe('AUDIENCE');
    expect((await engine.dispatch(sub('join', '!red', 2))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(sub('full', '!blue', 3, 'ben'))).code).toBe('PARTICIPANT_LIMIT');
    engine.restoreSession(host.pauseSession(engine.session!, 4));
    expect((await engine.dispatch(sub('paused', '!throw', 10000))).code).toBe('SESSION_PAUSED');
    engine.restoreSession(host.resumeSession(engine.session!, 11000));
    expect((await engine.dispatch(sub('again', '!throw', 11001))).code).toBe('ACCEPTED');
  } finally {
    engine.stop();
  }
});
it('does not announce a cooperative winner when its deadline expires before the target', () => {
  const cooperative = {
    ...definition,
    teams: [],
    objective: { kind: 'collective-goal' as const, target: 10 },
  };
  expect(
    host.advanceSession(host.createSessionSnapshot(cooperative, 0), 1000, cooperative),
  ).toMatchObject({ phase: 'finished', winner: null, outcome: 'deadline' });
});
it('verifies state assertions independently of effect counts', async () => {
  const result = await host.runScenarios(
    artifact(),
    [
      {
        name: 'state mismatch',
        kind: 'happy',
        steps: [
          {
            id: 'join',
            viewer: 'ada',
            roles: ['viewer'],
            text: '!red',
            at: 0,
            expect: 'ACCEPTED',
            effects: 0,
            session: { scores: { red: 99 } },
          },
        ],
      },
    ],
    'generated',
  );
  expect(result[0]?.passed).toBe(false);
});
it('derives host-owned session scenarios that pass for generated visuals', async () => {
  for (const experience of [
    definition,
    { ...definition, teams: [], objective: { kind: 'collective-goal' as const, target: 4 } },
  ]) {
    const candidate = artifact(
      experience,
      "(event,riff) => riff.overlay.emit({kind:'projectile',asset:'tomato',x:riff.util.random()})",
    );
    const suite = host.hostScenarios(candidate.manifest);
    expect(suite.some((s) => s.name.includes('deadline'))).toBe(true);
    const result = await host.runScenarios(candidate, suite, 'host');
    expect(result.filter((r) => !r.passed)).toEqual([]);
  }
});

it('rejects forged resources, scores, clocks and outcomes when restoring state', () => {
  const snapshot = host.createSessionSnapshot(definition, 0);
  for (const changed of [
    { ...snapshot, scores: { red: 999, blue: 0 } },
    { ...snapshot, deadlineAt: 20 },
    {
      ...snapshot,
      phase: 'finished',
      deadlineAt: null,
      remainingMs: 0,
      outcome: 'goal',
      winner: 'red',
    },
    { ...snapshot, participants: { ada: { teamId: 'red', remaining: 3, contributions: 1 } } },
  ])
    expect(() => host.validateSessionSnapshot(definition, changed)).toThrow();
});
it('assigns one revision to each logical transition and rejects unsafe event clocks', async () => {
  const snapshot = host.createSessionSnapshot(definition, 0);
  expect(host.pauseSession(snapshot, 1).revision).toBe(1);
  const engine = host.createEngine(artifact(), { seed: 7, session: snapshot });
  try {
    await engine.dispatch(event('join', '!red', 1));
    expect(engine.session?.revision).toBe(1);
    await engine.dispatch(event('contribution', '!throw', 2));
    expect(engine.session?.revision).toBe(2);
    expect((await engine.dispatch(event('unsafe', '!throw', Number.MAX_SAFE_INTEGER))).code).toBe(
      'INVALID_EVENT',
    );
  } finally {
    engine.stop();
  }
});
it('the host suite exercises a cooperative target across multiple participants', () => {
  const candidate = artifact({
    ...definition,
    teams: [],
    objective: { kind: 'collective-goal', target: 5 },
    contribution: { command: '!throw', points: 1 },
  });
  expect(
    host
      .hostScenarios(candidate.manifest)
      .some(
        (s) =>
          s.name.includes('Cooperative goal') &&
          s.steps.some((step) => step.session?.phase === 'finished'),
      ),
  ).toBe(true);
});

it('independent session host checks allow HUD-only semantic contributions', async () => {
  const candidate = artifact(definition, '(event, riff) => { riff.session.snapshot(); }');
  candidate.manifest.capabilities = ['session'];
  const results = await host.runScenarios(
    candidate,
    host.hostScenarios(candidate.manifest),
    'host',
  );
  expect(results.filter((result) => !result.passed)).toEqual([]);
});
