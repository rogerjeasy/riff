import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  compile,
  sceneSchema,
  QueueFullError,
  type CompilerTransport,
  type createCompileQueue,
} from '@riff/compiler';
import { artifactIdentity, verifyCandidate, manifestSchema } from '@riff/sandbox';
import {
  DEFAULT_SCENE,
  type RecipePackage,
  type RecipeProfile,
  type RecipeLibraryState,
  type RecipeExportInput,
  type RecipeAdaptInput,
  type RecipeReview,
  type RecipeInstallInput,
  type RecipePresentation,
  type RecipePublication,
  type RecipeRemoveInput,
  type SceneDocument,
} from '@riff/sdk';
import type { DatabaseConnection } from '../../db/client.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import { recipeRepository, type RecipeRecord } from '../../db/repositories/recipes.js';
import { sceneRepository } from '../../db/repositories/scenes.js';
import {
  RECIPE_LIMITS,
  RecipeError,
  blockersFor,
  commandsOf,
  defaultProfile,
  describeError,
  digest,
  parsePackage,
  profileSchema,
  publicTests,
} from './contract.js';
import { rehearseArtifact } from './proof.js';
import { adaptationIntent, presentationFor } from './presentation.js';
import {
  assertReviewRoom,
  makeReportRoom,
  makeReviewRoom,
  recordRateAttempt,
} from './retention.js';

type Manifest = RecipePackage['manifest'];
type Verification = Awaited<ReturnType<typeof verifyCandidate>>;
type Candidate = { source: string; manifest: unknown; tests: unknown };

/** Readable check lines for every profile rule the generated manifest did not honour. */
function profileMismatches(manifest: Manifest, profile: RecipeProfile): string[] {
  const sameRoles = (left: string[], right: string[]) =>
    left.length === right.length && left.every((role) => right.includes(role));
  const { trigger, experience } = manifest;
  // Experiences map the profile command to the contribution command and the allowance to
  // the per-round resource; a rolling window has no round equivalent, so it is not compared.
  const rows: [string, string, string, boolean][] = experience
    ? [
        [
          'experience.contribution.command',
          profile.command,
          experience.contribution.command,
          profile.command === experience.contribution.command,
        ],
        [
          'trigger.audience',
          profile.audience.join(', '),
          trigger.audience.join(', '),
          sameRoles(profile.audience, trigger.audience),
        ],
        [
          'experience.resource.perParticipant',
          String(profile.maxPerViewer),
          String(experience.resource.perParticipant),
          profile.maxPerViewer === experience.resource.perParticipant,
        ],
      ]
    : [
        ['trigger.command', profile.command, trigger.command, profile.command === trigger.command],
        [
          'trigger.audience',
          profile.audience.join(', '),
          trigger.audience.join(', '),
          sameRoles(profile.audience, trigger.audience),
        ],
        [
          'trigger.maxPerViewer',
          String(profile.maxPerViewer),
          String(trigger.maxPerViewer),
          profile.maxPerViewer === trigger.maxPerViewer,
        ],
        [
          'trigger.windowMs',
          String(profile.windowMs),
          String(trigger.windowMs),
          profile.windowMs === trigger.windowMs,
        ],
      ];
  return rows
    .filter(([, , , same]) => !same)
    .map(
      ([field, wanted, generated]) =>
        `Profile mismatch — ${field}: the profile asks for ${wanted}, the generated candidate uses ${generated}.`,
    );
}
function failedStage(verification: Verification) {
  const stage = verification.stages.find((item) => item.status === 'failed');
  return stage ? ` (${stage.label}: ${stage.summary.slice(0, 120)})` : '';
}

