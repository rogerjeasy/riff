import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  buildWorkspace,
  checkIntent,
  compileOffline,
  compileOutputSchema,
  COMPILE_OUTPUT_JSON_SCHEMA,
  PROMPT_VERSION,
  type ManifestView,
} from '@riff/compiler';

export const MURAL = 'Let chat paint a 8x8 pixel mural with !paint';
export const SONG = 'Let chat compose a song in three stages: tempo, instrument, mood';
export const QUIZ = 'Run a 3-question quiz about the solar system with !a !b !c';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/stateful-formats.json', import.meta.url), 'utf8'),
) as {
  provenance: { transport: string; model: string | null; promptVersion: string };
  records: { intent: string; output: unknown }[];
};
const experienceOf = (intent: string) =>
  (compileOffline({ intent, base: null }).manifest as ManifestView).experience;

describe('offline version 3 format templates', () => {
  it('audience mural: bounded grid, palette and per-viewer paints', () => {
    expect(experienceOf(MURAL)).toMatchObject({
      version: 3,
      teams: [],
      contribution: { command: '!paint' },
      objective: { kind: 'highest-score', target: null },
      format: { kind: 'mural', width: 8, height: 8, overwrite: true, reveal: 'live' },
    });
  });
  it('staged composition: one stage per named step with built-in option sets', () => {
    const d = experienceOf(SONG);
    expect(d).toMatchObject({
      version: 3,
      resource: { perParticipant: 3 },
      contribution: { command: '!vote' },
      format: { kind: 'composition', tieBreak: 'first-listed' },
    });
    expect(d?.format?.kind === 'composition' && d.format.stages.map((s) => s.id)).toEqual([
      'tempo',
      'instrument',
      'mood',
    ]);
  });
  it('group challenge: three questions answered with !a !b !c, collective pass mark', () => {
    const d = experienceOf(QUIZ);
    expect(d).toMatchObject({
      version: 3,
      contribution: { command: '!a' },
      resource: { perParticipant: 3 },
      format: { kind: 'quiz', passPercent: 60, revealMs: 10_000 },
    });
    if (d?.format?.kind !== 'quiz') throw new Error('expected a quiz');
    for (const q of d.format.questions) {
      expect(q.options).toHaveLength(3);
      expect(q.answer).toBeLessThan(3);
    }
  });
  it('refuses what it cannot build faithfully instead of reducing it', () => {
    for (const intent of [
      'Run a 3-question quiz about medieval history with !a !b',
      'Let chat compose a song in three stages: tempo, lyrics, mood',
      'Let chat compose a song in two stages: tempo, instrument, mood',
      'Let chat paint a 40x40 pixel mural with !paint',
      'Run a 7-question quiz about the solar system',
    ])
      expect(compileOffline({ intent, base: null }).kind, intent).toBe('unsupported');
  });
  it('states every intent fact it honours (no mismatches) and flags a dropped format', () => {
    for (const intent of [MURAL, SONG, QUIZ]) {
      const out = compileOffline({ intent, base: null });
      expect(
        checkIntent(intent, {
          source: out.source ?? '',
          manifest: out.manifest as ManifestView,
        }).filter((c) => c.status === 'mismatch'),
        intent,
      ).toEqual([]);
    }
    const out = compileOffline({ intent: QUIZ, base: null });
    const manifest = structuredClone(out.manifest) as ManifestView;
    delete manifest.experience!.format;
    expect(
      checkIntent(QUIZ, { source: out.source ?? '', manifest }).find(
        (c) => c.label === 'Activity format',
      )?.status,
    ).toBe('mismatch');
  });
});

describe('per-slot durations in staged formats', () => {
  it('reads "each question lasts 40 seconds" as one slot, not the whole round (production regression)', () => {
    // Recorded from a real Codex compile on production (2026-11-02): 3 questions x 40 s = 2 min
    // was correct, but the intent check compared 40 s with the 2 min round and rejected it.
    const intent =
      'Run a 3-question quiz about the solar system: viewers answer with !a, !b or !c, each question lasts 40 seconds.';
    const out = compileOffline({ intent: QUIZ, base: null });
    const manifest = structuredClone(out.manifest) as ManifestView;
    const experience = manifest.experience as unknown as {
      durationMs: number;
      format: { questions: unknown[] };
    };
    const slots = experience.format.questions.length;
    experience.durationMs = 40_000 * slots;
    const duration = () =>
      checkIntent(intent.replace('3-question', `${slots}-question`), {
        source: out.source ?? '',
        manifest,
      }).find((c) => c.aspect === 'duration');
    expect(duration()?.status).toBe('match');
    expect(duration()?.stated).toContain('per question');
    // A round that ignores the stated per-question length is still a mismatch.
    experience.durationMs = 40_000;
    expect(duration()?.status).toBe('mismatch');
  });
});

describe('strict model contract for formats', () => {
  it('requires a nullable format and normalizes null away for older versions', () => {
    const experience = (
      COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1].properties as Record<string, unknown>
    ).experience as {
      anyOf: [unknown, { required: string[]; properties: Record<string, { enum?: number[] }> }];
    };
    expect(experience.anyOf[1].required).toContain('format');
    expect(experience.anyOf[1].properties.version?.enum).toEqual([1, 2, 3]);
    const raw = structuredClone(compileOffline({ intent: QUIZ, base: null })) as {
      manifest: { experience: Record<string, unknown> };
    };
    raw.manifest.experience.mechanics = null;
    const v3 = compileOutputSchema.parse(raw);
    expect((v3.manifest as ManifestView).experience).not.toHaveProperty('mechanics');
    expect((v3.manifest as ManifestView).experience?.format?.kind).toBe('quiz');
    const v1 = structuredClone(raw);
    v1.manifest.experience.format = null;
    expect((compileOutputSchema.parse(v1).manifest as ManifestView).experience).not.toHaveProperty(
      'format',
    );
  });
  it('documents the formats precisely in the prompt rules and curated examples', () => {
    expect(PROMPT_VERSION).toBe('riff-compiler/13');
    const prompt = buildPrompt({ intent: MURAL, base: null });
    for (const text of [
      'Version 3 formats',
      'INVALID_CHOICE',
      'ALREADY_CHOSEN',
      'CELL_TAKEN',
      'ANSWER_CLOSED',
      "tieBreak:'first-listed'",
      'no sound is played',
      'There is no\n    per-viewer ranking',
    ])
      expect(prompt).toContain(text);
    const files = buildWorkspace({ intent: MURAL, base: null });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'examples/pixel-mural.json',
        'examples/song-stages.json',
        'examples/solar-quiz.json',
      ]),
    );
  });
  it('the recorded fixture replays byte for byte with truthful provenance', () => {
    expect(fixture.provenance).toMatchObject({
      transport: 'offline',
      model: null,
      promptVersion: PROMPT_VERSION,
    });
    expect(fixture.records.map((r) => r.intent)).toEqual([MURAL, SONG, QUIZ]);
    for (const record of fixture.records)
      expect(compileOutputSchema.parse(record.output)).toEqual(
        compileOffline({ intent: record.intent, base: null }),
      );
  });
});
