/** Public SDK version. 0.4.0 adds host-owned stateful sessions; 0.3.0 remains supported. */
export const SDK_VERSION = '0.4.0' as const;

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
  sourceBytes: 16_384,
  /** Delivery identities are remembered for this long (EventSub redelivery window). */
  dedupeWindowMs: 10 * 60_000,
  /** A private rehearsal holds at most this many distinct events. */
  previewEvents: 256,
});

/** Executable bridge capability identifiers; unsupported capabilities are rejected. */
export const CAPABILITIES = ['overlay', 'session'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const EFFECT_LIMITS = Object.freeze({ perEvent: 10, perMinute: 120 });
export const AUDIENCE_ROLES = ['viewer', 'subscriber', 'moderator', 'broadcaster'] as const;
export type AudienceRole = (typeof AUDIENCE_ROLES)[number];
export const PROJECTILE_ASSETS = ['tomato', 'star', 'heart'] as const;
export type ProjectileAsset = (typeof PROJECTILE_ASSETS)[number];
/** Trigger policy bounds shared by validators, editors and the compiler prompt. */
export const TRIGGER_LIMITS = Object.freeze({
  maxPerViewer: { min: 1, max: 100 },
  windowMs: { min: 1000, max: 3_600_000 },
  commandPattern: '^![a-z0-9_-]{1,32}$',
});

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
  sdkVersion: typeof SDK_VERSION | '0.3.0';
  experience?: ExperienceDefinition | null | undefined;
  capabilities: Capability[];
  trigger: {
    /** Lowercase `!command`. Chat text matches after trimming and lowercasing. */
    command: string;
    /** Any listed role is eligible. `viewer` means everyone in chat. */
    audience: AudienceRole[];
    maxPerViewer: number;
    windowMs: number;
  };
  limits: { effectsPerEvent: number; effectsPerMinute: number };
}
export interface ProjectileEffect {
  kind: 'projectile';
  asset: ProjectileAsset;
  x: number;
}
/** Canonical bounded session policy, independent of cosmetic effect budgets. */
export const SESSION_LIMITS = Object.freeze({
  durationMs: { min: 1000, max: 3_600_000 },
  maxParticipants: 256,
  maxTeams: 8,
  resourcePerParticipant: 100,
  pointsPerContribution: 100,
  titleLength: 120,
  labelLength: 60,
  idLength: 32,
  maxScore: 2_560_000,
});
export interface ExperienceDefinition {
  /** 1 = score rounds only; 2 adds the declarative `mechanics` block. */
  version: 1 | 2;
  title: string;
  durationMs: number;
  maxParticipants: number;
  teams: { id: string; label: string; joinCommand: string }[];
  resource: { name: string; perParticipant: number };
  contribution: { command: string; points: number };
  /** `burst` (version 2 only) wins a round after `target` burst triggers. */
  objective: { kind: 'highest-score' | 'collective-goal' | 'burst'; target: number | null };
  /** Present exactly when version is 2. */
  mechanics?: ExperienceMechanics | undefined;
}
/** Bounds for definition version 2 mechanics; validators import these values. */
export const MECHANIC_LIMITS = Object.freeze({
  rounds: { min: 2, max: 9 },
  intermissionMs: { min: 0, max: 60_000 },
  health: { min: 1, max: 1000 },
  damage: { min: 1, max: 1000 },
  heal: { min: 1, max: 1000 },
  burstParticipants: { min: 2, max: 50 },
  burstWindowMs: { min: 1000, max: 60_000 },
  burstPoints: { min: 0, max: 100 },
  burstLimit: { min: 1, max: 20 },
  shieldMs: { min: 0, max: 60_000 },
  milestones: 4,
  unlockPoints: { min: 1, max: 100 },
});
/**
 * Host-owned declarative rules (definition version 2). Each block is optional (null/[]).
 * Example: { match: { rounds: 3, intermissionMs: 5000 }, health: null, burst: null, milestones: [] }.
 */
