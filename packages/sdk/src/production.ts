/** Host-only production contracts. No guest transport or credential access is granted. */
export type ProductionKind = 'obs' | 'streamerbot' | 'firebot';
/** Automation tools whose events and actions can be bridged to Riff mappings. */
export type ProductionBotKind = Exclude<ProductionKind, 'obs'>;
export interface ProductionMapping {
  id: string;
  eventName: string;
  versionId: string;
  control: 'start' | 'pause';
  actionId: string | null;
  /** The tool this mapping bridges. Absent means Streamer.bot (version 1 documents). */
  tool?: ProductionBotKind | undefined;
}
export interface ProductionConnection {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  reason: string | null;
  url: string | null;
  scenes: string[];
  actions: { id: string; name: string; enabled: boolean }[];
  /** Read-only command triggers discovered from Firebot; never invoked. */
  commands?: string[];
}
export interface ObsSetupReview {
  digest: string;
  sceneName: string;
  inputName: string;
  width: number;
  height: number;
  operation: 'create' | 'update';
  status: 'review' | 'test' | 'live' | 'rolled-back';
  before: { width: number | null; height: number | null; mode: 'owned-browser' } | null;
}
export interface ProductionMappingReview {
  digest: string;
  mappings: ProductionMapping[];
  unsupported: string[];
  differences: string[];
}
export interface ProductionState {
  revision: number;
  configured: boolean;
  origin: string;
  connections: Record<ProductionKind, ProductionConnection>;
  obsReview: ObsSetupReview | null;
  mappingReview: ProductionMappingReview | null;
  mappings: ProductionMapping[];
  recent: { at: number; code: string; message: string }[];
}

/** Native configuration import (F39): read as data only, never executed. */
export type ProductionImportTool = 'streamerbot' | 'firebot' | 'obs';
export type ProductionImportTrigger =
  'command' | 'cheer' | 'sub' | 'raid' | 'redemption' | 'follow';
export type ProductionImportAction = 'scene' | 'source-visibility' | 'media' | 'chat';
export interface ProductionImportItem {
  /** Deterministic for the same tool and source item, so re-imports are idempotent. */
  id: string;
  kind: 'action' | 'command' | 'event' | 'preset' | 'scene' | 'source' | 'script' | 'component';
  name: string;
  /**
   * mapped: a recognised trigger with recognised actions; review: something needs a
   * person (scripts, unknown parts); imported: read for reference only; skipped: not read.
   */
  status: 'mapped' | 'review' | 'imported' | 'skipped';
  trigger: { kind: ProductionImportTrigger; detail: string | null } | null;
  actions: { kind: ProductionImportAction; detail: string }[];
  /** Plain-language parts that were not imported and need manual review. */
  review: string[];
  reason: string | null;
  /** Proposed authoring intent the creator can edit and compile. */
  intent: string | null;
  /** Proposed external event name for a bridge mapping draft (bot tools only). */
  bridge: string | null;
  drafted: 'intent' | 'bridge' | null;
}
export interface ProductionImportReport {
  tool: ProductionImportTool;
  title: string | null;
  counts: { imported: number; mapped: number; review: number; skipped: number };
  items: ProductionImportItem[];
  notes: string[];
}
