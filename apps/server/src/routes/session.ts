import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const COOKIE = 'riff_session';
const MAX_AGE_S = 30 * 24 * 60 * 60;
const ATTEMPTS = 10;
const WINDOW_MS = 60_000;

export interface ConsoleAccess {
  /** Console password; when absent the console is open (local development). */
  password: string | null;
  /** Long random token for the OBS dock's one-time sign-in link (`?access=`). */
  accessToken: string | null;
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** Paths a hosted streamer's visitors and peers may reach without the console session. */
function isPublic(path: string) {
  if (path === '/api/health' || path === '/ws/overlay' || path.startsWith('/peer/')) return true;
  if (path === '/api/session' || path.startsWith('/api/session/')) return true;
  // Static console/overlay/dock files hold no private data; their API calls are gated.
  return !(path.startsWith('/api/') || path.startsWith('/ws/') || path.startsWith('/auth/'));
}

/**
 * Console sign-in for hosted instances: a password form (and an OBS dock link) issue a
 * signed, HttpOnly session cookie. The signing key mixes RIFF_SECRET with the password,
 * so changing the password signs every browser out. Without a configured password the
 * console stays open, as in local development.
 */
export function registerConsoleSession(
  app: FastifyInstance,
  deps: ConsoleAccess & { secret: string | null; secure: boolean; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  const password = deps.password;
  const required = Boolean(password);
  const key = password
    ? createHmac('sha256', deps.secret ?? password)
        .update(`riff-console:${password}`)
        .digest()
    : null;
  const sign = (expires: number) =>
    createHmac('sha256', key ?? '')
      .update(`session:${expires}`)
      .digest('base64url');
  const cookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.header(
      'Set-Cookie',
      `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${deps.secure ? '; Secure' : ''}`,
    );
  const issue = (reply: FastifyReply) => {
    const expires = now() + MAX_AGE_S * 1000;
    cookie(reply, `${expires}.${sign(expires)}`, MAX_AGE_S);
  };
  function signedIn(request: FastifyRequest) {
    if (!required) return true;
    const raw = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const match = raw?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
    if (!match?.[1] || !match[2]) return false;
    const expires = Number(match[1]);
    return expires > now() && same(match[2], sign(expires));
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!required) return;
    const url = new URL(request.url, 'http://riff.local');
    // OBS dock sign-in link: trade the token for a session, then drop it from the address.
    if (request.method === 'GET' && url.searchParams.has('access')) {
      const token = url.searchParams.get('access') ?? '';
      if (deps.accessToken && same(token, deps.accessToken)) issue(reply);
      url.searchParams.delete('access');
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(`${url.pathname}${url.search}`, 302);
    }
    if (isPublic(url.pathname) || signedIn(request)) return;
    return reply
      .code(401)
      .header('Cache-Control', 'no-store')
      .send({ code: 'SIGNED_OUT', message: 'Sign in to open this studio.' });
  });

  app.get('/api/session', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { required, authenticated: signedIn(request) };
  });

  let failures: number[] = [];
  app.post('/api/session/login', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!password) return { authenticated: true };
    failures = failures.filter((at) => at > now() - WINDOW_MS);
    if (failures.length >= ATTEMPTS)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Wait a minute, then try again.',
      });
    const body = z
      .object({ password: z.string().max(256) })
      .strict()
      .safeParse(request.body);
    if (!body.success || !same(body.data.password, password)) {
      failures.push(now());
      return reply.code(401).send({
        code: 'INVALID_PASSWORD',
        message: 'That password isn’t right. Check it and try again.',
      });
    }
    issue(reply);
    return { authenticated: true };
  });

  app.post('/api/session/logout', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    cookie(reply, '', 0);
    return { authenticated: false };
  });
}
