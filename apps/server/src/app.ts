import { createCoordinator } from './services/collaboration/coordinator.js';
import { createCollaborationMember } from './services/collaboration/member.js';
import { createPeerTransport, type PeerTransport } from './services/collaboration/transport.js';
import { registerCollaborationRoutes } from './routes/collaboration.js';
import { createSceneService } from './services/scenes/service.js';
import { registerSceneRoutes } from './routes/scenes.js';
import { createRehearsalService } from './services/rehearsal/service.js';
import { registerRehearsalRoutes } from './routes/rehearsals.js';
import { createProposalService } from './services/proposals/service.js';
import { communityProjection } from './services/proposals/projection.js';
import type { ProposalCommand } from './services/proposals/commands.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createOfflineTransport, createCompileQueue, type CompilerTransport } from '@riff/compiler';
import { verifyCandidate } from '@riff/sandbox';
import { EXAMPLES } from '@riff/sdk';
import { openDatabase, type DatabaseConnection } from './db/client.js';
import { forChannel } from './db/repositories/studio.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMutationGuard } from './routes/guard.js';
import { registerConsoleSession, type ConsoleAccess } from './routes/session.js';
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
  now?: () => number;
  peerFetch?: typeof fetch;
  /** Hosted console sign-in; omitted locally, where the console stays open. */
  console?: ConsoleAccess;
}

export function migrateConnection(database: DatabaseConnection) {
  migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
  });
}

