import type { PermissionManifest, AudienceRole } from './index.js';
import type { SceneDocument } from './scene.js';
export type RecipeLanguage = 'en' | 'fr' | 'es' | 'de';
export type RecipeLicense = 'MIT' | 'CC0-1.0' | 'CC-BY-4.0';
export interface RecipeCredit {
  recipeId: string;
  revision: number;
  digest: string;
  author: string;
  license: RecipeLicense;
}
export interface RecipePackage {
  version: 1;
  recipeId: string;
  revision: number;
  digest: string;
  title: string;
  description: string;
  author: string;
  license: RecipeLicense;
  rightsAttested: true;
  source: string;
  manifest: PermissionManifest;
  tests: unknown;
  scene: SceneDocument;
  presentation: {
    language: RecipeLanguage;
    reducedMotion: boolean;
    highContrast?: boolean | undefined;
    effectLabels?: boolean | undefined;
  };
  assets: { id: 'tomato' | 'star' | 'heart'; credit: 'Riff'; license: 'project-license' }[];
  lineage: RecipeCredit[];
}
export interface RecipeProfile {
  revision: number;
  displayName: string;
  language: RecipeLanguage;
  reducedMotion: boolean;
  highContrast?: boolean | undefined;
  effectLabels?: boolean | undefined;
  scene: SceneDocument;
  capabilities: ('overlay' | 'session')[];
  command: string;
  audience: AudienceRole[];
  maxPerViewer: number;
  windowMs: number;
}
export interface RecipeImport {
  digest: string;
  package: RecipePackage;
  supported: boolean;
  blockers: string[];
}
export interface RecipeDifference {
  field: string;
  before: string;
  after: string;
}
export interface RecipeProof {
  synthetic: true;
  accepted: number;
  blocked: number;
  scores: Record<string, number>;
  contributions: number;
  steps: {
    at: number;
    text: string;
    code: string;
    reason: string;
    effects: { asset: 'tomato' | 'star' | 'heart'; x: number }[];
  }[];
}
export interface RecipeReview {
  verification: unknown;
  proof: RecipeProof;
  requiredTwitchScopes: ['user:read:chat'];
  id: string;
  digest: string;
  sourceDigest: string;
  profileRevision: number;
  artifactId: string;
  source: string;
  manifest: PermissionManifest;
  tests: unknown;
  scene: SceneDocument;
  differences: RecipeDifference[];
  passed: boolean;
  checks: string[];
  rehearsalHash: string;
  installedVersionId: string | null;
  targetVersionId: string | null;
}
export interface RecipeReport {
  id: string;
  digest: string;
  reason: string;
  status: 'open' | 'resolved';
  createdAt: number;
}
export interface RecipePublication {
  proof: RecipeProof;
  package: RecipePackage;
  withheld: boolean;
  samples: { at: number; asset: 'tomato' | 'star' | 'heart'; x: number }[];
}
export interface RecipeState {
  profile: RecipeProfile;
  imports: RecipeImport[];
  reviews: RecipeReview[];
  publications: RecipePublication[];
  reports: RecipeReport[];
}
export interface RecipeExportInput {
  versionId: string;
  title: string;
  description: string;
  author: string;
  license: RecipeLicense;
  rightsAttested: true;
  recipeId?: string;
  revision?: number;
}
export interface RecipeAdaptInput {
  sourceDigest: string;
  profileRevision: number;
  generate?: boolean;
  targetVersionId?: string;
}
export interface RecipeInstallInput {
  reviewId: string;
  digest: string;
}
export interface RecipePresentation {
  language: RecipeLanguage;
  reducedMotion: boolean;
  highContrast?: boolean | undefined;
  effectLabels?: boolean | undefined;
  instructions: string[];
}
/** An edition this channel exported; identity is null for exports recorded before F38 hardening. */
export interface RecipeExportSummary {
  digest: string;
  recipeId: string | null;
  revision: number | null;
  title: string | null;
}
/** Retention bounds for one channel's recipe library. */
export interface RecipeLibraryLimits {
  imports: number;
  exports: number;
  reviews: number;
  publications: number;
  reports: number;
  openReportsPerEdition: number;
}
/** The private library view: the stored state plus exports and bounds for room-making UI. */
export interface RecipeLibraryState extends RecipeState {
  exports: RecipeExportSummary[];
  limits: RecipeLibraryLimits;
}
/** Remove one import or export to make room; installed imports are kept for lineage. */
export interface RecipeRemoveInput {
  kind: 'import' | 'export';
  digest: string;
}
