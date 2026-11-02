import { z } from 'zod';
import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import {
  sceneProjectionSchema,
  defaultScene,
  contains,
  intersects,
  type SceneProjection,
  type SceneNode,
  type Rect,
} from './schema.js';
import { renderScene, launchSceneEffect, clearScene } from './render.js';
import { clearStage, type Asset } from '../effects/projectile.js';
type Session = {
  automationId: string;
  versionId?: string | undefined;
  definition: ExperienceDefinition;
  snapshot: SessionSnapshot;
};
/** A rectangle's overlap with a node, in percentages of the node box. */
function clipTo(node: Rect, r: Rect) {
  const pct = (v: number, start: number, size: number) =>
    Math.min(100, Math.max(0, ((v - start) / size) * 100));
  return {
    x1: pct(r.x, node.x, node.width),
    y1: pct(r.y, node.y, node.height),
    x2: pct(r.x + r.width, node.x, node.width),
    y2: pct(r.y + r.height, node.y, node.height),
  };
}
/** One even-odd polygon: the full box with each hole joined to the origin by a zero-width seam. */
function cutout(holes: { x1: number; y1: number; x2: number; y2: number }[]) {
  const point = (x: number, y: number) => `${x}% ${y}%`;
  const parts = [point(0, 0), point(100, 0), point(100, 100), point(0, 100), point(0, 0)];
  for (const h of holes)
    parts.push(
      point(h.x1, h.y1),
      point(h.x2, h.y1),
      point(h.x2, h.y2),
      point(h.x1, h.y2),
      point(h.x1, h.y1),
      point(0, 0),
    );
  return `polygon(evenodd, ${parts.join(', ')})`;
}
/** Identity-routed live adapter. Private previews never construct a connection or call it. */
export function createSceneOverlay(
  root: HTMLElement,
  options: { reducedMotion: boolean; showLabels?: boolean },
) {
  let projections: SceneProjection[] = [],
    sessions: Session[] = [];
  // Lets the shared scene stylesheet honour the overlay's `?motion=reduced` flag too.
  if (options.reducedMotion) root.dataset.motion = 'reduced';
  const layers = new Map<string, HTMLElement>();
  function clear() {
    for (const node of layers.values()) clearScene(node);
    root.replaceChildren();
    layers.clear();
    projections = [];
    sessions = [];
    layout();
  }
  type Key = string;
  const keyOf = (p: SceneProjection, id: string): Key => `${p.automationId}:${id}`;
  const sessionOf = (p: SceneProjection) =>
    sessions.find((s) => s.automationId === p.automationId && s.versionId === p.versionId);
  /** Where text actually goes: computed when scenes, sessions or instructions change. */
  let plan = {
    occupied: [] as Rect[],
    accepted: new Set<Key>(),
    moved: new Map<Key, Rect>(),
    merged: new Map<Key, string[]>(),
  };
  let cardBox: Rect | null | undefined;
  function layout() {
    cardBox = undefined;
    const protectedRects = projections.flatMap((p) =>
      p.scene.regions.filter((r) => r.protected).map((r) => r.rect),
    );
    const next = {
      occupied: [] as Rect[],
      accepted: new Set<Key>(),
      moved: new Map<Key, Rect>(),
      merged: new Map<Key, string[]>(),
    };
    const free = (r: Rect) =>
      !protectedRects.some((x) => intersects(x, r)) && !next.occupied.some((x) => intersects(x, r));
    // An idle scoreboard or empty instruction list draws nothing, so it reserves nothing.
    const hasText = (p: SceneProjection, n: SceneNode) =>
      n.kind === 'scoreboard' ? Boolean(sessionOf(p)) : (p.instructions ?? []).length > 0;
    const pending: { p: SceneProjection; n: SceneNode }[] = [];
    // Reserve all critical text before considering any effects, regardless of mount order.
    for (const p of projections)
      for (const n of p.scene.nodes) {
        if ((n.kind !== 'scoreboard' && n.kind !== 'instructions') || !hasText(p, n)) continue;
        if (free(n.rect)) {
          next.occupied.push(n.rect);
          next.accepted.add(keyOf(p, n.id));
        } else pending.push({ p, n });
      }
    const placedInstructions = () =>
      projections.flatMap((p) =>
        p.scene.nodes
          .filter((n) => n.kind === 'instructions' && next.accepted.has(keyOf(p, n.id)))
          .map((n) => ({ key: keyOf(p, n.id), rect: next.moved.get(keyOf(p, n.id)) ?? n.rect })),
      );
    for (const { p, n } of pending) {
      // Instructions that share space join the panel already there: viewers see every command.
      if (n.kind === 'instructions') {
        const panels = placedInstructions();
        const target = panels.find((x) => intersects(x.rect, n.rect)) ?? panels[0];
        if (target) {
          next.merged.set(target.key, [
            ...(next.merged.get(target.key) ?? []),
            ...(p.instructions ?? []),
          ]);
          continue;
        }
      }
      // Otherwise move it to the nearest free spot inside its own unprotected region.
      const region = p.scene.regions.find((r) => r.id === n.regionId);
      if (!region || region.protected) continue;
      const own = p.scene.nodes.filter((o) => o.id !== n.id).map((o) => o.rect);
      let best: Rect | null = null,
        distance = Infinity;
      for (let y = region.rect.y; y + n.rect.height <= region.rect.y + region.rect.height; y += 10)
        for (
          let x = region.rect.x;
          x + n.rect.width <= region.rect.x + region.rect.width;
          x += 10
        ) {
          const r = { x, y, width: n.rect.width, height: n.rect.height };
          const d = Math.abs(x - n.rect.x) + Math.abs(y - n.rect.y);
          if (d < distance && free(r) && !own.some((o) => intersects(o, r))) {
            best = r;
            distance = d;
          }
        }
      if (best) {
        next.occupied.push(best);
        next.accepted.add(keyOf(p, n.id));
        next.moved.set(keyOf(p, n.id), best);
      }
    }
    plan = next;
  }
  function render(now = Date.now()) {
    const protectedRects = projections.flatMap((p) =>
      p.scene.regions.filter((r) => r.protected).map((r) => r.rect),
    );
    for (const p of projections) {
      const layer = layers.get(p.automationId);
      if (!layer) continue;
      const session = sessionOf(p);
      const moved = p.scene.nodes.some((n) => plan.moved.has(keyOf(p, n.id)));
      const scene = moved
        ? {
            ...p.scene,
            nodes: p.scene.nodes.map((n) => ({
              ...n,
              rect: plan.moved.get(keyOf(p, n.id)) ?? n.rect,
            })),
          }
        : p.scene;
      const instructionsNode = p.scene.nodes.find((n) => n.kind === 'instructions');
      const extra = instructionsNode ? plan.merged.get(keyOf(p, instructionsNode.id)) : undefined;
      renderScene(layer, scene, {
        now,
        definition: session?.definition,
        snapshot: session?.snapshot,
        instructions: [...(p.instructions ?? []), ...(extra ?? [])],
        ...(p.language ? { language: p.language } : {}),
      });
      for (const n of scene.nodes) {
        const element = [...layer.querySelectorAll<HTMLElement>('[data-scene-node]')].find(
          (e) => e.dataset.sceneNode === n.id,
        );
        if (!element) continue;
        const text = n.kind === 'scoreboard' || n.kind === 'instructions';
        if (text) {
          if (element.dataset.empty !== 'true' && !plan.accepted.has(keyOf(p, n.id))) {
            element.hidden = true;
            for (const effect of element.querySelectorAll('[data-projectile]')) effect.remove();
          }
          continue;
        }
        // Effects keep playing, but are cut away wherever another interaction's text or
        // protected area sits: text stays readable and protected areas stay clear.
        const holes = [...protectedRects, ...plan.occupied]
          .filter((r) => intersects(r, n.rect))
          .map((r) => clipTo(n.rect, r));
        if (holes.length) {
          element.style.setProperty('clip-path', cutout(holes));
          element.dataset.clipped = 'true';
        } else {
          element.style.removeProperty('clip-path');
          delete element.dataset.clipped;
        }
      }
    }
  }
  return {
    clear,
    /**
     * A card-sized free box for the community card: never over protected areas or visible
     * text, preferably clear of effects, and as close to a screen edge as possible.
     * Computed once per layout change; the overlay asks for it on every redraw.
     */
    communityRegion(): Rect | null {
      if (cardBox !== undefined) return cardBox;
      const scenes = projections.length ? projections.map((p) => p.scene) : [defaultScene()];
      const hard = [
        ...scenes.flatMap((s) => s.regions.filter((r) => r.protected).map((r) => r.rect)),
        ...(projections.length
          ? plan.occupied
          : scenes.flatMap((s) =>
              s.nodes
                .filter((n) => n.kind === 'scoreboard' || n.kind === 'instructions')
                .map((n) => n.rect),
            )),
      ];
      const soft = scenes.flatMap((s) =>
        s.nodes.filter((n) => n.kind === 'effects' || n.kind === 'celebration').map((n) => n.rect),
      );
      const areas = scenes.flatMap((s) => s.regions.filter((r) => !r.protected).map((r) => r.rect));
      // Nearest a screen edge first; among equals, the lower-right (where cards usually live).
      const cost = (b: Rect) =>
        Math.min(b.x, b.y, 1000 - b.x - b.width, 1000 - b.y - b.height) * 10_000 - b.x - b.y;
      cardBox = null;
      search: for (const obstacles of [[...hard, ...soft], hard])
        for (const size of [
          { width: 300, height: 360 },
          { width: 300, height: 200 },
          { width: 260, height: 140 },
        ]) {
          let best: Rect | null = null;
          for (let y = 0; y + size.height <= 1000; y += 20)
            for (let x = 0; x + size.width <= 1000; x += 20) {
              const box = { x, y, ...size };
              if (best && cost(box) >= cost(best)) continue;
              if (!areas.some((a) => contains(a, box))) continue;
              if (obstacles.some((o) => intersects(o, box))) continue;
              best = box;
            }
          if (best) {
            cardBox = best;
            break search;
          }
        }
      return cardBox;
    },
    setScenes(raw: unknown) {
      const checked = z.array(sceneProjectionSchema).max(64).safeParse(raw);
      if (
        !checked.success ||
        new Set(checked.data.map((p) => p.automationId)).size !== checked.data.length
      ) {
        clear();
        return;
      }
      const next = checked.data.sort((a, b) => a.automationId.localeCompare(b.automationId));
      for (const [id, layer] of layers) {
        const p = next.find((p) => p.automationId === id),
          old = projections.find((p) => p.automationId === id);
        if (!p || p.versionId !== old?.versionId || p.digest !== old.digest) {
          clearScene(layer);
          layer.remove();
          layers.delete(id);
        }
      }
      projections = next;
      layout();
      for (const p of projections)
        if (!layers.has(p.automationId)) {
          const layer = document.createElement('div');
          layer.className = 'scene-live-layer';
          layer.dataset.sceneAutomation = p.automationId;
          Object.assign(layer.style, { position: 'absolute', inset: '0' });
          layers.set(p.automationId, layer);
          root.append(layer);
        }
      for (const p of projections) {
        const layer = layers.get(p.automationId);
        if (layer) {
          layer.dataset.highContrast = String(p.highContrast === true);
          // Schema-checked #rrggbb only; it is a CSS custom property, never markup.
          if (p.accent) layer.style.setProperty('--scene-accent', p.accent);
          else layer.style.removeProperty('--scene-accent');
          layer.lang = p.language ?? 'en';
          // A viewer asked `!riff help`: emphasise the instruction panel for the help window.
          layer.dataset.reducedMotion = String(p.reducedMotion === true);
          if (p.help) layer.dataset.help = 'true';
          else delete layer.dataset.help;
          root.append(layer);
        }
      }
      render();
    },
    setSessions(next: Session[]) {
      for (const old of sessions) {
        const replacement = next.find(
          (s) => s.automationId === old.automationId && s.versionId === old.versionId,
        );
        if (
          !replacement ||
          replacement.snapshot.id !== old.snapshot.id ||
          replacement.snapshot.phase === 'paused'
        ) {
          const layer = layers.get(old.automationId);
          if (layer) clearStage(layer);
        }
      }
      sessions = next;
      layout();
      render();
    },
    render,
    effect(effect: {
      intensity?: number | undefined;
      automationId?: string | undefined;
      versionId?: string | undefined;
      asset: Asset;
      x: number;
      viewer?: string | null | undefined;
    }) {
      const p = projections.find(
        (p) => p.automationId === effect.automationId && p.versionId === effect.versionId,
      );
      const layer = p ? layers.get(p.automationId) : null;
      if (!layer) return false;
      render();
      return launchSceneEffect(layer, effect, {
        reducedMotion: options.reducedMotion || p?.reducedMotion === true,
        label: p?.effectLabels ? effect.asset : options.showLabels ? (effect.viewer ?? null) : null,
      });
    },
  };
}