export interface RiffServices {
  collaboration: {
    coordinator: ReturnType<typeof createCoordinator>;
    member: ReturnType<typeof createCollaborationMember>;
  };
  repo: ReturnType<typeof forChannel>;
  runtime: ReturnType<typeof createLiveRuntime>;
  overlay: ReturnType<typeof createOverlayBroker>;
  hub: ReturnType<typeof createHub>;
  studio: ReturnType<typeof createStudioService>;
  authoring: ReturnType<typeof createAuthoringService>;
  proposals: ReturnType<typeof createProposalService>;
  rehearsal: ReturnType<typeof createRehearsalService>;
  scenes: ReturnType<typeof createSceneService>;
  twitch: ReturnType<typeof createTwitchConnection>;
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
  const proposals = createProposalService(
    database,
    HOME_CHANNEL,
    dependencies.now ? { now: dependencies.now } : {},
  );
  let studioSoon: ReturnType<typeof setTimeout> | null = null;
  const proposalChanged = (kind?: ProposalCommand['kind']) => {
    // Suggestions, votes and credit cannot revoke lineage. Coalesce their bursts so a
    // busy ballot refreshes open consoles a few times a second, not once per vote.
    if (kind === 'suggest' || kind === 'vote' || kind === 'credit' || kind === 'invalid') {
      studioSoon ??= setTimeout(() => {
        studioSoon = null;
        hub.publish('studio', null);
      }, 250);
      studioSoon.unref();
      return;
    }
    try {
      authoring.reconcileSelections();
    } finally {
      hub.publish('studio', null);
    }
  };
  const shared: { current?: RiffServices['collaboration'] } = {};
  const stopCollaboration = () => {
    try {
      shared.current?.member.stop('Your channel stopped. Request a new invitation to rejoin.');
    } catch {
      /* Local publication is fenced first. */
    }
    try {
      shared.current?.coordinator.stop('Coordinator channel stopped.');
    } catch {
      /* Memory fencing precedes persistence. */
    }
  };
  const runtime = createLiveRuntime({
    onSharedChat: (message) => shared.current?.member.input(message) ?? Promise.resolve(false),
    onStop: stopCollaboration,
    repo,
    hub,
    overlay,
    proposals,
    onProposalChange: proposalChanged,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  runtime.boot();
  const studio = createStudioService({ repo, hub, runtime, overlay });
  const rehearsal = createRehearsalService(repo);
  const transport = dependencies.transport ?? createOfflineTransport({ delayMs: 250 });
  const queue = createCompileQueue();
  const scenes = createSceneService({ database, repo, runtime, overlay, hub, transport, queue });
  const authoring = createAuthoringService({
    queue,
    inheritScene: scenes.inherit,
    rehearsal,
    repo,
    hub,
    proposals,
    transport,
  });
  const publishCommunity = () => {
    if (runtime.panicked) return;
    try {
      overlay.setCommunity(communityProjection(proposals, repo));
    } catch {
      overlay.clearCommunity();
    }
  };
  const unsubscribeCommunity = hub.subscribe((message) => {
    if (message.type === 'studio' || message.type === 'run') publishCommunity();
  });
  publishCommunity();
  const communityTimer = setInterval(publishCommunity, 1000);
  communityTimer.unref();
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
    onStatus: (status) => {
      if (status.state !== 'connected') stopCollaboration();
    },
  });
  const publicUrl = dependencies.publicUrl ?? 'http://localhost:5173';
  const coordinator = createCoordinator({
    database,
    repo,
    blocked: () => runtime.panicked,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const remote = createPeerTransport(dependencies.peerFetch);
  const peer: PeerTransport = async (origin, token, action, body, signal) => {
    if (origin !== 'local') return remote(origin, token, action, body, signal);
    if (signal?.aborted) throw new Error('Membership request cancelled.');
    switch (action) {
      case 'review':
        return coordinator.review(token);
      case 'approve':
        return coordinator.approve(token, (body as { digest: string }).digest);
      case 'heartbeat':
        return coordinator.heartbeat(token);
      case 'input':
        return coordinator.input(token, body);
      case 'leave':
        coordinator.leave(token);
        return { ok: true };
    }
  };
  const member = createCollaborationMember({
    database,
    repo,
    sealer,
    identity: () => repo.state().twitchUserId,
    ready: () => twitch.status.state === 'connected',
    blocked: () => runtime.panicked,
    transport: peer,
    publish: (projection) => {
      overlay.setCollaboration(projection);
      hub.publish('studio', null);
    },
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const collaboration = { coordinator, member };
  shared.current = collaboration;
  const collaborationTimer = setInterval(() => {
    try {
      coordinator.tick();
    } catch {
      stopCollaboration();
    }
    void member.poll();
  }, 2000);
  collaborationTimer.unref();

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
  registerConsoleSession(app, {
    password: dependencies.console?.password ?? null,
    accessToken: dependencies.console?.accessToken ?? null,
    secret: dependencies.secret ?? null,
    secure: publicUrl.startsWith('https://'),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  registerHealthRoute(
    app,
    dependencies.checkDatabase ?? (() => Boolean(database.client.prepare('SELECT 1').get())),
  );
  registerStudioRoutes(app, {
    studio,
    authoring,
    preview,
    repo,
    overlay,
    twitch,
    publicUrl,
    proposals,
  });
  registerRehearsalRoutes(app, { rehearsal, authoring });
  registerSceneRoutes(app, scenes);
  registerCollaborationRoutes(app, {
    coordinator,
    member,
    identity: () => repo.state().twitchUserId,
    login: () => repo.state().twitchLogin,
    publicUrl,
    configured: !!sealer,
    ready: () => twitch.status.state === 'connected',
  });
  registerProposalRoutes(app, { proposals, authoring, repo, changed: proposalChanged });
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
    clearInterval(communityTimer);
    clearInterval(collaborationTimer);
    member.close();
    coordinator.close();
    if (studioSoon) clearTimeout(studioSoon);
    unsubscribeCommunity();
    scenes.close();
    authoring.close();
    preview.close();
    await rehearsal.close();
    twitch.close();
    runtime.close();
    overlay.close();
    if (ownsDatabase) database.close();
  });
  if (dependencies.webRoot) {
    await app.register(staticFiles, { root: dependencies.webRoot, dotfiles: 'deny' });
  }
  const services: RiffServices = {
    collaboration,
    repo,
    runtime,
    overlay,
    hub,
    studio,
    authoring,
    proposals,
    rehearsal,
    scenes,
    twitch,
  };
  return Object.assign(app as FastifyInstance, { riff: services });
}
