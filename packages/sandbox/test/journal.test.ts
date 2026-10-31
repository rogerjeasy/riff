import { describe, expect, it } from 'vitest';
import type { AutomationArtifact, ExperienceDefinition, SessionSnapshot } from '@riff/sdk';
import * as host from '@riff/sandbox';

const battle: ExperienceDefinition = {
  version: 1,
  title: 'Tomato Battle',
  durationMs: 120_000,
  maxParticipants: 16,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score', target: null },
};
const goal: ExperienceDefinition = {
  ...battle,
  title: 'Community Goal',
  teams: [],
  resource: { name: 'hearts', perParticipant: 3 },
  contribution: { command: '!grow', points: 1 },
  objective: { kind: 'collective-goal', target: 4 },
};
const artifact = (experience: ExperienceDefinition): AutomationArtifact => ({
  source:
    "async (event, riff) => { await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() }); }",
  manifest: {
    sdkVersion: '0.4.0',
    capabilities: ['overlay', 'session'],
    trigger: {
      command: experience.contribution.command,
      audience: ['viewer'],
      maxPerViewer: 3,
      windowMs: 120_000,
    },
    limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
    experience,
  },
});

type Step =
  | { chat: string; viewer: string; at: number }
  | { control: 'pause' | 'resume' | 'advance'; at: number };

/** Records a round the way the live host does: one journal entry per committed change. */
async function record(definition: ExperienceDefinition, steps: Step[]) {
  const live = host.createEngine(artifact(definition), { seed: 99, mode: 'live' });
  let state = host.createSessionSnapshot(definition, 1_000, 'round-1');
  let seq = 0;
  const entries: host.JournalEntry[] = [
    {
      seq: ++seq,
      kind: 'start',
      at: 1_000,
      versionId: 'v1',
      snapshot: state,
      digest: host.sessionDigest(state),
    },
  ];
  for (const [i, step] of steps.entries()) {
    if ('chat' in step) {
      live.restoreSession(state);
      const event = {
        id: `m${i}`,
        channelId: 'c',
        viewerId: step.viewer,
        roles: ['viewer' as const],
        text: step.chat,
        at: step.at,
      };
      const decision = await live.dispatch(event);
      const next = live.session as SessionSnapshot;
      if (decision.code === 'UNRELATED' && host.sessionDigest(next) === host.sessionDigest(state))
        continue;
      state = next;
      entries.push({
        seq: ++seq,
        kind: 'chat',
        at: step.at,
        versionId: 'v1',
        event,
        code: decision.code,
        digest: host.sessionDigest(state),
      });
    } else {
      const next =
        step.control === 'pause'
          ? host.pauseSession(state, step.at, definition)
          : step.control === 'resume'
            ? host.resumeSession(state, step.at)
            : host.advanceSession(state, step.at, definition);
      expect(host.classifyTransition(state, next)).toBe(
        step.control === 'advance' ? 'advance' : step.control,
      );
      state = next;
      entries.push({
        seq: ++seq,
        kind: step.control,
        at: step.at,
        versionId: 'v1',
        digest: host.sessionDigest(state),
      });
    }
  }
  live.stop();
  return { entries, state };
}
const replay = (
  definition: ExperienceDefinition,
  entries: host.JournalEntry[],
  expected: SessionSnapshot,
) =>
  host.replaySessionJournal({
    definition,
    entries,
    expected,
    artifactFor: () => artifact(definition),
  });

const round: Step[] = [
  { chat: '!red', viewer: 'alice', at: 2_000 },
  { chat: '!blue', viewer: 'bob', at: 2_100 },
  { chat: '!throw', viewer: 'alice', at: 3_000 },
  { chat: '!throw', viewer: 'bob', at: 3_100 },
  { chat: '!throw', viewer: 'carol', at: 3_200 }, // not joined
  { control: 'pause', at: 10_000 },
  { control: 'resume', at: 50_000 },
  { chat: '!throw', viewer: 'alice', at: 51_000 },
  { chat: '!throw', viewer: 'alice', at: 52_000 },
  { chat: '!throw', viewer: 'alice', at: 53_000 }, // fourth throw: no resources
  { control: 'advance', at: 200_000 }, // deadline passes while the server is down
  { chat: '!throw', viewer: 'bob', at: 200_500 }, // finished
];

