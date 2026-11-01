import type { Rect, Scene } from './schema.js';

/** One-click starting points. They only move the standard areas; validation still decides. */
const SIDES: Record<'left' | 'right', Record<string, Rect>> = {
  left: {
    gameplay: { x: 440, y: 20, width: 540, height: 840 },
    'scoreboard-region': { x: 20, y: 340, width: 400, height: 520 },
    effects: { x: 460, y: 40, width: 500, height: 580 },
    celebration: { x: 460, y: 640, width: 500, height: 180 },
    scoreboard: { x: 20, y: 340, width: 400, height: 240 },
    instructions: { x: 20, y: 600, width: 400, height: 240 },
  },
  right: {
    gameplay: { x: 20, y: 340, width: 540, height: 520 },
    'scoreboard-region': { x: 580, y: 20, width: 400, height: 840 },
    effects: { x: 40, y: 360, width: 500, height: 300 },
    celebration: { x: 40, y: 680, width: 500, height: 160 },
    scoreboard: { x: 580, y: 20, width: 400, height: 240 },
    instructions: { x: 580, y: 600, width: 400, height: 240 },
  },
};
const HOME: Record<string, string> = {
  effects: 'gameplay',
  celebration: 'gameplay',
  scoreboard: 'scoreboard-region',
  instructions: 'scoreboard-region',
};
/** True when the scene still has the standard areas a quick layout rearranges. */
export function hasStandardAreas(scene: Scene): boolean {
  return (
    ['gameplay', 'scoreboard-region'].every((id) =>
      scene.regions.some((r) => r.id === id && !r.protected),
    ) &&
    ['effects', 'scoreboard', 'instructions'].every((id) => scene.nodes.some((n) => n.id === id))
  );
}
/** Put the scoreboard and instructions column on one side and gameplay on the other. */
export function scoreboardSide(scene: Scene, side: 'left' | 'right'): Scene {
  const rects = SIDES[side];
  const at = (id: string) => {
    const rect = rects[id];
    return rect ? { ...rect } : null;
  };
  return {
    ...scene,
    regions: scene.regions.map((r) => {
      const rect = at(r.id);
      return rect ? { ...r, rect } : r;
    }),
    nodes: scene.nodes.map((n) => {
      const rect = at(n.id);
      return rect ? { ...n, rect, regionId: HOME[n.id] ?? n.regionId } : n;
    }),
  };
}
