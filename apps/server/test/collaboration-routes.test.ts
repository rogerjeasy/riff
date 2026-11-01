import { afterEach, expect, it } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('keeps peer bearer authentication separate from local operator authority', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  expect((await app.inject('/api/collaboration')).statusCode).toBe(200);
  expect(
    (await app.inject({ method: 'POST', url: '/peer/collaboration/heartbeat', payload: {} }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/peer/collaboration/heartbeat',
        payload: {},
        headers: { authorization: `Bearer ${'x'.repeat(43)}` },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/collaboration/leave',
        payload: {},
        headers: { authorization: `Bearer ${'x'.repeat(43)}` },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/collaboration/leave',
        payload: {},
        headers: { 'x-riff-request': '1', origin: 'https://attacker.example' },
      })
    ).statusCode,
  ).toBe(403);
});