export function createRecipeService(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  transport: CompilerTransport;
  queue: ReturnType<typeof createCompileQueue>;
  saveScene: (versionId: string, scene: SceneDocument) => unknown;
  reservedCommands?: () => string[];
  now?: () => number;
  /** Server secret keying report rate identities; a per-process key is used when absent. */
  rateSecret?: string | null;
  /** Deadline for adaptation and publication work. */
  deadlineMs?: number;
}) {
  const { repo } = deps,
    storage = recipeRepository(deps.database, repo.channelId),
    now = deps.now ?? Date.now,
    deadlineMs = deps.deadlineMs ?? RECIPE_LIMITS.deadlineMs,
    rateSecret = deps.rateSecret || randomBytes(32).toString('hex');
  const rateKeyOf = (client: string) =>
    createHmac('sha256', rateSecret).update(`riff-recipe-report-rate:${client}`).digest('hex');
  const empty = (): RecipeRecord => ({
    profile: defaultProfile(),
    imports: [],
    reviews: [],
    publications: [],
    reports: [],
    exports: [],
    exportedEditions: [],
    installations: {},
    rateKeys: {},
  });
  const read = () => storage.get() ?? empty();
  const mutate = <T>(change: (record: RecipeRecord) => T) =>
    deps.database.client.transaction(() => {
      const record = read();
      const result = change(record);
      storage.save(record);
      return structuredClone(result);
    })();
  const state = (): RecipeLibraryState => {
    const record = read();
    const { profile, imports, reviews, publications, reports } = record;
    const exports = record.exports.map((exportDigest) => {
      const edition = record.exportedEditions?.find((item) => item.digest === exportDigest);
      return {
        digest: exportDigest,
        recipeId: edition?.recipeId ?? null,
        revision: edition?.revision ?? null,
        title: edition?.title ?? null,
      };
    });
    const { imports: importCap, exports: exportCap, reviews: reviewCap } = RECIPE_LIMITS;
    return structuredClone({
      profile,
      imports,
      reviews,
      publications,
      reports,
      exports,
      limits: {
        imports: importCap,
        exports: exportCap,
        reviews: reviewCap,
        publications: RECIPE_LIMITS.publications,
        reports: RECIPE_LIMITS.reports,
        openReportsPerEdition: RECIPE_LIMITS.openReportsPerEdition,
      },
    });
  };

  let active: AbortController | null = null,
    closed = false;
  const stopped = () =>
    closed
      ? new RecipeError(
          'BLOCKED',
          'Recipe validation stopped because the server is shutting down. Nothing was saved.',
        )
      : new RecipeError(
          'BLOCKED',
          `Recipe validation timed out after ${Math.round(deadlineMs / 1000)} s. Nothing was saved; try again.`,
        );
  /** Single-flight, deadline-bounded work through the shared compiler queue. */
  const assertOpen = () => {
    if (closed)
      throw new RecipeError('BUSY', 'The server is shutting down. Try again after it restarts.');
  };
  async function exclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertOpen();
    if (active)
      throw new RecipeError(
        'BUSY',
        'Another recipe adaptation or publication is running. Wait for it to finish.',
      );
    const controller = new AbortController();
    active = controller;
    const timer = setTimeout(() => controller.abort(new Error('timeout')), deadlineMs);
    timer.unref();
    try {
      return await deps.queue.run(repo.channelId, () => work(controller.signal), {
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || closed) throw stopped();
      if (error instanceof QueueFullError)
        throw new RecipeError('BUSY', 'The compiler is busy, try again in a moment.');
      throw error;
    } finally {
      clearTimeout(timer);
      active = null;
    }
  }
  const assertRunning = (signal: AbortSignal) => {
    if (signal.aborted || closed) throw stopped();
  };

  const reservedCommands = () => new Set(['!riff', ...(deps.reservedCommands?.() ?? [])]);
  /** Host, shared-experience and other live commands stay with their current owner. */
  function assertCommandsFree(manifest: Manifest, target: string | null) {
    const proposed = commandsOf(manifest);
    const reserved = reservedCommands();
    if (proposed.some((command) => reserved.has(command)))
      throw new RecipeError(
        'CONFLICT',
        'The proposed command is reserved by host controls or a shared experience. Choose another command.',
      );
    const targetAutomation = target ? repo.version(target)?.automationId : null;
    for (const automation of repo.automations()) {
      if (automation.id === targetAutomation || !automation.activeVersionId) continue;
      const live = repo.version(automation.activeVersionId)?.manifest as Manifest | undefined;
      if (live?.trigger && commandsOf(live).some((command) => proposed.includes(command)))
        throw new RecipeError(
          'CONFLICT',
          'The proposed command is already used by a live interaction. Choose another command.',
        );
    }
  }
  /** The installation a version descends from, with the imported package it came from. */
  function installationFor(versionId: string, record = read()) {
    const seen = new Set<string>();
    let version = repo.version(versionId);
    while (version && !seen.has(version.id)) {
      seen.add(version.id);
      const installation = record.installations[version.id];
      if (installation)
        return {
          installation,
          sourcePackage: record.imports.find((item) => item.digest === installation.sourceDigest)
            ?.package,
        };
      version = version.parentVersionId ? repo.version(version.parentVersionId) : undefined;
    }
    return null;
  }
  /** Recipe id and revision for an export; explicit ids must belong to this channel. */
  function exportIdentity(record: RecipeRecord, input: RecipeExportInput) {
    if (!input.recipeId) {
      if (input.revision !== undefined && input.revision !== 1)
        throw new RecipeError(
          'CONFLICT',
          'A new recipe starts at revision 1. Leave the revision empty, or choose an existing recipe.',
        );
      return { recipeId: randomUUID(), revision: 1, latest: 0 };
    }
    const owned = [
      ...(record.exportedEditions ?? []),
      ...record.publications.map((publication) => publication.package),
    ].filter((edition) => edition.recipeId === input.recipeId);
    if (!owned.length)
      throw new RecipeError(
        'CONFLICT',
        'This channel has not exported that recipe. Export without a recipe id to start a new recipe.',
      );
    const latest = Math.max(...owned.map((edition) => edition.revision));
    return { recipeId: input.recipeId, revision: input.revision ?? latest + 1, latest };
  }

  async function generateCandidate(
    pack: RecipePackage,
    profile: RecipeProfile,
    target: string | null,
    signal: AbortSignal,
  ): Promise<Candidate & { verification: Verification }> {
    const intent = adaptationIntent(profile);
    const result = await compile(
      {
        intent,
        base: {
          title: pack.title,
          intent: pack.description,
          source: pack.source,
          manifest: pack.manifest,
          tests: pack.tests,
        },
      },
      deps.transport,
      { signal, verify: verifyCandidate },
    );
    repo.insertRun({
      id: randomUUID(),
      automationId: target ? (repo.version(target)?.automationId ?? null) : null,
      baseVersionId: target,
      intent,
      status: result.status,
      transport: result.transport,
      model: result.model,
      promptVersion: result.promptVersion,
      threadId: result.threadId,
      attempts: result.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        durationMs: attempt.durationMs,
        stages:
          attempt.verification?.stages.map((stage) => ({ id: stage.id, status: stage.status })) ??
          [],
      })),
      usage: result.usage,
      durationMs: result.durationMs,
      error: result.error,
      versionId: null,
    });
    assertRunning(signal);
    const output = result.final?.output;
    const verification = result.final?.verification;
    // A verified candidate that ignored the profile still becomes a failed, inspectable review.
    if (output?.kind === 'candidate' && output.source && verification?.ok)
      return {
        source: output.source,
        manifest: output.manifest,
        tests: output.tests,
        verification,
      };
    throw new RecipeError(
      'BLOCKED',
      result.status === 'question'
        ? 'The compiler asked a question instead of adapting this recipe. Adapt the exact source, or change the profile.'
        : result.status === 'unsupported'
          ? 'The compiler cannot adapt this recipe to the profile. Adapt the exact source instead.'
          : `Generation did not produce a verified candidate${result.error ? `: ${result.error}` : '.'}`,
    );
  }

  const api = {
    state,
    export(input: RecipeExportInput): RecipePackage {
      const version = repo.version(input.versionId);
      if (!version) throw new RecipeError('NOT_FOUND', 'Choose a local version to export.');
      if (input.rightsAttested !== true)
        throw new RecipeError('INVALID', 'Attest your distribution rights before export.');
      const record = read();
      const identity = exportIdentity(record, input);
      const inherited = installationFor(version.id, record);
      const parent = inherited?.sourcePackage;
      if (parent && input.license !== parent.license)
        throw new RecipeError(
          'INVALID',
          `Derivatives must keep the source license (${parent.license}). Choose ${parent.license}.`,
        );
      const manifest = version.manifest as Manifest;
      if (!manifest?.trigger)
        throw new RecipeError(
          'INVALID',
          'This version has no trigger to share. Verify it again first.',
        );
      const scene =
        sceneRepository(deps.database, repo.channelId).history(version.id).at(-1)?.scene ??
        DEFAULT_SCENE;
      const build = (revision: number) => {
        const content = {
          version: 1 as const,
          recipeId: identity.recipeId,
          revision,
          title: input.title,
          description: input.description,
          author: input.author,
          license: input.license,
          rightsAttested: true as const,
          source: version.source,
          manifest,
          tests: publicTests(
            version.tests,
            manifest.trigger.command,
            manifest.experience?.teams.map((team) => team.joinCommand),
          ),
          scene,
          presentation: {
            language: inherited?.installation.profile.language ?? record.profile.language,
            reducedMotion:
              inherited?.installation.profile.reducedMotion ?? record.profile.reducedMotion,
          },
          assets: [
            ...new Set(
              scene.nodes
                .flatMap((node) => (node.asset ? [node.asset] : []))
                .concat(['tomato', 'star', 'heart'] as const),
            ),
          ].map((id) => ({ id, credit: 'Riff' as const, license: 'project-license' as const })),
          lineage: parent
            ? [
                ...parent.lineage,
                {
                  recipeId: parent.recipeId,
                  revision: parent.revision,
                  digest: parent.digest,
                  author: parent.author,
                  license: parent.license,
                },
              ]
            : [],
        };
        return parsePackage({ ...content, digest: digest(content) });
      };
      const pack = build(identity.revision);
      const repeated = record.exports.includes(pack.digest);
      if (identity.latest && identity.revision !== identity.latest + 1 && !repeated)
        throw new RecipeError(
          'CONFLICT',
          `The next revision of this recipe is revision ${identity.latest + 1}.`,
        );
      mutate((current) => {
        if (current.exports.includes(pack.digest)) return;
        if (current.exports.length >= RECIPE_LIMITS.exports)
          throw new RecipeError(
            'LIMIT',
            `This channel keeps at most ${RECIPE_LIMITS.exports} exports. Remove an older export to make room.`,
          );
        current.exports.push(pack.digest);
        current.exportedEditions = [
          ...(current.exportedEditions ?? []),
          {
            digest: pack.digest,
            recipeId: pack.recipeId,
            revision: pack.revision,
            title: pack.title,
          },
        ];
      });
      return pack;
    },
    import(raw: unknown) {
      const pack = parsePackage(raw);
      return mutate((record) => {
        const prior = record.imports.find((item) => item.digest === pack.digest);
        if (prior) return prior;
        if (record.imports.length >= RECIPE_LIMITS.imports)
          throw new RecipeError(
            'LIMIT',
            `This library keeps at most ${RECIPE_LIMITS.imports} imported recipes. Remove an older import to make room.`,
          );
        const blockers = blockersFor(pack, record.profile.capabilities);
        const item = {
          digest: pack.digest,
          package: pack,
          supported: blockers.length === 0,
          blockers,
        };
        record.imports.push(item);
        return item;
      });
    },
    /** Remove an import or export to make room. Installed imports stay: exports need their credits. */
    remove(kind: RecipeRemoveInput['kind'], editionDigest: string) {
      mutate((record) => {
        if (kind === 'export') {
          if (!record.exports.includes(editionDigest))
            throw new RecipeError(
              'NOT_FOUND',
              'This export is not in your library. Reload the list.',
            );
          record.exports = record.exports.filter((item) => item !== editionDigest);
          record.exportedEditions = (record.exportedEditions ?? []).filter(
            (edition) => edition.digest !== editionDigest,
          );
          return;
        }
        if (!record.imports.some((item) => item.digest === editionDigest))
          throw new RecipeError(
            'NOT_FOUND',
            'This import is not in your library. Reload the list.',
          );
        const installed = Object.values(record.installations).filter(
          (installation) => installation.sourceDigest === editionDigest,
        ).length;
        if (installed)
          throw new RecipeError(
            'CONFLICT',
            `This recipe is installed as ${installed} local version${installed > 1 ? 's' : ''}. Keep the import so exports of ${installed > 1 ? 'those versions' : 'that version'} keep the original license and credits.`,
          );
        record.imports = record.imports.filter((item) => item.digest !== editionDigest);
        record.reviews = record.reviews.filter((review) => review.sourceDigest !== editionDigest);
      });
      return state();
    },
    saveProfile(expected: number, raw: Omit<RecipeProfile, 'revision'>) {
      const parsed = profileSchema.safeParse(raw);
      if (!parsed.success) throw new RecipeError('INVALID', describeError(parsed.error, 'profile'));
      mutate((record) => {
        if (expected !== record.profile.revision)
          throw new RecipeError('STALE', 'The profile changed. Reload before saving.');
        record.profile = { ...parsed.data, revision: expected + 1 };
        for (const imported of record.imports) {
          imported.blockers = blockersFor(imported.package, record.profile.capabilities);
          imported.supported = imported.blockers.length === 0;
        }
      });
      return state();
    },
    async adapt(input: RecipeAdaptInput): Promise<RecipeReview> {
      assertOpen();
      const snapshot = read(),
        profile = snapshot.profile,
        imported = snapshot.imports.find((item) => item.digest === input.sourceDigest);
      if (!imported) throw new RecipeError('NOT_FOUND', 'Import the pinned recipe first.');
      if (profile.revision !== input.profileRevision)
        throw new RecipeError('STALE', 'The profile changed. Review it again.');
      const pack = parsePackage(imported.package),
        blockers = blockersFor(pack, profile.capabilities);
      if (blockers.length) throw new RecipeError('UNSUPPORTED', blockers.join('; '));
      const target = input.targetVersionId ?? null;
      if (target && !repo.version(target))
        throw new RecipeError('NOT_FOUND', 'Choose a local update target.');
      // Bounds and reservations are checked before any model or sandbox work is spent.
      assertReviewRoom(snapshot.reviews, { sourceDigest: pack.digest, targetVersionId: target });
      if (input.generate && reservedCommands().has(profile.command))
        throw new RecipeError(
          'CONFLICT',
          'The proposed command is reserved by host controls or a shared experience. Choose another command.',
        );
      return exclusive(async (signal) => {
        let candidate: Candidate, verification: Verification;
        if (input.generate)
          ({ verification, ...candidate } = await generateCandidate(pack, profile, target, signal));
        else {
          candidate = { source: pack.source, manifest: pack.manifest, tests: pack.tests };
          verification = await verifyCandidate(candidate);
          assertRunning(signal);
        }
        if (!verification.ok)
          throw new RecipeError(
            'BLOCKED',
            `Local verification failed${failedStage(verification)}. Inspect the source and tests.`,
          );
        const checkedManifest = manifestSchema.safeParse(candidate.manifest);
        if (!checkedManifest.success)
          throw new RecipeError('BLOCKED', describeError(checkedManifest.error, 'manifest'));
        const manifest = checkedManifest.data as Manifest;
        const unsupported = blockersFor({ ...pack, manifest }, profile.capabilities);
        if (unsupported.length) throw new RecipeError('UNSUPPORTED', unsupported.join('; '));
        // Exact public validation also fences model-produced secrets and unsupported artwork.
        const adapted = { ...pack, ...candidate, manifest };
        parsePackage({
          ...adapted,
          digest: digest((({ digest: _digest, ...content }) => content)(adapted)),
        });
        assertCommandsFree(manifest, target);
        const artifact = { source: candidate.source, manifest };
        const { rehearsal, proof } = await rehearseArtifact(artifact, signal);
        assertRunning(signal);
        if (read().profile.revision !== profile.revision)
          throw new RecipeError('STALE', 'The profile changed during adaptation. Adapt again.');
        assertCommandsFree(manifest, target);
        const mismatches = input.generate ? profileMismatches(manifest, profile) : [];
        const differences: RecipeReview['differences'] = (
          ['trigger', 'capabilities', 'experience'] as const
        ).map((field) => ({
          field,
          before: JSON.stringify(pack.manifest[field] ?? null),
          after: JSON.stringify(manifest[field] ?? null),
        }));
        differences.push(
          { field: 'source', before: pack.source, after: candidate.source },
          {
            field: 'scene',
            before: JSON.stringify(pack.scene),
            after: JSON.stringify(profile.scene),
          },
          {
            field: 'presentation',
            before: JSON.stringify(pack.presentation),
            after: JSON.stringify({
              language: profile.language,
              reducedMotion: profile.reducedMotion,
              displayName: profile.displayName,
            }),
          },
        );
        const body = {
          verification,
          id: randomUUID(),
          sourceDigest: pack.digest,
          profileRevision: profile.revision,
          artifactId: artifactIdentity(artifact),
          ...candidate,
          manifest,
          scene: profile.scene,
          differences,
          passed: rehearsal.status === 'passed' && proof.accepted > 0 && mismatches.length === 0,
          checks: [
            'Local source verification',
            'Synthetic private crowd rehearsal',
            'Exact source/profile/scene binding',
            ...(input.generate && !mismatches.length
              ? ['Generated rules match the recipient profile']
              : mismatches),
            'Normal version and canvas approval still required',
          ],
          rehearsalHash: rehearsal.evidenceHash,
          installedVersionId: null,
          targetVersionId: target,
          proof,
          requiredTwitchScopes: ['user:read:chat'] as ['user:read:chat'],
        };
        const review = { ...body, digest: digest(body) };
        mutate((record) => {
          makeReviewRoom(record.reviews, review);
          record.reviews.push(review);
        });
        return review;
      });
    },
    install(input: RecipeInstallInput) {
      return mutate((record) => {
        const review = record.reviews.find((item) => item.id === input.reviewId);
        if (!review || review.digest !== input.digest)
          throw new RecipeError('STALE', 'Review the exact candidate before installing.');
        if (review.installedVersionId) {
          const installed = repo.version(review.installedVersionId);
          if (!installed)
            throw new RecipeError(
              'NOT_FOUND',
              'The version installed from this review no longer exists. Adapt the recipe again.',
            );
          return { versionId: installed.id, automationId: installed.automationId };
        }
        const { digest: reviewDigest, ...body } = review;
        if (
          digest(body) !== reviewDigest ||
          !review.passed ||
          review.profileRevision !== record.profile.revision
        )
          throw new RecipeError('STALE', 'The review or profile changed. Adapt again.');
        const pack = record.imports.find((item) => item.digest === review.sourceDigest)?.package;
        if (!pack)
          throw new RecipeError(
            'NOT_FOUND',
            'The source recipe is no longer imported. Import it again and adapt.',
          );
        parsePackage(pack);
        const unsupported = blockersFor(
          { ...pack, manifest: review.manifest },
          record.profile.capabilities,
        );
        if (unsupported.length) throw new RecipeError('UNSUPPORTED', unsupported.join('; '));
        assertCommandsFree(review.manifest, review.targetVersionId);
        const target = review.targetVersionId ? repo.version(review.targetVersionId) : null;
        if (review.targetVersionId && !target)
          throw new RecipeError(
            'STALE',
            'The update target no longer exists. Adapt again without it.',
          );
        const automationId = target?.automationId ?? repo.createAutomation(pack.title).id;
        const version = repo.insertVersion({
          automationId,
          parentVersionId: target?.id ?? null,
          artifactId: review.artifactId,
          title: pack.title,
          intent: pack.description,
          source: review.source,
          manifest: review.manifest,
          tests: review.tests,
          behavior: {},
          assumptions: [],
          evidence: {
            verification: review.verification,
            intent: [],
            remix: { digest: review.digest, rehearsalHash: review.rehearsalHash },
          },
          origin: 'manual',
          compileRunId: null,
          status: 'candidate',
        });
        deps.saveScene(version.id, sceneSchema.parse(review.scene));
        record.installations[version.id] = {
          versionId: version.id,
          automationId,
          sourceDigest: pack.digest,
          profile: structuredClone(record.profile),
        };
        review.installedVersionId = version.id;
        return { versionId: version.id, automationId };
      });
    },
    async publish(raw: unknown): Promise<RecipePublication> {
      assertOpen();
      const pack = parsePackage(raw);
      const notExported = () =>
        new RecipeError('BLOCKED', 'Publish a recipe explicitly exported by this channel.');
      /** Fail before rehearsal when the edition could never be stored. */
      const assertPublishable = (record: RecipeRecord) => {
        if (!record.exports.includes(pack.digest)) throw notExported();
        if (record.publications.length >= RECIPE_LIMITS.publications)
          throw new RecipeError(
            'LIMIT',
            `This channel already has ${RECIPE_LIMITS.publications} published editions, the maximum. This edition was not published.`,
          );
        if (
          record.publications.some(
            (publication) =>
              publication.package.recipeId === pack.recipeId &&
              publication.package.revision >= pack.revision,
          )
        )
          throw new RecipeError(
            'CONFLICT',
            'A newer or equal revision of this recipe is already published. Export the next revision.',
          );
      };
      const snapshot = read();
      const prior = snapshot.publications.find(
        (publication) => publication.package.digest === pack.digest,
      );
      if (prior) return structuredClone(prior);
      assertPublishable(snapshot);
      const proof = await exclusive(async (signal) => {
        const verified = await verifyCandidate(pack);
        assertRunning(signal);
        if (!verified.ok)
          throw new RecipeError(
            'BLOCKED',
            `Public demonstration requires passing source verification${failedStage(verified)}.`,
          );
        const { rehearsal, proof: evidence } = await rehearseArtifact(
          { source: pack.source, manifest: pack.manifest },
          signal,
        );
        assertRunning(signal);
        if (rehearsal.status !== 'passed')
          throw new RecipeError(
            'BLOCKED',
            'Public demonstration requires a passing synthetic rehearsal. Adapt or fix the recipe first.',
          );
        return evidence;
      });
      if (closed) throw stopped();
      return mutate((record) => {
        const existing = record.publications.find(
          (publication) => publication.package.digest === pack.digest,
        );
        if (existing) return existing;
        assertPublishable(record);
        const publication = { package: pack, withheld: false, samples: [], proof };
        record.publications.push(publication);
        return publication;
      });
    },
    directory(query = '') {
      const needle = query.slice(0, 100).toLowerCase();
      return storage
        .published()
        .reverse()
        .filter((publication) =>
          `${publication.package.title} ${publication.package.description} ${publication.package.author}`
            .toLowerCase()
            .includes(needle),
        )
        .slice(0, 20);
    },
    detail(editionDigest: string) {
      const publication = storage.published().find((item) => item.package.digest === editionDigest);
      if (!publication) throw new RecipeError('NOT_FOUND', 'This published recipe is unavailable.');
      return structuredClone(publication);
    },
    report(editionDigest: string, reason: string, client: string) {
      api.detail(editionDigest);
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500)
        throw new RecipeError('INVALID', 'Reports require 1–500 characters.');
      return mutate((record) => {
        const rateKeys = recordRateAttempt(record.rateKeys, rateKeyOf(client), now());
        const prior = record.reports.find(
          (report) => report.digest === editionDigest && report.reason === reason,
        );
        if (prior) return prior;
        makeReportRoom(record.reports, editionDigest);
        record.rateKeys = rateKeys;
        const report = {
          id: randomUUID(),
          digest: editionDigest,
          reason: reason.trim(),
          status: 'open' as const,
          createdAt: now(),
        };
        record.reports.push(report);
        return report;
      });
    },
    moderate(reportId: string, withhold: boolean) {
      mutate((record) => {
        const report = record.reports.find((item) => item.id === reportId);
        if (!report)
          throw new RecipeError(
            'NOT_FOUND',
            'This report no longer exists. Reload the report list.',
          );
        const publication = record.publications.find(
          (item) => item.package.digest === report.digest,
        );
        if (!publication)
          throw new RecipeError('NOT_FOUND', 'The reported edition is no longer published here.');
        if (withhold) publication.withheld = true;
        report.status = 'resolved';
      });
      return state();
    },
    restore(editionDigest: string, rightsAttested: boolean) {
      if (rightsAttested !== true)
        throw new RecipeError(
          'BLOCKED',
          'Confirm distribution rights before restoring a withheld edition.',
        );
      mutate((record) => {
        const publication = record.publications.find(
          (item) => item.package.digest === editionDigest,
        );
        if (!publication)
          throw new RecipeError('NOT_FOUND', 'This edition is not published by this channel.');
        if (
          record.reports.some(
            (report) => report.digest === editionDigest && report.status === 'open',
          )
        )
          throw new RecipeError(
            'BLOCKED',
            'Resolve every open report before restoring this edition.',
          );
        publication.withheld = false;
      });
      return state();
    },
    presentation(versionId: string): RecipePresentation | null {
      const inherited = installationFor(versionId),
        version = repo.version(versionId);
      const manifest = version?.manifest as Manifest | undefined;
      if (!inherited || !manifest?.trigger) return null;
      return presentationFor(inherited.installation.profile, manifest);
    },
    close() {
      closed = true;
      active?.abort();
    },
  };
  return api;
}
export type RecipeService = ReturnType<typeof createRecipeService>;
