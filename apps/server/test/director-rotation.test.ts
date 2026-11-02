import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTOR_ENVELOPE, type DirectorEnvelope } from '@riff/sdk';
import { directorDigest, directorEnvelopeSchema } from '../src/services/director/contract.js';
import { createDirectorPolicy } from '../src/services/director/policy.js';
import { copy, fairnessCopy } from '../src/services/participation/copy.js';

/** F40/F37 opportunity rotation: a contested presentation slot goes to whoever waited longest. */
const envelope = (participation: DirectorEnvelope['participation'] = 'rotation') => ({
  ...structuredClone(DEFAULT_DIRECTOR_ENVELOPE),
  batchSize: { min: 1, max: 1 },
  participation,
});
const action = (n: number, viewer: string, at: number, extra: object = {}) => ({
  key: `event-${n}`,
  viewerId: viewer,
  roundId: 'round-1',
  at,
  effects: [{ id: `effect-${n}`, asset: 'tomato' as const, x: 0.5, viewer: null }],
  ...extra,
});
/**
 * 10 eager viewers act every turn and always reach chat first; 5 occasional viewers act
 * every third turn after them. One slot is shown per batch, so slots are contested.
 */
function surge(participation: DirectorEnvelope['participation']) {
  const policy = createDirectorPolicy(envelope(participation));
  const eager = Array.from({ length: 10 }, (_, i) => `eager-${i}`);
  const occasional = Array.from({ length: 5 }, (_, i) => `occasional-${i}`);
  const owner = new Map<string, string>();
  const shown: Record<string, number> = {};
  let n = 0;
  for (let turn = 0; turn < 30; turn++) {
    const at = turn * 1600;
    const arrivals = [...eager, ...(turn % 3 === 0 ? occasional : [])];
    for (const viewer of arrivals) {
      owner.set(`effect-${n}`, viewer);
      policy.enqueue(action(n++, viewer, at));
    }
    for (const frame of policy.tick(at + 1500)) {
      const viewer = owner.get(frame.id)!;
      shown[viewer] = (shown[viewer] ?? 0) + 1;
    }
  }
  const occasionalShown = occasional.reduce((sum, v) => sum + (shown[v] ?? 0), 0);
  const distinct = Object.keys(shown).length;
  return { shown, occasionalShown, distinct, snapshot: policy.snapshot() };
}

