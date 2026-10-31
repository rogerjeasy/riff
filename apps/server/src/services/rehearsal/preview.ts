import { createEngine } from '@riff/sandbox';
import type { ChatEvent, ExecutionDecision } from '@riff/sdk';

export interface PreviewResult {
  provenance: 'synthetic';
  artifactId: string;
  seed: number;
  decisions: ExecutionDecision[];
  durationMs: number;
}

/**
 * Private rehearsal. Every request rebuilds isolated state from the seed and the
 * ordered synthetic events (deterministic replay) in a fresh preview-mode engine with
 * its own worker, counters and clock. Results only return over HTTP: there is no
 * code path from here to the live overlay broker or to Twitch.
 */
export function createPreviewService(options: { maxConcurrent?: number } = {}) {
  const active = new Set<ReturnType<typeof createEngine>>();
  let closed = false;
  return {
    async replay(
      artifact: { source: string; manifest: unknown },
      events: ChatEvent[],
      seed: number,
      signal?: AbortSignal,
    ): Promise<PreviewResult | null> {
      if (closed || active.size >= (options.maxConcurrent ?? 2)) return null;
      const started = performance.now();
      const engine = createEngine(artifact, { seed, mode: 'preview' });
      active.add(engine);
      const cancel = () => engine.stop();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const decisions: ExecutionDecision[] = [];
        for (const event of events) {
          if (signal?.aborted) break;
          decisions.push(await engine.dispatch(event));
        }
        return {
          provenance: 'synthetic',
          artifactId: engine.artifactId,
          seed,
          decisions,
          durationMs: Math.round(performance.now() - started),
        };
      } finally {
        engine.stop();
        active.delete(engine);
        signal?.removeEventListener('abort', cancel);
      }
    },
    close() {
      closed = true;
      for (const engine of active) engine.stop();
    },
  };
}
export type PreviewService = ReturnType<typeof createPreviewService>;
