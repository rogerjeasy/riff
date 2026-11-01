import type { SceneDocument } from '@riff/sdk';
import type { SceneGenerationResult } from '@riff/compiler';
export interface SceneRevision {
  revision: number;
  digest: string;
  scene: SceneDocument;
  source: 'default' | 'direct' | 'generated' | 'undo' | 'inherited';
  classification: 'review' | 'configuration';
  inheritedFrom?: { versionId: string; revision: number; digest: string };
  generation?: Omit<SceneGenerationResult, 'scene'> & { intent: string; selectionId: string };
}
export interface SceneState extends SceneRevision {
  versionId: string;
  artifactId: string;
  appliedRevision: number | null;
  history: SceneRevision[];
  instructions: string[];
  checks: string[];
}
export class SceneError extends Error {
  constructor(
    readonly code: 'INVALID' | 'STALE' | 'NOT_FOUND' | 'BLOCKED' | 'LIMIT' | 'CANCELLED',
    message?: string,
  ) {
    super(
      message ??
        {
          INVALID: 'The scene is invalid. Check protected regions, readable text and timing.',
          STALE: 'The scene changed. Reload the latest revision before saving or applying.',
          NOT_FOUND: 'That scene or behavior version is unavailable.',
          BLOCKED:
            'Apply requires the exact healthy active behavior version and a resumed channel.',
          LIMIT: 'This scene reached its retained history limit of 100 revisions.',
          CANCELLED: 'Scene generation was cancelled or timed out.',
        }[code],
    );
  }
}
