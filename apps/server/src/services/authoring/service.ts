import { randomUUID } from 'node:crypto';
import {
  compile,
  createCompileQueue,
  QueueFullError,
  type CompileRequest,
  type CompileResult,
  type CompileStage,
  type CompilerProgress,
  type CompilerTransport,
} from '@riff/compiler';
import { verifyCandidate, type VerificationReport } from '@riff/sandbox';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { Hub } from '../hub.js';
import type { Evidence } from '../automations/views.js';

export class AuthoringError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'QUEUE_FULL' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}
export interface RunSnapshot {
  id: string;
  intent: string;
  automationId: string | null;
  baseVersionId: string | null;
  stage: CompileStage;
  attempt: number;
  transport: CompilerTransport['kind'];
  model: string | null;
  startedAt: number;
  progress: (CompilerProgress & { at: number })[];
  result: {
    status: CompileResult<VerificationReport>['status'];
    versionId: string | null;
    error: string | null;
    question: string | null;
    choices: string[];
    unsupportedReason: string | null;
    alternative: string | null;
    threadId: string | null;
    durationMs: number;
  } | null;
}

/** Runs compile jobs, persists every run and turns successful output into candidates. */
export function createAuthoringService(deps: {
  repo: ChannelRepository;
  hub: Hub;
  transport: CompilerTransport;
  queue?: ReturnType<typeof createCompileQueue>;
}) {
  const { repo, hub, transport } = deps;
  const queue = deps.queue ?? createCompileQueue();
  const live = new Map<string, { snapshot: RunSnapshot; controller: AbortController }>();
  const publish = (snapshot: RunSnapshot) => hub.publish('run', snapshot);

  function persist(
    snapshot: RunSnapshot,
    result: CompileResult<VerificationReport> | null,
    versionId: string | null,
  ) {
    try {
      repo.updateRun(snapshot.id, {
        status: snapshot.stage,
        threadId: result?.threadId ?? null,
        attempts: result?.attempts ?? [],
        usage: result?.usage ?? null,
        durationMs: Date.now() - snapshot.startedAt,
        error: result?.error ?? null,
        versionId,
      });
    } catch {
      /* Run records are audit data; a write failure must not hide the result. */
    }
  }

  function storeCandidate(
    snapshot: RunSnapshot,
    result: CompileResult<VerificationReport>,
    base: VersionRow | undefined,
  ) {
    const final = result.final;
    const output = final?.output;
    if (!final || !output || output.kind !== 'candidate' || !final.verification) return null;
    const automationId = base?.automationId ?? repo.createAutomation(output.title).id;
    const evidence: Evidence = { verification: final.verification, intent: final.intent };
    const version = repo.insertVersion({
      automationId,
      parentVersionId: base?.id ?? null,
      artifactId: final.verification.artifactId,
      title: base?.title ?? output.title,
      intent: snapshot.intent,
      source: output.source ?? '',
      manifest: output.manifest,
      tests: output.tests,
      behavior: output.behavior,
      assumptions: output.assumptions,
      evidence,
      origin: transport.kind === 'codex' ? 'codex' : 'offline',
      compileRunId: snapshot.id,
      status: result.status === 'ready' ? 'candidate' : 'failed',
    });
    return version;
  }

  return {
    transport: { kind: transport.kind, model: transport.model },
    runs() {
      return [...live.values()].map(({ snapshot }) => snapshot);
    },
    /** Start generation for a new interaction or an edit of `baseVersionId`. */
    start(input: { intent: string; baseVersionId: string | null }): RunSnapshot {
      const base = input.baseVersionId ? repo.version(input.baseVersionId) : undefined;
      if (input.baseVersionId && !base)
        throw new AuthoringError('NOT_FOUND', 'That version no longer exists.');
      if (queue.position(repo.channelId) >= 3)
        throw new AuthoringError('QUEUE_FULL', new QueueFullError().message);
      const snapshot: RunSnapshot = {
        id: randomUUID(),
        intent: input.intent,
        automationId: base?.automationId ?? null,
        baseVersionId: base?.id ?? null,
        stage: 'queued',
        attempt: 0,
        transport: transport.kind,
        model: transport.model,
        startedAt: Date.now(),
        progress: [],
        result: null,
      };
      const controller = new AbortController();
      live.set(snapshot.id, { snapshot, controller });
      repo.insertRun({
        id: snapshot.id,
        automationId: snapshot.automationId,
        baseVersionId: snapshot.baseVersionId,
        intent: input.intent,
        status: 'queued',
        transport: transport.kind,
        model: transport.model,
        promptVersion: 'pending',
        threadId: null,
        attempts: [],
        usage: null,
        durationMs: null,
        error: null,
        versionId: null,
      });
      publish(snapshot);
      const request: CompileRequest = {
        intent: input.intent,
        base: base
          ? {
              title: base.title,
              intent: base.intent,
              source: base.source,
              manifest: base.manifest,
              tests: base.tests,
            }
          : null,
      };
      const job = async () => {
        const result = await compile(request, transport, {
          signal: controller.signal,
          verify: verifyCandidate,
          onStage(stage, attempt) {
            snapshot.stage = stage;
            snapshot.attempt = attempt;
            publish(snapshot);
          },
          onProgress(progress) {
            const entry = { ...progress, at: Date.now() };
            snapshot.progress = [...snapshot.progress.slice(-39), entry];
            hub.publish('run-progress', { id: snapshot.id, entry });
          },
        });
        const version = storeCandidate(snapshot, result, base);
        const output = result.final?.output;
        snapshot.stage = result.status;
        snapshot.automationId = version?.automationId ?? snapshot.automationId;
        snapshot.result = {
          status: result.status,
          versionId: version?.id ?? null,
          error: result.error,
          question: output?.question ?? null,
          choices: output?.choices ?? [],
          unsupportedReason: output?.unsupportedReason ?? null,
          alternative: output?.alternative ?? null,
          threadId: result.threadId,
          durationMs: result.durationMs,
        };
        persist(snapshot, result, version?.id ?? null);
        try {
          repo.updateRun(snapshot.id, { promptVersion: result.promptVersion });
        } catch {
          /* audit only */
        }
        publish(snapshot);
        hub.publish('studio', null);
      };
      queue
        .run(repo.channelId, job, {
          signal: controller.signal,
          onQueued: () => publish(snapshot),
        })
        .catch((error: unknown) => {
          snapshot.stage = controller.signal.aborted ? 'cancelled' : 'failed';
          snapshot.result = {
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            versionId: null,
            error: controller.signal.aborted
              ? 'Generation was cancelled.'
              : error instanceof Error
                ? error.message
                : 'Generation failed.',
            question: null,
            choices: [],
            unsupportedReason: null,
            alternative: null,
            threadId: null,
            durationMs: Date.now() - snapshot.startedAt,
          };
          persist(snapshot, null, null);
          publish(snapshot);
        })
        .finally(() => {
          setTimeout(() => live.delete(snapshot.id), 60_000).unref();
        });
      return snapshot;
    },
    cancel(id: string) {
      const run = live.get(id);
      if (!run) throw new AuthoringError('NOT_FOUND', 'That generation is not running.');
      run.controller.abort();
      return run.snapshot;
    },
    close() {
      for (const { controller } of live.values()) controller.abort();
    },
  };
}
export type AuthoringService = ReturnType<typeof createAuthoringService>;
