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

/** Route patterns open without a console session. Everything else is private by default. */
const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/session',
  '/api/session/login',
  '/api/session/logout',
  '/ws/overlay',
  '/recipes',
  '/participate',
  '/participation',
  '/production-test',
  '/directory/recipes',
  '/directory/recipes/:digest',
  '/directory/recipes/:digest/report',
]);
/**
 * Decide on the route Fastify actually matched, never on our own reading of the raw URL:
 * an encoded or doubled path (`/%61pi/studio`, `//api/studio`) must not look public while
 * routing to a private handler. Unmatched requests are private too.
 */
function isPublic(route: string | undefined) {
  if (!route) return false;
  if (PUBLIC_ROUTES.has(route) || route.startsWith('/peer/collaboration/')) return true;
  // The static file handler (console, overlay and dock bundles) holds no private data;
  // every API call those pages make is gated separately.
  return route === '/*' || route === '/';
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
      // Same-site only: normalisation can leave `//host` (e.g. from `/.//host`), which a
      // browser would follow off-site, so collapse any leading slashes or backslashes.
      const path = `/${url.pathname.replace(/^[/\\]+/, '')}`;
      return reply.redirect(`${path}${url.search}`, 302);
    }
    if (isPublic(request.routeOptions.url) || signedIn(request)) return;
    return reply
      .code(401)
      .header('Cache-Control', 'no-store')
      .send({ code: 'SIGNED_OUT', message: 'Sign in to open this studio.' });
  });

  app.get('/api/session', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { required, authenticated: signedIn(request) };
  });

  // Failed attempts are limited per client, so someone guessing cannot lock the streamer
  // out; a much higher overall cap is the backstop against many sources at once.
  const failures = new Map<string, number[]>();
  let everyone: number[] = [];
  const client = (request: FastifyRequest) => {
    // Behind Caddy the socket peer is the proxy; Caddy replaces X-Forwarded-For with the
    // real client address (it does not trust a client-supplied value by default).
    const forwarded = request.headers['x-forwarded-for'];
    const last = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(',').at(-1);
    return (last ?? request.ip).trim().slice(0, 64);
  };
  app.post('/api/session/login', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!password) return { authenticated: true };
    const since = now() - WINDOW_MS;
    const who = client(request);
    const mine = (failures.get(who) ?? []).filter((at) => at > since);
    everyone = everyone.filter((at) => at > since);
    if (mine.length >= ATTEMPTS || everyone.length >= ATTEMPTS * 20)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Wait a minute, then try again.',
      });
    const body = z
      .object({ password: z.string().max(256) })
      .strict()
      .safeParse(request.body);
    if (!body.success || !same(body.data.password, password)) {
      mine.push(now());
      everyone.push(now());
      failures.delete(who);
      failures.set(who, mine);
      // Bound memory: forget the least recently failing client beyond 1,000.
      if (failures.size > 1000) failures.delete(failures.keys().next().value ?? '');
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
