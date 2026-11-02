import { describe, expect, it } from 'vitest';
import type { PermissionManifest, Scenario } from '@riff/sdk';
import { verifyCandidate } from '@riff/sandbox';

// Recorded from a real Codex compile on production (2026-11-02): the handler and its
// tests were correct, but timer fires counted overlay effects only, so the generated
// timer assertions (3 hearts + 1 announcement = 4) failed verification.
const artifact = {
  source: `async (event, riff) => {
  if (event.source === 'timer.fired') {
    if (event.name !== 'hydration') return;
  } else {
    await riff.timer.start('hydration', 300000, { repeat: true });
  }
  for (let i = 0; i < 3; i++) {
    await riff.overlay.emit({ kind: 'projectile', asset: 'heart', x: 0.3 + i * 0.2 });
  }
  await riff.chat.announce({ message: 'Hydration check, grab some water!' });
}`,
  manifest: {
    sdkVersion: '0.4.0',
    experience: null,
    capabilities: ['overlay', 'timer', 'chat.announce'],
    trigger: {
      command: '!hydrate',
      audience: ['broadcaster', 'moderator'],
      maxPerViewer: 1,
      windowMs: 60000,
      kind: 'chat.command',
      reward: null,
      event: null,
    },
    limits: { effectsPerEvent: 4, effectsPerMinute: 12 },
  } as PermissionManifest,
};

describe('timer fires count native actions like chat events do', () => {
  it('counts a staged announcement in the timer effects of a scenario step', async () => {
    const scenario: Scenario = {
      name: 'Immediate reminder and repeating timer',
      kind: 'happy',
      steps: [
        {
          id: 'h1',
          viewer: 'creator',
          roles: ['viewer', 'broadcaster'],
          text: '!hydrate',
          at: 0,
          expect: 'ACCEPTED',
          effects: 4,
          timers: null,
          kind: null,
          twitch: null,
          session: null,
        },
        {
          id: 'h2',
          viewer: 'alice',
          roles: ['viewer'],
          text: 'hello',
          at: 300000,
          expect: 'UNRELATED',
          effects: 0,
          timers: { fired: 1, effects: 4 },
          kind: null,
          twitch: null,
          session: null,
        },
      ],
    } as Scenario;
    const negative: Scenario = {
      name: 'Unrelated chat does nothing',
      kind: 'negative',
      steps: [
        {
          id: 'n1',
          viewer: 'alice',
          roles: ['viewer'],
          text: 'hello',
          at: 0,
          expect: 'UNRELATED',
          effects: 0,
          timers: null,
          kind: null,
          twitch: null,
          session: null,
        },
      ],
    } as Scenario;
    const role: Scenario = {
      name: 'Viewers cannot start it',
      kind: 'role',
      steps: [
        {
          id: 'r1',
          viewer: 'alice',
          roles: ['viewer'],
          text: '!hydrate',
          at: 0,
          expect: 'AUDIENCE',
          effects: 0,
          timers: null,
          kind: null,
          twitch: null,
          session: null,
        },
      ],
    } as Scenario;
    const report = await verifyCandidate({ ...artifact, tests: [scenario, negative, role] });
    const [result] = report.generated;
    if (!result) throw new Error(JSON.stringify(report.stages));
    expect(
      result?.steps.map((step) => [step.actual, step.actualEffects, step.timers, step.passed]),
    ).toEqual([
      ['ACCEPTED', 4, undefined, true],
      ['UNRELATED', 0, { fired: 1, effects: 4 }, true],
    ]);
  });
});
