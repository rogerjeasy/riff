import { z } from 'zod';

/** Browser wire contract, deliberately independent of server/compiler bundles. */
const id = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const rectSchema = z
  .object({
    x: z.number().int().min(0).max(1000),
    y: z.number().int().min(0).max(1000),
    width: z.number().int().min(1).max(1000),
    height: z.number().int().min(1).max(1000),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1000 && r.y + r.height <= 1000,
    'Keep the rectangle inside the scene.',
  );
const regionSchema = z
  .object({
    id,
    label: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)),
    kind: z.enum(['camera', 'captions', 'gameplay', 'scoreboard', 'custom']),
    protected: z.boolean(),
    rect: rectSchema,
  })
  .strict();
export const timingSchema = z
  .object({
    trigger: z.enum(['always', 'round-start', 'round-end']),
    delayMs: z.number().int().min(0).max(60000),
    durationMs: z.number().int().min(0).max(60000),
  })
  .strict();
const nodeSchema = z
  .object({
    id,
    kind: z.enum(['effects', 'scoreboard', 'instructions', 'celebration']),
    regionId: id,
    rect: rectSchema,
    asset: z.enum(['tomato', 'star', 'heart']).nullable(),
    timing: timingSchema,
  })
  .strict();
export type Rect = z.infer<typeof rectSchema>;
export function contains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
/** Plain names for creator-facing messages. */
export const KIND_NAME: Record<z.infer<typeof nodeSchema>['kind'], string> = {
  effects: 'Effects',
  scoreboard: 'Scoreboard',
  instructions: 'Instructions',
  celebration: 'Celebration',
};
/** Structure only: safe to draw in private previews while a draft is still invalid. */
export const sceneShapeSchema = z
  .object({
    version: z.literal(1),
    regions: z.array(regionSchema).min(1).max(12),
    nodes: z.array(nodeSchema).min(1).max(8),
  })
  .strict();
export const sceneSchema = sceneShapeSchema.superRefine((s, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: 'custom', message, path });
  const ids = [...s.regions, ...s.nodes].map((n) => n.id);
  if (new Set(ids).size !== ids.length) issue('Scene identifiers must be unique.');
  if (new Set(s.nodes.map((n) => n.kind)).size !== s.nodes.length)
    issue('Use one object of each kind.');
  for (const kind of ['effects', 'scoreboard', 'instructions'] as const)
    if (!s.nodes.some((n) => n.kind === kind)) issue(`The ${KIND_NAME[kind]} object is required.`);
  for (const kind of ['camera', 'captions'])
    if (!s.regions.some((r) => r.kind === kind && r.protected))
      issue(`A protected ${kind} region is required.`);
  s.nodes.forEach((n, i) => {
    const name = KIND_NAME[n.kind];
    const at = ['nodes', i];
    const region = s.regions.find((r) => r.id === n.regionId);
    if (!region || region.protected || !contains(region.rect, n.rect))
      issue(`${name} must sit wholly inside an unprotected region.`, at);
    const covered = s.regions.find((r) => r.protected && intersects(r.rect, n.rect));
    if (covered) issue(`${name} covers the protected ${covered.label} region.`, at);
    if (
      n.timing.trigger === 'always'
        ? n.timing.delayMs !== 0 || n.timing.durationMs !== 0
        : n.timing.durationMs === 0
    )
      issue(`${name} needs a duration when it is timed, or no timing when always shown.`, at);
    if (n.kind === 'scoreboard' || n.kind === 'instructions') {
      if (n.rect.width < 400 || n.rect.height < 200)
        issue(`${name} needs at least 400 × 200 units to stay readable on phones.`, at);
      if (n.timing.trigger !== 'always') issue(`${name} must always be visible.`, at);
      const other = s.nodes.find((o) => o !== n && intersects(o.rect, n.rect));
      if (other) issue(`${name} overlaps ${KIND_NAME[other.kind]}.`, at);
    }
    if (n.kind !== 'celebration' && n.asset !== null)
      issue('Only the celebration can show a sprite.', at);
  });
});
export type Scene = z.infer<typeof sceneSchema>;
export type SceneNode = Scene['nodes'][number];
const always = { trigger: 'always' as const, delayMs: 0, durationMs: 0 };
export function defaultScene(): Scene {
  return {
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
        timing: { ...always },
      },
      {
        id: 'scoreboard',
        kind: 'scoreboard',
        regionId: 'scoreboard-region',
        rect: { x: 20, y: 340, width: 400, height: 240 },
        asset: null,
        timing: { ...always },
      },
      {
        id: 'instructions',
        kind: 'instructions',
        regionId: 'scoreboard-region',
        rect: { x: 20, y: 600, width: 400, height: 240 },
        asset: null,
        timing: { ...always },
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
}
const revision = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const classification = z.enum(['review', 'configuration']);
export const sceneHistorySchema = z
  .object({
    revision,
    digest,
    scene: sceneSchema,
    source: z.enum(['default', 'direct', 'generated', 'undo', 'inherited']),
    classification,
    generation: z
      .object({ origin: z.enum(['offline', 'codex']), summary: z.string().max(400) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const sceneStateSchema = z
  .object({
    versionId: z.string(),
    artifactId: z.string(),
    revision,
    digest,
    scene: sceneSchema,
    classification,
    instructions: z.array(z.string().max(200)).max(4).optional(),
    appliedRevision: revision.nullable(),
    history: z.array(sceneHistorySchema).max(100),
    checks: z.array(z.string().max(500)).max(30),
    sharing: z.array(z.string().max(300)).max(16).optional(),
  })
  .passthrough();
export type SceneState = z.infer<typeof sceneStateSchema>;
export const sceneProjectionSchema = z
  .object({
    automationId: z.string(),
    versionId: z.string(),
    revision,
    digest,
    scene: sceneSchema,
    instructions: z.array(z.string().max(200)).max(4).optional(),
  })
  .strict();
export type SceneProjection = z.infer<typeof sceneProjectionSchema>;
