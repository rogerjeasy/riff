import { randomUUID } from 'node:crypto';
import type { ExecutionDecision, ExperienceDefinition, SessionSnapshot } from '@riff/sdk';

/** Versioned overlay protocol. The overlay ignores unknown types. */
export type OverlayMessage =
  | { v: 1; type: 'hello'; payload: { channel: string } }
  | { v: 1; type: 'heartbeat'; payload: { at: number } }
  | {
      v: 1;
      type: 'effect';
      payload: { id: string; asset: string; x: number; viewer: string | null };
    }
  | { v: 1; type: 'instructions'; payload: { lines: string[] } }
  | { v: 1; type: 'clear'; payload: { reason: 'panic' | 'pause' | 'rotate' } }
  | { v: 1; type: 'sessions'; payload: { sessions: SessionProjection[] } }
  | { v: 1; type: 'test'; payload: { at: number } };

export interface SessionProjection {
  automationId: string;
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
export function createOverlayBroker(options: { heartbeatMs?: number } = {}) {
  const sockets = new Set<OverlaySocket>();
  let instructions: string[] = [];
  let sessions: SessionProjection[] = [];
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
        JSON.stringify({ v: 1, type: 'sessions', payload: { sessions } } satisfies OverlayMessage),
      );
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
    deliver(decision: ExecutionDecision, viewer: string | null) {
      if (decision.mode !== 'live') throw new Error('Only live decisions may reach the overlay');
      if (decision.code !== 'ACCEPTED') return 0;
      for (const effect of decision.effects)
        broadcast({
          v: 1,
          type: 'effect',
          payload: { id: randomUUID(), asset: effect.asset, x: effect.x, viewer },
        });
      return decision.effects.length;
    },
    setInstructions(lines: string[]) {
      instructions = lines.slice(0, 4);
      broadcast({ v: 1, type: 'instructions', payload: { lines: instructions } });
    },
    clear(reason: 'panic' | 'pause' | 'rotate') {
      if (reason === 'panic') sessions = [];
      broadcast({ v: 1, type: 'clear', payload: { reason } });
    },
    testFrame() {
      broadcast({ v: 1, type: 'test', payload: { at: Date.now() } });
      return sockets.size;
    },
    /** Rotation invalidates every existing socket. */
    disconnectAll() {
      this.clear('rotate');
      for (const socket of sockets) socket.close(4001, 'Overlay key rotated');
      sockets.clear();
    },
    close() {
      clearInterval(timer);
      for (const socket of sockets) socket.close(1001, 'Server shutting down');
      sockets.clear();
    },
  };
}
export type OverlayBroker = ReturnType<typeof createOverlayBroker>;
