import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  buildWorkspace,
  checkIntent,
  compileOffline,
  compileOutputSchema,
  COMPILE_OUTPUT_JSON_SCHEMA,
  extractExperienceHints,
  type ManifestView,
} from '@riff/compiler';

export const SHIELD_WALL =
  'Shield Wall: when 5 different viewers type !shield within 10 seconds, the shield goes up.';
export const CASTLE_SIEGE =
  'Castle Siege: viewers join Red with !red or Blue with !blue. Each !attack deals 10 damage to the other castle; castles have 100 health and !heal restores 5 health. A castle at 0 health is eliminated.';
export const TOMATO_MATCH =
  'Tomato Battle best of 3: viewers join Red with !red or Blue with !blue, then use !throw to throw tomatoes. Give each participant 3 throws for a 60 second round with a 5 second break between rounds.';
export const GARDEN =
  'Community Garden: everyone uses !grow to contribute, with 5 contributions per participant in a 120 second round. Work together toward a collective goal of 40 points. At 10 points unlock !bloom worth 3 points.';

const manifestOf = (intent: string) =>
  compileOffline({ intent, base: null }).manifest as ManifestView;

describe('offline version 2 mechanics templates', () => {
  it('Shield Wall: a distinct-viewer burst objective, not a round duration', () => {
    const hints = extractExperienceHints(SHIELD_WALL);
    expect(hints.mechanics.burst).toMatchObject({
      participants: 5,
      windowMs: 10_000,
      command: '!shield',
    });
    expect(hints.durationMs).toBeNull();
    const out = compileOffline({ intent: SHIELD_WALL, base: null });
    expect(out.kind).toBe('candidate');
    expect(out.manifest).toMatchObject({
      trigger: { command: '!shield' },
      experience: {
        version: 2,
        teams: [],
        contribution: { command: '!shield' },
        objective: { kind: 'burst', target: 1 },
        mechanics: {
          burst: { command: null, participants: 5, windowMs: 10_000, limit: 1 },
          health: null,
          match: null,
          milestones: [],
        },
      },
    });
    expect(out.tests.map((t) => (t as { name: string }).name)).toContain(
      'Shield needs 5 different viewers',
    );
  });
  it('Castle Siege: team health pools with damage, healing and elimination', () => {
    const m = manifestOf(CASTLE_SIEGE);
    expect(m.trigger.command).toBe('!attack');
    expect(m.experience).toMatchObject({
      version: 2,
      objective: { kind: 'highest-score', target: null },
      mechanics: { health: { max: 100, damage: 10, heal: { command: '!heal', amount: 5 } } },
    });
  });
  it('Tomato Match: best-of-N rounds keep the round duration separate from the break', () => {
    const m = manifestOf(TOMATO_MATCH);
    expect(m.experience).toMatchObject({
      version: 2,
      durationMs: 60_000,
      resource: { perParticipant: 3 },
      mechanics: { match: { rounds: 3, intermissionMs: 5000 } },
    });
  });
  it('Community Garden: a score milestone unlocks a new command and effect tier', () => {
    const out = compileOffline({ intent: GARDEN, base: null });
    expect(out.manifest).toMatchObject({
      experience: {
        version: 2,
        objective: { kind: 'collective-goal', target: 40 },
        mechanics: {
          milestones: [{ id: 'tier-1', score: 10, unlock: { command: '!bloom', points: 3 } }],
        },
      },
    });
    expect(out.source).toContain('unlocked.length');
  });
  it('keeps unparseable or out-of-scope mechanics unsupported instead of reducing them', () => {
    for (const intent of [
      'Use !tomato and add health and damage to every throw.',
      'Battle with Red using !red and Blue using !blue; !throw scores and each team has 50 health but no damage rule; also add lives and respawns.',
      'Shield Wall: when 80 different viewers type !shield within 10 seconds the shield rises.',
    ])
      expect(compileOffline({ intent, base: null }).kind, intent).toBe('unsupported');
  });
  it('version 1 outputs keep their exact canonical shape (no mechanics key)', () => {
    const battle = compileOffline({
      intent:
        'Tomato Battle: viewers join Red with !red or Blue with !blue, then use !throw to throw tomatoes. Give each participant 3 throws for a 120 second round; the team with the highest score wins.',
      base: null,
    });
    expect((battle.manifest as ManifestView).experience).not.toHaveProperty('mechanics');
    expect((battle.manifest as ManifestView).experience?.version).toBe(1);
  });
  it('flags a candidate that silently drops a stated mechanic', () => {
    const honest = compileOffline({ intent: CASTLE_SIEGE, base: null });
    const manifest = structuredClone(honest.manifest) as ManifestView;
    manifest.experience!.mechanics!.health = null;
    const checks = checkIntent(CASTLE_SIEGE, { source: honest.source ?? '', manifest });
    expect(checks.find((c) => c.aspect === 'mechanics')?.status).toBe('mismatch');
    expect(
      checkIntent(CASTLE_SIEGE, {
        source: honest.source ?? '',
        manifest: honest.manifest as ManifestView,
      }).filter((c) => c.status === 'mismatch'),
    ).toEqual([]);
  });
});

describe('strict model contract for mechanics', () => {
  it('requires a nullable mechanics block and normalizes null away for version 1', () => {
    const experience = (
      COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1].properties as Record<string, unknown>
    ).experience as {
      anyOf: [unknown, { required: string[]; properties: Record<string, unknown> }];
    };
    expect(experience.anyOf[1].required).toContain('mechanics');
    const mechanics = experience.anyOf[1].properties.mechanics as {
      anyOf: [{ type: string }, { required: string[]; additionalProperties: boolean }];
    };
    expect(mechanics.anyOf[0].type).toBe('null');
    expect(mechanics.anyOf[1]).toMatchObject({
      additionalProperties: false,
      required: ['match', 'health', 'burst', 'milestones'],
    });
    const raw = compileOffline({ intent: SHIELD_WALL, base: null });
    const v1 = structuredClone(raw) as { manifest: { experience: Record<string, unknown> } };
    v1.manifest.experience.mechanics = null;
    v1.manifest.experience.version = 1;
    const parsed = compileOutputSchema.parse(v1);
    expect((parsed.manifest as ManifestView).experience).not.toHaveProperty('mechanics');
  });
  it('documents the new primitives precisely in the prompt rules', () => {
    const prompt = buildPrompt({ intent: SHIELD_WALL, base: null });
    expect(prompt).toContain('version 2');
    expect(prompt).toMatch(/BURST_COUNTED/);
    expect(prompt).toMatch(/ELIMINATED/);
    expect(prompt).toMatch(/ROUND_INTERMISSION/);
    expect(prompt).toMatch(/LOCKED/);
    expect(prompt).not.toMatch(/Arbitrary health, elimination, inventories, unlocks, rounds/);
    expect(prompt).toContain('- "Shield Wall: when 5 different viewers');
    const files = buildWorkspace({ intent: SHIELD_WALL, base: null });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['examples/shield-wall.json', 'examples/castle-siege.json']),
    );
  });
});
