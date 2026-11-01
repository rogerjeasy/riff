import { describe, expect, it } from 'vitest';
import { TIMER_LIMITS, type Scenario } from '@riff/sdk';
import {
  analyzeSource,
  applyTimerOps,
  createEngine,
  createVirtualTimers,
  manifestSchema,
  nextTimerSlot,
  runRehearsal,
  runScenarios,
  timerLateness,
  verifyCandidate,
  type TimerEntry,
} from '@riff/sandbox';

const manifest = {
  sdkVersion: '0.4.0' as const,
  capabilities: ['overlay', 'timer'] as ('overlay' | 'timer')[],
  trigger: {
    command: '!start',
    audience: ['viewer'] as ('viewer' | 'broadcaster')[],
    maxPerViewer: 2,
    windowMs: 60_000,
  },
  limits: { effectsPerEvent: 3, effectsPerMinute: 30 },
};
const celebrate = `async (event, riff) => {
  if (event.source === 'timer.fired') {
    for (let i = 0; i < 3; i++) await riff.overlay.emit({ kind: 'projectile', asset: 'heart', x: 0.2 + i * 0.3 });
    return;
  }
  await riff.timer.start('celebrate', 60000);
}`;
const chat = (id: string, at: number, text = '!start', viewerId = 'alice') => ({
  id,
  at,
  viewerId,
  channelId: 'c',
  roles: ['viewer'],
  text,
});
const fire = (id: string, at: number, name = 'celebrate') => ({
  source: 'timer.fired',
  id,
  channelId: 'c',
  name,
  scheduledAt: at,
  firedAt: at,
  missed: false,
  at,
});

describe('timer capability bridge', () => {
  it('stages a named timer as a queued side effect that spends the viewer allowance', async () => {
    const engine = createEngine({ source: celebrate, manifest }, { seed: 3 });
    const first = await engine.dispatch(chat('a', 0));
    expect(first.code).toBe('ACCEPTED');
    expect(first.effects).toEqual([]);
    expect(first.timers).toEqual([{ op: 'start', name: 'celebrate', ms: 60_000, repeat: false }]);
    expect((await engine.dispatch(chat('b', 1))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(chat('c', 2))).code).toBe('VIEWER_LIMIT');
    engine.stop();
  });

  it.each([
    ['undeclared capability', celebrate, { ...manifest, capabilities: ['overlay' as const] }],
    ['too short', `async (e, riff) => { await riff.timer.start('x', 10); }`, manifest],
    ['too long', `async (e, riff) => { await riff.timer.start('x', 3600001); }`, manifest],
    ['bad name', `async (e, riff) => { await riff.timer.start('Bad Name', 6000); }`, manifest],
    [
      'eleventh distinct name',
      `async (e, riff) => { for (let i = 0; i < 11; i++) await riff.timer.start('t' + i, 6000); }`,
      manifest,
    ],
  ])('quarantines and discards staged work for %s', async (_label, source, candidate) => {
    const engine = createEngine({ source, manifest: candidate }, { seed: 3 });
    const decision = await engine.dispatch(chat('a', 0));
    expect(decision.code).toBe('INCIDENT');
    expect(decision.timers).toBeUndefined();
    engine.stop();
  });

  it('restarting an existing name never counts as an extra timer', async () => {
    const source = `async (e, riff) => { for (let i = 0; i < 20; i++) await riff.timer.start('same', 6000 + i); }`;
    const pending = Array.from({ length: TIMER_LIMITS.maxPerAutomation }, (_, i) => `t${i}`);
    const engine = createEngine(
      { source, manifest: { ...manifest, limits: { effectsPerEvent: 1, effectsPerMinute: 10 } } },
      { seed: 3, timers: { active: () => pending.slice(0, 9) } },
    );
    const decision = await engine.dispatch(chat('a', 0));
    expect(decision.code).toBe('ACCEPTED');
    expect(decision.timers).toHaveLength(20);
    engine.stop();
  });

  it('has no guest setTimeout: static analysis and the isolate both refuse it', async () => {
    const source = `async (e, riff) => { setTimeout(() => {}, 10); }`;
    const analysis = analyzeSource(source, manifest);
    expect(analysis.findings.some((f) => f.rule === 'no-ambient' && f.severity === 'error')).toBe(
      true,
    );
    const engine = createEngine({ source, manifest }, { seed: 3 });
    expect((await engine.dispatch(chat('a', 0))).code).toBe('INCIDENT');
    engine.stop();
  });

  it('timers are rejected inside stateful experiences and before SDK 0.4.0', () => {
    expect(manifestSchema.safeParse({ ...manifest, sdkVersion: '0.3.0' }).success).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...manifest,
        capabilities: ['overlay', 'session', 'timer'],
        trigger: { ...manifest.trigger, command: '!grow' },
        experience: {
          version: 1,
          title: 'Goal',
          durationMs: 60_000,
          maxParticipants: 10,
          teams: [],
          resource: { name: 'hearts', perParticipant: 3 },
          contribution: { command: '!grow', points: 1 },
          objective: { kind: 'collective-goal', target: 5 },
        },
      }).success,
    ).toBe(false);
  });
});

