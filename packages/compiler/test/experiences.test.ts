import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkIntent,
  compile,
  compileOffline,
  compileOutputSchema,
  COMPILE_OUTPUT_JSON_SCHEMA,
  createOfflineTransport,
  type ManifestView,
} from '@riff/compiler';

const BATTLE =
  'Tomato Battle: viewers join Red with !red or Blue with !blue, then use !throw to throw tomatoes. Give each participant 3 throws for a 120 second round; the team with the highest score wins.';
const GOAL =
  'Community Goal: everyone uses !grow to contribute hearts, with 3 contributions per participant in a 120 second round. Work together toward a collective goal of 5 points.';

function candidate(intent: string) {
  const output = compileOffline({ intent, base: null });
  return { source: output.source ?? '', manifest: output.manifest as ManifestView };
}

describe('stateful experience compilation', () => {
  it('generates team battle primitives and semantic generated scenarios', async () => {
    const result = await compile({ intent: BATTLE, base: null }, createOfflineTransport(), {
      verify: async () => ({ ok: true, failureReport: null }),
    });
    expect(result.status).toBe('ready');
    expect(result.transport).toBe('offline');
    expect(result.final?.output?.manifest).toMatchObject({
      sdkVersion: '0.4.0',
      capabilities: ['overlay', 'session'],
      trigger: { command: '!throw', maxPerViewer: 3 },
      experience: {
        version: 1,
        title: 'Tomato Battle',
        durationMs: 120000,
        teams: [
          { id: 'red', label: 'Red', joinCommand: '!red' },
          { id: 'blue', label: 'Blue', joinCommand: '!blue' },
        ],
        resource: { name: 'throws', perParticipant: 3 },
        contribution: { command: '!throw', points: 1 },
        objective: { kind: 'highest-score', target: null },
      },
    });
    expect(result.final?.output?.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'limit',
          steps: expect.arrayContaining([
            expect.objectContaining({
              expect: 'RESOURCE_LIMIT',
              effects: 0,
              session: { participants: { alice: { remaining: 0, contributions: 3 } } },
            }),
          ]),
        }),
      ]),
    );
    expect(result.final?.output?.behavior.howMuch).toContain('per round');
    expect(result.final?.output?.assumptions).toContain(
      'Offline template compiler; no model call.',
    );
  });

  it('generates structurally distinct cooperative goals and an early finish scenario', () => {
    const output = compileOffline({ intent: GOAL, base: null });
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      trigger: { command: '!grow' },
      experience: {
        title: 'Community Goal',
        durationMs: 120000,
        teams: [],
        resource: { name: 'contributions', perParticipant: 3 },
        contribution: { command: '!grow', points: 1 },
        objective: { kind: 'collective-goal', target: 5 },
      },
    });
    expect(output.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ session: { phase: 'finished', scores: { community: 5 } } }),
          ]),
        }),
      ]),
    );
  });

  it('detects duration, team, resource and objective mismatches independently', () => {
    const battle = candidate(BATTLE);
    const goal = candidate(GOAL);
    expect(checkIntent(BATTLE, battle).filter((check) => check.status === 'mismatch')).toEqual([]);
    const wrong = checkIntent(BATTLE, goal);
    for (const aspect of ['command', 'teams', 'resource', 'objective'])
      expect(wrong.find((check) => check.aspect === aspect)?.status).toBe('mismatch');
    const altered = structuredClone(battle);
    const experience = (
      altered.manifest as unknown as {
        experience: { durationMs: number; resource: { perParticipant: number } };
      }
    ).experience;
    experience.durationMs = 60000;
    experience.resource.perParticipant = 4;
    const checks = checkIntent(BATTLE, altered);
    expect(checks.find((check) => check.aspect === 'duration')?.status).toBe('mismatch');
    expect(checks.find((check) => check.aspect === 'resource')?.status).toBe('mismatch');
  });

  it('rejects dropping gameplay while preserving the projectile request', () => {
    const legacy = candidate(
      'Let viewers throw tomatoes with !throw, three per viewer in 120 seconds.',
    );
    const checks = checkIntent(BATTLE, legacy);
    expect(checks.find((check) => check.aspect === 'teams')?.status).toBe('mismatch');
    expect(checks.find((check) => check.aspect === 'objective')?.status).toBe('mismatch');
  });

  it('preserves session rules on a command-only edit', () => {
    const base = compileOffline({ intent: BATTLE, base: null });
    const output = compileOffline({
      intent: 'Change the contribution command to !splat.',
      base: {
        title: base.title,
        intent: BATTLE,
        source: base.source!,
        manifest: base.manifest,
        tests: base.tests,
      },
    });
    expect(output.manifest).toMatchObject({
      experience: {
        teams: [{ id: 'red' }, { id: 'blue' }],
        durationMs: 120000,
        contribution: { command: '!splat' },
        resource: { perParticipant: 3 },
      },
    });
    expect(
      checkIntent(
        'Change the contribution command to !splat.',
        { source: output.source!, manifest: output.manifest as ManifestView },
        candidate(BATTLE),
      )
        .filter((check) => ['duration', 'teams', 'resource', 'objective'].includes(check.aspect))
        .map((check) => check.status),
    ).toEqual(['preserved', 'preserved', 'preserved', 'preserved']);
  });

  it.each([
    'Make a team battle with !throw, health bars, damage and elimination.',
    'Create a cooperative community goal with !grow and a shared inventory that unlocks levels.',
    'Make a Tomato Battle with !throw and let users steal resources from other teams.',
  ])('does not silently replace unsupported mechanics: %s', (intent) => {
    expect(compileOffline({ intent, base: null }).kind).toBe('unsupported');
  });

  it('checks an explicit cooperative target independently', () => {
    const goal = candidate(GOAL);
    const checks = checkIntent(GOAL.replace('5 points', '8 points'), goal);
    expect(checks.find((check) => check.aspect === 'objective')?.status).toBe('mismatch');
  });

  it('retains the canonical countdown while rejecting unsupported gameplay on ordinary edits', () => {
    expect(compileOffline({ intent: `${BATTLE} Show a countdown.`, base: null }).kind).toBe(
      'candidate',
    );
    expect(
      compileOffline({
        intent: 'Use !tomato and add health and damage to every throw.',
        base: null,
      }).kind,
    ).toBe('unsupported');
  });

  it('requires a nullable experience in strict model manifests with all canonical fields', () => {
    const manifest = COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1];
    expect(manifest.required).toContain('experience');
    const experience = (manifest.properties as Record<string, unknown>).experience as {
      anyOf: [{ type: string }, { required: string[]; additionalProperties: boolean }];
    };
    expect(experience.anyOf[0].type).toBe('null');
    expect(experience.anyOf[1].additionalProperties).toBe(false);
    expect(experience.anyOf[1].required).toEqual([
      'version',
      'title',
      'durationMs',
      'maxParticipants',
      'teams',
      'resource',
      'contribution',
      'objective',
    ]);
  });
});

describe('recorded stateful responses', () => {
  it('replays offline recordings with truthful provenance through the compiler contract', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/stateful-experiences.json', import.meta.url), 'utf8'),
    ) as {
      provenance: { transport: string; model: string | null };
      records: { intent: string; output: unknown }[];
    };
    expect(fixture.provenance).toMatchObject({ transport: 'offline', model: null });
    expect(fixture.records).toHaveLength(2);
    for (const record of fixture.records) {
      const output = compileOutputSchema.parse(record.output);
      expect(output.kind).toBe('candidate');
      expect(
        checkIntent(record.intent, {
          source: output.source ?? '',
          manifest: output.manifest as ManifestView,
        }).filter((check) => check.status === 'mismatch'),
      ).toEqual([]);
    }
  });
});
