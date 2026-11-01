/** Host-only production contracts. No guest transport or credential access is granted. */
export type ProductionKind = 'obs' | 'streamerbot';
export interface ProductionMapping {
  id: string;
  eventName: string;
  versionId: string;
  control: 'start' | 'pause';
  actionId: string | null;
}
export interface ProductionConnection {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  reason: string | null;
  url: string | null;
  scenes: string[];
  actions: { id: string; name: string; enabled: boolean }[];
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
