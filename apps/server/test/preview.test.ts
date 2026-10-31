import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';

it('runs isolated synthetic replay and returns actual host decisions', async () => {
  const app = await createApp({ checkDatabase: () => true, logger: false });
  try {
    const payload = {
      seed: 42,
      events: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        at: i,
        viewerId: i === 4 ? 'bob' : 'alice',
        channelId: 'preview',
        roles: ['viewer'],
        text: '!tomato',
      })),
    };
    const response = await app.inject({ method: 'POST', url: '/api/preview', payload });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.provenance).toBe('synthetic');
    expect(result.decisions.map((d: { code: string }) => d.code)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'VIEWER_LIMIT',
      'ACCEPTED',
    ]);
    expect(result.decisions.flatMap((d: { effects: unknown[] }) => d.effects)).toHaveLength(4);
    expect((await app.inject({ method: 'POST', url: '/api/preview', payload })).json()).toEqual(
      result,
    );
  } finally {
    await app.close();
  }
});
it('rejects executable inputs, oversized replay and cross-site requests', async () => {
  const app = await createApp({ checkDatabase: () => true, logger: false });
  try {
    for (const payload of [
      { seed: 42, events: [], source: 'arbitrary' },
      { seed: 42, events: Array(65).fill({}) },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/api/preview', payload })).statusCode).toBe(
        400,
      );
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/preview',
          headers: { origin: 'https://untrusted.example' },
          payload: { seed: 42, events: [] },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});

it('cancellation releases the rehearsal slot and fences the old engine', async () => {
  const { createPreviewService } = await import('../src/services/rehearsal/preview.js');
  const service = createPreviewService();
  const controller = new AbortController();
  const events = [
    {
      id: 'a',
      at: 0,
      viewerId: 'alice',
      channelId: 'preview',
      roles: ['viewer' as const],
      text: '!tomato',
    },
  ];
  const pending = service.replay(events, 42, controller.signal);
  controller.abort();
  const next = await service.replay(events, 42);
  expect(next?.decisions[0]?.code).toBe('ACCEPTED');
  expect((await pending)?.decisions.flatMap((d) => d.effects)).toEqual([]);
  service.close();
});
