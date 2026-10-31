import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
afterEach(() => vi.unstubAllGlobals());
it('validates studio community and strips private fields from public frames', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        panic: false,
        automations: [],
        activity: [],
        compiler: { kind: 'offline' },
        runs: [],
        twitch: { state: 'unconfigured' },
        community: {
          commands: [],
          creditNotice: '',
          ballot: null,
          outcomes: Array(6).fill({}),
          selections: [],
        },
      }),
    })),
  );
  await expect(api.studio()).rejects.toThrow();
});
it('uses guarded mutations with exact revision and immutable selection bodies', async () => {
  const fetcher = vi.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ code: 'STALE', message: 'Refresh this proposal.' }),
  }));
  vi.stubGlobal('fetch', fetcher);
  await expect(api.moderateProposal('p', 4, 'hide')).rejects.toMatchObject({
    code: 'STALE',
    status: 409,
  });
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/proposals/p/moderate',
    expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'x-riff-request': '1' },
      body: '{"expectedRevision":4,"action":"hide"}',
    }),
  );
  await expect(api.generateSelection('s')).rejects.toMatchObject({ code: 'STALE' });
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/proposals/selections/s/generate',
    expect.objectContaining({ body: '{}' }),
  );
});
