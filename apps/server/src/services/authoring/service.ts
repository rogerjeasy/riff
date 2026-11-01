import type { RehearsalService } from '../rehearsal/service.js';
import { rehearsalScenarioHash } from '@riff/sandbox';
import { ProposalError, type ProposalService } from '../proposals/service.js';
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
import { type VerificationReport } from '@riff/sandbox';
import { verifyAuthoredCandidate, type AuthoringVerification } from './verify-migration.js';
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
  selectionId?: string;
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
  proposals?: ProposalService;
  rehearsal?: RehearsalService;
  inheritScene?: (versionId: string, parentVersionId: string) => void;
}) {
  const { repo, hub, transport } = deps;
  const queue = deps.queue ?? createCompileQueue();
  const authorizeSelection = (id: string) => {
    if (!deps.proposals) throw new ProposalError('FORBIDDEN');
    return deps.proposals.assertSelectionAuthorized(id);
  };
  repo.reconcileProposalRuns();
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
        error: result?.error ?? snapshot.result?.error ?? null,
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
    if (snapshot.selectionId) authorizeSelection(snapshot.selectionId);
    if (base) repo.assertVersionLineage(base.id);
    const final = result.final;
    const output = final?.output;
    if (!final || !output || output.kind !== 'candidate' || !final.verification) return null;
    const automationId = base?.automationId ?? repo.createAutomation(output.title).id;
    const migration = (final.verification as AuthoringVerification).migration;
    const rehearsal = (final.verification as AuthoringVerification).rehearsal;
    const evidence: Evidence = {
      ...(rehearsal ? { rehearsal } : {}),
      verification: final.verification,
      intent: final.intent,
      ...(migration ? { migration } : {}),
    };
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
    if (base?.artifactId && version.artifactId && result.status === 'ready')
      deps.inheritScene?.(version.id, base.id);
    return version;
  }

  return {
    transport: { kind: transport.kind, model: transport.model },
    runs() {
      return [...live.values()].map(({ snapshot }) => snapshot);
    },
    /** Start generation for a new interaction or an edit of `baseVersionId`. */
    start(input: {
      intent: string;
      baseVersionId: string | null;
      selectionId?: string;
      regressionId?: string;
    }): RunSnapshot {
      if (input.selectionId) {
        const previous = repo.generationForSelection(input.selectionId);
        if (previous) {
          const running = live.get(previous.runId);
          if (running) return running.snapshot;
          const row = repo.run(previous.runId);
          if (!row) throw new AuthoringError('CONFLICT', 'Generation record is unavailable.');
          const attempts = row.attempts as CompileResult<VerificationReport>['attempts'];
          const output = attempts.at(-1)?.output;
          return {
            id: row.id,
            selectionId: input.selectionId,
            intent: row.intent,
            automationId: row.automationId,
            baseVersionId: row.baseVersionId,
            stage: row.status as CompileStage,
            attempt: Array.isArray(row.attempts) ? row.attempts.length : 0,
            transport: row.transport as CompilerTransport['kind'],
            model: row.model,
            startedAt: row.createdAt,
            progress: [],
            result: {
              status: row.status as CompileResult<VerificationReport>['status'],
              versionId: row.versionId,
              error: row.error,
              question: output?.question ?? null,
              choices: output?.choices ?? [],
              unsupportedReason: output?.unsupportedReason ?? null,
              alternative: output?.alternative ?? null,
              threadId: row.threadId,
              durationMs: row.durationMs ?? 0,
            },
          };
        }
        const selected = authorizeSelection(input.selectionId);
        input = {
          intent: selected.brief,
          baseVersionId: selected.baseVersionId,
          selectionId: selected.id,
        };
      }
      const base = input.baseVersionId ? repo.version(input.baseVersionId) : undefined;
      if (input.baseVersionId && !base)
        throw new AuthoringError('NOT_FOUND', 'That version no longer exists.');
      if (base) repo.assertVersionLineage(base.id);
      const pinned = deps.rehearsal?.applicable(base?.id ?? null) ?? [];
      if (input.regressionId && !pinned.some((item) => item.id === input.regressionId))
        throw new AuthoringError(
          'CONFLICT',
          'The selected regression is not applicable to this version.',
        );
      const rehearsalContext: CompileRequest['rehearsalContext'] = pinned.length
        ? {
            version: 1,
            regressions: pinned.map((item) => {
              // Include the target and a bounded sample. Full immutable input stays host-owned.
              let steps = item.scenario.steps.filter(
                (step, i) => i < 12 || step.key === item.failure.stepKey,
              );
              const describe = () =>
                JSON.stringify({
                  partial: true,
                  seed: item.scenario.seed,
                  initialAt: item.scenario.initialAt,
                  hasInitialSession: !!item.scenario.initialSession,
                  steps,
                  expectations: item.scenario.expectations.filter(
                    (check) => check.stepKey === item.failure.stepKey,
                  ),
                  provenance: item.scenario.provenance,
                });
              while (Buffer.byteLength(describe(), 'utf8') > 8192 && steps.length > 1) {
                const index = steps.findIndex((step) => step.key !== item.failure.stepKey);
                if (index < 0) break;
                steps = steps.filter((_, i) => i !== index);
              }
              const data = describe();
              return {
                id: item.id,
                originVersionId: item.originVersionId,
                scenarioHash: rehearsalScenarioHash(item.scenario),
                checkId: item.checkId,
                expected: item.failure.expected,
                actual: item.failure.actual,
                summary: 'A retained independent host check failed on its origin version.',
                scenario:
                  Buffer.byteLength(data, 'utf8') <= 8192
                    ? data
                    : JSON.stringify({
                        partial: true,
                        target: item.failure.stepKey,
                        omitted: 'Input exceeds compiler evidence budget.',
                      }),
              };
            }),
          }
        : undefined;
      if (rehearsalContext) {
        // Inner JSON is a string here: its quotes/backslashes escape again. Budget
        // the final serialized envelope, preserving every identity and host check.
        const contextBytes = () => Buffer.byteLength(JSON.stringify(rehearsalContext), 'utf8');
        const largestSamples = [...rehearsalContext.regressions].sort(
          (a, b) =>
            Buffer.byteLength(JSON.stringify(b.scenario), 'utf8') -
            Buffer.byteLength(JSON.stringify(a.scenario), 'utf8'),
        );
        for (const item of largestSamples) {
          if (contextBytes() <= 96 * 1024) break;
          item.scenario = JSON.stringify({
            partial: true,
            target: pinned.find((regression) => regression.id === item.id)?.failure.stepKey,
            omitted: 'Input omitted to fit aggregate compiler evidence budget.',
          });
        }
        if (contextBytes() > 96 * 1024)
          throw new AuthoringError('CONFLICT', 'Private compiler evidence is unavailable.');
      }
      if (queue.position(repo.channelId) >= 3)
        throw new AuthoringError('QUEUE_FULL', new QueueFullError().message);
      const snapshot: RunSnapshot = {
        id: randomUUID(),
        ...(input.selectionId ? { selectionId: input.selectionId } : {}),
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
      repo.atomic(() => {
        if (input.selectionId && repo.generationForSelection(input.selectionId))
          throw new AuthoringError(
            'CONFLICT',
            'A generation already exists for this selection. Refresh to see its result.',
          );
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
        if (input.selectionId) repo.linkSelectionRun(input.selectionId, snapshot.id);
      });
      live.set(snapshot.id, { snapshot, controller });
      publish(snapshot);
      const request: CompileRequest = {
        intent: input.intent,
        ...(rehearsalContext ? { rehearsalContext } : {}),
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
        if (snapshot.selectionId) authorizeSelection(snapshot.selectionId);
        if (base) repo.assertVersionLineage(base.id);
        if (controller.signal.aborted) throw new ProposalError('REVOKED');
        const result = await compile(request, transport, {
          signal: controller.signal,
          verify: async (candidate) => {
            const report = await verifyAuthoredCandidate(candidate, base?.manifest);
            if (!deps.rehearsal || !pinned.length) return report;
            const rehearsal = await deps.rehearsal.verifyRegressions(
              candidate,
              pinned,
              controller.signal,
            );
            const failed = rehearsal.some((item) => !item.ok);
            return {
              ...report,
              rehearsal,
              ok: report.ok && !failed,
              failureReport: failed
                ? [
                    report.failureReport,
                    'Independent rehearsal regressions failed. Saved expectations cannot be weakened.',
                    ...rehearsal
                      .filter((item) => !item.ok)
                      .map((item) => `Regression ${item.regressionId}: ${item.failure}`),
                  ]
                    .filter(Boolean)
                    .join('\n')
                    .slice(0, 4096)
                : report.failureReport,
            };
          },
          onStage(stage, attempt) {
            snapshot.stage = stage;
            snapshot.attempt = attempt;
            repo.updateRun(snapshot.id, { status: stage });
            publish(snapshot);
          },
          onProgress(progress) {
            const entry = { ...progress, at: Date.now() };
            snapshot.progress = [...snapshot.progress.slice(-39), entry];
            hub.publish('run-progress', { id: snapshot.id, entry });
          },
        });
        if (controller.signal.aborted) throw new ProposalError('REVOKED');
        const version = repo.atomic(() => storeCandidate(snapshot, result, base));
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
                ? error instanceof ProposalError
                  ? 'The audience selection is no longer authorized. Create a new selection.'
                  : 'Generation failed.'
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
    reconcileSelections() {
      for (const { snapshot, controller } of live.values()) {
        if (snapshot.result) continue;
        try {
          if (snapshot.selectionId) authorizeSelection(snapshot.selectionId);
          if (snapshot.baseVersionId) repo.assertVersionLineage(snapshot.baseVersionId);
        } catch (error) {
          if (!(error instanceof ProposalError)) throw error;
          controller.abort();
        }
      }
      repo.invalidateUnauthorizedTransitions();
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
