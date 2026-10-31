import Fastify, { type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { registerHealthRoute } from './routes/health.js';

interface AppDependencies {
  checkDatabase: () => boolean;
  logger: NonNullable<FastifyServerOptions['logger']>;
  webRoot?: string;
}

/** Construct an isolated application; the caller owns listening and shutdown. */
export async function createApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: dependencies.logger, bodyLimit: 64 * 1024 });
  await app.register(helmet);
  registerHealthRoute(app, dependencies.checkDatabase);
  if (dependencies.webRoot) {
    await app.register(staticFiles, { root: dependencies.webRoot, dotfiles: 'deny' });
  }
  return app;
}
