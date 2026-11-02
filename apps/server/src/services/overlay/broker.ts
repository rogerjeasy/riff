import type { SharedPresentationFrame } from '../collaboration/contract.js';
import type { CommunityProjection } from '../proposals/projection.js';
import { randomUUID } from 'node:crypto';
import type {
  DirectorFrame,
  ExecutionDecision,
  ExperienceDefinition,
  SessionSnapshot,
  SceneDocument,
} from '@riff/sdk';

/** Versioned overlay protocol. The overlay ignores unknown types. */
export type OverlayMessage =
  | { v: 1; type: 'collaboration'; payload: SharedPresentationFrame | null }
  | { v: 1; type: 'hello'; payload: { channel: string } }
  | { v: 1; type: 'scenes'; payload: { scenes: SceneProjection[] } }
  | { v: 1; type: 'heartbeat'; payload: { at: number } }
  | {
      v: 1;
      type: 'effect';
      payload: {
        id: string;
        asset: string;
        x: number;
        viewer: string | null;
        automationId?: string;
        versionId?: string;
        intensity?: number;
      };
    }
  | { v: 1; type: 'instructions'; payload: { lines: string[] } }
  | { v: 1; type: 'clear'; payload: { reason: 'panic' | 'pause' | 'rotate' } }
  | { v: 1; type: 'sessions'; payload: { sessions: SessionProjection[] } }
  | { v: 1; type: 'community'; payload: CommunityProjection | null }
  | { v: 1; type: 'test'; payload: { at: number } };

export interface SceneProjection {
  highContrast?: boolean;
  effectLabels?: boolean;
  reducedMotion?: boolean;
  /** Present only while an accepted `!riff help` asks the renderer to emphasize guidance. */
  help?: true;
  /** Reviewed viewer language for scoreboard text (F40); absent means English. */
  language?: 'en' | 'fr' | 'es' | 'de';
  /** F29: reviewed, contrast-checked #rrggbb accent for the instruction panel edge. */
  accent?: string;
  automationId: string;
  versionId: string;
  revision: number;
  digest: string;
  scene: SceneDocument;
  instructions: string[];
}

export interface SessionProjection {
  automationId: string;
  versionId?: string;
  title: string;
  definition: ExperienceDefinition;
  snapshot: SessionSnapshot;
}

export interface OverlaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Fan-out to OBS browser sources. Only live decisions are accepted: preview and
 * verification output have no path to a live overlay.
 */
