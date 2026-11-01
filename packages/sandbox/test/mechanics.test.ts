import { afterEach, describe, expect, it } from 'vitest';
import type {
  AutomationArtifact,
  ExperienceDefinition,
  ExperienceMechanics,
  SessionSnapshot,
} from '@riff/sdk';
import * as host from '@riff/sandbox';

const noMechanics: ExperienceMechanics = { match: null, health: null, burst: null, milestones: [] };
const battle = (
  mechanics: Partial<ExperienceMechanics>,
  extra: Partial<ExperienceDefinition> = {},
) =>
  ({
    version: 2,
    title: 'Castle Siege',
    durationMs: 10_000,
    maxParticipants: 16,
    teams: [
      { id: 'red', label: 'Red', joinCommand: '!red' },
      { id: 'blue', label: 'Blue', joinCommand: '!blue' },
    ],
    resource: { name: 'attacks', perParticipant: 5 },
    contribution: { command: '!attack', points: 1 },
    objective: { kind: 'highest-score', target: null },
    mechanics: { ...noMechanics, ...mechanics },
    ...extra,
  }) satisfies ExperienceDefinition;
const shieldWall: ExperienceDefinition = {
  version: 2,
  title: 'Shield Wall',
  durationMs: 60_000,
  maxParticipants: 32,
  teams: [],
  resource: { name: 'shields', perParticipant: 3 },
  contribution: { command: '!shield', points: 1 },
  objective: { kind: 'burst', target: 1 },
  mechanics: {
    ...noMechanics,
    burst: {
      command: null,
      label: 'Shield',
      participants: 5,
      windowMs: 10_000,
      points: 0,
      limit: 1,
      shieldMs: 0,
    },
  },
};
const source =
  "async (event, riff) => { const s = riff.session.snapshot(); await riff.overlay.emit({ kind:'projectile', asset:'tomato', x: s.revision % 2 ? 0.2 : 0.8 }); }";
const artifact = (experience: ExperienceDefinition): AutomationArtifact => ({
  source,
  manifest: {
    sdkVersion: '0.4.0',
    capabilities: ['overlay', 'session'],
    trigger: {
      command: experience.contribution.command,
      audience: ['viewer'],
      maxPerViewer: experience.resource.perParticipant,
      windowMs: experience.durationMs,
    },
    limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
    experience,
  },
});
let n = 0;
const chat = (viewerId: string, text: string, at: number) => ({
  id: `e${++n}`,
  channelId: 'test',
  viewerId,
  roles: ['viewer'],
  text,
  at,
});
const engines: { stop(): void }[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});
function play(definition: ExperienceDefinition) {
  const engine = host.createEngine(artifact(definition), {
    seed: 11,
    session: host.createSessionSnapshot(definition, 0),
  });
  engines.push(engine);
  return engine;
}
const standing = (s: SessionSnapshot | undefined, key: string) => s?.mechanics?.standings[key];

