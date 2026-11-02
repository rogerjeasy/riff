import { createEngine, createVirtualTimers } from '@riff/sandbox';
import type { ChatEvent, ExecutionDecision, SessionSnapshot } from '@riff/sdk';

export interface PreviewResult {
  provenance: 'synthetic';
  artifactId: string;
  seed: number;
  decisions: ExecutionDecision[];
  durationMs: number;
  session?: SessionSnapshot;
  /** Timer fires on the private virtual clock, in order; never the live scheduler. */
  timerFires?: PreviewTimerFire[];
}
export interface PreviewTimerFire {
  name: string;
  at: number;
  /** Index of the next synthetic event this fire preceded (events.length after the last). */
  before: number;
  decision: ExecutionDecision;
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
      const timers = createVirtualTimers(() => events[0]?.channelId ?? 'preview');
      const engine = createEngine(artifact, { seed, mode: 'preview', timers });
      active.add(engine);
      const cancel = () => engine.stop();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const decisions: ExecutionDecision[] = [];
        const timerFires: PreviewTimerFire[] = [];
        for (const [index, event] of events.entries()) {
          if (signal?.aborted) break;
          for (const fire of (await timers.advance(engine, event.at)).fires)
            timerFires.push({
              name: fire.name,
              at: fire.firedAt,
              before: index,
              decision: fire.decision,
            });
          const decision = await engine.dispatch(event);
          timers.apply(decision);
          decisions.push(decision);
        }
        return {
          provenance: 'synthetic',
          artifactId: engine.artifactId,
          seed,
          decisions,
          durationMs: Math.round(performance.now() - started),
          ...(engine.session ? { session: engine.session } : {}),
          ...(timerFires.length ? { timerFires } : {}),
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
