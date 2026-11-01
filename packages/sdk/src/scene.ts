/** Host presentation contract. These values grant no guest execution capability. */
export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SceneRegion {
  id: string;
  label: string;
  kind: 'camera' | 'captions' | 'gameplay' | 'scoreboard' | 'custom';
  protected: boolean;
  rect: SceneRect;
}
export interface SceneNode {
  id: string;
  kind: 'effects' | 'scoreboard' | 'instructions' | 'celebration';
  regionId: string;
  rect: SceneRect;
  asset: 'tomato' | 'star' | 'heart' | null;
  timing: { trigger: 'always' | 'round-start' | 'round-end'; delayMs: number; durationMs: number };
}
export interface SceneDocument {
  version: 1;
  regions: SceneRegion[];
  nodes: SceneNode[];
}
export const SCENE_LIMITS = Object.freeze({
  grid: 1000,
  regions: 12,
  nodes: 8,
  timeMs: 60_000,
  revisions: 100,
});
/** Safe legacy layout. Clone before editing. All rectangles use global grid coordinates. */
export const DEFAULT_SCENE: SceneDocument = {
  version: 1,
  regions: [
    {
      id: 'camera',
      label: 'Camera',
      kind: 'camera',
      protected: true,
      rect: { x: 20, y: 20, width: 240, height: 300 },
    },
    {
      id: 'captions',
      label: 'Captions',
      kind: 'captions',
      protected: true,
      rect: { x: 20, y: 880, width: 960, height: 100 },
    },
    {
      id: 'gameplay',
      label: 'Gameplay',
      kind: 'gameplay',
      protected: false,
      rect: { x: 440, y: 20, width: 540, height: 840 },
    },
    {
      id: 'scoreboard-region',
      label: 'Scoreboard',
      kind: 'scoreboard',
      protected: false,
      rect: { x: 20, y: 340, width: 400, height: 520 },
    },
  ],
  nodes: [
    {
      id: 'effects',
      kind: 'effects',
      regionId: 'gameplay',
      rect: { x: 460, y: 40, width: 500, height: 580 },
      asset: null,
      timing: { trigger: 'always', delayMs: 0, durationMs: 0 },
    },
    {
      id: 'scoreboard',
      kind: 'scoreboard',
      regionId: 'scoreboard-region',
      rect: { x: 20, y: 340, width: 400, height: 240 },
      asset: null,
      timing: { trigger: 'always', delayMs: 0, durationMs: 0 },
    },
    {
      id: 'instructions',
      kind: 'instructions',
      regionId: 'scoreboard-region',
      rect: { x: 20, y: 600, width: 400, height: 240 },
      asset: null,
      timing: { trigger: 'always', delayMs: 0, durationMs: 0 },
    },
    {
      id: 'celebration',
      kind: 'celebration',
      regionId: 'gameplay',
      rect: { x: 460, y: 640, width: 500, height: 180 },
      asset: 'tomato',
      timing: { trigger: 'round-end', delayMs: 0, durationMs: 5000 },
    },
  ],
};
