import { expect, it } from 'vitest';
import { createOverlayBroker } from '../src/services/overlay/broker.js';
import type { SharedProjection } from '../src/services/collaboration/contract.js';
const projection: SharedProjection = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  digest: 'a'.repeat(64),
  revision: 1,
  title: 'Shared goal',
  roleId: 'repair',
  roleLabel: 'Repairs',
  status: 'running',
  reason: null,
  instructions: 'Type !repair',
  score: 1,
  target: 5,
};
it('rehydrates unchanged approved shared state after unrelated local overlay clearing', () => {
  const broker = createOverlayBroker();
  const frames: { type: string; payload: unknown }[] = [];
  broker.attach({ send: (value) => frames.push(JSON.parse(value)), close() {} }, 'home');
  try {
    expect(frames[0]?.type).toBe('hello');
    broker.setCollaboration(projection);
    broker.clear('pause');
    broker.setCollaboration(projection);
    expect(frames.at(-1)).toEqual({ v: 1, type: 'collaboration', payload: projection });
    broker.clear('panic');
    broker.setCollaboration(projection);
    expect(frames.at(-1)?.type).toBe('clear');
  } finally {
    broker.close();
  }
});
