import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  checkIntent,
  compileOffline,
  compileOutputSchema,
  COMPILE_OUTPUT_JSON_SCHEMA,
  PROMPT_VERSION,
  type CompileRequest,
  type ManifestView,
} from '@riff/compiler';

const HYDRATE = "When someone redeems 'Hydrate', show a water splash.";
const PREDICT =
  "When I type !predict, propose a prediction 'Will we beat the boss?' with 'Yes' and 'No' for 90 seconds.";

describe('Channel Points and Predictions compiler contract', () => {
  it('lets the strict model schema express redemption triggers and redemption steps', () => {
    const manifest = COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1];
    const trigger = manifest.properties.trigger;
    expect(trigger.required).toEqual(expect.arrayContaining(['kind', 'reward']));
    expect(trigger.properties.kind.enum).toEqual(['chat.command', 'points.redeem']);
    expect(manifest.properties.capabilities.items.enum).toContain('predictions');
    const step = COMPILE_OUTPUT_JSON_SCHEMA.properties.tests.items.properties.steps.items;
    expect(step.required).toContain('kind');
  });

  it('teaches the prompt that predictions are proposals and settlement is creator-only', () => {
    const prompt = buildPrompt({ intent: HYDRATE, base: null });
    expect(prompt).toContain('points.redeem');
    expect(prompt).toContain('riff.predictions.propose');
    expect(prompt).toMatch(/creator opens it and alone/);
    expect(PROMPT_VERSION).toBe('riff-compiler/10');
  });

  it('compiles the hydrate redemption intent offline into a points.redeem candidate', () => {
    const output = compileOffline({ intent: HYDRATE, base: null });
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      capabilities: ['overlay'],
      trigger: {
        kind: 'points.redeem',
        reward: 'Hydrate',
        command: '!hydrate',
        audience: ['viewer'],
      },
    });
    const tests = output.tests as { steps: { kind?: string | null }[] }[];
    expect(tests.some((t) => t.steps.some((s) => s.kind === 'points.redeem'))).toBe(true);
    expect(output.assumptions.join(' ')).toMatch(/no water effect/i);
    const checks = checkIntent(HYDRATE, {
      source: output.source ?? '',
      manifest: output.manifest as ManifestView,
    });
    expect(checks.find((c) => c.aspect === 'reward')).toMatchObject({
      stated: 'Hydrate',
      actual: 'Hydrate',
      status: 'match',
    });
    expect(checks.filter((c) => c.status === 'mismatch')).toEqual([]);
  });

  it('asks which reward when none is named', () => {
    expect(
      compileOffline({ intent: 'Show hearts when someone redeems channel points', base: null })
        .kind,
    ).toBe('question');
  });

  it('flags a manifest whose reward differs from the stated one', () => {
    const output = compileOffline({ intent: HYDRATE, base: null });
    const manifest = structuredClone(output.manifest) as ManifestView;
    manifest.trigger.reward = 'Stretch';
    expect(
      checkIntent(HYDRATE, { source: output.source ?? '', manifest }).find(
        (c) => c.aspect === 'reward',
      )?.status,
    ).toBe('mismatch');
  });

  it('compiles a prediction intent into a proposal with host-bounded fields', () => {
    const output = compileOffline({ intent: PREDICT, base: null });
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      capabilities: ['predictions'],
      trigger: { command: '!predict' },
    });
    expect(output.source).toContain('riff.predictions.propose');
    expect(output.source).toContain('Will we beat the boss?');
    expect(output.source).toContain('windowSeconds: 90');
    expect(output.source).not.toMatch(/resolve|winner/i);
    // The stated 90 seconds is the voting window, not a rolling allowance mismatch.
    expect(
      checkIntent(PREDICT, {
        source: output.source ?? '',
        manifest: output.manifest as ManifestView,
      }).filter((c) => c.status === 'mismatch'),
    ).toEqual([]);
  });

  it.each([
    'When chat types !win, resolve the prediction with the winning outcome',
    'Let !predict pick the winner of the prediction automatically',
  ])('refuses model- or chat-decided settlement: %s', (intent) => {
    const output = compileOffline({ intent, base: null });
    expect(output.kind).toBe('unsupported');
    expect(output.unsupportedReason).toMatch(/Only you/);
  });

  it('replays the recorded prompt-pack 7 outputs exactly', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/channel-points-predictions.json', import.meta.url), 'utf8'),
    ) as {
      provenance: { transport: string; model: null; promptVersion: string };
      records: { request: CompileRequest; output: unknown }[];
    };
    expect(fixture.provenance).toEqual({
      transport: 'offline',
      model: null,
      promptVersion: PROMPT_VERSION,
    });
    expect(fixture.records.map((r) => r.request.intent)).toEqual([HYDRATE, PREDICT]);
    for (const record of fixture.records)
      expect(compileOutputSchema.parse(record.output)).toEqual(compileOffline(record.request));
  });
});
