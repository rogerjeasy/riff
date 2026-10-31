import type { FastifyInstance, FastifyRequest } from 'fastify';

/** True when the browser says the request comes from this same site. */
export function isSameOrigin(request: FastifyRequest) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    const forwarded = request.headers['x-forwarded-host'];
    return host === request.host || (typeof forwarded === 'string' && host === forwarded);
  } catch {
    return false;
  }
}

/**
 * Local-operator CSRF defense for every mutating API route: reject cross-site
 * requests and require a custom header, which browsers only send cross-origin after a
 * CORS preflight this server never approves.
 */
export function registerMutationGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || !request.url.startsWith('/api/'))
      return;
    reply.header('Cache-Control', 'no-store');
    if (!isSameOrigin(request))
      return reply
        .code(403)
        .send({ code: 'CROSS_SITE', message: 'Use the Riff console on this machine.' });
    if (request.headers['x-riff-request'] !== '1')
      return reply.code(403).send({ code: 'CSRF', message: 'Missing console request header.' });
  });
}
