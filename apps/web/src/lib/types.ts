import type { RegressionEvidence } from '../console/rehearsal/contracts.js';
import type { ProposalSnapshot } from '../console/proposals/contracts.js';
import type { Community } from '../community/schema.js';
/** Wire types mirrored from the server. Validated at the boundary in api.ts. */
export type Role = 'viewer' | 'subscriber' | 'moderator' | 'broadcaster';
export type Asset = 'tomato' | 'star' | 'heart';
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
  | 'PARTICIPANT_LIMIT';
export interface ExperienceDefinition {
  version: 1;
  title: string;
  durationMs: number;
  maxParticipants: number;
  teams: { id: string; label: string; joinCommand: string }[];
  resource: { name: string; perParticipant: number };
  contribution: { command: string; points: number };
  objective: { kind: 'highest-score' | 'collective-goal'; target: number | null };
}
export interface SessionParticipant {
  teamId: string | null;
  remaining: number;
  contributions: number;
}
export interface SessionSnapshot {
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
  outcome: 'deadline' | 'goal' | null;
}
export interface Effect {
  kind: 'projectile';
  asset: Asset;
  x: number;
}
export interface Allowance {
  used: number;
  max: number;
  windowMs: number;
  nextAt: number | null;
}
export interface Decision {
  eventId: string;
  artifactId: string;
  code: DecisionCode;
  reason: string;
  effects: Effect[];
  mode: 'preview' | 'live';
  viewerId: string | null;
  at: number | null;
  allowance: Allowance | null;
  session?: SessionSnapshot;
}
export interface Manifest {
  experience?: ExperienceDefinition | null;
  sdkVersion: string;
  capabilities: string[];
  trigger: {
    command: string;
    audience: Role[];
    maxPerViewer: number;
    windowMs: number;
    /** F22: `points.redeem` triggers run on linked Channel Points redemptions only. */
    kind?: 'chat.command' | 'points.redeem';
    reward?: string | null;
  };
  limits: { effectsPerEvent: number; effectsPerMinute: number };
}
export interface Stage {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  summary: string;
}
export interface SessionAssertion {
  phase?: SessionSnapshot['phase'];
  scores?: Record<string, number>;
  remainingMs?: number;
  participants?: Record<
    string,
    { teamId?: string | null; remaining?: number; contributions?: number }
  >;
}
export interface StepResult {
  session?: SessionSnapshot;
  expectSession?: SessionAssertion;
  id: string;
  viewer: string;
  roles: Role[];
  text: string;
  at: number;
  expect: DecisionCode;
  expectEffects: number | null;
  actual: DecisionCode;
  actualEffects: number;
  passed: boolean;
}
export interface ScenarioResult {
  name: string;
  kind: string;
  origin: 'generated' | 'host';
  passed: boolean;
  steps: StepResult[];
  durationMs: number;
}
export interface Finding {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  line: number | null;
}
export interface Verification {
  rehearsal?: RegressionEvidence[];
  ok: boolean;
  artifactId: string | null;
  stages: Stage[];
  findings: Finding[];
  capabilitiesUsed: string[];
  generated: ScenarioResult[];
  host: ScenarioResult[];
  failureReport: string | null;
}
export interface IntentCheck {
  aspect: string;
  label: string;
  stated: string | null;
  actual: string;
  previous: string | null;
  status: 'match' | 'mismatch' | 'assumed' | 'preserved' | 'changed';
}
export interface Change {
  field: string;
  label: string;
  from: string;
  to: string;
  authority: 'more' | 'less' | 'same';
}
export type VersionStatus =
  'candidate' | 'failed' | 'approved' | 'active' | 'superseded' | 'quarantined' | 'discarded';