describe('opportunity rotation fairness policy', () => {
  it('is an approvable participation policy with its own evidence identity and no new authority', () => {
    expect(directorEnvelopeSchema.safeParse(envelope('rotation')).success).toBe(true);
    expect(directorEnvelopeSchema.safeParse(envelope('subscribers' as never)).success).toBe(false);
    expect(
      directorEnvelopeSchema.safeParse({ ...envelope('rotation'), rotationBoost: 'bits' }).success,
    ).toBe(false);
    expect(directorDigest(envelope('rotation'))).not.toBe(directorDigest(envelope('first-time')));
  });

  it('gives a contested slot to a viewer who has not had a turn before a repeat winner', () => {
    const p = createDirectorPolicy(envelope());
    p.enqueue(action(1, 'repeat', 0));
    expect(p.tick(500).map((f) => f.id)).toEqual(['effect-1']);
    p.enqueue(action(2, 'repeat', 600));
    p.enqueue(action(3, 'waiting', 601));
    expect(p.tick(1100).map((f) => f.id)).toEqual(['effect-3']);
    // Next contested slot: 'repeat' has now waited longest, so rotation returns to them.
    p.enqueue(action(4, 'waiting', 1200));
    p.enqueue(action(5, 'repeat', 1201));
    expect(p.tick(1700).map((f) => f.id)).toEqual(['effect-5']);
    expect(p.snapshot().decisions.at(-1)?.reason).toContain(
      'Priority to viewers who haven’t had a turn yet.',
    );
  });

  it('spreads one batch across distinct viewers before giving anyone a second slot', () => {
    const e = envelope();
    e.batchSize = { min: 3, max: 3 };
    const p = createDirectorPolicy(e);
    const owners: string[] = [];
    let n = 0;
    for (const viewer of ['a', 'a', 'a', 'b', 'c']) {
      owners.push(viewer);
      p.enqueue(action(n++, viewer, 0));
    }
    const shown = p.tick(500).map((f) => owners[Number(f.id.slice(7))]);
    expect(shown).toEqual(['a', 'b', 'c']);
  });

  it('improves the distribution of turns versus arrival order for 10 eager and 5 occasional viewers', () => {
    const fifo = surge('fifo');
    const rotation = surge('rotation');
    expect(fifo.occasionalShown).toBe(0);
    expect(rotation.occasionalShown).toBeGreaterThanOrEqual(5);
    expect(rotation.distinct).toBe(15);
    expect(fifo.distinct).toBeLessThan(rotation.distinct);
    const turns = Object.values(rotation.shown);
    expect(Math.max(...turns) - Math.min(...turns)).toBeLessThanOrEqual(2);
    // Rotation changes presentation priority only: every accepted action is still counted
    // and every offered effect is accounted for.
    for (const run of [fifo, rotation]) {
      expect(run.snapshot.accepted).toBe(30 * 10 + 10 * 5);
      expect(run.snapshot.offered).toBe(
        run.snapshot.presented +
          run.snapshot.coalesced +
          run.snapshot.expired +
          run.snapshot.cleared +
          run.snapshot.pending,
      );
    }
    expect(rotation.snapshot.presented).toBe(fifo.snapshot.presented);
  });

  it('replays rotation decisions identically for rehearsal evidence', () => {
    expect(surge('rotation')).toEqual(surge('rotation'));
  });

  it('never ranks by spending or subscription status', () => {
    const run = (paid: boolean) => {
      const p = createDirectorPolicy(envelope());
      p.enqueue(action(1, 'supporter', 0, paid ? { bits: 5000, subscriber: true } : {}));
      p.tick(500);
      p.enqueue(action(2, 'supporter', 600, paid ? { bits: 5000, tier: '3000' } : {}));
      p.enqueue(action(3, 'free-viewer', 601));
      return p.tick(1100).map((f) => f.id);
    };
    expect(run(true)).toEqual(['effect-3']);
    expect(run(true)).toEqual(run(false));
  });

  it('stays inside the approved batch, interval and interruption ranges', () => {
    const e = envelope();
    e.batchSize = { min: 1, max: 2 };
    e.interruptionsPerMinute = 2;
    const p = createDirectorPolicy(e);
    // A burst switches to the approved calm settings: slowest interval, smallest batch.
    for (let n = 0; n < 10; n++) p.enqueue(action(n, `v-${n}`, 0));
    expect(p.tick(1000)).toEqual([]);
    expect(p.tick(1500)).toHaveLength(1);
    for (let n = 10; n < 20; n++) p.enqueue(action(n, `v-${n}`, 3000));
    expect(p.tick(4500)).toHaveLength(1);
    for (let n = 20; n < 30; n++) p.enqueue(action(n, `v-${n}`, 6000));
    expect(p.tick(7500)).toEqual([]);
    expect(p.snapshot().decisions.at(-1)?.reason).toContain('interruptions per minute');
    expect(p.snapshot().accepted).toBe(30);
  });

  it('has reviewed on-stream copy in every participation language', () => {
    expect(Object.keys(copy).sort()).toEqual(['de', 'en', 'es', 'fr']);
    expect(fairnessCopy('en', 'rotation')).toBe('Priority to viewers who haven’t had a turn yet');
    expect(fairnessCopy('fr', 'rotation')).toBe(
      'Priorité aux spectateurs qui n’ont pas encore eu leur tour',
    );
    expect(fairnessCopy('es', 'rotation')).toBe(
      'Prioridad para quienes aún no han tenido su turno',
    );
    expect(fairnessCopy('de', 'rotation')).toBe(
      'Vorrang für Zuschauer, die noch nicht an der Reihe waren',
    );
    expect(fairnessCopy('en', 'fifo')).toBeNull();
    expect(fairnessCopy('de', null)).toBeNull();
  });
});
