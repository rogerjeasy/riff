import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createOfflineTransport, type CompilerTransport } from '@riff/compiler';
import { verifyCandidate } from '@riff/sandbox';
import { EXAMPLES } from '@riff/sdk';
import { openDatabase, type DatabaseConnection } from './db/client.js';
import { forChannel } from './db/repositories/studio.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMutationGuard } from './routes/guard.js';
import { registerRealtimeRoutes } from './routes/realtime.js';
import { registerStudioRoutes } from './routes/studio.js';
import { registerTwitchRoutes } from './routes/twitch.js';
import { createSealer } from './services/auth/secrets.js';
import { createAuthoringService } from './services/authoring/service.js';
import { createStudioService } from './services/automations/studio.js';
import { createHub } from './services/hub.js';
import { createLiveRuntime } from './services/live/runtime.js';
import { createOverlayBroker } from './services/overlay/broker.js';
import { createPreviewService } from './services/rehearsal/preview.js';
import { createTwitchConnection, type TwitchConfig } from './services/twitch/connection.js';
import type { FetchLike } from '@riff/twitch';

/** The studio is operator-local: one home channel per server process. */
export const HOME_CHANNEL = 'home';

interface AppDependencies {
  checkDatabase?: () => boolean;
  logger: NonNullable<FastifyServerOptions['logger']>;
  webRoot?: string;
  /** Defaults to a migrated in-memory database (tests). */
  database?: DatabaseConnection;
  transport?: CompilerTransport;
  publicUrl?: string;
  secret?: string | null;
  twitch?: TwitchConfig | null;
  fetch?: FetchLike;
}

export function migrateConnection(database: DatabaseConnection) {
  migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
  });
}

export interface RiffServices {
  repo: ReturnType<typeof forChannel>;
  runtime: ReturnType<typeof createLiveRuntime>;
  overlay: ReturnType<typeof createOverlayBroker>;
  hub: ReturnType<typeof createHub>;
  studio: ReturnType<typeof createStudioService>;
  authoring: ReturnType<typeof createAuthoringService>;
}
export type RiffApp = FastifyInstance & { riff: RiffServices };

/** Construct an isolated application; the caller owns listening and shutdown. */
export async function createApp(dependencies: AppDependencies): Promise<RiffApp> {
  const app = Fastify({
    logger: dependencies.logger,
    bodyLimit: 64 * 1024,
    forceCloseConnections: true,
  });
  const ownsDatabase = !dependencies.database;
  const database = dependencies.database ?? openDatabase(':memory:');
  if (ownsDatabase) migrateConnection(database);
  const repo = forChannel(database, HOME_CHANNEL);
  repo.ensure('Home channel');

  const hub = createHub();
  const overlay = createOverlayBroker();
  const runtime = createLiveRuntime({ repo, hub, overlay });
  runtime.boot();
  const studio = createStudioService({ repo, hub, runtime, overlay });
  const authoring = createAuthoringService({
    repo,
    hub,
    transport: dependencies.transport ?? createOfflineTransport({ delayMs: 250 }),
  });
  const preview = createPreviewService();
  const sealer = dependencies.secret ? createSealer(dependencies.secret) : null;
  const twitch = createTwitchConnection({
    config: dependencies.twitch ?? null,
    repo,
    hub,
    runtime,
    sealer,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    log: (message) => app.log.warn(message),
  });
  const publicUrl = dependencies.publicUrl ?? 'http://localhost:5173';

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
      },
    },
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  registerMutationGuard(app);
  registerHealthRoute(
    app,
    dependencies.checkDatabase ?? (() => Boolean(database.client.prepare('SELECT 1').get())),
  );
  registerStudioRoutes(app, { studio, authoring, preview, repo, overlay, twitch, publicUrl });
  registerRealtimeRoutes(app, { hub, overlay, repo, twitch });
  registerTwitchRoutes(app, { twitch, publicUrl });
  app.addHook('onReady', async () => {
    twitch.start();
    // Warm the verifier (TypeScript parser, QuickJS WASM, worker startup) off the
    // request path so the first generation is as fast as later ones.
    const example = EXAMPLES[0];
    if (example)
      void verifyCandidate({ source: example.source, manifest: example.manifest, tests: [] }).catch(
        () => undefined,
      );
  });
  app.addHook('onClose', async () => {
    authoring.close();
    preview.close();
    twitch.close();
    runtime.close();
    overlay.close();
    if (ownsDatabase) database.close();
  });
  if (dependencies.webRoot) {
    await app.register(staticFiles, { root: dependencies.webRoot, dotfiles: 'deny' });
  }
  const services: RiffServices = { repo, runtime, overlay, hub, studio, authoring };
  return Object.assign(app as FastifyInstance, { riff: services });
}
