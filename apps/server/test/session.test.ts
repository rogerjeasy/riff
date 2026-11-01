import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';

const PASSWORD = 'correct-horse-battery-staple';
const TOKEN = 'T'.repeat(40);
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function hosted(password = PASSWORD, now?: () => number, webRoot?: string) {
  const app = await createApp({
    ...(webRoot ? { webRoot } : {}),
    logger: false,
    secret: 's'.repeat(40),
    publicUrl: 'https://streamer.example',
    console: { password, accessToken: TOKEN },
    ...(now ? { now } : {}),
  });
  apps.push(app);
  return app;
}
const login = (app: RiffApp, password: string, client = '203.0.113.7') =>
  app.inject({
    method: 'POST',
    url: '/api/session/login',
    headers: {
      'x-forwarded-for': client,
      'x-riff-request': '1',
      origin: 'https://streamer.example',
      host: 'streamer.example',
    },
    payload: { password },
  });
const sessionCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0]!;

describe('console sign-in', () => {
  it('leaves a local console without a password open', async () => {
    const app = await createApp({ logger: false });
    apps.push(app);
    expect((await app.inject('/api/studio')).statusCode).toBe(200);
    expect((await app.inject('/api/session')).json()).toEqual({
      required: false,
      authenticated: true,
    });
  });

  it('gates the console API, live updates and Twitch routes but not public paths', async () => {
    const app = await hosted();
    for (const url of ['/api/studio', '/api/collaboration', '/ws/console', '/auth/twitch']) {
      const response = await app.inject(url);
      expect(response.statusCode, url).toBe(401);
      expect(response.json().code).toBe('SIGNED_OUT');
    }
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect((await app.inject('/api/session')).json()).toEqual({
      required: true,
      authenticated: false,
    });
    // Overlay sockets and peer routes keep their own keys/bearers; the gate never blocks them.
    expect((await app.inject('/ws/overlay')).body).not.toContain('SIGNED_OUT');
    const peer = await app.inject({
      method: 'POST',
      url: '/peer/collaboration/heartbeat',
      payload: {},
    });
    // The peer route answers for itself (missing bearer), not the console sign-in gate.
    expect(peer.json().code).toBe('UNAUTHORIZED');
  });

  it('signs in with the password and issues a secure HttpOnly session cookie', async () => {
    const app = await hosted();
    const wrong = await login(app, 'not-the-password');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('INVALID_PASSWORD');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const ok = await login(app, PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(
      /^riff_session=\d{13}\.[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/,
    );
    const cookie = sessionCookie(ok);
    expect((await app.inject({ url: '/api/studio', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
      required: true,
      authenticated: true,
    });
    const forged = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await app.inject({ url: '/api/studio', headers: { cookie: forged } })).statusCode).toBe(
      401,
    );
  });

  it('requires the console request header for sign-in, like every mutation', async () => {
    const app = await hosted();
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rate-limits repeated wrong passwords', async () => {
    const app = await hosted();
    for (let i = 0; i < 10; i++) expect((await login(app, `guess-${i}`)).statusCode).toBe(401);
    const limited = await login(app, PASSWORD);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
  });

  it('expires sessions and signs everyone out when the password changes', async () => {
    let at = Date.UTC(2026, 10, 1);
    const first = await hosted(PASSWORD, () => at);
    const cookie = sessionCookie(await login(first, PASSWORD));
    const rotated = await hosted('a-brand-new-password-value', () => at);
    expect((await rotated.inject({ url: '/api/studio', headers: { cookie } })).statusCode).toBe(
      401,
    );
    expect((await first.inject({ url: '/api/studio', headers: { cookie } })).statusCode).toBe(200);
    at += 31 * 24 * 60 * 60 * 1000;
    expect((await first.inject({ url: '/api/studio', headers: { cookie } })).statusCode).toBe(401);
  });

  it('trades the dock sign-in link for a session and strips the token from the address', async () => {
    const app = await hosted();
    const ok = await app.inject(`/dock/?access=${TOKEN}`);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/dock/');
    const cookie = sessionCookie(ok);
    expect((await app.inject({ url: '/api/studio', headers: { cookie } })).statusCode).toBe(200);
    const wrong = await app.inject('/?access=nope&tab=live');
    expect(wrong.statusCode).toBe(302);
    expect(wrong.headers.location).toBe('/?tab=live');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('signs out by clearing the cookie', async () => {
    const app = await hosted();
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: {
        'x-riff-request': '1',
        origin: 'https://streamer.example',
        host: 'streamer.example',
      },
    });
    expect(String(response.headers['set-cookie'])).toMatch(/^riff_session=; Path=\/; Max-Age=0;/);
  });

  it('keys the gate on the matched route, so disguised API paths stay private', async () => {
    const app = await hosted();
    for (const url of [
      '/%61pi/studio',
      '/api/%73tudio',
      '//api/studio',
      '/api/../api/studio',
      '/API/studio',
      '/api/studio/',
      '/api/studio?x=/api/health',
    ]) {
      const response = await app.inject(url);
      expect(response.statusCode, url).not.toBe(200);
      expect(response.body, url).not.toContain('automations');
    }
  });

  it('keeps the console, overlay and dock pages public while their data stays gated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'riff-web-'));
    for (const dir of ['', 'overlay', 'dock']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, 'index.html'),
        `<!doctype html><title>${dir || 'console'}</title>`,
      );
    }
    const app = await hosted(PASSWORD, undefined, root);
    for (const url of ['/', '/overlay/', '/dock/'])
      expect((await app.inject(url)).statusCode, url).toBe(200);
    expect((await app.inject('/api/studio')).statusCode).toBe(401);
    expect((await app.inject('/%61pi/studio')).statusCode).not.toBe(200);
  });

  it('limits failed guesses per client so a guesser cannot lock the streamer out', async () => {
    const app = await hosted();
    for (let i = 0; i < 10; i++) await login(app, `guess-${i}`, '198.51.100.9');
    expect((await login(app, PASSWORD, '198.51.100.9')).statusCode).toBe(429);
    expect((await login(app, PASSWORD, '203.0.113.50')).statusCode).toBe(200);
  });

  it('only redirects a sign-in link within this site', async () => {
    const app = await hosted();
    for (const url of [
      '/.//evil.example/?access=nope',
      '//evil.example/?access=nope',
      '/%2F%2Fevil.example/?access=nope',
      '/\\evil.example/?access=nope',
    ]) {
      const location = String((await app.inject(url)).headers.location);
      expect(location, url).toMatch(/^\/(?![/\\])/);
      expect(location, url).not.toMatch(/^\/\/|^https?:/);
    }
  });
});