describe('timer.fired delivery', () => {
  it('runs the same handler without command or audience checks but with budgets and dedupe', async () => {
    const restricted = {
      ...manifest,
      trigger: { ...manifest.trigger, audience: ['broadcaster' as const] },
      limits: { effectsPerEvent: 3, effectsPerMinute: 6 },
    };
    const engine = createEngine({ source: celebrate, manifest: restricted }, { seed: 3 });
    const accepted = await engine.dispatchTimer(fire('t1', 10));
    expect(accepted.code).toBe('ACCEPTED');
    expect(accepted.effects).toHaveLength(3);
    expect(accepted.viewerId).toBeNull();
    expect((await engine.dispatchTimer(fire('t1', 11))).code).toBe('DUPLICATE');
    expect((await engine.dispatchTimer(fire('t2', 12))).code).toBe('ACCEPTED');
    expect((await engine.dispatchTimer(fire('t3', 13))).code).toBe('CHANNEL_LIMIT');
    expect((await engine.dispatchTimer(fire('t4', 61_000))).code).toBe('ACCEPTED');
    engine.stop();
  });

  it('carries native Twitch actions staged by a fire and counts them against the budget', async () => {
    const source = `async (event, riff) => {
      if (event.source === 'timer.fired') {
        await riff.chat.announce({ message: 'Hydrate!' });
        return;
      }
      await riff.timer.start('hydrate', 600000, { repeat: true });
    }`;
    const engine = createEngine(
      {
        source,
        manifest: {
          ...manifest,
          capabilities: ['chat.announce', 'timer'],
          limits: { effectsPerEvent: 1, effectsPerMinute: 1 },
        },
      },
      { seed: 3 },
    );
    const fired = await engine.dispatchTimer(fire('a1', 10));
    expect(fired.code).toBe('ACCEPTED');
    expect(fired.effects).toHaveLength(0);
    expect(fired.actions).toHaveLength(1);
    expect(fired.actions?.[0]).toMatchObject({ kind: 'announce', message: 'Hydrate!' });
    // The announcement spent the one effect this minute allows.
    expect((await engine.dispatchTimer(fire('a2', 20))).code).toBe('CHANNEL_LIMIT');
    engine.stop();
  });

  it('refuses timer events for interactions without the timer capability', async () => {
    const engine = createEngine(
      {
        source: celebrate.replace(/riff\.timer\.start\([^)]*\)/, '0'),
        manifest: { ...manifest, capabilities: ['overlay'] },
      },
      { seed: 3 },
    );
    expect((await engine.dispatchTimer(fire('t1', 10))).code).toBe('INVALID_EVENT');
    expect((await engine.dispatchTimer({ ...fire('t2', 10), scheduledAt: 11 })).code).toBe(
      'INVALID_EVENT',
    );
    engine.stop();
  });
});

describe('timer policy', () => {
  it('classifies lateness with one shared grace rule', () => {
    expect(timerLateness(1000, 1000)).toBe('on-time');
    expect(timerLateness(1000, 1000 + TIMER_LIMITS.lateToleranceMs)).toBe('on-time');
    expect(timerLateness(1000, 1001 + TIMER_LIMITS.lateToleranceMs)).toBe('missed');
    expect(timerLateness(1000, 1000 + TIMER_LIMITS.missedGraceMs)).toBe('missed');
    expect(timerLateness(1000, 1001 + TIMER_LIMITS.missedGraceMs)).toBe('expired');
  });
  it('re-arms repeating timers on the original cadence without a catch-up burst', () => {
    expect(nextTimerSlot({ scheduledAt: 10_000, intervalMs: 5000 }, 9_000)).toBe(10_000);
    expect(nextTimerSlot({ scheduledAt: 10_000, intervalMs: 5000 }, 10_000)).toBe(15_000);
    expect(nextTimerSlot({ scheduledAt: 10_000, intervalMs: 5000 }, 31_000)).toBe(35_000);
  });
  it('restart replaces a name from now; cancel of an unknown name is a no-op', () => {
    const table = new Map<string, TimerEntry>();
    applyTimerOps(table, [{ op: 'start', name: 'a', ms: 60_000, repeat: false }], 0);
    applyTimerOps(table, [{ op: 'start', name: 'a', ms: 10_000, repeat: true }], 30_000);
    expect([...table.values()]).toEqual([
      {
        name: 'a',
        intervalMs: 10_000,
        repeat: true,
        scheduledAt: 40_000,
        createdAt: 30_000,
        fires: 0,
      },
    ]);
    expect(applyTimerOps(table, [{ op: 'cancel', name: 'missing' }], 31_000)).toEqual([]);
    expect(applyTimerOps(table, [{ op: 'cancel', name: 'a' }], 31_000)).toEqual(['a']);
    expect(table.size).toBe(0);
  });
});

