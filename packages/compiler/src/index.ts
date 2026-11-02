export {
  COMPILE_OUTPUT_JSON_SCHEMA,
  compileOutputSchema,
  compileRequestSchema,
  type CompileOutput,
  type CompileRequest,
} from './contract.js';
export {
  checkIntent,
  describeAudience,
  describeWindow,
  extractIntentHints,
  type IntentAspect,
  type IntentCheck,
  type IntentHints,
  type ManifestView,
} from './intent.js';
export { compileOffline, createOfflineTransport } from './offline.js';
export { compileEventOffline } from './event-output.js';
export { extractEventHints, type EventHints } from './event-hints.js';
export { createCompileQueue, QUEUE_LIMITS, QueueFullError } from './queue.js';
export {
  compile,
  COMPILE_LIMITS,
  type CompileAttempt,
  type CompileHooks,
  type CompileResult,
  type CompileStage,
  type VerificationLike,
} from './run.js';
export type {
  CompilerProgress,
  CompilerSession,
  CompilerTransport,
  CompilerTurn,
  CompilerUsage,
} from './transport.js';
export { buildPrompt, buildRepairPrompt, buildWorkspace, PROMPT_VERSION } from './workspace.js';

export { PRESERVING_MIGRATION_SOURCE } from './experience-output.js';
export { compileFormatOffline, describeFormat } from './format-output.js';
export { formatKindOf } from './format-hints.js';
export {
  extractExperienceHints,
  type ExperienceHints,
  type MechanicHints,
} from './experience-hints.js';

export {
  sceneSchema,
  overlaps,
  contains,
  canonicalScene,
  classifySceneEdit,
  compileScene,
  SCENE_OUTPUT_JSON_SCHEMA,
  SCENE_PROMPT_VERSION,
  type SceneGenerationInput,
  type SceneGenerationResult,
} from './scene.js';
