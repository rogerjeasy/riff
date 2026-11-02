import {
  TWITCH_ACTION_CAPABILITIES,
  type AnnouncementRequest,
  type PollRequest,
  type ShoutoutRequest,
  type TwitchAction,
} from './twitch-actions.js';
import type { EventTrigger, TwitchEventDetail } from './events.js';

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
export const CAPABILITIES = [
  'overlay',
  'session',
  'timer',
  'predictions',
  ...TWITCH_ACTION_CAPABILITIES,
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const EFFECT_LIMITS = Object.freeze({ perEvent: 10, perMinute: 120 });
/**
 * Host-owned named timer policy (capability `timer`). Kept separate from HOST_LIMITS so
 * existing artifact identities, which hash HOST_LIMITS, stay stable.
 */
export const TIMER_LIMITS = Object.freeze({
  /** Distinct pending timer names per automation version. */
  maxPerAutomation: 10,
  durationMs: { min: 5_000, max: 3_600_000 },
  namePattern: '^[a-z][a-z0-9_-]{0,31}$',
  /** A fire delivered later than this after its due time is reported as `missed`. */
  lateToleranceMs: 2_000,
  /** A fire overdue by more than this (for example after downtime) is skipped and logged. */
  missedGraceMs: 30_000,
  /** Preview/rehearsal fires at most this many timers per clock advance. */
  previewFiresPerAdvance: 32,
});
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
  /** Absent for chat. `points.redeem`: a linked Channel Points redemption; text is the viewer input. */
  kind?: RedemptionKind | undefined;
  /** Set only for Twitch platform events (F19); chat messages omit it or carry null. */
  twitch?: TwitchEventDetail | null | undefined;
}
/** Internal host trigger source `timer.fired`; never a Twitch transport event. */
export interface TimerEvent {
  source: 'timer.fired';
  id: string;
  channelId: string;
  /** Timer name given to riff.timer.start. */
  name: string;
  /** Host time the timer was due. */
  scheduledAt: number;
  /** Host time the fire was delivered; equals `at`. */
  firedAt: number;
  /** True when delivered more than TIMER_LIMITS.lateToleranceMs late (e.g. after a restart). */
  missed: boolean;
  at: number;
}
export interface TimerOptions {
  /** Re-arm with the same interval after every fire until cancelled. */
  repeat?: boolean | undefined;
}
/** A queued timer side effect staged by one handler invocation; applied only on success. */
export type TimerOp =
  { op: 'start'; name: string; ms: number; repeat: boolean } | { op: 'cancel'; name: string };
/** Rate policy shared by every trigger source. */
export interface TriggerPolicy {
  /** Any listed role is eligible. `viewer` means everyone in chat. */
  audience: AudienceRole[];
  maxPerViewer: number;
  windowMs: number;
}
/**
 * A chat command. `kind` may be omitted (the default), so existing chat artifacts keep
 * their identity. Chat text matches after trimming and lowercasing.
 */