describe('version 2 definition contract', () => {
  it('keeps version 1 definitions and their hashes unchanged', () => {
    const v1: ExperienceDefinition = {
      ...battle({}),
      version: 1,
      mechanics: undefined,
    };
    delete (v1 as { mechanics?: unknown }).mechanics;
    expect(host.sessionDefinitionSchema.parse(v1)).not.toHaveProperty('mechanics');
    expect(host.createSessionSnapshot(v1, 0)).not.toHaveProperty('mechanics');
    expect(host.sessionDefinitionSchema.safeParse({ ...v1, mechanics: noMechanics }).success).toBe(
      false,
    );
    expect(
      host.sessionDefinitionSchema.safeParse({ ...battle({}), mechanics: undefined }).success,
    ).toBe(false);
  });
  it('rejects incoherent mechanics with explicit reasons', () => {
    const problems = (d: unknown) => {
      const parsed = host.sessionDefinitionSchema.safeParse(d);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(
      problems(
        battle({
          health: { label: 'Health', max: 10, damage: 1, heal: { command: '!red', amount: 1 } },
        }),
      ),
    ).toContain('Every join, contribution, heal, burst and unlock command must be unique');
    expect(
      problems({
        ...battle({ health: { label: 'Health', max: 10, damage: 1, heal: null } }),
        teams: [],
      }),
    ).toContain('Health pools need two or more competing teams');
    expect(
      problems(
        battle({
          milestones: [
            { id: 'b', label: 'B', score: 5, unlock: null },
            { id: 'a', label: 'A', score: 5, unlock: null },
          ],
        }),
      ),
    ).toContain('Milestone scores must strictly increase');
    expect(problems({ ...shieldWall, objective: { kind: 'burst', target: 2 } })).toContain(
      'A burst objective target must be between 1 and the burst limit',
    );
    expect(
      problems({
        ...shieldWall,
        objective: { kind: 'collective-goal', target: 5 },
        mechanics: {
          ...shieldWall.mechanics,
          burst: { ...shieldWall.mechanics!.burst!, points: 0 },
        },
      }),
    ).toContain('A burst must award points, raise a shield or count toward the objective');
    expect(problems(shieldWall)).toEqual([]);
  });
});

describe('distinct-participant burst', () => {
  it('needs five different viewers inside a sliding host-clocked window', async () => {
    const engine = play(shieldWall);
    for (const [i, viewer] of ['a', 'b', 'c', 'd'].entries())
      expect((await engine.dispatch(chat(viewer, '!shield', 1000 + i))).code).toBe('ACCEPTED');
    // A repeat viewer is accepted as a contribution but never counts twice.
    const repeat = await engine.dispatch(chat('a', '!shield', 2000));
    expect(repeat.code).toBe('ACCEPTED');
    expect(repeat.reason).toMatch(/already counts/);
    expect(standing(repeat.session, 'community')?.burstWindow).toHaveLength(4);
    // a and b age out of the ten-second window exactly at its boundary; c and d still count.
    const late = await engine.dispatch(chat('e', '!shield', 11_001));
    expect(standing(late.session, 'community')?.burstWindow.map((x) => x.viewerId)).toEqual([
      'c',
      'd',
      'e',
    ]);
    expect(standing(late.session, 'community')?.bursts).toBe(0);
    await engine.dispatch(chat('f', '!shield', 11_001));
    const done = await engine.dispatch(chat('g', '!shield', 11_001));
    expect(done.reason).toMatch(/Shield triggered by 5 different viewers/);
    expect(done.session).toMatchObject({ phase: 'finished', outcome: 'goal', winner: 'community' });
    expect(standing(done.session, 'community')?.bursts).toBe(1);
    expect((await engine.dispatch(chat('j', '!shield', 15_001))).code).toBe('SESSION_FINISHED');
  });
  it('dedicated burst commands are resource-free with explicit rejection codes', async () => {
    const d = battle({
      health: { label: 'Health', max: 3, damage: 1, heal: null },
      burst: {
        command: '!shield',
        label: 'Shield',
        participants: 2,
        windowMs: 5000,
        points: 2,
        limit: 2,
        shieldMs: 4000,
      },
    });
    const engine = play(d);
    for (const [viewer, team] of [
      ['ada', '!red'],
      ['bo', '!red'],
      ['cy', '!blue'],
    ] as const)
      await engine.dispatch(chat(viewer, team, 1));
    expect((await engine.dispatch(chat('ada', '!shield', 10))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(chat('ada', '!shield', 11))).code).toBe('BURST_COUNTED');
    const raised = await engine.dispatch(chat('bo', '!shield', 12));
    expect(raised.session?.scores.red).toBe(2);
    expect(standing(raised.session, 'red')).toMatchObject({ bursts: 1, shieldUntil: 4012 });
    expect(raised.session?.participants.ada?.remaining).toBe(5);
    expect((await engine.dispatch(chat('ada', '!shield', 13))).code).toBe('BURST_ACTIVE');
    // The shield blocks blue damage until it expires.
    const blocked = await engine.dispatch(chat('cy', '!attack', 100));
    expect(standing(blocked.session, 'red')?.health).toBe(3);
    const hit = await engine.dispatch(chat('cy', '!attack', 4012));
    expect(standing(hit.session, 'red')?.health).toBe(2);
    expect((await engine.dispatch(chat('ada', '!shield', 4013))).code).toBe('ACCEPTED');
    const again = await engine.dispatch(chat('bo', '!shield', 4014));
    expect(standing(again.session, 'red')).toMatchObject({ bursts: 2, shieldUntil: 8014 });
    expect((await engine.dispatch(chat('ada', '!shield', 4015))).code).toBe('BURST_LIMIT');
  });
});

describe('health pools and elimination', () => {
  const three = battle(
    { health: { label: 'Health', max: 2, damage: 1, heal: { command: '!heal', amount: 1 } } },
    {
      teams: [
        { id: 'red', label: 'Red', joinCommand: '!red' },
        { id: 'blue', label: 'Blue', joinCommand: '!blue' },
        { id: 'gold', label: 'Gold', joinCommand: '!gold' },
      ],
    },
  );
  it('damages every other standing team, heals, eliminates and ends with the last team', async () => {
    const engine = play(three);
    await engine.dispatch(chat('r', '!red', 1));
    await engine.dispatch(chat('b', '!blue', 1));
    await engine.dispatch(chat('g', '!gold', 1));
    expect((await engine.dispatch(chat('b', '!heal', 2))).code).toBe('HEALTH_FULL');
    const first = await engine.dispatch(chat('r', '!attack', 3));
    expect(standing(first.session, 'blue')?.health).toBe(1);
    expect(standing(first.session, 'gold')?.health).toBe(1);
    const healed = await engine.dispatch(chat('g', '!heal', 4));
    expect(standing(healed.session, 'gold')?.health).toBe(2);
    expect(healed.session?.participants.g?.remaining).toBe(4);
    const second = await engine.dispatch(chat('r', '!attack', 5));
    expect(standing(second.session, 'blue')).toMatchObject({ health: 0, eliminated: true });
    expect(second.session?.phase).toBe('running');
    expect((await engine.dispatch(chat('b', '!attack', 6))).code).toBe('ELIMINATED');
    expect((await engine.dispatch(chat('b', '!heal', 6))).code).toBe('ELIMINATED');
    expect((await engine.dispatch(chat('late', '!blue', 7))).code).toBe('ELIMINATED');
    const third = await engine.dispatch(chat('r', '!attack', 8));
    expect(third.session).toMatchObject({
      phase: 'finished',
      outcome: 'elimination',
      winner: 'red',
    });
    expect(() => host.validateSessionSnapshot(three, third.session)).not.toThrow();
  });
  it('rejects forged health, elimination and score ledgers', async () => {
    const engine = play(three);
    await engine.dispatch(chat('r', '!red', 1));
    const s = (await engine.dispatch(chat('r', '!attack', 2))).session!;
    const forged = structuredClone(s);
    forged.mechanics!.standings.blue!.health = 2;
    forged.mechanics!.standings.blue!.eliminated = true;
    expect(() => host.validateSessionSnapshot(three, forged)).toThrow(/health/);
    const points = structuredClone(s);
    points.scores.red = 5;
    expect(() => host.validateSessionSnapshot(three, points)).toThrow(/scores/);
  });
});

describe('best-of-N matches', () => {
  const match = battle({ match: { rounds: 3, intermissionMs: 2000 } });
  it('resets per round, keeps teams, gates the intermission and ends on a majority', async () => {
    const engine = play(match);
    await engine.dispatch(chat('r', '!red', 1));
    await engine.dispatch(chat('b', '!blue', 1));
    await engine.dispatch(chat('r', '!attack', 2));
    const pause = await engine.dispatch(chat('b', '!attack', 10_000));
    expect(pause.code).toBe('ROUND_INTERMISSION');
    expect(pause.session).toMatchObject({
      phase: 'running',
      remainingMs: 12_000,
      scores: { red: 0, blue: 0 },
    });
    expect(pause.session?.mechanics).toMatchObject({ round: 2, wins: { red: 1, blue: 0 } });
    expect(pause.session?.mechanics?.history[0]).toMatchObject({
      round: 1,
      winner: 'red',
      scores: { red: 1 },
    });
    expect(pause.session?.participants.r).toEqual({
      teamId: 'red',
      remaining: 5,
      contributions: 0,
    });
    expect((await engine.dispatch(chat('late', '!blue', 11_000))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(chat('b', '!attack', 12_000))).code).toBe('ACCEPTED');
    const decided = await engine.dispatch(chat('r', '!attack', 22_000));
    expect(decided.code).toBe('ROUND_INTERMISSION');
    expect(decided.session?.mechanics?.wins).toEqual({ red: 1, blue: 1 });
    await engine.dispatch(chat('r', '!attack', 24_000));
    const final = await engine.dispatch(chat('b', '!attack', 34_000));
    expect(final.code).toBe('SESSION_FINISHED');
    expect(final.session).toMatchObject({ phase: 'finished', winner: 'red', outcome: 'deadline' });
    expect(final.session?.mechanics?.history).toHaveLength(3);
  });
  it('replays downtime across several deadlines deterministically and survives pause', () => {
    const start = host.createSessionSnapshot(match, 0, 'm');
    const paused = host.pauseSession(host.advanceSession(start, 11_000, match), 11_000, match);
    // Round one ended at 10 s; round two's deadline is 10 s + 2 s intermission + 10 s.
    expect(paused).toMatchObject({ phase: 'paused', remainingMs: 11_000 });
    expect(paused.mechanics?.round).toBe(2);
    const resumed = host.resumeSession(paused, 50_000);
    expect(resumed.deadlineAt).toBe(61_000);
    const late = host.advanceSession(resumed, 200_000, match);
    expect(late).toMatchObject({ phase: 'finished', winner: 'tie' });
    expect(late.mechanics?.history.map((x) => x.winner)).toEqual(['tie', 'tie', 'tie']);
    expect(host.advanceSession(resumed, 200_000, match)).toEqual(late);
    expect(() => host.validateSessionSnapshot(match, late)).not.toThrow();
  });
});

describe('milestones and unlocks', () => {
  const garden: ExperienceDefinition = {
    ...shieldWall,
    title: 'Community Garden',
    contribution: { command: '!grow', points: 2 },
    objective: { kind: 'collective-goal', target: 20 },
    mechanics: {
      ...noMechanics,
      milestones: [
        { id: 'sprout', label: 'Sprout', score: 2, unlock: null },
        { id: 'bloom', label: 'Bloom', score: 4, unlock: { command: '!bloom', points: 5 } },
      ],
    },
  };
  it('locks tier commands until the score threshold and exposes the tier to handlers', async () => {
    const engine = play(garden);
    expect((await engine.dispatch(chat('a', '!bloom', 1))).code).toBe('LOCKED');
    const one = await engine.dispatch(chat('a', '!grow', 2));
    expect(standing(one.session, 'community')?.unlocked).toEqual(['sprout']);
    await engine.dispatch(chat('b', '!grow', 3));
    const bloom = await engine.dispatch(chat('a', '!bloom', 4));
    expect(bloom.code).toBe('ACCEPTED');
    expect(bloom.session?.scores.community).toBe(9);
    expect(standing(bloom.session, 'community')).toMatchObject({
      unlocked: ['sprout', 'bloom'],
      unlocks: { bloom: 1 },
    });
    expect(bloom.session?.participants.a).toMatchObject({ remaining: 1, contributions: 2 });
    expect(bloom.effects).toHaveLength(1);
  });
});

describe('host suite, journal replay and rehearsal presets', () => {
  const all = [
    shieldWall,
    battle({
      health: { label: 'Health', max: 3, damage: 1, heal: { command: '!heal', amount: 1 } },
    }),
    battle({ match: { rounds: 3, intermissionMs: 1000 } }),
    battle({
      burst: {
        command: '!shield',
        label: 'Shield',
        participants: 3,
        windowMs: 5000,
        points: 3,
        limit: 2,
        shieldMs: 0,
      },
      milestones: [
        { id: 'fire', label: 'Fire', score: 2, unlock: { command: '!fire', points: 2 } },
      ],
    }),
  ];
  it.each(all.map((d) => [d.title, d] as const))(
    '%s passes the independent host suite derived from its definition',
    async (_title, d) => {
      const scenarios = host.hostScenarios(artifact(d).manifest);
      expect(scenarios.length).toBeGreaterThanOrEqual(5);
      const results = await host.runScenarios(artifact(d), scenarios, 'host');
      const failures = results.filter((r) => !r.passed);
      expect(failures.map((f) => [f.name, f.steps.filter((s) => !s.passed)])).toEqual([]);
    },
  );
  it('mechanic presets rehearse deterministically with their expectations', async () => {
    for (const d of all) {
      for (const preset of host.mechanicPresetsFor(artifact(d).manifest)) {
        const scenario = host.createRehearsalPreset(artifact(d), preset, 5);
        const a = await host.runRehearsal({ artifact: artifact(d), scenario });
        const b = await host.runRehearsal({ artifact: artifact(d), scenario });
        expect(
          a.checks.filter((c) => c.status !== 'passed'),
          `${d.title} ${preset}`,
        ).toEqual([]);
        expect(a.scenarioHash).toBe(b.scenarioHash);
        expect(a.timeline.at(-1)).toEqual(b.timeline.at(-1));
      }
    }
  });
});

describe('live evolution compatibility for mechanics', () => {
  const siege = battle({
    match: { rounds: 3, intermissionMs: 1000 },
    health: { label: 'Health', max: 5, damage: 1, heal: null },
  });
  it('requires reset when mechanics are added, removed or change meaning', () => {
    const v1: ExperienceDefinition = { ...siege, version: 1 };
    delete (v1 as { mechanics?: unknown }).mechanics;
    expect(host.assessSessionTransition(v1, siege).reasons.join(' ')).toMatch(/added/);
    expect(host.assessSessionTransition(siege, v1).reasons.join(' ')).toMatch(/removed/);
    const longer = battle({ ...siege.mechanics, match: { rounds: 5, intermissionMs: 1000 } });
    expect(host.classifySessionTransition(siege, longer)).toBe('reset-required');
    const tougher = battle({
      ...siege.mechanics,
      health: { label: 'Health', max: 9, damage: 1, heal: null },
    });
    expect(host.assessSessionTransition(siege, tougher).reasons.join(' ')).toMatch(/Health/);
  });
  it('preserves pools and match progress through label and longer-break edits', async () => {
    const renamed = battle({
      match: { rounds: 3, intermissionMs: 3000 },
      health: { label: 'Castle', max: 5, damage: 1, heal: null },
    });
    expect(host.classifySessionTransition(siege, renamed)).toBe('migration-required');
    const engine = play(siege);
    await engine.dispatch(chat('r', '!red', 1));
    const s = (await engine.dispatch(chat('r', '!attack', 2))).session!;
    const migrated = await host.runSessionMigration('(input) => input.snapshot', {
      oldDefinition: siege,
      newDefinition: renamed,
      snapshot: s,
      at: 3,
    });
    expect(migrated.mechanics?.standings.blue?.health).toBe(4);
    await expect(
      host.runSessionMigration(
        '(input) => ({ ...input.snapshot, mechanics: { ...input.snapshot.mechanics, round: 2 } })',
        { oldDefinition: siege, newDefinition: renamed, snapshot: s, at: 3 },
      ),
    ).rejects.toThrow();
  });
});
