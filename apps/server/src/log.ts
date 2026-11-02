import type { FastifyServerOptions } from 'fastify';

export function createLoggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'access_token',
        'refresh_token',
        'client_secret',
        'password',
        'apiKey',
        'api_key',
      ],
      censor: '[redacted]',
    },
    // Never serialize URLs: future overlay keys and OAuth codes can occur there.
    serializers: {
      req(request: { method: string; id: string }) {
        return { method: request.method, id: request.id };
      },
    },
  };
}