export interface ChatCommandTrigger extends TriggerPolicy {
  kind?: 'chat.command' | undefined;
  /** Lowercase `!command`. */
  command: string;
  reward?: null | undefined;
  event?: null | undefined;
}
/** F22: a linked Channel Points redemption. Chat text never matches it. */
export interface PointsRedeemTrigger extends TriggerPolicy {
  kind: 'points.redeem';
  /** Console handle such as `!hydrate`; viewers never type it. */
  command: string;
  /** Reward title the creator links (1..45 characters). */
  reward: string;
  event?: null | undefined;
}
/** F19: one Twitch platform event kind. Chat and redemptions never match it. */
export interface TwitchEventTrigger extends TriggerPolicy {
  kind: 'twitch.event';
  /** Reserved non-chat token, always eventTriggerCommand(event.kind), e.g. `@raid`. */
  command: string;
  reward?: null | undefined;
  event: EventTrigger;
}
/** One trigger, one source: `kind` is the single discriminator. */
export type ManifestTrigger = ChatCommandTrigger | PointsRedeemTrigger | TwitchEventTrigger;
export interface PermissionManifest {
  sdkVersion: typeof SDK_VERSION | '0.3.0';
  experience?: ExperienceDefinition | null | undefined;
  capabilities: Capability[];
  trigger: ManifestTrigger;
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
  /** 1 = score rounds only; 2 adds the declarative `mechanics` block; 3 adds a non-game `format`. */
  version: 1 | 2 | 3;
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
  /** Present exactly when version is 3: a declarative non-game format (teamless). */
  format?: ExperienceFormat | undefined;
}
/** Host palette for murals: the only colors a viewer can name (no free text). */
export const MURAL_COLORS = Object.freeze({
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#30a46c',
  teal: '#12a594',
  blue: '#0090ff',
  purple: '#8e4ec6',
  pink: '#d6409f',
  white: '#ffffff',
  black: '#1c2024',
} as const);
export type MuralColor = keyof typeof MURAL_COLORS;
/** Fixed quiz answer commands, by option index. */
export const QUIZ_ANSWER_COMMANDS = ['!a', '!b', '!c', '!d'] as const;
/** Bounds for definition version 3 formats; validators import these values. */
export const FORMAT_LIMITS = Object.freeze({
  muralSize: { min: 2, max: 16 },
  palette: { min: 2, max: 8 },
  stages: { min: 2, max: 4 },
  options: { min: 2, max: 4 },
  questions: { min: 1, max: 5 },
  promptLength: 140,
  optionLength: 60,
  explanationLength: 200,
  passPercent: { min: 1, max: 100 },
  revealMs: { min: 0, max: 30_000 },
  /** Every stage/question window must leave at least this long to act. */
  minActionMs: 5000,
});
/**
 * Host-owned non-game formats (definition version 3). Each slot (stage or question) gets
 * an equal share of durationMs: slot i spans [i, i+1) × floor(durationMs / slots).
 * Example: { kind: 'mural', width: 8, height: 8, palette: ['red','blue'], overwrite: true, reveal: 'live' }.
 */
export type ExperienceFormat =
  | {
      /** `!paint <cell> <color>`, cell = column letter + row number (A1 is top-left). */
      kind: 'mural';
      width: number;
      height: number;
      palette: MuralColor[];
      /** false: a painted cell is final (CELL_TAKEN). */
      overwrite: boolean;
      /** 'end' keeps the canvas hidden on the overlay until the session finishes. */
      reveal: 'live' | 'end';
    }
  | {
      /** `<contribution.command> <option id | 1-based number>`, one vote per viewer per stage. */
      kind: 'composition';
      /** Ties (and stages without votes) resolve to the first listed option. */
      tieBreak: 'first-listed';
      stages: { id: string; label: string; options: { id: string; label: string }[] }[];
    }
  | {
      /** Answer with !a..!d, one final answer per viewer per question. */
      kind: 'quiz';
      /** A question is solved when at least this share of answers is correct. */
      passPercent: number;
      /** The last revealMs of each question window closes answers and shows the explanation. */
      revealMs: number;
      questions: { prompt: string; options: string[]; answer: number; explanation: string }[];
    };
/**
 * Version 3 format state. Mural `canvas` holds palette indexes (-1 = empty, row-major);
 * composition/quiz `choices` hold each viewer's option index per slot (-1 = none).
 */
