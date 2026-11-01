import {
  SDK_VERSION,
  TIMER_LIMITS,
  type AudienceRole,
  type ProjectileAsset,
  type Scenario,
} from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { describeAudience, describeTimer, describeWindow, extractIntentHints } from './intent.js';
import { extractTimerHint } from './timer-hints.js';

const empty = {
  question: null,
  choices: [],
  unsupportedReason: null,
  alternative: null,
  source: null,
  migrationSource: null,
  manifest: null,
  tests: [],
  behavior: { when: '', what: '', who: '', howMuch: '' },
  assumptions: [],
};

/** Deterministic named-timer templates for offline demos and CI. It is not Codex. */
export function compileTimerOffline(request: CompileRequest): CompileOutput | null {
  const timer = extractTimerHint(request.intent);
  if (!timer) return null;
  if (timer.ms < TIMER_LIMITS.durationMs.min || timer.ms > TIMER_LIMITS.durationMs.max)
    return {
      ...empty,
      kind: 'unsupported',
      title: 'Timer Out of Range',
      summary: 'Named timers run between 5 seconds and 1 hour.',
      unsupportedReason: `Riff timers last between ${describeWindow(TIMER_LIMITS.durationMs.min)} and ${describeWindow(TIMER_LIMITS.durationMs.max)}; ${describeWindow(timer.ms)} is outside that range.`,
      alternative: 'Choose an interval between 5 seconds and 1 hour.',
    };
  const hints = extractIntentHints(request.intent);
  const assumptions = ['Offline template compiler; no model call.'];
  const celebration = /\bcelebrat\w*/i.test(request.intent);
  const reminder = request.intent.match(/\b([a-z]{3,20})\s+reminder\b/i)?.[1]?.toLowerCase();
  const name = celebration ? 'celebrate' : (reminder ?? 'reminder');
  const command = hints.command ? `!${hints.command}` : `!${name}`;
  if (!hints.command)
    assumptions.push(`Timers start from chat: ${command} starts (or restarts) the ${name} timer.`);
  const audience: AudienceRole[] = hints.audience ?? ['broadcaster', 'moderator'];
  if (!hints.audience) assumptions.push('Only you and your moderators can start it.');
  const asset: ProjectileAsset = hints.asset ?? (celebration ? 'heart' : 'star');
  if (!hints.asset)
    assumptions.push(
      `Each fire shows three ${asset}s; text reminders are not available on the overlay.`,
    );
  if (/\bcountdown\b/i.test(request.intent))
    assumptions.push('The countdown is shown in your console timers list.');
  assumptions.push('Typing the command again restarts the timer from zero.');
  const maxPerViewer = hints.maxPerViewer ?? 3;
  const windowMs = hints.windowMs && hints.windowMs !== timer.ms ? hints.windowMs : 60_000;
  if (hints.maxPerViewer === null) assumptions.push('Up to three starts per person a minute.');
  const effectsPerEvent = 3;
  const effectsPerMinute = Math.min(
    120,
    Math.max(30, effectsPerEvent * Math.ceil(60_000 / timer.ms)),
  );
  const options = timer.repeat ? ', { repeat: true }' : '';
  const source = `async (event, riff) => {
  if (event.source === 'timer.fired') {
    for (let i = 0; i < 3; i++) await riff.overlay.emit({ kind: 'projectile', asset: '${asset}', x: 0.3 + i * 0.2 });
    return;
  }
  await riff.timer.start('${name}', ${timer.ms}${options});
}`;
  const roles: AudienceRole[] = audience.includes('viewer')
    ? ['viewer']
    : [audience[0] ?? 'broadcaster', 'viewer'];
  const s = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: Scenario['steps'][number]['expect'],
    timers: { fired: number; effects: number } | null = null,
    r = roles,
  ) => ({ id, viewer, roles: r, text, at, expect, effects: 0, timers, session: null });
  const half = Math.floor(timer.ms / 2);
  const tests: Scenario[] = [
    {
      name: `${command} schedules ${asset}s ${describeTimer(timer)}`,
      kind: 'happy',
      steps: [
        s('start', 'alice', command, 0, 'ACCEPTED'),
        s('before', 'bob', 'hello chat', timer.ms - 1, 'UNRELATED', { fired: 0, effects: 0 }),
        s('due', 'bob', 'hello chat', timer.ms, 'UNRELATED', { fired: 1, effects: 3 }),
        ...(timer.repeat
          ? [s('again', 'bob', 'hello chat', timer.ms * 2, 'UNRELATED', { fired: 1, effects: 3 })]
          : [
              s('once', 'bob', 'hello chat', timer.ms * 2, 'UNRELATED', {
                fired: 0,
                effects: 0,
              }),
            ]),
      ],
    },
    {
      name: 'Starting again restarts the countdown instead of adding a second timer',
      kind: 'happy',
      steps: [
        s('first', 'alice', command, 0, 'ACCEPTED'),
        s('restart', 'dana', command, half, 'ACCEPTED'),
        s('old-due', 'bob', 'hello chat', timer.ms, 'UNRELATED', { fired: 0, effects: 0 }),
        s('new-due', 'bob', 'hello chat', half + timer.ms, 'UNRELATED', { fired: 1, effects: 3 }),
      ],
    },
    {
      name: `Start ${maxPerViewer + 1} within the window is blocked`,
      kind: 'limit',
      steps: [
        ...Array.from({ length: maxPerViewer }, (_, i) =>
          s(`a${i}`, 'alice', command, i, 'ACCEPTED'),
        ),
        s('over', 'alice', command, maxPerViewer, 'VIEWER_LIMIT'),
      ],
    },
    {
      name: 'Ordinary chat never starts a timer',
      kind: 'negative',
      steps: [
        s('chat', 'alice', 'hello chat', 0, 'UNRELATED'),
        s('suffix', 'alice', `${command}s`, 1, 'UNRELATED'),
        s('nothing', 'alice', 'hello chat', timer.ms + 1, 'UNRELATED', { fired: 0, effects: 0 }),
      ],
    },
    {
      name: 'A redelivered start is ignored',
      kind: 'duplicate',
      steps: [s('d1', 'alice', command, 0, 'ACCEPTED'), s('d1', 'alice', command, 5, 'DUPLICATE')],
    },
  ];
  if (!audience.includes('viewer'))
    tests.push({
      name: `Only ${describeAudience(audience)} can start it`,
      kind: 'role',
      steps: [
        s('viewer', 'carol', command, 0, 'AUDIENCE', null, ['viewer']),
        s('nofire', 'carol', 'hello chat', timer.ms, 'UNRELATED', { fired: 0, effects: 0 }, [
          'viewer',
        ]),
      ],
    });
  const title = celebration
    ? 'Countdown Celebration'
    : `${name[0]?.toUpperCase()}${name.slice(1)} Reminder`;
  return {
    ...empty,
    kind: 'candidate',
    title: title.slice(0, 80),
    summary: `${command} starts a host-owned ${name} timer that shows ${asset}s ${describeTimer(timer)}.`,
    source,
    manifest: {
      sdkVersion: SDK_VERSION,
      experience: null,
      capabilities: ['overlay', 'timer'],
      trigger: { command, audience, maxPerViewer, windowMs },
      limits: { effectsPerEvent, effectsPerMinute },
    },
    tests,
    behavior: {
      when: `Someone types ${command}, then ${timer.repeat ? `every ${describeWindow(timer.ms)}` : `${describeWindow(timer.ms)} later`}`,
      what: `Three ${asset}s ${celebration ? 'celebrate' : 'appear'} on your overlay`,
      who: audience.includes('viewer') ? 'Everyone in chat' : `Only ${describeAudience(audience)}`,
      howMuch: `${timer.repeat ? 'Repeats until paused or cancelled' : 'Fires once'}; up to ${maxPerViewer} starts per person in any ${describeWindow(windowMs)}`,
    },
    assumptions: assumptions.slice(0, 8),
  };
}
