/** Host presentation contracts. These grant no generated-code capabilities. */
export interface DirectorEnvelope {
  version: 1;
  intervalMs: { min: number; max: number };
  batchSize: { min: number; max: number };
  intensity: { min: number; max: number };
  interruptionsPerMinute: number;
  participation: 'fifo' | 'first-time';
}
export interface DirectorSettings {
  intervalMs: number;
  batchSize: number;
  intensity: number;
}
export type DirectorMode = 'balanced' | 'gameplay' | 'locked' | 'manual';
export interface DirectorFrame {
  id: string;
  asset: 'tomato' | 'star' | 'heart';
  x: number;
  viewer: string | null;
  automationId?: string;
  versionId?: string;
  intensity?: number;
}
export interface DirectorDecision {
  at: number;
  reason: string;
  settings: DirectorSettings;
  pending: number;
  activity: number;
}
export interface DirectorSnapshot {
  mode: DirectorMode;
  settings: DirectorSettings;
  accepted: number;
  offered: number;
  presented: number;
  coalesced: number;
  expired: number;
  cleared: number;
  pending: number;
  decisions: DirectorDecision[];
}
export const DEFAULT_DIRECTOR_ENVELOPE: DirectorEnvelope = {
  version: 1,
  intervalMs: { min: 500, max: 1500 },
  batchSize: { min: 1, max: 4 },
  intensity: { min: 35, max: 100 },
  interruptionsPerMinute: 30,
  participation: 'first-time',
};
export interface DirectorEvidence {
  hash: string;
  digest: string;
  versionId: string;
  artifactId: string;
  scenarioHash: string;
  rehearsalHash: string;
  passed: boolean;
  accepted: number;
  blocked: number;
  scores: Record<string, number>;
  contributions: number;
  stateDigest: string;
  replayStateDigest: string;
  telemetry: DirectorSnapshot;
  samples: { at: number; frames: DirectorFrame[] }[];
  provenance: 'synthetic';
}
export interface DirectorRevision {
  revision: number;
  digest: string;
  envelope: DirectorEnvelope;
}
export interface DirectorApproval extends DirectorRevision {
  evidenceHash: string;
  approvedAt: number;
}
export interface DirectorState {
  revision: number;
  draft: (DirectorRevision & { evidence: DirectorEvidence | null }) | null;
  approved: DirectorApproval | null;
  enabled: boolean;
  mode: DirectorMode;
  settings: DirectorSettings | null;
  history: DirectorRevision[];
  telemetry: DirectorSnapshot | null;
}
