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
  | 'STOPPED';
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
}
export interface Manifest {
  sdkVersion: string;
  capabilities: string[];
  trigger: { command: string; audience: Role[]; maxPerViewer: number; windowMs: number };
  limits: { effectsPerEvent: number; effectsPerMinute: number };
}
export interface Stage {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  summary: string;
}
export interface StepResult {
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
  evidence: { verification: Verification; intent: IntentCheck[] };
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
  durationMs: number;
}
