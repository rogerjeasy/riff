import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTOR_ENVELOPE } from '@riff/sdk';
import { directorEnvelopeSchema } from '../src/services/director/contract.js';
import { createDirectorPolicy } from '../src/services/director/policy.js';
const envelope = () => structuredClone(DEFAULT_DIRECTOR_ENVELOPE);
const input = (n: number, viewer = `viewer-${n}`, round = 'round-1', at = 0) => ({
  key: `event-${n}`,
  viewerId: viewer,
  roundId: round,
  at,
  effects: [
    {
      id: `effect-${n}`,
      asset: 'tomato' as const,
      x: 0.5,
      viewer: null,
      automationId: 'a',
      versionId: 'v',
    },
  ],
});
describe('approved adaptive presentation policy', () => {
  it('validates all ranges and rejects gameplay authority', () => {
    expect(directorEnvelopeSchema.safeParse(envelope()).success).toBe(true);
    expect(directorEnvelopeSchema.safeParse({ ...envelope(), cooldownMs: 1000 }).success).toBe(
      false,
    );
    expect(
      directorEnvelopeSchema.safeParse({ ...envelope(), intervalMs: { min: 1000, max: 250 } })
        .success,
    ).toBe(false);
    expect(
      directorEnvelopeSchema.safeParse({ ...envelope(), intensity: { min: 0, max: 101 } }).success,
    ).toBe(false);
  });
  it('replays a surge deterministically, coalesces cosmetics and accounts for every effect', () => {
    function run() {
      const policy = createDirectorPolicy(envelope());
      for (let n = 0; n < 20; n++) policy.enqueue(input(n));
      const frames = policy.tick(2000);
      return { frames, state: policy.snapshot() };
    }
    const a = run();
    expect(a).toEqual(run());
    expect(a.state.accepted).toBe(20);
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]?.intensity).toBe(35);
    expect(a.state.coalesced).toBe(19);
    expect(a.state.offered).toBe(
      a.state.presented + a.state.coalesced + a.state.expired + a.state.cleared + a.state.pending,
    );
    expect(a.state.decisions.some((d) => d.reason.includes('20 accepted'))).toBe(true);
  });
  it('locks settings but continues enforcing approved interruption budgets', () => {
    const e = envelope();
    e.interruptionsPerMinute = 1;
    const p = createDirectorPolicy(e);
    p.configure('locked');
    for (let n = 0; n < 20; n++) p.enqueue(input(n));
    expect(p.tick(500)).toHaveLength(e.batchSize.max);
    p.enqueue(input(30, 'new', 'round', 600));
    expect(p.tick(2000)).toHaveLength(0);
    expect(p.snapshot().decisions.at(-1)?.reason).toContain('interruption');
    expect(() => p.configure('manual', { intervalMs: 10, batchSize: 99, intensity: 100 })).toThrow(
      /review/i,
    );
    p.configure('manual', { intervalMs: 1000, batchSize: 2, intensity: 50 });
    expect(p.snapshot().settings).toEqual({ intervalMs: 1000, batchSize: 2, intensity: 50 });
  });
  it('prioritizes first participation per round without changing accepted counts', () => {
    const e = envelope();
    e.batchSize = { min: 1, max: 1 };
    e.participation = 'first-time';
    const p = createDirectorPolicy(e);
    p.enqueue(input(1, 'repeat'));
    p.tick(500);
    p.enqueue(input(2, 'repeat', 'round-1', 501));
    p.enqueue(input(3, 'new', 'round-1', 501));
    expect(p.tick(1001)[0]?.id).toBe('effect-3');
    p.enqueue(input(4, 'repeat', 'round-2', 1002));
    p.enqueue(input(5, 'new', 'round-1', 1002));
    expect(p.tick(1502)[0]?.id).toBe('effect-4');
    expect(p.snapshot().accepted).toBe(5);
  });
  it('deduplicates, bounds pending memory, expires stale cosmetics and clears without replay', () => {
    const p = createDirectorPolicy(envelope());
    p.enqueue(input(1));
    p.enqueue(input(1));
    expect(p.snapshot().accepted).toBe(1);
    for (let n = 2; n <= 150; n++) p.enqueue(input(n));
    expect(p.snapshot().pending).toBe(120);
    expect(p.snapshot().coalesced).toBe(30);
    expect(p.tick(6000)).toEqual([]);
    expect(p.snapshot().expired).toBe(120);
    p.enqueue(input(151, 'late', 'round', 6001));
    p.clear('Creator stopped presentation.', 6002);
    expect(p.tick(8000)).toEqual([]);
    expect(p.snapshot().cleared).toBe(1);
  });
});
it('keeps per-round participation history for the longest approved round', () => {
  const e = envelope();
  e.batchSize = { min: 1, max: 1 };
  const p = createDirectorPolicy(e);
  p.enqueue(input(1, 'repeat'));
  p.tick(500);
  p.enqueue(input(2, 'repeat', 'round-1', 700000));
  p.enqueue(input(3, 'new', 'round-1', 700000));
  expect(p.tick(700500)[0]?.id).toBe('effect-3');
});
it('exposes only pending identities and accounts for presentation invalidated after selection', () => {
  const p = createDirectorPolicy(envelope());
  p.enqueue(input(1));
  expect(p.pendingIds()).toEqual(['effect-1']);
  p.tick(500);
  p.discard(1, 'Version changed before emission.');
  expect(p.pendingIds()).toEqual([]);
  expect(p.snapshot()).toMatchObject({ presented: 0, cleared: 1, offered: 1 });
});
describe('review regressions', () => {
  it('keeps presenting and counting after identity memory fills on a long busy stream', () => {
    const p = createDirectorPolicy(envelope());
    // 2400 accepted actions at 4 per second: well past the 2000-identity memory.
    for (let n = 0; n < 2400; n++) {
      p.enqueue(input(n, `viewer-${n}`, 'round-1', n * 250));
      p.tick(n * 250);
    }
    const before = p.snapshot();
    expect(before.accepted).toBe(2400);
    p.enqueue(input(5000, 'fresh', 'round-1', 2400 * 250));
    expect(p.tick(2400 * 250 + 2000)).toHaveLength(1);
    expect(p.snapshot().accepted).toBe(2401);
    // A duplicate inside memory is still ignored.
    p.enqueue(input(2399, 'viewer-2399', 'round-1', 2400 * 250 + 2001));
    expect(p.snapshot().accepted).toBe(2401);
  });
  it('keeps the decision log readable during a sustained burst at the interruption limit', () => {
    const e = envelope();
    e.interruptionsPerMinute = 2;
    const p = createDirectorPolicy(e);
    for (let n = 0; n < 400; n++) {
      p.enqueue(input(n, `viewer-${n}`, 'round-1', n * 20));
      p.tick(n * 20);
    }
    const reasons = p.snapshot().decisions.map((d) => d.reason);
    expect(reasons.length).toBeLessThan(10);
    expect(reasons.filter((r) => r.includes('interruptions per minute'))).toHaveLength(1);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