export interface Version {
  id: string;
  automationId: string;
  number: number;
  parentVersionId: string | null;
  artifactId: string | null;
  title: string;
  intent: string;
  source: string;
  manifest: Manifest;
  tests: unknown[];
  behavior: { when: string; what: string; who: string; howMuch: string };
  assumptions: string[];
  evidence: {
    rehearsal?: RegressionEvidence[];
    verification: Verification;
    intent: IntentCheck[];
    migration?: { source: string; ok: boolean; snapshots: string[]; failure: string | null };
  };
  /** Present when a live round's rules differ from this version's; null/absent otherwise. */
  progress?: ProgressAssessment | null;
  origin: 'codex' | 'offline' | 'manual' | 'reference';
  compileRunId: string | null;
  status: VersionStatus;
  incident: string | null;
  approvedAt: number | null;
  activatedAt: number | null;
  createdAt: number;
  changes: Change[];
  blockers: string[];
}
export interface Automation {
  id: string;
  title: string;
  activeVersionId: string | null;
  status: 'draft' | 'live' | 'paused';
  createdAt: number;
  updatedAt: number;
  versions: Version[];
  canRollback: boolean;
  session: SessionSnapshot | null;
  transitions?: TransitionSummary[];
}
export interface Activity {
  id: number;
  at: number;
  kind: 'decision' | 'incident' | 'control' | 'system';
  automationId: string | null;
  versionId: string | null;
  eventId: string | null;
  viewer: string | null;
  code: string | null;
  message: string;
}
export type RunStage =
  | 'queued'
  | 'drafting'
  | 'verifying'
  | 'repairing'
  | 'ready'
  | 'question'
  | 'unsupported'
  | 'failed'
  | 'cancelled';
export interface Progress {
  kind: 'thinking' | 'command' | 'message' | 'status';
  text: string;
  at: number;
}
export interface Run {
  selectionId?: string;
  id: string;
  intent: string;
  automationId: string | null;
  baseVersionId: string | null;
  stage: RunStage;
  attempt: number;
  transport: 'codex' | 'offline';
  model: string | null;
  startedAt: number;
  progress: Progress[];
  result: {
    status: 'ready' | 'question' | 'unsupported' | 'failed' | 'cancelled';
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
export type TwitchStatus =
  | { state: 'unconfigured' | 'disconnected'; configured: boolean }
  | {
      state: 'connecting' | 'connected' | 'reconnecting';
      login: string | null;
      configured: boolean;
    }
  | { state: 'error'; login: string | null; message: string; configured: boolean };
export interface Studio {
  proposals?: ProposalSnapshot;
  community?: Community | null;
  panic: boolean;
  panicAt: number | null;
  overlay: { connections: number };
  running: { automationId: string; versionId: string; artifactId: string; status: string }[];
  lastEvent: { at: number; viewer: string; code: string } | null;
  automations: Automation[];
  activity: Activity[];
  compiler: { kind: 'codex' | 'offline'; model: string | null };
  runs: Run[];
  twitch: TwitchStatus;
}
export interface PreviewResult {
  provenance: 'synthetic';
  artifactId: string;
  seed: number;
  decisions: Decision[];
  session?: SessionSnapshot;
  durationMs: number;
}

/** Result of replaying a live round's journal privately (POST /api/automations/:id/session/audit). */
export interface SessionAudit {
  status: 'verified' | 'diverged' | 'unavailable';
  sessionId: string;
  summary: string;
  entries: number;
  joins: number;
  contributions: number;
  rejections: number;
  controls: number;
  durationMs: number;
  divergence: { seq: number; kind: string; expected: string; actual: string } | null;
}

export type TransitionBoundary = 'immediate' | 'round-end' | 'stopped';
export type TransitionStatus = 'review' | 'pending' | 'applied' | 'cancelled';
/** Studio list view: no migration source or evidence (those come only from the preview call). */
export interface TransitionSummary {
  id: string;
  status: TransitionStatus;
  sourceVersionId: string;
  targetVersionId: string;
  boundary?: TransitionBoundary;
  createdAt?: number;
  appliedAt?: number | null;
}
/** Host assessment of carrying a live round over to this version's rules. */
export interface ProgressAssessment {
  kind: 'migration-required' | 'reset-required';
  reasons: string[];
}
export interface Transition {
  id: string;
  sourceVersionId: string;
  targetVersionId: string;
  sourceSessionId: string;
  migrationSource: string;
  evidenceId: string;
  status: TransitionStatus;
  plan: { targetArtifactId: string; boundary: TransitionBoundary };
  evidence: {
    preserved: string[];
    changed: Change[];
    reset: string[];
    takesEffect: TransitionBoundary;
    beforeRules: { definition: ExperienceDefinition; audience: Role[] };
    afterRules: { definition: ExperienceDefinition; audience: Role[] };
    migration: { before: SessionSnapshot; after: SessionSnapshot };
    comparison: {
      provenance: 'synthetic';
      label: string;
      /** A paused round was resumed privately so the comparison exercises live-like rules. */
      resumedPrivately?: boolean;
      events: { id: string; text: string }[];
      steps: {
        eventId: string;
        before: { code: string; reason: string; effects: unknown[] };
        after: { code: string; reason: string; effects: unknown[] };
      }[];
      before: SessionSnapshot;
      after: SessionSnapshot;
    };
  };
}