export interface SessionFormatState {
  canvas: number[];
  choices: Record<string, number[]>;
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
  /** Present exactly when the definition is version 3. */
  format?: SessionFormatState | undefined;
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
  /** Version 3 format subset: current slot, painted cells, current-slot tally, solved questions. */
  format?:
    | {
        slot?: number | undefined;
        painted?: number | undefined;
        tally?: number[] | undefined;
        solved?: number | undefined;
      }
    | undefined;
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
  timer: {
    /** Queue a host-owned named timer; restarting a name replaces it. Example: await riff.timer.start('celebrate', 60000). */
    start(name: string, ms: number, options?: TimerOptions): Promise<void>;
    /** Queue cancellation of a named timer; unknown names are ignored. Example: await riff.timer.cancel('celebrate'). */
    cancel(name: string): Promise<void>;
  };
  predictions: {
    /** Propose a prediction for the creator to open; never opens or settles one. Example: await riff.predictions.propose({title:'Win?',outcomes:['Yes','No'],windowSeconds:120}). */
    propose(proposal: PredictionProposal): Promise<void>;
  };
  polls: {
    /** Queue a host-validated Twitch poll. Example: await riff.polls.start({title:'Next game?',choices:['A','B'],durationSeconds:60}). */
    start(poll: PollRequest): Promise<void>;
    /** Queue ending the poll this channel's Riff started. Example: await riff.polls.end(). */
    end(): Promise<void>;
  };
  chat: {
    /** Queue a budgeted chat announcement. Example: await riff.chat.announce({message:'Round two!',color:'purple'}). */
    announce(announcement: AnnouncementRequest): Promise<void>;
  };
  shoutout: {
    /** Queue a shoutout to a creator-approved channel. Example: await riff.shoutout.send({login:'twitchdev'}). */
    send(target: ShoutoutRequest): Promise<void>;
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
  | 'ROUND_INTERMISSION'
  | 'INVALID_CHOICE'
  | 'ALREADY_CHOSEN'
  | 'CELL_TAKEN'
  | 'ANSWER_CLOSED'
  | 'BELOW_MINIMUM';
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
  'INVALID_CHOICE',
  'ALREADY_CHOSEN',
  'CELL_TAKEN',
  'ANSWER_CLOSED',
  'BELOW_MINIMUM',
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
  /** Host-validated prediction proposals; present only when the handler proposed one. */
  proposals?: PredictionProposal[];
  /** Staged native Twitch actions; present only when non-empty. Preview never sends them. */
  actions?: TwitchAction[];
  mode: ExecutionMode;
  viewerId: string | null;
  at: number | null;
  allowance: AllowanceSnapshot | null;
  /** Timer side effects staged by an accepted handler; present only when non-empty. */
  timers?: TimerOp[];
}

/**
 * Timer fires the virtual clock delivered after the previous step and up to this step's
 * `at` (fires due exactly at `at` run first), with the total effects they emitted.
 */
export interface TimerAssertion {
  fired: number;
  effects: number;
}
/** One synthetic chat message inside a declarative scenario. */
export interface ScenarioStep {
  /** Optional assertion about timer fires reached before this event. */
  timers?: TimerAssertion | null | undefined;
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
  /** F19: a labeled synthetic Twitch event instead of a chat message. */
  twitch?: TwitchEventDetail | null | undefined;
  expect: DecisionCode;
  /** Exact number of effects expected for this step. */
  effects: number;
  /** `points.redeem` models a linked Channel Points redemption; text is its viewer input. */
  kind?: RedemptionKind | null | undefined;
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
export * from './events.js';

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

/**
 * Trigger sources, discriminated by `trigger.kind`. `chat.command` is the default when a
 * manifest omits it; `points.redeem` requires `reward`; `twitch.event` requires `event`.
 */
export const TRIGGER_KINDS = ['chat.command', 'points.redeem', 'twitch.event'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
/** The event-side marker for a Channel Points redemption (platform events use `twitch`). */
export type RedemptionKind = 'points.redeem';
/** Resolve the trigger source; an omitted kind is a chat command. */
export function triggerKind(trigger: { kind?: TriggerKind | undefined }): TriggerKind {
  return trigger.kind ?? 'chat.command';
}
/**
 * Twitch-documented Channel Points and Predictions bounds
 * (https://dev.twitch.tv/docs/api/reference/#create-custom-rewards,
 * https://dev.twitch.tv/docs/api/reference/#create-prediction).
 */
export const CHANNEL_POINTS_LIMITS = Object.freeze({ rewardTitleLength: 45 });
export const PREDICTION_LIMITS = Object.freeze({
  titleLength: 45,
  outcomeLength: 25,
  outcomes: { min: 2, max: 10 },
  windowSeconds: { min: 30, max: 1800 },
  /** Host policy: one proposal per handler call. */
  proposalsPerEvent: 1,
});
/** A guest-proposed prediction. The creator opens it; only the creator settles it. */
export interface PredictionProposal {
  title: string;
  outcomes: string[];
  windowSeconds: number;
}
export * from './twitch-actions.js';
