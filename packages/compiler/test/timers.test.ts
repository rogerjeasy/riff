import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  checkIntent,
  COMPILE_OUTPUT_JSON_SCHEMA,
  compileOffline,
  compileOutputSchema,
  type CompileRequest,
  type ManifestView,
} from '@riff/compiler';
import { extractTimerHint } from '../src/timer-hints.js';

const HYDRATION = 'Every 10 minutes show a hydration reminder on the overlay.';
const COUNTDOWN = 'After !start, show a countdown and celebrate in 60 seconds.';

describe('timer intent extraction', () => {
  it.each([
    [HYDRATION, { repeat: true, ms: 600_000 }],
    [COUNTDOWN, { repeat: false, ms: 60_000 }],
    ['Show stars every minute after !go', { repeat: true, ms: 60_000 }],
    ['When a mod types !break, show hearts in five minutes', { repeat: false, ms: 300_000 }],
  ])('reads explicit timer phrasing: %s', (intent, hint) => {
    expect(extractTimerHint(intent)).toEqual(hint);
  });
  it.each([
    'Subscribers can type !love to send a burst of three hearts, once every 30 seconds.',
    'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.',
    'Viewers may throw 3 tomatoes in 60 seconds with !tomato',
    'Allow 2 per viewer every 30 seconds with !splat',
  ])('never mistakes a rolling allowance for a timer: %s', (intent) => {
    expect(extractTimerHint(intent)).toBeNull();
  });
});

describe('offline named timers', () => {
  it.each([HYDRATION, COUNTDOWN])('compiles a verified-shape timer candidate: %s', (intent) => {
    const output = compileOffline({ intent, base: null });
    expect(compileOutputSchema.safeParse(output).success).toBe(true);
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      sdkVersion: '0.4.0',
      experience: null,
      capabilities: ['overlay', 'timer'],
    });
    expect(output.source).toContain("event.source === 'timer.fired'");
    expect(output.source).not.toMatch(/setTimeout|setInterval/);
    const checks = checkIntent(intent, {
      source: output.source ?? '',
      manifest: output.manifest as ManifestView,
    });
    expect(checks.find((check) => check.aspect === 'timer')?.status).toBe('match');
    expect(checks.filter((check) => check.status === 'mismatch')).toEqual([]);
    expect(output.tests.some((t) => JSON.stringify(t).includes('"fired":1'))).toBe(true);
  });
  it('repeats the hydration reminder and fires the celebration once', () => {
    expect(compileOffline({ intent: HYDRATION, base: null }).source).toContain(
      "riff.timer.start('hydration', 600000, { repeat: true })",
    );
    const countdown = compileOffline({ intent: COUNTDOWN, base: null });
    expect(countdown.source).toContain("riff.timer.start('celebrate', 60000)");
    expect((countdown.manifest as ManifestView).trigger.command).toBe('!start');
    expect(countdown.assumptions.join(' ')).toMatch(/countdown is shown in your console/i);
  });
  it('flags a candidate whose timer interval differs from the request', () => {
    const output = compileOffline({ intent: COUNTDOWN, base: null });
    const wrong = checkIntent(COUNTDOWN, {
      source: (output.source ?? '').replace('60000', '30000'),
      manifest: output.manifest as ManifestView,
    });
    expect(wrong.find((check) => check.aspect === 'timer')?.status).toBe('mismatch');
  });
  it('rejects out-of-range intervals and unparseable timer requests honestly', () => {
    expect(
      compileOffline({ intent: 'Every 2 seconds show a star with !spam', base: null }).kind,
    ).toBe('unsupported');
    expect(
      compileOffline({ intent: 'Every 3 hours show a star with !long', base: null }).kind,
    ).toBe('unsupported');
    expect(compileOffline({ intent: 'Add a timer to !tomato', base: null }).kind).toBe(
      'unsupported',
    );
  });
});

describe('timer prompt pack', () => {
  it('no longer lists general timers as unsupported and documents the timer contract', () => {
    const prompt = buildPrompt({ intent: COUNTDOWN, base: null });
    expect(prompt).not.toContain('general timers');
    expect(prompt).toContain('riff.timer.start');
    expect(prompt).toContain("event.source === 'timer.fired'");
  });
  it('lets strict model output declare timer and assert timer fires', () => {
    const manifest = COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1];
    expect(manifest.properties.capabilities.items.enum).toContain('timer');
    const step = COMPILE_OUTPUT_JSON_SCHEMA.properties.tests.items.properties.steps.items;
    expect(step.required).toContain('timers');
  });
  it('replays the recorded offline timer responses through the compiler contract', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/named-timers.json', import.meta.url), 'utf8'),
    ) as {
      provenance: { transport: string; model: string | null; promptVersion: string };
      records: { intent: string; output: unknown }[];
    };
    expect(fixture.provenance).toMatchObject({
      transport: 'offline',
      model: null,
      promptVersion: 'riff-compiler/7',
    });
    expect(fixture.records.map((record) => record.intent)).toEqual([HYDRATION, COUNTDOWN]);
    for (const record of fixture.records) {
      const request: CompileRequest = { intent: record.intent, base: null };
      expect(compileOutputSchema.parse(record.output)).toEqual(compileOffline(request));
    }
  });
});