export interface ExperienceMechanics {
  /** Best-of-N match: rounds reset resources, scores and pools; a majority of round wins ends it. */
  match: { rounds: number; intermissionMs: number } | null;
  /** One pool per team (two or more teams). Each contribution damages every other standing team. */
  health: {
    label: string;
    max: number;
    damage: number;
    heal: { command: string; amount: number } | null;
  } | null;
  /**
   * `participants` distinct viewers of one side act within a sliding `windowMs`. A null
   * command counts accepted contributions; a command makes a resource-free burst action.
   */
  burst: {
    command: string | null;
    label: string;
    participants: number;
    windowMs: number;
    points: number;
    limit: number;
    shieldMs: number;
  } | null;
  /** Ascending round-score thresholds that unlock an effect tier and an optional command. */
  milestones: {
    id: string;
    label: string;
    score: number;
    unlock: { command: string; points: number } | null;
  }[];
}
export interface SessionParticipant {
  teamId: string | null;
  remaining: number;
  contributions: number;
}
/** Per side (team id or community) state for version 2 mechanics, reset every round. */
export interface SessionStanding {
  health: number | null;
  eliminated: boolean;
  contributions: number;
  heals: number;
  /** Accepted uses of each unlocked milestone command this round. */
  unlocks: Record<string, number>;
  bursts: number;
  /** Distinct viewers counted in the current sliding burst window (host clock). */
  burstWindow: { viewerId: string; at: number }[];
  shieldUntil: number | null;
  /** Milestone ids reached this round; its length is the effect tier. */
  unlocked: string[];
}
export interface SessionRoundResult {
  round: number;
  winner: string | null;
  outcome: 'deadline' | 'goal' | 'elimination';
  scores: Record<string, number>;
}
export interface SessionMechanicsState {
  /** 1-based current round. */
  round: number;
  wins: Record<string, number>;
  history: SessionRoundResult[];
  standings: Record<string, SessionStanding>;
}
export interface SessionSnapshot {
  /** Present exactly when the definition is version 2. */
  mechanics?: SessionMechanicsState | undefined;
  id: string;
  phase: 'running' | 'paused' | 'finished';
  startedAt: number;
  deadlineAt: number | null;
  remainingMs: number;
  updatedAt: number;
  revision: number;
  participants: Record<string, SessionParticipant>;
  scores: Record<string, number>;
  winner: string | null;
  outcome: 'deadline' | 'goal' | 'elimination' | null;
}
export interface SessionAssertion {
  phase?: SessionSnapshot['phase'] | undefined;
  /** Version 2 mechanics subset assertions. */
  round?: number | undefined;
  winner?: string | null | undefined;
  wins?: Record<string, number> | undefined;
  standings?:
    | Record<
        string,
        {
          health?: number | null | undefined;
          eliminated?: boolean | undefined;
          bursts?: number | undefined;
          tier?: number | undefined;
        }
      >
    | undefined;
  scores?: Record<string, number> | undefined;
  remainingMs?: number | undefined;
  participants?:
    | Record<
        string,
        {
          teamId?: string | null | undefined;
          remaining?: number | undefined;
          contributions?: number | undefined;
        }
      >
    | undefined;
}
export interface AutomationContext {
  session: {
    /** Read deeply frozen canonical state. Example: const score = riff.session.snapshot().scores.community. */
    snapshot(): Readonly<SessionSnapshot>;
  };
  overlay: {
    /** Queue a bounded projectile. Example: await riff.overlay.emit({kind:'projectile',asset:'tomato',x:0.5}). */
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
export type ExecutionMode = 'preview' | 'live';
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
  | 'CAPACITY'
  | 'STOPPED'
  | 'NOT_JOINED'
  | 'RESOURCE_LIMIT'
  | 'SESSION_PAUSED'
  | 'SESSION_FINISHED'
  | 'ALREADY_JOINED'
  | 'PARTICIPANT_LIMIT'
  | 'ELIMINATED'
  | 'LOCKED'
  | 'HEALTH_FULL'
  | 'BURST_COUNTED'
  | 'BURST_ACTIVE'
  | 'BURST_LIMIT'
  | 'ROUND_INTERMISSION';
export const DECISION_CODES: readonly DecisionCode[] = [
  'ACCEPTED',
  'UNRELATED',
  'AUDIENCE',
  'VIEWER_LIMIT',
  'CHANNEL_LIMIT',
  'DUPLICATE',
  'INVALID_EVENT',
  'INCIDENT',
  'DISABLED',
  'CAPACITY',
  'STOPPED',
  'NOT_JOINED',
  'RESOURCE_LIMIT',
  'SESSION_PAUSED',
  'SESSION_FINISHED',
  'ALREADY_JOINED',
  'PARTICIPANT_LIMIT',
  'ELIMINATED',
  'LOCKED',
  'HEALTH_FULL',
  'BURST_COUNTED',
  'BURST_ACTIVE',
  'BURST_LIMIT',
  'ROUND_INTERMISSION',
];
/** Viewer allowance after admission, for explanations. */
export interface AllowanceSnapshot {
  used: number;
  max: number;
  windowMs: number;
  /** Event time at which the oldest counted action expires; null when nothing is counted. */
  nextAt: number | null;
}
export interface ExecutionDecision {
  session?: SessionSnapshot;
  eventId: string;
  artifactId: string;
  code: DecisionCode;
  reason: string;
  effects: ProjectileEffect[];
  mode: ExecutionMode;
  viewerId: string | null;
  at: number | null;
  allowance: AllowanceSnapshot | null;
}

/** One synthetic chat message inside a declarative scenario. */
export interface ScenarioStep {
  /** Optional subset assertion against canonical state after this event. */
  session?: SessionAssertion | null | undefined;
  /** Stable synthetic viewer identity, e.g. "alice". */
  viewer: string;
  roles: AudienceRole[];
  text: string;
  /** Milliseconds since the scenario started; must not decrease. */
  at: number;
  /** Reuse an earlier step's id to model a duplicate delivery. */
  id: string;
  expect: DecisionCode;
  /** Exact number of effects expected for this step. */
  effects: number;
}
export type ScenarioKind = 'happy' | 'limit' | 'role' | 'negative' | 'duplicate' | 'window';
/** Generated tests are data, never code: they run in the same engine as live events. */
export interface Scenario {
  name: string;
  kind: ScenarioKind;
  steps: ScenarioStep[];
}
export const SCENARIO_LIMITS = Object.freeze({ minScenarios: 3, maxScenarios: 12, maxSteps: 24 });
export * from './guide.js';

/** Host-reviewed activation boundary; stopped requires an already paused session. */
export type SessionTransitionBoundary = 'immediate' | 'round-end' | 'stopped';
/** Immutable host-computed identities; executable source is stored separately. */
export interface SessionTransitionPlan {
  version: 1;
  sourceArtifactId: string;
  targetArtifactId: string;
  sourceDefinitionHash: string;
  targetDefinitionHash: string;
  migrationSourceHash: string;
  boundary: SessionTransitionBoundary;
  preserve: readonly [
    'identity',
    'participants',
    'teams',
    'scores',
    'contributions',
    'phase',
    'time',
  ];
  resets: readonly [];
}

export {
  DEFAULT_SCENE,
  SCENE_LIMITS,
  type SceneDocument,
  type SceneNode,
  type SceneRegion,
  type SceneRect,
} from './scene.js';

export { DEFAULT_DIRECTOR_ENVELOPE } from './director.js';
export type {
  DirectorEnvelope,
  DirectorSettings,
  DirectorMode,
  DirectorFrame,
  DirectorDecision,
  DirectorSnapshot,
} from './director.js';
export type {
  DirectorEvidence,
  DirectorRevision,
  DirectorApproval,
  DirectorState,
} from './director.js';

export type * from './recipes.js';
export type * from './participation.js';
export type * from './production.js';
