import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('foundation HTTP service', () => {
  it('reports only foundation health and adds security headers', async () => {
    const app = await createApp({ checkDatabase: () => true, logger: false });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', mode: 'foundation', integrations: 'disabled' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('returns unavailable when the database cannot be reached', async () => {
    const app = await createApp({ checkDatabase: () => false, logger: false });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
  });
  it('does not expose generation or activation routes', async () => {
    const app = await createApp({ checkDatabase: () => true, logger: false });
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/automations' })).statusCode).toBe(404);
  });
});
