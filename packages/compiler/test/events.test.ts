import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  checkIntent,
  compileOffline,
  compileOutputSchema,
  COMPILE_OUTPUT_JSON_SCHEMA,
  extractEventHints,
  PROMPT_VERSION,
  type CompileRequest,
  type ManifestView,
} from '@riff/compiler';

const CONFETTI = 'When someone cheers 100+ bits, rain confetti';
const RAID = 'When we get raided, show a welcome banner';

describe('F19 event intent extraction', () => {
  it.each([
    [CONFETTI, { kind: 'cheer', minimum: 100 }],
    ['If anyone cheers at least 1,000 bits send hearts', { kind: 'cheer', minimum: 1000 }],
    [RAID, { kind: 'raid', minimum: null }],
    ['When a raid of 20+ viewers arrives, burst stars', { kind: 'raid', minimum: 20 }],
    ['When someone gifts 5 or more subs, throw hearts', { kind: 'gift', minimum: 5 }],
    ['Celebrate every resub of 12+ months with stars', { kind: 'resub', minimum: 12 }],
    ['When someone subscribes, send three hearts', { kind: 'subscribe', minimum: null }],
  ])('reads %j', (intent, expected) => {
    expect(extractEventHints(intent)).toEqual(expected);
  });

  it('keeps chat commands and audience phrasing as chat interactions', () => {
    expect(extractEventHints('Subscribers can type !love to send hearts')).toBeNull();
    expect(extractEventHints('Let viewers throw tomatoes with !tomato')).toBeNull();
    expect(
      compileOffline({ intent: 'Subscribers can type !love to send hearts', base: null }),
    ).toMatchObject({ kind: 'candidate', manifest: { trigger: { command: '!love' } } });
  });
});

describe('F19 offline compiler', () => {
  it('compiles "cheers 100+ bits, rain confetti" deterministically with stated stand-ins', () => {
    const output = compileOutputSchema.parse(compileOffline({ intent: CONFETTI, base: null }));
    expect(output).toEqual(compileOffline({ intent: CONFETTI, base: null }));
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      sdkVersion: '0.4.0',
      experience: null,
      capabilities: ['overlay'],
      trigger: { command: '@cheer', audience: ['viewer'], event: { kind: 'cheer', minimum: 100 } },
    });
    expect(output.source).toContain('event.twitch.amount');
    expect(output.assumptions.join(' ')).toMatch(/no confetti effect/);
    expect(output.behavior.when).toBe('Someone cheers 100+ bits');
    const kinds = output.tests.map((test) => (test as { kind: string }).kind);
    expect(kinds).toEqual(expect.arrayContaining(['happy', 'limit', 'negative', 'duplicate']));
    const steps = output.tests.flatMap((test) => (test as { steps: { expect: string }[] }).steps);
    expect(steps.some((step) => step.expect === 'BELOW_MINIMUM')).toBe(true);
  });

  it('compiles "we get raided, show a welcome banner" honestly as a projectile welcome', () => {
    const output = compileOffline({ intent: RAID, base: null });
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      trigger: { command: '@raid', event: { kind: 'raid', minimum: 1 } },
    });
    expect(output.assumptions.join(' ')).toMatch(/cannot draw text banners/);
    expect(output.title).toBe('Raid Welcome');
  });

  it('agrees with the explicit intent facts, including the Twitch event row', () => {
    for (const intent of [CONFETTI, RAID, 'When someone gifts 5 or more subs, throw hearts']) {
      const output = compileOffline({ intent, base: null });
      const checks = checkIntent(intent, {
        source: output.source ?? '',
        manifest: output.manifest as ManifestView,
      });
      expect(checks.filter((check) => check.status === 'mismatch')).toEqual([]);
      expect(checks.find((check) => check.aspect === 'event')?.status).toBe('match');
    }
    const cheer = compileOffline({ intent: CONFETTI, base: null });
    const wrong = structuredClone(cheer.manifest) as ManifestView;
    wrong.trigger.event = { kind: 'cheer', minimum: 500 };
    expect(
      checkIntent(CONFETTI, { source: cheer.source ?? '', manifest: wrong }).find(
        (check) => check.aspect === 'event',
      )?.status,
    ).toBe('mismatch');
  });

  it('preserves the event trigger on an edit that does not mention it', () => {
    const first = compileOffline({ intent: CONFETTI, base: null });
    const edited = compileOffline({
      intent: 'Make it hearts instead please',
      base: {
        title: first.title,
        intent: CONFETTI,
        source: first.source ?? '',
        manifest: first.manifest,
        tests: first.tests,
      },
    });
    expect(edited.manifest).toMatchObject({
      trigger: { event: { kind: 'cheer', minimum: 100 } },
    });
    expect(edited.source).toContain("'heart'");
  });
});

describe('F19 compiler contract and prompt', () => {
  it('requires the nullable event trigger and twitch step in strict model output', () => {
    const manifest = COMPILE_OUTPUT_JSON_SCHEMA.properties.manifest.anyOf[1];
    expect(manifest.properties.trigger.required).toContain('event');
    const step = COMPILE_OUTPUT_JSON_SCHEMA.properties.tests.items.properties.steps.items;
    expect(step.required).toContain('twitch');
    expect(step.properties.twitch.anyOf[1].required).toEqual([
      'kind',
      'amount',
      'tier',
      'anonymous',
      'gift',
    ]);
  });

  it('no longer tells the compiler that subs, cheers and raids are unsupported', () => {
    const prompt = buildPrompt({ intent: CONFETTI, base: null });
    expect(prompt).toContain('cheers (bits) and incoming raids ARE supported');
    expect(prompt).toContain('## Twitch event triggers');
    expect(prompt).toContain('When someone cheers 100+ bits, rain stars');
  });

  it('replays the recorded F19 offline outputs for the current prompt pack', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/event-triggers.json', import.meta.url), 'utf8'),
    ) as {
      provenance: { transport: string; model: string | null; promptVersion: string };
      records: { request: CompileRequest; output: unknown }[];
    };
    expect(fixture.provenance).toMatchObject({
      transport: 'offline',
      model: null,
      promptVersion: PROMPT_VERSION,
    });
    expect(fixture.records.length).toBeGreaterThanOrEqual(2);
    for (const record of fixture.records)
      expect(compileOutputSchema.parse(record.output)).toEqual(compileOffline(record.request));
  });
});
