import { createVoiceService } from './services/voice/service.js';
import type { TranscriptionTransport } from './services/voice/transport.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { createInsightsService } from './services/insights/service.js';
import { registerInsightsRoutes } from './routes/insights.js';
import {
  createChatAuthoringService,
  type ChatAuthoringService,
  type ChatReplies,
} from './services/chat-authoring/service.js';
import { chatAuthoringRepository } from './db/repositories/chat-authoring.js';
import { registerChatAuthoringRoutes } from './routes/chat-authoring.js';
import { createProductionService, type ProductionService } from './services/production/service.js';
import { registerProductionRoutes } from './routes/production.js';
import {
  createParticipationService,
  type ParticipationService,
} from './services/participation/service.js';
import { registerParticipationRoutes } from './routes/participation.js';
import { createRecipeService, type RecipeService } from './services/recipes/service.js';
import { registerRecipeRoutes } from './routes/recipes.js';
import type { TwitchAccess } from './services/recipes/install.js';
import { createEligibility } from './services/twitch/features.js';
import { createDirectorService, type DirectorService } from './services/director/service.js';
import { directorRepository } from './db/repositories/director.js';
import { registerDirectorRoutes } from './routes/director.js';
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
import {
  createChannelPointsService,
  type ChannelPointsService,
} from './services/channel-points/service.js';
import {
  createPredictionsService,
  type PredictionsService,
} from './services/predictions/service.js';
import { registerChannelPointsRoutes } from './routes/channel-points.js';
import {
  createTwitchFeatureService,
  type TwitchFeatureService,
} from './services/twitch-features/service.js';
import { twitchFeaturesRepository } from './db/repositories/twitch-features.js';
import { registerTwitchFeatureRoutes } from './routes/twitch-features.js';
import { createEchoLedger } from './services/twitch/echo-ledger.js';

/** The studio is operator-local: one home channel per server process. */
export const HOME_CHANNEL = 'home';

interface AppDependencies {
  production?: Pick<
    Parameters<typeof createProductionService>[0],
    'obsFactory' | 'botFactory' | 'firebotFactory'
  >;
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
  /** F09 push-to-talk transcription; null/omitted means voice is not configured. */
  transcription?: TranscriptionTransport | null;
  /** Test seam for host system chat replies; defaults to the Twitch connection. */
  chatReplies?: ChatReplies;
}

export function migrateConnection(database: DatabaseConnection) {
  migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
  });
}

