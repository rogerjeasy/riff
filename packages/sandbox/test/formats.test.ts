import { afterEach, describe, expect, it } from 'vitest';
import type { AutomationArtifact, ExperienceDefinition, SessionSnapshot } from '@riff/sdk';
import * as host from '@riff/sandbox';

const base: Pick<ExperienceDefinition, 'version' | 'maxParticipants' | 'teams' | 'objective'> = {
  version: 3,
  maxParticipants: 64,
  teams: [],
  objective: { kind: 'highest-score', target: null },
};
const mural = (
  format: Partial<Extract<ExperienceDefinition['format'], { kind: 'mural' }>> = {},
): ExperienceDefinition =>
  ({
    ...base,
    title: 'Pixel Mural',
    durationMs: 120_000,
    resource: { name: 'paints', perParticipant: 3 },
    contribution: { command: '!paint', points: 1 },
    format: {
      kind: 'mural',
      width: 8,
      height: 8,
      palette: ['red', 'blue', 'yellow'],
      overwrite: true,
      reveal: 'live',
      ...format,
    },
  }) as ExperienceDefinition;
const song: ExperienceDefinition = {
  ...base,
  title: 'Song Builder',
  durationMs: 90_000,
  resource: { name: 'votes', perParticipant: 3 },
  contribution: { command: '!vote', points: 1 },
  format: {
    kind: 'composition',
    tieBreak: 'first-listed',
    stages: [
      {
        id: 'tempo',
        label: 'Tempo',
        options: [
          { id: 'slow', label: 'Slow · 70 BPM' },
          { id: 'fast', label: 'Fast · 140 BPM' },
        ],
      },
      {
        id: 'instrument',
        label: 'Instrument',
        options: [
          { id: 'piano', label: 'Piano' },
          { id: 'synth', label: 'Synth' },
          { id: 'drums', label: 'Drums' },
        ],
      },
      {
        id: 'mood',
        label: 'Mood',
        options: [
          { id: 'happy', label: 'Happy' },
          { id: 'dreamy', label: 'Dreamy' },
        ],
      },
    ],
  },
};
const quiz: ExperienceDefinition = {
  ...base,
  title: 'Solar Quiz',
  durationMs: 60_000,
  resource: { name: 'answers', perParticipant: 2 },
  contribution: { command: '!a', points: 1 },
  format: {
    kind: 'quiz',
    passPercent: 60,
    revealMs: 10_000,
    questions: [
      {
        prompt: 'Which planet is largest?',
        options: ['Jupiter', 'Mars', 'Venus'],
        answer: 0,
        explanation: 'Jupiter is more than twice as massive as every other planet combined.',
      },
      {
        prompt: 'Which planet is closest to the Sun?',
        options: ['Earth', 'Mercury'],
        answer: 1,
        explanation: 'Mercury orbits closest to the Sun.',
      },
    ],
  },
};
const source =
  "async (event, riff) => { const s = riff.session.snapshot(); await riff.overlay.emit({ kind:'projectile', asset:'star', x: s.revision % 2 ? 0.2 : 0.8 }); }";
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
    seed: 3,
    session: host.createSessionSnapshot(definition, 0),
  });
  engines.push(engine);
  return engine;
}
const problems = (d: unknown) => {
  const parsed = host.sessionDefinitionSchema.safeParse(d);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('version 3 definition contract', () => {
  it('accepts the three formats and keeps older versions free of a format key', () => {
    for (const d of [mural(), song, quiz]) expect(problems(d)).toEqual([]);
    expect(host.createSessionSnapshot(mural(), 0).format?.canvas).toHaveLength(64);
    const v1 = { ...mural(), version: 1 };
    expect(problems(v1)).toContain('Only version 3 definitions carry a format');
    const noFormat = { ...mural(), format: undefined };
    expect(problems(noFormat)).toContain('Version 3 definitions require a format');
  });
  it('rejects incoherent formats with explicit reasons', () => {
    expect(problems({ ...song, resource: { name: 'votes', perParticipant: 5 } })).toContain(
      'Each participant gets exactly one choice per stage or question',
    );
    expect(problems({ ...quiz, contribution: { command: '!answer', points: 1 } })).toContain(
      'Quiz answers use !a, !b, !c and !d; the contribution command must be !a',
    );
    expect(problems({ ...quiz, durationMs: 20_000 })).toContain(
      'Every stage or question needs at least 5 seconds to act',
    );
    expect(problems(mural({ palette: ['red', 'red'] }))).toContain(
      'Mural palette colors must be distinct',
    );
    expect(
      problems({ ...mural(), teams: [{ id: 'red', label: 'Red', joinCommand: '!red' }] }),
    ).toContain('Formats are shared by the whole community without teams');
    // Free text and unknown colors never parse.
    expect(problems(mural({ palette: ['red', 'gold' as 'red'] })).length).toBeGreaterThan(0);
    const longPrompt = structuredClone(quiz);
    if (longPrompt.format?.kind === 'quiz')
      longPrompt.format.questions[0]!.prompt = 'x'.repeat(141);
    expect(problems(longPrompt).length).toBeGreaterThan(0);
  });
});

describe('audience mural', () => {
  it('paints bounded cells and colors, spends the allowance and rejects free text', async () => {
    const engine = play(mural());
    expect((await engine.dispatch(chat('ann', '!paint', 1))).code).toBe('INVALID_CHOICE');
    expect((await engine.dispatch(chat('ann', '!paint i1 red', 2))).code).toBe('INVALID_CHOICE');
    expect((await engine.dispatch(chat('ann', '!paint a1 gold', 3))).code).toBe('INVALID_CHOICE');
    expect((await engine.dispatch(chat('ann', '!paint a1 red hi', 4))).code).toBe('INVALID_CHOICE');
    const ok = await engine.dispatch(chat('ann', '!paint B3 Blue', 5));
    expect(ok.code).toBe('ACCEPTED');
    expect(ok.session?.format?.canvas[2 * 8 + 1]).toBe(1);
    await engine.dispatch(chat('ann', '!paint b3 red', 6));
    await engine.dispatch(chat('ann', '!paint c3 red', 7));
    const spent = await engine.dispatch(chat('ann', '!paint d3 red', 8));
    expect(spent.code).toBe('RESOURCE_LIMIT');
    expect(spent.session?.format?.canvas[2 * 8 + 1]).toBe(0);
    expect(spent.session?.scores.community).toBe(3);
    expect(JSON.stringify(spent.session)).not.toContain('hi');
  });
  it('keeps painted cells final when overwrite is off', async () => {
    const engine = play(mural({ overwrite: false }));
    expect((await engine.dispatch(chat('ann', '!paint a1 red', 1))).code).toBe('ACCEPTED');
    const taken = await engine.dispatch(chat('bob', '!paint a1 blue', 2));
    expect(taken.code).toBe('CELL_TAKEN');
    expect(taken.session?.participants).not.toHaveProperty('bob');
  });
});

describe('staged composition vote', () => {
  it('opens one stage at a time, one vote per viewer per stage, first-listed tie-break', async () => {
    const engine = play(song);
    expect((await engine.dispatch(chat('ann', '!vote fast', 1))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(chat('ann', '!vote slow', 2))).code).toBe('ALREADY_CHOSEN');
    expect((await engine.dispatch(chat('bob', '!vote 1', 3))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(chat('cat', '!vote piano', 4))).code).toBe('INVALID_CHOICE');
    const second = await engine.dispatch(chat('cat', '!vote drums', 30_000));
    expect(second.code).toBe('ACCEPTED');
    const s = second.session!;
    expect(host.currentSlot(song, s)).toBe(1);
    expect(host.slotTally(song, s.format!, 0)).toEqual([1, 1]);
    // A tied stage resolves to the first listed option.
    expect(host.tallyWinner(host.slotTally(song, s.format!, 0))).toBe(0);
    expect(host.tallyWinner(host.slotTally(song, s.format!, 1))).toBe(2);
    // Empty stages resolve to the first option too.
    expect(host.tallyWinner(host.slotTally(song, s.format!, 2))).toBe(0);
    const done = await engine.dispatch(chat('ann', '!vote happy', 90_000));
    expect(done.code).toBe('SESSION_FINISHED');
    expect(done.session).toMatchObject({ phase: 'finished', winner: 'community' });
  });
});

describe('educational group challenge', () => {
  it('locks answers, closes during the reveal and counts solved questions collectively', async () => {
    const engine = play(quiz);
    expect((await engine.dispatch(chat('ann', '!a', 1))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(chat('ann', '!b', 2))).code).toBe('ALREADY_CHOSEN');
    expect((await engine.dispatch(chat('bob', '!d', 3))).code).toBe('INVALID_CHOICE');
    expect((await engine.dispatch(chat('bob', '!b', 4))).code).toBe('ACCEPTED');
    const closed = await engine.dispatch(chat('cat', '!a', 20_000));
    expect(closed.code).toBe('ANSWER_CLOSED');
    // 1 of 2 correct = 50% < 60%: not solved.
    expect(host.solvedCount(quiz, closed.session!)).toBe(0);
    expect((await engine.dispatch(chat('cat', '!b', 30_000))).code).toBe('ACCEPTED');
    const s = (await engine.dispatch(chat('dan', '!b', 30_001))).session!;
    expect(host.questionSolved(quiz, s.format!, 1)).toBe(true);
    expect(host.solvedCount(quiz, s)).toBe(1);
    // No per-viewer ranking: the community score counts participation.
    expect(s.scores).toEqual({ community: 4 });
  });
  it('rejects persisted state that does not match the ledger', () => {
    const s = host.createSessionSnapshot(quiz, 0) as SessionSnapshot;
    s.format!.choices.ghost = [0, -1];
    expect(() => host.validateSessionSnapshot(quiz, s)).toThrow();
  });
});

describe('host verification, rehearsal and replay', () => {
  const all = [mural(), mural({ overwrite: false, reveal: 'end' }), song, quiz];
  it.each(all.map((d, i) => [`${d.title} ${i}`, d] as const))(
    '%s passes the independent host suite derived from its definition',
    async (_title, d) => {
      const scenarios = host.hostScenarios(artifact(d).manifest);
      expect(scenarios.length).toBeGreaterThanOrEqual(4);
      const results = await host.runScenarios(artifact(d), scenarios, 'host');
      expect(
        results.filter((r) => !r.passed).map((f) => [f.name, f.steps.filter((s) => !s.passed)]),
      ).toEqual([]);
    },
  );
  it('format and generic presets rehearse deterministically with their expectations', async () => {
    for (const d of all) {
      const presets = [
        ...host.formatPresetsFor(artifact(d).manifest),
        'proof',
        'duplicate-delivery',
        'late-arrival',
        'exhaustion',
        'deadline',
      ] as const;
      for (const preset of presets) {
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
  it('canonical export text keeps only bounded choices', () => {
    expect(host.canonicalFormatText(mural(), '  !PAINT  b3  Blue ')).toBe('!paint b3 blue');
    expect(host.canonicalFormatText(mural(), '!paint b3 my-name')).toBeNull();
    expect(host.canonicalFormatText(song, '!vote dreamy')).toBe('!vote dreamy');
    expect(host.canonicalFormatText(quiz, '!c')).toBe('!c');
  });
});

describe('live evolution compatibility for formats', () => {
  it('keeps progress through wording edits and requires reset when meaning changes', async () => {
    const reworded = structuredClone(song);
    if (reworded.format?.kind === 'composition') reworded.format.stages[0]!.label = 'Speed';
    expect(host.classifySessionTransition(song, reworded)).toBe('migration-required');
    const engine = play(song);
    const s = (await engine.dispatch(chat('ann', '!vote fast', 1))).session!;
    const migrated = await host.runSessionMigration('(input) => input.snapshot', {
      oldDefinition: song,
      newDefinition: reworded,
      snapshot: s,
      at: 2,
    });
    expect(migrated.format?.choices.ann).toEqual([1, -1, -1]);
    expect(host.classifySessionTransition(song, { ...song, durationMs: 120_000 })).toBe(
      'reset-required',
    );
    expect(host.classifySessionTransition(mural(), mural({ palette: ['blue', 'red'] }))).toBe(
      'reset-required',
    );
    expect(
      host.classifySessionTransition(
        mural(),
        mural({ palette: ['red', 'blue', 'yellow', 'green'] }),
      ),
    ).toBe('migration-required');
    expect(host.assessSessionTransition(mural(), song).reasons.join(' ')).toMatch(/format/);
    const harder = structuredClone(quiz);
    if (harder.format?.kind === 'quiz') harder.format.passPercent = 90;
    expect(host.classifySessionTransition(quiz, harder)).toBe('reset-required');
  });
  it('replays a journal-free round identically from the same inputs', async () => {
    const inputs = [
      chat('a', '!paint a1 red', 1),
      chat('b', '!paint a2 blue', 2),
      chat('a', '!paint a1 yellow', 3),
    ];
    const run = async () => {
      const engine = play(mural());
      let last: SessionSnapshot | undefined;
      for (const input of inputs) last = (await engine.dispatch({ ...input })).session;
      return last;
    };
    expect(await run()).toEqual(await run());
  });
});
