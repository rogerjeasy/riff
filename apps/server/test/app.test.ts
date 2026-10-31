import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('HTTP service', () => {
  it('reports health and adds security headers', async () => {
    const app = await createApp({ checkDatabase: () => true, logger: false });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', mode: 'studio' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('returns unavailable when the database cannot be reached', async () => {
    const app = await createApp({ checkDatabase: () => false, logger: false });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
  });
  it('refuses mutations without the console header or from another site', async () => {
    const app = await createApp({ checkDatabase: () => true, logger: false });
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/channel/panic' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/channel/panic',
          headers: { 'x-riff-request': '1', origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
  });
});