describe('virtual timer clock', () => {
  const step = (
    id: string,
    at: number,
    text: string,
    expect: Scenario['steps'][number]['expect'],
    timers: { fired: number; effects: number } | null = null,
  ) => ({ id, viewer: 'alice', roles: ['viewer' as const], text, at, expect, effects: 0, timers });

  it('fires due timers before the next step and checks scenario assertions', async () => {
    const [result] = await runScenarios(
      { source: celebrate, manifest },
      [
        {
          name: 'Celebrates sixty seconds after !start',
          kind: 'happy',
          steps: [
            step('s', 0, '!start', 'ACCEPTED'),
            step('early', 59_999, 'hello', 'UNRELATED', { fired: 0, effects: 0 }),
            step('late', 60_000, 'hello', 'UNRELATED', { fired: 1, effects: 3 }),
          ],
        },
      ],
      'generated',
    );
    expect(result?.passed).toBe(true);
    expect(result?.steps[2]?.timers).toEqual({ fired: 1, effects: 3 });
  });

  it('restart postpones, cancel prevents, and repeat follows its cadence', async () => {
    const source = `async (event, riff) => {
      if (event.source === 'timer.fired') { await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: 0.5 }); return; }
      if (event.text.trim() === '!start') await riff.timer.start('tick', 10000, { repeat: true });
      else await riff.timer.cancel('tick');
    }`;
    const both = {
      ...manifest,
      trigger: { ...manifest.trigger, command: '!start', maxPerViewer: 5 },
    };
    const [result] = await runScenarios(
      { source, manifest: both },
      [
        {
          name: 'cadence',
          kind: 'happy',
          steps: [
            step('a', 0, '!start', 'ACCEPTED'),
            step('b', 5_000, '!start', 'ACCEPTED', { fired: 0, effects: 0 }),
            step('c', 35_000, 'hi', 'UNRELATED', { fired: 3, effects: 3 }),
          ],
        },
      ],
      'generated',
    );
    expect(result?.steps.map((s) => s.passed)).toEqual([true, true, true]);
  });

  it('keeps virtual timers private to one store and bounds fires per advance', async () => {
    const source = `async (event, riff) => {
      if (event.source === 'timer.fired') return;
      await riff.timer.start('tick', 5000, { repeat: true });
    }`;
    const timers = createVirtualTimers('c');
    const other = createVirtualTimers('c');
    const engine = createEngine({ source, manifest }, { seed: 1, timers });
    timers.apply(await engine.dispatch(chat('a', 0)));
    expect(other.active()).toEqual([]);
    const advanced = await timers.advance(engine, 3_600_000);
    expect(advanced.fires).toHaveLength(TIMER_LIMITS.previewFiresPerAdvance);
    expect(advanced.skipped).toBeGreaterThan(0);
    expect(timers.entries()[0]?.scheduledAt).toBeGreaterThan(3_600_000);
    engine.stop();
  });

  it('shows timer fires on the rehearsal timeline as evidence', async () => {
    const result = await runRehearsal({
      artifact: { source: celebrate, manifest },
      scenario: {
        version: 1,
        seed: 9,
        initialAt: 0,
        initialSession: null,
        steps: [
          { kind: 'chat', key: 'go', event: chat('go', 0) },
          { kind: 'advance', key: 'wait', at: 60_000 },
        ],
        expectations: [],
        provenance: { kind: 'synthetic' },
      },
    });
    expect(result.status).toBe('passed');
    expect(result.timeline[0]?.timers).toBeUndefined();
    expect(result.timeline[1]?.timers).toEqual([
      { name: 'celebrate', at: 60_000, code: 'ACCEPTED', effects: 3 },
    ]);
  });

  it('a timer interaction passes the full verification pipeline', async () => {
    const report = await verifyCandidate({
      source: celebrate,
      manifest,
      tests: [
        {
          name: 'Celebrates after a minute',
          kind: 'happy',
          steps: [
            step('s', 0, '!start', 'ACCEPTED'),
            step('l', 60_000, 'hello', 'UNRELATED', { fired: 1, effects: 3 }),
          ],
        },
        {
          name: 'Two starts per viewer',
          kind: 'limit',
          steps: [
            step('a', 0, '!start', 'ACCEPTED'),
            step('b', 1, '!start', 'ACCEPTED'),
            step('c', 2, '!start', 'VIEWER_LIMIT'),
          ],
        },
        { name: 'Chat does nothing', kind: 'negative', steps: [step('n', 0, 'hi', 'UNRELATED')] },
      ],
    });
    expect(report.failureReport).toBeNull();
    expect(report.capabilitiesUsed.sort()).toEqual(['overlay', 'timer']);
  }, 30_000);
});
