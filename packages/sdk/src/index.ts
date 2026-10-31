/** Public SDK version. Versioned preview execution contract. */
export const SDK_VERSION = '0.2.0' as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Public policy ceilings; trusted hosts may impose stricter operational limits. */
export const HOST_LIMITS = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  handlerDeadlineMs: 50,
  wallTimeoutMs: 2000,
  workerStartupMs: 10_000,
  bridgeCallsPerEvent: 25,
  observedResultsPerEvent: 256,
  pendingJobsPerEvent: 100,
  stateBytes: 1024 * 1024,
});

/** Executable bridge capability identifiers; unsupported capabilities are rejected. */
export const CAPABILITIES = ['overlay'] as const;
export const EFFECT_LIMITS = Object.freeze({ perEvent: 10, perMinute: 120 });
export type AudienceRole = 'viewer' | 'subscriber' | 'moderator' | 'broadcaster';
export interface ChatEvent {
  id: string;
  channelId: string;
  viewerId: string;
  roles: AudienceRole[];
  text: string;
  /** Ordered host observation time in milliseconds; replay supplies the original value. */
  at: number;
}
export interface PermissionManifest {
  sdkVersion: typeof SDK_VERSION;
  capabilities: (typeof CAPABILITIES)[number][];
  trigger: {
    command: string;
    audience: AudienceRole[];
    maxPerViewer: number;
    windowMs: number;
  };
  limits: { effectsPerEvent: number; effectsPerMinute: number };
}
export interface ProjectileEffect {
  kind: 'projectile';
  asset: 'tomato' | 'star';
  x: number;
}
export interface AutomationContext {
  overlay: {
    /** Queue a bounded private projectile. Example: await riff.overlay.emit({kind:'projectile',asset:'tomato',x:0.5}). */
    emit(effect: ProjectileEffect): Promise<void>;
  };
  util: {
    /** Recorded event time. Example: const at = riff.util.now(). */
    now(): number;
    /** Deterministic seeded number in [0,1). Example: const x = riff.util.random(). */
    random(): number;
  };
}
export interface AutomationArtifact {
  source: string;
  manifest: PermissionManifest;
}
export type DecisionCode =
  | 'ACCEPTED'
  | 'UNRELATED'
  | 'AUDIENCE'
  | 'VIEWER_LIMIT'
  | 'CHANNEL_LIMIT'
  | 'DUPLICATE'
  | 'INVALID_EVENT'
  | 'INCIDENT'
  | 'DISABLED'
  | 'STOPPED';
export interface ExecutionDecision {
  eventId: string;
  artifactId: string;
  code: DecisionCode;
  reason: string;
  effects: ProjectileEffect[];
  mode: 'preview';
}