export interface RiffServices {
  chatAuthoring: ChatAuthoringService;
  channelPoints: ChannelPointsService;
  predictions: PredictionsService;
  production: ProductionService;
  participation: ParticipationService;
  recipes: RecipeService;
  director: DirectorService;
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
  twitchFeatures: TwitchFeatureService;
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
  const directorRef: { current?: DirectorService } = {};
  const overlay = createOverlayBroker({
    submit: (...args) => directorRef.current?.submit(...args) ?? null,
    onClear: (reason) => directorRef.current?.clear(reason),
  });
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
  const productionRef: { current?: ProductionService } = {};
  const participationRef: { current?: ParticipationService } = {};
  const chatAuthoringRef: { current?: ChatAuthoringService } = {};
  const pointsRef: { current?: ChannelPointsService } = {};
  const predictionsRef: { current?: PredictionsService } = {};
  const twitchFeaturesRef: { current?: TwitchFeatureService } = {};
  const runtime = createLiveRuntime({
    onAuthorChat: (message) => chatAuthoringRef.current?.handle(message) ?? false,
    onPredictionProposal: (proposal) => predictionsRef.current?.propose(proposal),
    onTwitchActions: (actions, context) =>
      twitchFeaturesRef.current?.dispatch(actions, context) ?? Promise.resolve(),
    onHelpChat: (message) =>
      (participationRef.current?.language(message).consumed ||
        participationRef.current?.help(message).consumed) ??
      false,
    onSharedChat: (message) => shared.current?.member.input(message) ?? Promise.resolve(false),
    onStop: () => {
      try {
        productionRef.current?.stop();
      } catch {
        /* Memory fencing precedes best-effort disconnect. */
      }
      participationRef.current?.stop();
      try {
        chatAuthoringRef.current?.stop('Everything was stopped.');
      } catch {
        /* Codes are fenced in memory first. */
      }
      // Best effort after the in-memory fence: pause rewards, refund queue, lock prediction.
      void pointsRef.current?.onPanic().catch(() => undefined);
      void predictionsRef.current?.onPanic().catch(() => undefined);
      // Fences queued native actions in memory, then ends the poll Riff started.
      void twitchFeaturesRef.current?.panic().catch(() => undefined);
      stopCollaboration();
    },
    repo,
    hub,
    overlay,
    proposals,
    onProposalChange: proposalChanged,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  runtime.boot();
  const directorService = createDirectorService({
    storage: directorRepository(database, HOME_CHANNEL),
    repo,
    blocked: () => runtime.panicked,
    emit: (frame) => overlay.present(frame),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  directorRef.current = directorService;
  const directorTimer = setInterval(() => directorService.tick(), 100);
  directorTimer.unref();
  const studio = createStudioService({ repo, hub, runtime, overlay });
  const rehearsal = createRehearsalService(repo);
  const transport = dependencies.transport ?? createOfflineTransport({ delayMs: 250 });
  const queue = createCompileQueue();
  const participation = createParticipationService({
    database,
    repo,
    blocked: () => runtime.panicked,
    changed: () => hub.publish('studio', null),
    fairness: () => directorService.participation(),
    reply: (text, replyTo) => chatAuthoringRef.current?.systemReply(text, replyTo) ?? false,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  participationRef.current = participation;
  const recipeRef: { current?: RecipeService } = {};
  // F27 install-link compatibility reads Twitch facts once the connection exists below.
  const recipeTwitchRef: { current?: () => Promise<TwitchAccess> } = {};
  const scenes = createSceneService({
    database,
    repo,
    runtime,
    overlay,
    hub,
    transport,
    queue,
    presentation: (versionId) =>
      participation.presentation(versionId, recipeRef.current?.presentation(versionId) ?? null),
  });
  const recipes = createRecipeService({
    database,
    repo,
    transport,
    queue,
    saveScene: (versionId, scene) => scenes.save(versionId, 0, scene),
    rateSecret: dependencies.secret ?? null,
    twitchAccess: async () =>
      (await recipeTwitchRef.current?.()) ?? {
        connected: false,
        scopes: [],
        eligibility: 'unknown',
      },
    publicPresentation: participation.exportPresentation,
    reservedCommands: () => {
      const member = shared.current?.member.status();
      if (!member || !['connected', 'paused'].includes(member.state)) return [];
      const command = member.review?.contract.roles.find(
        (role) => role.id === member.review?.roleId,
      )?.command;
      return command ? [command] : [];
    },
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  recipeRef.current = recipes;
  hub.publish('studio', null);
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
    echoes: createEchoLedger(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    log: (message) => app.log.warn(message),
    onStatus: (status) => {
      if (status.state !== 'connected') stopCollaboration();
      else {
        void pointsRef.current?.refresh().catch(() => undefined);
        void predictionsRef.current?.refresh().catch(() => undefined);
      }
    },
    onRedemption: (redemption) => {
      void pointsRef.current?.handleRedemption(redemption).catch((error: unknown) => {
        app.log.warn({ err: error }, 'redemption handling failed');
      });
    },
    wantsChatWrite: () => chatAuthoringRef.current?.enabled() ?? false,
    onRaid: (raider) => {
      // F36: an opted-in shared session may hand presentation to this raided member channel.
      void shared.current?.member.raid(raider).catch(() => undefined);
      const { id, login, displayName } = raider;
      void twitchFeaturesRef.current
        ?.recordRaid({ id, login, displayName })
        .catch((error: unknown) => {
          app.log.warn({ err: error }, 'recording a raid failed');
        });
    },
    // F36: the coordinating channel verifies raid handoff from its own outgoing raids.
    wantsOutgoingRaids: () => shared.current?.coordinator.wantsRaids() ?? false,
    onOutgoingRaid: (raid) => {
      try {
        if (shared.current?.coordinator.recordRaid(raid).length) hub.publish('studio', null);
      } catch (error) {
        app.log.warn({ err: error }, 'recording an outgoing raid failed');
      }
    },
    hostTriggers: () =>
      twitchFeaturesRef.current?.wantsRaids() || shared.current?.member.wantsRaids()
        ? ['raid']
        : [],
  });
  const chatAuthoring = createChatAuthoringService({
    storage: chatAuthoringRepository(database, HOME_CHANNEL),
    repo,
    hub,
    authoring,
    approve: (versionId, expected) => studio.approve(versionId, expected),
    discard: (versionId) => studio.discard(versionId),
    blocked: () => runtime.panicked,
    chat: dependencies.chatReplies ?? {
      send: (text, replyTo) => twitch.sendChat(text, replyTo),
      status: () => twitch.chatReplies(),
    },
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  chatAuthoringRef.current = chatAuthoring;
  chatAuthoring.boot();
  const featureAccess = { api: () => twitch.api(), configured: twitch.configured };
  const recipeEligibility = createEligibility(featureAccess, dependencies.now ?? Date.now);
  recipeTwitchRef.current = async () => ({
    connected: twitch.api() !== null,
    scopes: twitch.scopes(),
    eligibility: await recipeEligibility.refresh(),
  });
  const changedSoon = () => hub.publish('studio', null);
  const channelPoints = createChannelPointsService({
    database,
    repo,
    access: featureAccess,
    route: (redemption) => runtime.handleRedemption(redemption),
    blocked: () => runtime.panicked,
    changed: changedSoon,
    subscription: () => twitch.redemptions,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  pointsRef.current = channelPoints;
  const predictions = createPredictionsService({
    database,
    repo,
    access: featureAccess,
    blocked: () => runtime.panicked,
    changed: changedSoon,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  predictionsRef.current = predictions;
  const twitchFeatures = createTwitchFeatureService({
    storage: twitchFeaturesRepository(database, HOME_CHANNEL),
    connection: twitch,
    blocked: () => runtime.panicked,
    automations: () =>
      repo.automations().flatMap((automation) => {
        const version = automation.activeVersionId
          ? repo.version(automation.activeVersionId)
          : null;
        const manifest = version?.manifest as { capabilities?: string[] } | undefined;
        return version
          ? [
              {
                automationId: automation.id,
                title: automation.title,
                capabilities: manifest?.capabilities ?? [],
                live: automation.status === 'live',
              },
            ]
          : [];
      }),
    record: (entry) => {
      let row;
      try {
        row = repo.record({
          ...entry,
          at: Date.now(),
          versionId: null,
          eventId: null,
          viewer: null,
        });
      } catch {
        row = null;
      }
      if (row) hub.publish('activity', row);
    },
    disable: (automationId) => {
      try {
        studio.pause(automationId);
      } catch {
        runtime.pause(automationId);
      }
    },
    changed: () => hub.publish('studio', null),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  twitchFeaturesRef.current = twitchFeatures;
  const twitchFeatureTimer = setInterval(
    () => void twitchFeatures.tick().catch(() => undefined),
    1000,
  );
  twitchFeatureTimer.unref();
  const publicUrl = dependencies.publicUrl ?? 'http://localhost:5173';
  const production = createProductionService({
    database,
    repo,
    secret: dependencies.secret ?? null,
    overlayUrl: () => `${publicUrl}/overlay/?key=${repo.state().overlayKey}`,
    blocked: () => runtime.panicked,
    control: (versionId, action) => {
      const version = repo.version(versionId);
      const automation = version ? repo.automation(version.automationId) : null;
      if (
        runtime.panicked ||
        !version ||
        !automation ||
        automation.activeVersionId !== versionId ||
        version.status !== 'active' ||
        !version.approvedAt ||
        version.incident
      )
        throw new Error('The exact approved interaction is unavailable.');
      repo.assertVersionLineage(versionId);
      if (action === 'pause') return studio.pause(automation.id);
      if (repo.session(automation.id)?.snapshot.phase === 'finished')
        studio.resetSession(automation.id);
      return studio.resumeAutomation(automation.id);
    },
    ...(dependencies.production ?? {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  productionRef.current = production;
  const productionTimer = setInterval(() => {
    void production.observe().catch(() => undefined);
  }, 1000);
  productionTimer.unref();
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
      case 'handoff':
        return coordinator.handoff(token, body as { eventId: string; fromChannelId: string });
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
  registerDirectorRoutes(app, directorService);
  registerParticipationRoutes(app, participation);
  registerProductionRoutes(app, production);
  registerRecipeRoutes(app, recipes, () => hub.publish('studio', null));
  registerCollaborationRoutes(app, {
    coordinator,
    member,
    identity: () => repo.state().twitchUserId,
    login: () => repo.state().twitchLogin,
    publicUrl,
    configured: !!sealer,
    ready: () => twitch.status.state === 'connected',
  });
  registerChatAuthoringRoutes(app, chatAuthoring);
  registerProposalRoutes(app, { proposals, authoring, repo, changed: proposalChanged });
  registerRealtimeRoutes(app, { hub, overlay, repo, twitch });
  registerTwitchRoutes(app, { twitch, publicUrl });
  registerVoiceRoutes(app, createVoiceService({ transport: dependencies.transcription ?? null }));
  registerInsightsRoutes(
    app,
    createInsightsService({
      database,
      channelId: HOME_CHANNEL,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    }),
  );
  registerChannelPointsRoutes(app, { points: channelPoints, predictions });
  registerTwitchFeatureRoutes(app, twitchFeatures);
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
    chatAuthoring.close();
    clearInterval(twitchFeatureTimer);
    twitchFeatures.close();
    clearInterval(directorTimer);
    directorService.close();
    participation.close();
    clearInterval(productionTimer);
    production.close();
    recipes.close();
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
    app.get('/recipes', (_request, reply) => reply.sendFile('index.html'));
    app.get('/recipes/install', (_request, reply) => reply.sendFile('index.html'));
    app.get('/participate', (_request, reply) => reply.sendFile('index.html'));
    app.get('/production-test', (_request, reply) => reply.sendFile('index.html'));
  }
  const services: RiffServices = {
    chatAuthoring,
    channelPoints,
    predictions,
    production,
    participation,
    recipes,
    director: directorService,
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
    twitchFeatures,
  };
  return Object.assign(app as FastifyInstance, { riff: services });
}
