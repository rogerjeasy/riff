import { describe, expect, it } from 'vitest';
import { createSessionSnapshot } from '@riff/sandbox';
import {
  assessSessionTransition,
  migrationFailureReason,
  classifySessionTransition,
  sessionDefinitionHash,
  migrationSourceHash,
  transitionIdentity,
  sessionTransitionPlanSchema,
  runSessionMigration,
  validatePreservingMigration,
} from '@riff/sandbox';
import type { ExperienceDefinition } from '@riff/sdk';
const old: ExperienceDefinition = {
  version: 1,
  title: 'Throws',
  durationMs: 60000,
  maxParticipants: 20,
  teams: [],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score', target: null },
};
const next = {
  ...old,
  resource: { ...old.resource, perParticipant: 5 },
  contribution: { ...old.contribution, command: '!splat' },
};
const source = `(input) => { const s = JSON.parse(JSON.stringify(input.snapshot)); for (const p of Object.values(s.participants)) p.remaining += input.newDefinition.resource.perParticipant - input.oldDefinition.resource.perParticipant; return s; }`;
describe('preserving transitions', () => {
  it('classifies incompatible score, team and resource rules', () => {
    expect(classifySessionTransition(old, old)).toBe('identical-definition');
    expect(classifySessionTransition(old, next)).toBe('migration-required');
    expect(
      classifySessionTransition(old, {
        ...next,
        contribution: { ...next.contribution, points: 2 },
      }),
    ).toBe('reset-required');
    expect(classifySessionTransition(next, old)).toBe('reset-required');
    expect(
      classifySessionTransition(old, {
        ...next,
        teams: [{ id: 'red', label: 'Red', joinCommand: '!red' }],
      }),
    ).toBe('reset-required');
  });
  it('binds exact plans and rejects undeclared resets', () => {
    const h = sessionDefinitionHash(old);
    const plan = {
      version: 1 as const,
      sourceArtifactId: h,
      targetArtifactId: h,
      sourceDefinitionHash: h,
      targetDefinitionHash: sessionDefinitionHash(next),
      migrationSourceHash: migrationSourceHash(source),
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
    expect(transitionIdentity(plan)).toBe(transitionIdentity({ ...plan }));
    expect(transitionIdentity({ ...plan, boundary: 'stopped' })).not.toBe(transitionIdentity(plan));
    expect(() => sessionTransitionPlanSchema.parse({ ...plan, resets: ['scores'] })).toThrow();
    expect(() =>
      sessionTransitionPlanSchema.parse({ ...plan, targetArtifactId: 'untrusted' }),
    ).toThrow();
  });
  it('independently rejects score, team, contribution, participant and clock rewriting', () => {
    const s = createSessionSnapshot(old, 100);
    s.participants.viewer = { teamId: null, remaining: 2, contributions: 1 };
    s.scores.community = 1;
    const input = { oldDefinition: old, newDefinition: next, snapshot: s, at: 100 };
    const valid = structuredClone(s);
    valid.participants.viewer!.remaining = 4;
    expect(validatePreservingMigration(input, valid).revision).toBe(1);
    for (const mutate of [
      (v: typeof s) => {
        v.participants = {};
        v.scores.community = 0;
      },
      (v: typeof s) => {
        v.participants.viewer!.contributions = 2;
        v.participants.viewer!.remaining = 3;
        v.scores.community = 2;
      },
      (v: typeof s) => {
        v.deadlineAt!++;
        v.remainingMs++;
      },
      (v: typeof s) => {
        v.updatedAt++;
        v.remainingMs--;
      },
      (v: typeof s) => {
        v.participants.viewer!.teamId = 'red';
      },
      (v: typeof s) => {
        v.participants.viewer!.remaining--;
      },
    ]) {
      const v = structuredClone(valid);
      mutate(v);
      expect(() => validatePreservingMigration(input, v)).toThrow();
    }
  });
  it('supports a bounded async expression', async () => {
    const s = createSessionSnapshot(old, 100);
    expect(
      (
        await runSessionMigration(
          'async input => { await Promise.resolve(); return input.snapshot; }',
          { oldDefinition: old, newDefinition: old, snapshot: s, at: 100 },
        )
      ).revision,
    ).toBe(1);
  });
  it('rejects oversized source before starting the worker', async () => {
    await expect(
      runSessionMigration(' '.repeat(32769), {
        oldDefinition: old,
        newDefinition: next,
        snapshot: createSessionSnapshot(old, 100),
        at: 100,
      }),
    ).rejects.toThrow('budget');
  });
  for (const phase of ['empty', 'running', 'paused', 'finished'] as const)
    it(`preserves ${phase} state and host revision`, async () => {
      const s = createSessionSnapshot(old, 100, 'round');
      if (phase !== 'empty') {
        s.participants.viewer = { teamId: null, remaining: 0, contributions: 3 };
        s.scores.community = 3;
      }
      if (phase === 'paused') {
        s.phase = 'paused';
        s.deadlineAt = null;
      }
      if (phase === 'finished') {
        s.phase = 'finished';
        s.deadlineAt = null;
        s.remainingMs = 0;
        s.outcome = 'deadline';
        s.winner = 'community';
      }
      const input = { oldDefinition: old, newDefinition: next, snapshot: s, at: 100 };
      const result = await runSessionMigration(source, input);
      expect(result.revision).toBe(s.revision + 1);
      expect(result.phase).toBe(s.phase);
      expect(result.scores).toEqual(s.scores);
      if (phase !== 'empty') expect(result.participants.viewer?.remaining).toBe(2);
      expect(await runSessionMigration(source, input)).toEqual(result);
      expect(() => validatePreservingMigration(input, { ...s, id: 'stolen' })).toThrow();
      expect(() => validatePreservingMigration(input, { ...s, revision: 99 })).toThrow();
    });
  for (const code of [
    '() => { while(true){} }',
    '() => Date.now()',
    '() => fetch("https://example.com")',
    '() => require("node:fs")',
    '() => (function(){}).constructor("return 1")()',
    '() => "x".repeat(300000)',
    '() => null',
    '() => Math.random()',
    '() => eval("1")',
    '() => import("node:fs")',
    '() => new Array(10000000).fill("x").join("")',
    'input => { input.snapshot.participants.x = {}; return input.snapshot; }',
    '() => new Promise(() => {})',
  ])
    it(`rejects hostile migration ${code.slice(0, 35)}`, async () => {
      await expect(
        runSessionMigration(code, {
          oldDefinition: old,
          newDefinition: next,
          snapshot: createSessionSnapshot(old, 100),
          at: 100,
        }),
      ).rejects.toThrow();
    });
});

describe('creator-facing transition explanations', () => {
  it('names every reason progress cannot carry over, and none for compatible edits', () => {
    expect(assessSessionTransition(old, next)).toEqual({ kind: 'migration-required', reasons: [] });
    expect(assessSessionTransition(old, old)).toEqual({
      kind: 'identical-definition',
      reasons: [],
    });
    const { kind, reasons } = assessSessionTransition(old, {
      ...old,
      durationMs: 30000,
      maxParticipants: 10,
      resource: { ...old.resource, perParticipant: 2 },
      contribution: { ...old.contribution, points: 2 },
    });
    expect(kind).toBe('reset-required');
    expect(reasons).toEqual([
      expect.stringContaining('from 1 to 2'),
      expect.stringContaining('fewer throws (3 → 2)'),
      'The round gets shorter.',
      expect.stringContaining('20 → 10'),
    ]);
    expect(classifySessionTransition(old, { ...old, durationMs: 30000 })).toBe('reset-required');
  });
  it('maps host failures to fixed text and never echoes guest-controlled messages', () => {
    expect(
      migrationFailureReason(new Error('Migration violated preservation requirements')),
    ).toMatch(/changed progress it must keep/);
    expect(migrationFailureReason(new Error('Migration wall budget exceeded'))).toMatch(/budget/);
    expect(migrationFailureReason(new Error('Migration trapped'))).toMatch(/threw/);
    const guest = migrationFailureReason(new Error('<img src=x> attacker text'));
    expect(guest).not.toContain('attacker');
    expect(migrationFailureReason('not an error')).toMatch(/did not pass/);
  });
  it('rejects a guest that rewrites scores with the preservation reason', async () => {
    const snapshot = createSessionSnapshot(old, 1000, 'r');
    snapshot.participants.a = { teamId: null, contributions: 1, remaining: 2 };
    snapshot.scores.community = 1;
    const error = await runSessionMigration(
      '(input)=>({...input.snapshot,scores:{community:50}})',
      { oldDefinition: old, newDefinition: next, snapshot, at: 1000 },
    ).catch((e: unknown) => e);
    expect(migrationFailureReason(error)).toMatch(/does not fit the new rules/);
    const kept = createSessionSnapshot(old, 1000, 'r2');
    const moved = await runSessionMigration("(input)=>({...input.snapshot,id:'other-round'})", {
      oldDefinition: old,
      newDefinition: next,
      snapshot: kept,
      at: 1000,
    }).catch((e: unknown) => e);
    expect(migrationFailureReason(moved)).toMatch(/changed progress it must keep/);
  });
});