describe('round journal audit', () => {
  it('replays a live battle with pause, resume and deadline into the identical state', async () => {
    const { entries, state } = await record(battle, round);
    expect(state).toMatchObject({ phase: 'finished', winner: 'red', scores: { red: 3, blue: 1 } });
    const audit = await replay(battle, entries, state);
    expect(audit).toMatchObject({
      status: 'verified',
      joins: 2,
      contributions: 4,
      rejections: 3,
      controls: 3,
      divergence: null,
    });
    expect(host.sessionDigest(audit.replayed!)).toBe(host.sessionDigest(state));
  });

  it('replays a cooperative goal that finishes early through the same engine', async () => {
    const { entries, state } = await record(goal, [
      { chat: '!grow', viewer: 'ana', at: 2_000 },
      { chat: '!grow', viewer: 'ben', at: 2_001 },
      { chat: '!grow', viewer: 'ana', at: 2_002 },
      { chat: '!grow', viewer: 'cy', at: 2_003 },
      { chat: '!grow', viewer: 'dee', at: 2_004 },
    ]);
    expect(state).toMatchObject({ phase: 'finished', outcome: 'goal', winner: 'community' });
    expect(await replay(goal, entries, state)).toMatchObject({
      status: 'verified',
      contributions: 4,
      rejections: 1,
    });
  });

  it('names the first entry whose recorded decision or state does not reproduce', async () => {
    const { entries, state } = await record(battle, round);
    const forgedCode = entries.map((e) =>
      e.seq === 4 && e.kind === 'chat' ? { ...e, code: 'RESOURCE_LIMIT' as const } : e,
    );
    expect(await replay(battle, forgedCode, state)).toMatchObject({
      status: 'diverged',
      divergence: { seq: 4, kind: 'chat', expected: 'RESOURCE_LIMIT', actual: 'ACCEPTED' },
    });
    // An extra point written into the stored round cannot be explained by its inputs.
    const inflated = { ...state, scores: { red: 4, blue: 1 } };
    expect((await replay(battle, entries, inflated)).status).toBe('diverged');
    const forgedResume = entries.map((e) => (e.kind === 'resume' ? { ...e, at: e.at + 5_000 } : e));
    expect((await replay(battle, forgedResume, state)).divergence?.kind).toBe('resume');
  });

  it('refuses rounds without a pristine recorded start', async () => {
    const { entries, state } = await record(battle, round);
    expect((await replay(battle, entries.slice(1), state)).status).toBe('unavailable');
    const head = entries[0] as Extract<host.JournalEntry, { kind: 'start' }>;
    const prefilled = { ...head, snapshot: { ...head.snapshot, scores: { red: 9, blue: 0 } } };
    expect((await replay(battle, [prefilled, ...entries.slice(1)], state)).status).toBe('diverged');
  });
});

it('audits a migration from the original definition and rejects changed migration artifacts', async () => {
  const next = {
    ...battle,
    contribution: { ...battle.contribution, command: '!splat' },
    resource: { ...battle.resource, perParticipant: 5 },
  };
  const { entries, state } = await record(battle, [
    { chat: '!red', viewer: 'alice', at: 2000 },
    { chat: '!throw', viewer: 'alice', at: 3000 },
  ]);
  const source = `(input) => { const s=JSON.parse(JSON.stringify(input.snapshot)); for(const p of Object.values(s.participants))p.remaining+=2; return s; }`;
  const plan = {
    version: 1 as const,
    sourceArtifactId: host.artifactIdentity(artifact(battle)),
    targetArtifactId: host.artifactIdentity(artifact(next)),
    sourceDefinitionHash: host.sessionDefinitionHash(battle),
    targetDefinitionHash: host.sessionDefinitionHash(next),
    migrationSourceHash: host.migrationSourceHash(source),
    boundary: 'immediate' as const,
    preserve: [
      'identity',
      'participants',
      'teams',
      'scores',
      'contributions',
      'phase',
      'time',
    ] as const,
    resets: [] as const,
  };
  const migrated = await host.runSessionMigration(source, {
    oldDefinition: battle,
    newDefinition: next,
    snapshot: state,
    at: 4000,
  });
  const journal = [
    ...entries,
    {
      seq: 4,
      kind: 'migration' as const,
      at: 4000,
      versionId: 'v2',
      digest: host.sessionDigest(migrated),
      oldDefinition: battle,
      newDefinition: next,
      plan,
      source,
    },
  ];
  const audit = await host.replaySessionJournal({
    definition: next,
    entries: journal,
    expected: migrated,
    artifactFor: (id) => artifact(id === 'v1' ? battle : next),
  });
  expect(audit.status).toBe('verified');
  expect(audit.replayed?.participants.alice).toMatchObject({ remaining: 4, contributions: 1 });
  const corrupt = journal.map((e) =>
    e.kind === 'migration' ? { ...e, source: '(input) => input.snapshot' } : e,
  );
  expect(
    (
      await host.replaySessionJournal({
        definition: next,
        entries: corrupt,
        expected: migrated,
        artifactFor: (id) => artifact(id === 'v1' ? battle : next),
      })
    ).status,
  ).toBe('diverged');
});

it('audits random-dependent accepted decisions using the live session seed and per-event seed', async () => {
  const randomArtifact = {
    ...artifact(goal),
    source: `async (e,riff)=>{if(riff.util.random()<0.5)throw new Error('choice');}`,
  };
  const state = host.createSessionSnapshot(goal, 1000, 'random-round');
  const live = host.createEngine(randomArtifact, {
    seed: host.sessionSeed(state.id),
    mode: 'live',
    session: state,
  });
  const entries: host.JournalEntry[] = [
    {
      seq: 1,
      kind: 'start',
      at: 1000,
      versionId: 'v1',
      snapshot: state,
      digest: host.sessionDigest(state),
    },
  ];
  let expected = state;
  try {
    for (let i = 0; i < 3; i++) {
      const event = {
        id: `random-${i}`,
        channelId: 'c',
        viewerId: `v${i}`,
        roles: ['viewer' as const],
        text: '!grow',
        at: 2000 + i,
      };
      const decision = await live.dispatch(event);
      if (decision.code === 'INCIDENT') break;
      expected = live.session!;
      entries.push({
        seq: entries.length + 1,
        kind: 'chat',
        at: event.at,
        versionId: 'v1',
        event,
        code: decision.code,
        digest: host.sessionDigest(expected),
      });
    }
    expect(entries.length).toBeGreaterThan(1);
    expect(
      (
        await host.replaySessionJournal({
          definition: goal,
          entries,
          expected,
          artifactFor: () => randomArtifact,
        })
      ).status,
    ).toBe('verified');
  } finally {
    live.stop();
  }
});