export function createOverlayBroker(
  options: {
    heartbeatMs?: number;
    submit?: (
      decision: ExecutionDecision,
      viewer: string | null,
      automationId?: string,
      versionId?: string,
    ) => number | null;
    onClear?: (reason: 'panic' | 'pause' | 'rotate' | 'reset') => void;
  } = {},
) {
  const sockets = new Set<OverlaySocket>();
  let instructions: string[] = [];
  let sessions: SessionProjection[] = [];
  let scenes: SceneProjection[] = [];
  let community: CommunityProjection | null = null;
  let stopped = false;
  let collaboration: SharedPresentationFrame | null = null;
  const broadcast = (message: OverlayMessage) => {
    const data = JSON.stringify(message);
    for (const socket of sockets) {
      try {
        socket.send(data);
      } catch {
        sockets.delete(socket);
      }
    }
  };
  const timer = setInterval(
    () => broadcast({ v: 1, type: 'heartbeat', payload: { at: Date.now() } }),
    options.heartbeatMs ?? 2000,
  );
  timer.unref();
  return {
    attach(socket: OverlaySocket, channel: string) {
      sockets.add(socket);
      socket.send(
        JSON.stringify({ v: 1, type: 'hello', payload: { channel } } satisfies OverlayMessage),
      );
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'instructions',
          payload: { lines: instructions },
        } satisfies OverlayMessage),
      );
      socket.send(
        JSON.stringify({ v: 1, type: 'scenes', payload: { scenes } } satisfies OverlayMessage),
      );
      socket.send(
        JSON.stringify({ v: 1, type: 'sessions', payload: { sessions } } satisfies OverlayMessage),
      );
      socket.send(
        JSON.stringify({ v: 1, type: 'community', payload: community } satisfies OverlayMessage),
      );
      socket.send(
        JSON.stringify({
          v: 1,
          type: 'collaboration',
          payload: collaboration,
        } satisfies OverlayMessage),
      );
    },
    setCollaboration(next: SharedPresentationFrame | null) {
      const safe = stopped ? null : next;
      if (JSON.stringify(collaboration) === JSON.stringify(safe)) return;
      collaboration = structuredClone(safe);
      broadcast({ v: 1, type: 'collaboration', payload: collaboration });
    },
    setScenes(next: SceneProjection[]) {
      const safe = stopped ? [] : next;
      if (JSON.stringify(scenes) === JSON.stringify(safe)) return;
      scenes = structuredClone(safe);
      broadcast({ v: 1, type: 'scenes', payload: { scenes } });
    },
    setCommunity(next: CommunityProjection) {
      if (stopped) return;
      if (JSON.stringify(community) === JSON.stringify(next)) return;
      community = structuredClone(next);
      broadcast({ v: 1, type: 'community', payload: community });
    },
    clearCommunity() {
      if (community === null) return;
      community = null;
      broadcast({ v: 1, type: 'community', payload: null });
    },
    resumeCommunity() {
      stopped = false;
    },
    setSessions(next: SessionProjection[]) {
      sessions = structuredClone(next);
      broadcast({ v: 1, type: 'sessions', payload: { sessions } });
    },
    detach(socket: OverlaySocket) {
      sockets.delete(socket);
    },
    get connections() {
      return sockets.size;
    },
    deliver(
      decision: ExecutionDecision,
      viewer: string | null,
      automationId?: string,
      versionId?: string,
    ) {
      if (decision.mode !== 'live') throw new Error('Only live decisions may reach the overlay');
      if (decision.code !== 'ACCEPTED' || stopped) return 0;
      const directed = options.submit?.(decision, viewer, automationId, versionId);
      if (directed !== null && directed !== undefined) return directed;
      for (const effect of decision.effects)
        broadcast({
          v: 1,
          type: 'effect',
          payload: {
            id: randomUUID(),
            asset: effect.asset,
            x: effect.x,
            viewer,
            ...(automationId ? { automationId } : {}),
            ...(versionId ? { versionId } : {}),
          },
        });
      return decision.effects.length;
    },
    /** Activation, version swap or round reset: queued cosmetics belong to the old authority. */
    invalidatePresentation() {
      options.onClear?.('reset');
    },
    present(frame: DirectorFrame) {
      if (!stopped) broadcast({ v: 1, type: 'effect', payload: frame });
    },
    setInstructions(lines: string[]) {
      instructions = lines.slice(0, 4);
      broadcast({ v: 1, type: 'instructions', payload: { lines: instructions } });
    },
    clear(reason: 'panic' | 'pause' | 'rotate') {
      options.onClear?.(reason);
      // Clear the cached projection too: the next authoritative member heartbeat
      // must rehydrate clients even when no aggregate value changed.
      collaboration = null;
      scenes = [];
      broadcast({ v: 1, type: 'scenes', payload: { scenes } });
      if (reason === 'panic') {
        sessions = [];
        community = null;
        stopped = true;
      }
      broadcast({ v: 1, type: 'clear', payload: { reason } });
    },
    testFrame() {
      broadcast({ v: 1, type: 'test', payload: { at: Date.now() } });
      return sockets.size;
    },
    /** Rotation invalidates every existing socket. */
    disconnectAll() {
      const previous = scenes;
      this.clear('rotate');
      for (const socket of sockets) socket.close(4001, 'Overlay key rotated');
      sockets.clear();
      // The scene authority is unchanged by key rotation; only fresh sockets see it.
      this.setScenes(previous);
    },
    close() {
      clearInterval(timer);
      for (const socket of sockets) socket.close(1001, 'Server shutting down');
      sockets.clear();
    },
  };
}
export type OverlayBroker = ReturnType<typeof createOverlayBroker>;
