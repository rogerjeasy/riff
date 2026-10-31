import {
  compileOutputSchema,
  compileRequestSchema,
  type CompileOutput,
  type CompileRequest,
} from './contract.js';
import { checkIntent, type IntentCheck, type ManifestView } from './intent.js';
import type { CompilerProgress, CompilerTransport, CompilerUsage } from './transport.js';
import { buildPrompt, buildRepairPrompt, buildWorkspace, PROMPT_VERSION } from './workspace.js';

export const COMPILE_LIMITS = Object.freeze({
  timeoutMs: 180_000,
  repairRounds: 1,
  reportBytes: 4096,
});

export type CompileStage =
  | 'queued'
  | 'drafting'
  | 'verifying'
  | 'repairing'
  | 'ready'
  | 'question'
  | 'unsupported'
  | 'failed'
  | 'cancelled';
/** Minimal view of the host verification report the orchestrator relies on. */
export interface VerificationLike {
  ok: boolean;
  failureReport: string | null;
}
export interface CompileAttempt<V extends VerificationLike> {
  attempt: number;
  output: CompileOutput | null;
  outputError: string | null;
  verification: V | null;
  intent: IntentCheck[];
  durationMs: number;
}
export interface CompileResult<V extends VerificationLike> {
  status: 'ready' | 'question' | 'unsupported' | 'failed' | 'cancelled';
  transport: CompilerTransport['kind'];
  model: string | null;
  promptVersion: string;
  threadId: string | null;
  attempts: CompileAttempt<V>[];
  final: CompileAttempt<V> | null;
  usage: CompilerUsage | null;
  durationMs: number;
  error: string | null;
}
export interface CompileHooks<V extends VerificationLike> {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStage?: (stage: CompileStage, attempt: number) => void;
  onProgress?: (progress: CompilerProgress) => void;
  /** Host verification (sandbox pipeline), injected by the server. */
  verify: (candidate: { source: string; manifest: unknown; tests: unknown }) => Promise<V>;
}

const sumUsage = (a: CompilerUsage | null, b: CompilerUsage | null): CompilerUsage | null =>
  !a
    ? b
    : !b
      ? a
      : {
          inputTokens: a.inputTokens + b.inputTokens,
          cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
        };

function intentFailures(checks: IntentCheck[]) {
  return checks
    .filter((check) => check.status === 'mismatch')
    .map(
      (check) =>
        `- ${check.label}: the request says ${check.stated}, the candidate uses ${check.actual}.`,
    )
    .join('\n');
}

/**
 * The fixed authoring sequence: draft → verify → (one repair) → verify. The pipeline
 * never activates anything; it yields evidence for a human decision.
 */
export async function compile<V extends VerificationLike>(
  rawRequest: CompileRequest,
  transport: CompilerTransport,
  hooks: CompileHooks<V>,
): Promise<CompileResult<V>> {
  const request = compileRequestSchema.parse(rawRequest);
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('timeout')),
    hooks.timeoutMs ?? COMPILE_LIMITS.timeoutMs,
  );
  const forward = () => controller.abort(new Error('cancelled'));
  hooks.signal?.addEventListener('abort', forward, { once: true });
  if (hooks.signal?.aborted) forward();
  const attempts: CompileAttempt<V>[] = [];
  let usage: CompilerUsage | null = null;
  let session: Awaited<ReturnType<CompilerTransport['open']>> | null = null;
  const result = (
    status: CompileResult<V>['status'],
    error: string | null = null,
  ): CompileResult<V> => ({
    status,
    transport: transport.kind,
    model: transport.model,
    promptVersion: PROMPT_VERSION,
    threadId: session?.threadId ?? null,
    attempts,
    final: attempts.at(-1) ?? null,
    usage,
    durationMs: Date.now() - started,
    error,
  });
  const previous = request.base
    ? { source: request.base.source, manifest: request.base.manifest as ManifestView }
    : null;
  try {
    session = await transport.open(request, buildWorkspace(request));
    if (controller.signal.aborted) throw controller.signal.reason;
    let prompt = buildPrompt(request);
    for (let attempt = 1; attempt <= 1 + COMPILE_LIMITS.repairRounds; attempt++) {
      const attemptStarted = Date.now();
      if (controller.signal.aborted) throw controller.signal.reason;
      hooks.onStage?.(attempt === 1 ? 'drafting' : 'repairing', attempt);
      const turn = await session.turn(prompt, {
        signal: controller.signal,
        onProgress: (progress) => hooks.onProgress?.(progress),
      });
      usage = sumUsage(usage, turn.usage);
      const parsed = compileOutputSchema.safeParse(turn.output);
      const record: CompileAttempt<V> = {
        attempt,
        output: parsed.success ? parsed.data : null,
        outputError: parsed.success
          ? null
          : parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
        verification: null,
        intent: [],
        durationMs: 0,
      };
      attempts.push(record);
      if (!parsed.success) {
        record.durationMs = Date.now() - attemptStarted;
        prompt = buildRepairPrompt(`Output did not match the schema: ${record.outputError}`);
        continue;
      }
      const output = parsed.data;
      if (output.kind !== 'candidate') {
        record.durationMs = Date.now() - attemptStarted;
        hooks.onStage?.(output.kind, attempt);
        return result(output.kind);
      }
      hooks.onStage?.('verifying', attempt);
      if (controller.signal.aborted) throw controller.signal.reason;
      record.verification = await hooks.verify({
        source: output.source ?? '',
        manifest: output.manifest,
        tests: output.tests,
      });
      try {
        record.intent = checkIntent(
          request.intent,
          { source: output.source ?? '', manifest: output.manifest as ManifestView },
          previous,
        );
      } catch {
        // A malformed manifest already fails verification; there is nothing to compare.
        record.intent = [];
      }
      record.durationMs = Date.now() - attemptStarted;
      const mismatches = intentFailures(record.intent);
      if (record.verification.ok && !mismatches) {
        hooks.onStage?.('ready', attempt);
        return result('ready');
      }
      if (controller.signal.aborted) break;
      prompt = buildRepairPrompt(
        [record.verification.failureReport, mismatches && `Intent mismatches:\n${mismatches}`]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
    hooks.onStage?.('failed', attempts.length);
    return result('failed', 'The candidate did not pass verification after one repair.');
  } catch (error) {
    const reason =
      controller.signal.reason instanceof Error ? controller.signal.reason.message : null;
    if (reason === 'cancelled') {
      hooks.onStage?.('cancelled', attempts.length);
      return result('cancelled', 'Generation was cancelled.');
    }
    hooks.onStage?.('failed', attempts.length);
    return result(
      'failed',
      reason === 'timeout'
        ? 'Generation timed out after 180 seconds. Your live interaction is unchanged.'
        : `The compiler could not finish: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
    );
  } finally {
    clearTimeout(timeout);
    hooks.signal?.removeEventListener('abort', forward);
    await session?.close().catch(() => undefined);
  }
}
