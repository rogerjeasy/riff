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
  /** F29: publisher-declared editable parameters; absent on editions without any. */
  parameters?: RecipeParameter[] | undefined;
}
/** Localized copy keyed by recipe language; at least one language is present. */
export type RecipeLocalizedCopy = Partial<Record<RecipeLanguage, string>>;
/**
 * F29: one declared, typed, bounded parameter. Command and number defaults are read from
 * the published manifest; color and copy defaults are carried here because the artifact
 * has no other place for them. The host applies values, never the model.
 */
export type RecipeParameter =
  | { id: 'command'; kind: 'command'; label: string }
  | {
      id: 'maxPerViewer' | 'windowMs';
      kind: 'number';
      label: string;
      min: number;
      max: number;
      step: number;
    }
  | { id: 'accent'; kind: 'color'; label: string; palette: string[]; default: string }
  | { id: 'headline'; kind: 'copy'; label: string; maxLength: number; default: RecipeLocalizedCopy }
  | { id: 'experienceTitle'; kind: 'copy'; label: string; maxLength: number };
export type RecipeParameterId = RecipeParameter['id'];
/** Values chosen by a recipient; every key must be declared by the edition. */
export interface RecipeParameterValues {
  command?: string | undefined;
  maxPerViewer?: number | undefined;
  windowMs?: number | undefined;
  accent?: string | undefined;
  headline?: RecipeLocalizedCopy | undefined;
  experienceTitle?: string | undefined;
}
/** Host-rendered cosmetic choices installed alongside a parameterized candidate. */
export interface RecipeStyle {
  accent?: string | undefined;
  headline?: RecipeLocalizedCopy | undefined;
}
/** One applied parameter and whether it widens what viewers can make the automation do. */
export interface RecipeParameterChange {
  id: RecipeParameterId;
  field: string;
  before: string;
  after: string;
  authority: 'widened' | 'narrowed' | 'unchanged' | 'cosmetic';
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
  /** F29: present when the candidate came from declared parameters, not the compiler. */
  parameters?:
    | { values: RecipeParameterValues; changes: RecipeParameterChange[]; style: RecipeStyle }
    | undefined;
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
  /** F29: editable parameters to declare; derivatives inherit their source's when omitted. */
  parameters?: RecipeParameter[];
}
export interface RecipeAdaptInput {
  sourceDigest: string;
  profileRevision: number;
  generate?: boolean;
  targetVersionId?: string;
  /** F29: deterministic host substitution of declared parameters; excludes `generate`. */
  parameters?: RecipeParameterValues;
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
