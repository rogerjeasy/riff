import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  checkIntent,
  compileOffline,
  compileOutputSchema,
  compileRequestSchema,
  PROMPT_VERSION,
  type ManifestView,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/twitch-actions.json', import.meta.url), 'utf8'),
) as {
  provenance: { promptVersion: string; model: null };
  cases: { request: unknown; output: unknown }[];
};

describe('native Twitch actions in the compiler', () => {
  it('no longer tells the model polls, announcements or shoutouts are unsupported', () => {
    const prompt = buildPrompt({ intent: 'Start a poll with !poll please', base: null });
    expect(prompt).toContain('riff.polls.start');
    expect(prompt).toContain('riff.chat.announce');
    expect(prompt).toContain('riff.shoutout.send');
    expect(prompt).not.toMatch(/\(sending chat messages,\s+sounds, polls/);
    expect(prompt).toContain('capability `polls`');
  });

  it('replays the recorded offline fixture byte for byte', () => {
    expect(fixture.provenance).toMatchObject({ promptVersion: PROMPT_VERSION, model: null });
    expect(fixture.cases).toHaveLength(3);
    for (const recorded of fixture.cases) {
      const request = compileRequestSchema.parse(recorded.request);
      const output = compileOutputSchema.parse(compileOffline(request));
      expect(output).toEqual(recorded.output);
      expect(output.kind).toBe('candidate');
      const checks = checkIntent(request.intent, {
        source: output.source ?? '',
        manifest: output.manifest as ManifestView,
      });
      expect(checks.filter((check) => check.status === 'mismatch')).toEqual([]);
    }
  });

  it('compiles an owner-only Twitch poll with the stated question, choices and duration', () => {
    const output = compileOffline({
      intent:
        'When I type !nextgame, start a Twitch poll "What should we play next?" with choices "Speedrun" and "Hardcore" for 2 minutes.',
      base: null,
    });
    expect(output.manifest).toMatchObject({
      capabilities: ['polls'],
      trigger: {
        command: '!nextgame',
        audience: ['broadcaster'],
        maxPerViewer: 1,
        windowMs: 120_000,
      },
    });
    expect(output.source).toContain('durationSeconds: 120');
    expect(output.source).toContain('["Speedrun","Hardcore"]');
  });

  it('parses unquoted choices and asks when they are missing', () => {
    const output = compileOffline({
      intent: 'Let my mods use !vote to run a poll "Pizza or tacos?" between pizza and tacos',
      base: null,
    });
    expect(output.kind).toBe('candidate');
    expect(output.source).toContain('["pizza","tacos"]');
    expect((output.manifest as ManifestView).trigger.audience).toEqual([
      'broadcaster',
      'moderator',
    ]);
    expect(compileOffline({ intent: 'Start a poll with !poll', base: null }).kind).toBe('question');
  });

  it('asks instead of granting polls or shoutouts to everyone', () => {
    const output = compileOffline({
      intent: 'Let everyone start a poll "Best snack?" with "chips" or "fruit" using !poll',
      base: null,
    });
    expect(output.kind).toBe('question');
    expect(output.choices).toEqual(['Only me (the broadcaster)', 'Me and my moderators']);
  });

  it('refuses poll text that Twitch would reject instead of truncating it', () => {
    const output = compileOffline({
      intent: `Start a poll with !poll "${'x'.repeat(61)}" with "a" and "b"`,
      base: null,
    });
    expect(output.kind).toBe('unsupported');
  });

  it('compiles an announcement that quotes the creator exactly', () => {
    const output = compileOffline({
      intent: 'When anyone types !hype, announce "Hype train incoming!" in chat in purple.',
      base: null,
    });
    expect(output.manifest).toMatchObject({ capabilities: ['chat.announce'] });
    expect(output.source).toContain(`message: "Hype train incoming!", color: 'purple'`);
  });

  it('compiles a fixed-target shoutout and names the approval requirement', () => {
    const output = compileOffline({ intent: 'When I type !so, shout out @TwitchDev.', base: null });
    expect(output.source).toContain('login: "twitchdev"');
    expect(output.assumptions.join(' ')).toContain('approved shoutout list');
    expect(compileOffline({ intent: 'Shout out whoever with !so', base: null }).kind).toBe(
      'question',
    );
  });

  it('keeps predictions unsupported and refuses offline edits of native interactions', () => {
    expect(compileOffline({ intent: 'Start a prediction with !bet', base: null }).kind).toBe(
      'unsupported',
    );
    const poll = compileOffline({
      intent: 'When I type !nextgame, start a poll "Next?" with "A" and "B"',
      base: null,
    });
    const edit = compileOffline({
      intent: 'Change the command to !vote',
      base: {
        title: poll.title,
        intent: 'x',
        source: poll.source ?? '',
        manifest: poll.manifest,
        tests: poll.tests,
      },
    });
    expect(edit.kind).toBe('unsupported');
  });
});
