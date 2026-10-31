import { createPreviewEngine } from '@riff/sandbox';
import type { ChatEvent } from '@riff/sdk';

const referenceArtifact = {
  manifest: {
    sdkVersion: '0.3.0',
    capabilities: ['overlay'],
    trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60_000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
  },
  source: `async (event, riff) => {
    await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: riff.util.random() });
  }`,
};

/** One bounded rehearsal at a time per application. No live adapters are accepted. */
export function createPreviewService() {
  let active: ReturnType<typeof createPreviewEngine> | undefined;
  let closed = false;
  return {
    async replay(events: ChatEvent[], seed: number, signal?: AbortSignal) {
      if (active || closed) return null;
      const engine = createPreviewEngine(referenceArtifact, seed);
      active = engine;
      const cancel = () => {
        engine.stop();
        if (active === engine) active = undefined;
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const decisions = [];
        for (const event of events) {
          if (signal?.aborted) break;
          decisions.push(await engine.dispatch(event));
        }
        return {
          provenance: 'synthetic' as const,
          reference: 'Tomato Toss',
          artifactId: engine.artifactId,
          seed,
          decisions,
        };
      } finally {
        engine.stop();
        signal?.removeEventListener('abort', cancel);
        if (active === engine) active = undefined;
      }
    },
    close() {
      closed = true;
      active?.stop();
    },
  };
}
