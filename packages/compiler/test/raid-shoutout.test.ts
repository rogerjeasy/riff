import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  checkIntent,
  compileOffline,
  compileOutputSchema,
  PROMPT_VERSION,
  type CompileRequest,
  type ManifestView,
} from '@riff/compiler';

const WELCOME = 'When we get raided, shout out the raider and show a welcome burst';

describe('F23 raider shoutout offline compiler', () => {
  it('compiles the raid welcome deterministically with a host-bound raider shoutout', () => {
    const output = compileOffline({ intent: WELCOME, base: null });
    expect(compileOffline({ intent: WELCOME, base: null })).toEqual(output);
    expect(output.kind).toBe('candidate');
    expect(output.manifest).toMatchObject({
      capabilities: ['overlay', 'shoutout'],
      trigger: {
        kind: 'twitch.event',
        command: '@raid',
        audience: ['viewer'],
        event: { kind: 'raid', minimum: 1 },
      },
      limits: { effectsPerEvent: 6 },
    });
    expect(output.source).toContain('await riff.shoutout.raider();');
    expect(output.source).not.toContain('shoutout.send');
    expect(output.assumptions.join(' ')).toMatch(/Shout out raiders automatically/);
    const checks = checkIntent(WELCOME, {
      source: output.source ?? '',
      manifest: output.manifest as ManifestView,
    });
    expect(checks.filter((c) => c.status === 'mismatch')).toEqual([]);
  });

  it('keeps a stated minimum raid size', () => {
    const output = compileOffline({
      intent: 'When a raid of 20+ viewers arrives, shout out the raider',
      base: null,
    });
    expect(output.manifest).toMatchObject({ trigger: { event: { kind: 'raid', minimum: 20 } } });
  });

  it.each([
    'When someone cheers 100 bits, shout them out',
    'When someone gifts 5 subs, give them a shoutout',
  ])('refuses automatic shoutouts for non-raid events: %s', (intent) => {
    const output = compileOffline({ intent, base: null });
    expect(output.kind).toBe('unsupported');
    expect(output.unsupportedReason).toMatch(/only when it raids you/);
  });

  it('documents the rule in TASK_RULES and the unsupported list', () => {
    const prompt = buildPrompt({ intent: WELCOME, base: null });
    expect(prompt).toContain('Raider shoutouts (host-owned rule)');
    expect(prompt).toContain('automatic shoutouts on any event\nother than an incoming raid');
    expect(prompt).toContain('riff.shoutout.raider()');
  });

  it('replays the recorded raid-shoutout outputs for the current prompt pack', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/raid-shoutout.json', import.meta.url), 'utf8'),
    ) as {
      provenance: { transport: string; model: string | null; promptVersion: string };
      records: { request: CompileRequest; output: unknown }[];
    };
    expect(fixture.provenance).toMatchObject({
      transport: 'offline',
      model: null,
      promptVersion: PROMPT_VERSION,
    });
    expect(fixture.records).toHaveLength(3);
    for (const record of fixture.records)
      expect(compileOutputSchema.parse(record.output)).toEqual(compileOffline(record.request));
  });
});
