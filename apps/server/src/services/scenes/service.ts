import { createHash } from 'node:crypto';
import {
  DEFAULT_SCENE,
  describeTrigger,
  type SceneDocument,
  type PermissionManifest,
  type ParticipationLanguage,
} from '@riff/sdk';
import {
  canonicalScene,
  classifySceneEdit,
  compileScene,
  sceneSchema,
  overlaps,
  describeAudience,
  describeWindow,
  type createCompileQueue,
  type CompilerTransport,
} from '@riff/compiler';
import { artifactIdentity, definitionCommands } from '@riff/sandbox';
import type { DatabaseConnection } from '../../db/client.js';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import { sceneRepository } from '../../db/repositories/scenes.js';
import type { Hub } from '../hub.js';
import type { LiveRuntime } from '../live/runtime.js';
import type { OverlayBroker, SceneProjection } from '../overlay/broker.js';
import { SceneError, type SceneRevision, type SceneState } from './contract.js';
export type { SceneState } from './contract.js';
const checks = [
  'Exact behavior artifact bound',
  'Objects contained in safe regions',
  'Protected camera and captions clear',
  'Critical text always visible and readable',
  'Trusted assets and bounded timing only',
];
function instructionsFor(version: VersionRow): string[] {
  const manifest = version.manifest as PermissionManifest;
  const who = manifest.trigger.audience.includes('viewer')
    ? 'Everyone'
    : describeAudience(manifest.trigger.audience);
  const e = manifest.experience;
  if (manifest.trigger.kind === 'twitch.event') return [describeTrigger(manifest.trigger)];
  if (!e)
    return [
      `${who}: type ${manifest.trigger.command} · ${manifest.trigger.maxPerViewer} per ${describeWindow(manifest.trigger.windowMs)}`.slice(
        0,
        200,
      ),
    ];
  const commands = e.teams.map((team) => team.joinCommand);
  const lines: string[] = [];
  for (let i = 0; i < commands.length; i += 4)
    lines.push(`Join a team: ${commands.slice(i, i + 4).join(' / ')}`);
  lines.push(
    `${who}: ${e.contribution.command} · ${e.resource.perParticipant} ${e.resource.name} per round`.slice(
      0,
      200,
    ),
  );
  const more = definitionCommands(e).filter(
    (command) => command !== e.contribution.command && !commands.includes(command),
  );
  if (more.length) lines.push(`Also: ${more.join(' / ')}`.slice(0, 200));
  return lines.slice(0, 4);
}
function digest(versionId: string, artifactId: string, revision: number, scene: SceneDocument) {
  return createHash('sha256')
    .update(JSON.stringify({ versionId, artifactId, revision, scene: canonicalScene(scene) }))
    .digest('hex');
}
/** Host scene lifecycle; no guest code, live effects or behavior mutations are accepted. */
export function createSceneService(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  runtime: LiveRuntime;
  overlay: OverlayBroker;
  hub: Hub;
  transport: CompilerTransport;
  queue: ReturnType<typeof createCompileQueue>;
  presentation?: (versionId: string) => {
    instructions: string[];
    language?: ParticipationLanguage;
    reducedMotion: boolean;
    highContrast?: boolean;
    effectLabels?: boolean;
    help?: true;
  } | null;
}) {
  const { repo, runtime, overlay, hub } = deps;
  const records = sceneRepository(deps.database, repo.channelId);
  const controllers = new Set<AbortController>();
  const mustVersion = (id: string) => {
    const v = repo.version(id);
    if (!v || !v.artifactId) throw new SceneError('NOT_FOUND');
    if (artifactIdentity({ source: v.source, manifest: v.manifest }) !== v.artifactId)
      throw new SceneError('BLOCKED');
    return { ...v, artifactId: v.artifactId };
  };
  function state(versionId: string): SceneState {
    const version = mustVersion(versionId);
    const head = records.head(versionId);
    if (head && head.artifactId !== version.artifactId) throw new SceneError('STALE');
    const history = records.history(versionId);
    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      if (
        !item ||
        item.revision !== i + 1 ||
        item.digest !== digest(versionId, version.artifactId, item.revision, item.scene)
      )
        throw new SceneError(
          'BLOCKED',
          'Stored scene evidence no longer matches its reviewed document.',
        );
    }
    if (
      head?.appliedRevision !== null &&
      head?.appliedRevision !== undefined &&
      !history.some((r) => r.revision === head.appliedRevision)
    )
      throw new SceneError('BLOCKED', 'Stored scene approval no longer names retained evidence.');
    const current: SceneRevision = history.at(-1) ?? {
      revision: 0,
      scene: structuredClone(DEFAULT_SCENE),
      source: 'default',
      classification: 'review',
      digest: digest(versionId, version.artifactId, 0, DEFAULT_SCENE),
    };
    if (head && current.revision !== head.revision) throw new SceneError('BLOCKED');
    return {
      ...current,
      versionId,
      artifactId: version.artifactId,
      appliedRevision: head?.appliedRevision ?? null,
      history,
      instructions: deps.presentation?.(version.id)?.instructions ?? instructionsFor(version),
      checks: [...checks],
    };
  }
  function save(
    versionId: string,
    expectedRevision: number,
    raw: unknown,
    source: SceneRevision['source'],
    generation?: SceneRevision['generation'],
  ): SceneState {
    const scene = sceneSchema.safeParse(raw);
    if (!scene.success) throw new SceneError('INVALID');
    return repo.atomic(() => {
      const previous = state(versionId);
      if (previous.revision !== expectedRevision) throw new SceneError('STALE');
      repo.assertVersionLineage(versionId);
      const approved =
        previous.history.find((r) => r.revision === previous.appliedRevision)?.scene ?? null;
      const next: SceneRevision = {
        revision: expectedRevision + 1,
        scene: scene.data,
        source,
        classification: classifySceneEdit(approved, scene.data),
        digest: digest(versionId, previous.artifactId, expectedRevision + 1, scene.data),
        ...(generation ? { generation } : {}),
      };
      records.append(versionId, previous.artifactId, expectedRevision, next);
      return state(versionId);
    });
  }
  function healthy(version: VersionRow) {
    const a = repo.automation(version.automationId);
    if (
      runtime.panicked ||
      version.status !== 'active' ||
      version.approvedAt === null ||
      a?.activeVersionId !== version.id ||
      a.status !== 'live'
    )
      return false;
    const evidence = version.evidence as {
      verification?: { ok?: boolean };
      intent?: { status?: string }[];
    };
    if (
      evidence.verification?.ok !== true ||
      !Array.isArray(evidence.intent) ||
      evidence.intent.some((c) => c.status === 'mismatch')
    )
      return false;
    try {
      mustVersion(version.id);
      repo.assertVersionLineage(version.id);
      return true;
    } catch {
      return false;
    }
  }
  /** Applied (or default) scenes of the other healthy live interactions. */
  function liveScenes(exceptAutomationId: string) {
    const out: { title: string; scene: SceneDocument }[] = [];
    for (const other of repo.automations()) {
      if (other.id === exceptAutomationId || !other.activeVersionId) continue;
      const otherVersion = repo.version(other.activeVersionId);
      if (!otherVersion || !healthy(otherVersion)) continue;
      try {
        const otherState = state(otherVersion.id);
        out.push({
          title: other.title.slice(0, 60),
          scene:
            otherState.history.find((r) => r.revision === otherState.appliedRevision)?.scene ??
            DEFAULT_SCENE,
        });
      } catch {
        /* Unreadable peers are withdrawn from the overlay, so they cannot collide. */
      }
    }
    return out;
  }
  /** Shared space is resolved on stream (instructions combine, scoreboards move); protected areas never are. */
  function collisions(a: SceneDocument, b: SceneDocument) {
    const critical = (kind: string) => kind === 'instructions' || kind === 'scoreboard';
    return {
      protectedArea:
        a.nodes.some((n) => b.regions.some((r) => r.protected && overlaps(n.rect, r.rect))) ||
        b.nodes.some((n) => a.regions.some((r) => r.protected && overlaps(n.rect, r.rect))),
      text: a.nodes.some((n) =>
        b.nodes.some((m) => (critical(n.kind) || critical(m.kind)) && overlaps(n.rect, m.rect)),
      ),
    };
  }
  /** Creator-facing state, with a plain note for every live interaction sharing the screen. */
  function view(versionId: string) {
    const current = state(versionId);
    const version = repo.version(versionId);
    const sharing: string[] = [];
    if (version)
      for (const other of liveScenes(version.automationId)) {
        const hit = collisions(current.scene, other.scene);
        if (hit.protectedArea)
          sharing.push(
            `“${other.title}” protects part of the screen this layout uses. Move it before applying.`,
          );
        else if (hit.text)
          sharing.push(
            `Shares screen space with “${other.title}”. On stream Riff keeps all text readable: shared instructions combine into one panel, a scoreboard moves to free space in its area, and effects pass behind the other text.`,
          );
      }
    return { ...current, sharing: [...new Set(sharing)].slice(0, 16) };
  }
  function publish() {
    const frames: SceneProjection[] = [];
    try {
      if (!runtime.panicked)
        for (const a of repo.automations()) {
          const version = a.activeVersionId ? repo.version(a.activeVersionId) : null;
          if (!version || !healthy(version)) continue;
          try {
            const current = state(version.id);
            const applied = current.history.find((r) => r.revision === current.appliedRevision);
            const scene = sceneSchema.parse(applied?.scene ?? DEFAULT_SCENE);
            const presentation = deps.presentation?.(version.id);
            frames.push({
              ...(presentation
                ? {
                    reducedMotion: presentation.reducedMotion,
                    ...(presentation.highContrast !== undefined
                      ? { highContrast: presentation.highContrast }
                      : {}),
                    ...(presentation.effectLabels !== undefined
                      ? { effectLabels: presentation.effectLabels }
                      : {}),
                    ...(presentation.help ? { help: true as const } : {}),
                    ...(presentation.language ? { language: presentation.language } : {}),
                  }
                : {}),
              automationId: a.id,
              versionId: version.id,
              revision: applied?.revision ?? 0,
              digest: applied?.digest ?? digest(version.id, current.artifactId, 0, DEFAULT_SCENE),
              scene,
              instructions: presentation?.instructions ?? instructionsFor(version),
            });
          } catch {
            /* Invalid persisted presentation is withdrawn, never forwarded. */
          }
        }
    } catch {
      // Read failure withdraws cached output and preserves the subscription for recovery.
      frames.length = 0;
    }
    overlay.setScenes(frames);
  }
  const unsubscribe = hub.subscribe((message) => {
    if (message.type === 'studio') publish();
  });
  publish();
  return {
    state,
    view,
    /** Carry only an exact already-approved presentation; behavior still needs its own approval. */
    inherit(versionId: string, parentVersionId: string) {
      return repo.atomic(() => {
        const version = mustVersion(versionId),
          parent = mustVersion(parentVersionId);
        if (
          version.parentVersionId !== parent.id ||
          version.approvedAt !== null ||
          records.head(versionId)
        )
          throw new SceneError('STALE');
        repo.assertVersionLineage(versionId);
        const previous = state(parentVersionId);
        const approved = previous.history.find((r) => r.revision === previous.appliedRevision);
        if (!approved || (parent.approvedAt === null && approved.source !== 'inherited')) return;
        const scene = sceneSchema.parse(approved.scene);
        const next: SceneRevision = {
          revision: 1,
          scene,
          source: 'inherited',
          classification: 'configuration',
          digest: digest(versionId, version.artifactId, 1, scene),
          inheritedFrom: {
            versionId: parentVersionId,
            revision: approved.revision,
            digest: approved.digest,
          },
        };
        records.append(versionId, version.artifactId, 0, next);
        records.apply(versionId, 1);
      });
    },
    save(versionId: string, expectedRevision: number, scene: unknown) {
      save(versionId, expectedRevision, scene, 'direct');
      return view(versionId);
    },
    undo(versionId: string, expectedRevision: number, targetRevision: number) {
      const current = state(versionId);
      const target =
        targetRevision === 0
          ? DEFAULT_SCENE
          : current.history.find((r) => r.revision === targetRevision)?.scene;
      if (!target) throw new SceneError('NOT_FOUND');
      save(versionId, expectedRevision, target, 'undo');
      return view(versionId);
    },
    apply(versionId: string, expectedRevision: number, expectedDigest: string) {
      const result = repo.atomic(() => {
        const current = state(versionId);
        if (
          current.revision !== expectedRevision ||
          current.digest !== expectedDigest ||
          expectedRevision === 0
        )
          throw new SceneError('STALE');
        const version = mustVersion(versionId);
        if (!healthy(version)) throw new SceneError('BLOCKED');
        sceneSchema.parse(current.scene);
        for (const other of liveScenes(version.automationId))
          if (collisions(current.scene, other.scene).protectedArea)
            throw new SceneError(
              'BLOCKED',
              `This layout overlaps an area another active interaction (“${other.title}”) protects. Move it, or pause that interaction, before applying.`,
            );
        records.apply(versionId, expectedRevision);
        repo.record({
          at: Date.now(),
          kind: 'control',
          automationId: version.automationId,
          versionId,
          eventId: null,
          viewer: null,
          code: 'SCENE_APPLIED',
          message: `Applied reviewed scene revision ${expectedRevision} (${expectedDigest.slice(0, 12)}).`,
        });
        return state(versionId);
      });
      publish();
      hub.publish('studio', null);
      return { ...result, sharing: view(versionId).sharing };
    },
    async generate(
      versionId: string,
      input: { expectedRevision: number; selectionId: string; intent: string },
      signal?: AbortSignal,
    ) {
      const current = state(versionId);
      if (current.revision !== input.expectedRevision) throw new SceneError('STALE');
      repo.assertVersionLineage(versionId);
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, 180_000);
      try {
        return await deps.queue.run(
          repo.channelId,
          async () => {
            if (controller.signal.aborted) throw new SceneError('CANCELLED');
            const generated = await compileScene(
              { scene: current.scene, selectionId: input.selectionId, intent: input.intent },
              deps.transport,
              { signal: controller.signal },
            );
            if (controller.signal.aborted) throw new SceneError('CANCELLED');
            const { scene, ...metadata } = generated;
            save(versionId, input.expectedRevision, scene, 'generated', {
              ...metadata,
              intent: input.intent,
              selectionId: input.selectionId,
            });
            return view(versionId);
          },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controllers.delete(controller);
      }
    },
    publish,
    close() {
      unsubscribe();
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}
export type SceneService = ReturnType<typeof createSceneService>;
