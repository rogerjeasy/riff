import { assetMarkup, clearStage, launch, type LaunchOptions } from '../effects/projectile.js';
import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import { sceneSchema, sceneShapeSchema, type Scene, type SceneNode, type Rect } from './schema.js';
import { mechanicsLines } from '../sessions/mechanics-hud.js';
import './scene.css';

export interface SceneFrame {
  now: number;
  definition?: ExperienceDefinition | null | undefined;
  snapshot?: SessionSnapshot | null | undefined;
  instructions?: string[];
  guides?: boolean;
}
export function timingVisible(
  timing: SceneNode['timing'],
  frame: { snapshot?: SessionSnapshot | null | undefined; now: number; durationMs?: number },
): boolean {
  if (timing.trigger === 'always') return true;
  const s = frame.snapshot;
  if (!s) return false;
  let elapsed: number;
  if (timing.trigger === 'round-end') {
    if (s.phase !== 'finished') return false;
    elapsed = frame.now - s.updatedAt;
  } else {
    if (s.phase === 'finished') return false;
    const remaining =
      s.phase === 'running' && s.deadlineAt !== null
        ? Math.max(0, s.deadlineAt - frame.now)
        : s.remainingMs;
    elapsed = (frame.durationMs ?? 0) - remaining;
  }
  return elapsed >= timing.delayMs && elapsed < timing.delayMs + timing.durationMs;
}
export function positionStyle(rect: Rect) {
  return {
    left: `${rect.x / 10}%`,
    top: `${rect.y / 10}%`,
    width: `${rect.width / 10}%`,
    height: `${rect.height / 10}%`,
  };
}
const scenes = new WeakMap<HTMLElement, string>();
function label(className: string, text: string) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}
function pages(text: string, capacity: number): string[] {
  const out: string[] = [];
  let page = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (page && page.length + word.length + 1 > capacity) {
      out.push(page);
      page = '';
    }
    if (word.length > capacity) {
      if (page) {
        out.push(page);
        page = '';
      }
      for (let i = 0; i < word.length; i += capacity) out.push(word.slice(i, i + capacity));
    } else page = page ? `${page} ${word}` : word;
  }
  if (page) out.push(page);
  return out;
}
/** Pack whole lines into pages that fit `rows` × `cols`; only an oversized line is split. */
function linePages(lines: string[], cols: number, rows: number): string[][] {
  const out: string[][] = [];
  let page: string[] = [],
    used = 0;
  for (const line of lines) {
    for (const part of pages(line, cols * rows)) {
      const need = Math.max(1, Math.ceil(part.length / cols));
      if (page.length && used + need > rows) {
        out.push(page);
        page = [];
        used = 0;
      }
      page.push(part);
      used += need;
    }
  }
  if (page.length) out.push(page);
  return out;
}
/** Plain-language round status, e.g. "1:32 left", "Paused · 0:40 left", "Round over". */
export function roundStatus(snapshot: SessionSnapshot, now: number): string {
  if (snapshot.phase === 'finished') return 'Round over';
  const remaining =
    snapshot.phase === 'running' && snapshot.deadlineAt !== null
      ? Math.max(0, snapshot.deadlineAt - now)
      : snapshot.remainingMs;
  const seconds = Math.ceil(remaining / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
  return snapshot.phase === 'paused' ? `Paused · ${clock}` : clock;
}
/** Both private and live views call this renderer with host-validated logical state. */
export function renderScene(root: HTMLElement, raw: Scene, frame: SceneFrame) {
  // Private previews (guides) may draw a well-formed draft that still fails a layout rule,
  // so the creator sees what they are fixing. Live views accept only fully valid scenes.
  const checked = (frame.guides ? sceneShapeSchema : sceneSchema).safeParse(raw);
  if (!checked.success) {
    clearScene(root);
    return;
  }
  const scene = checked.data as Scene;
  const key = JSON.stringify(scene) + Boolean(frame.guides);
  root.classList.add('riff-scene');
  if (scenes.get(root) !== key) {
    clearScene(root);
    scenes.set(root, key);
    if (frame.guides)
      for (const r of scene.regions) {
        const guide = document.createElement('div');
        guide.className = 'scene-guide';
        guide.dataset.protected = String(r.protected);
        Object.assign(guide.style, positionStyle(r.rect));
        guide.append(label('scene-guide-label', `${r.label}${r.protected ? ' · protected' : ''}`));
        root.append(guide);
      }
    for (const n of scene.nodes) {
      const layer = document.createElement('div');
      layer.dataset.sceneNode = n.id;
      layer.dataset.sceneKind = n.kind;
      layer.className = `scene-node scene-${n.kind}`;
      // Panels hug their text inside the reserved box, anchored to the nearest screen edge.
      layer.dataset.alignX = n.rect.x + n.rect.width / 2 > 500 ? 'end' : 'start';
      layer.dataset.alignY = n.rect.y + n.rect.height / 2 > 500 ? 'end' : 'start';
      Object.assign(layer.style, positionStyle(n.rect), { overflow: 'hidden' });
      root.append(layer);
    }
  }
  for (const n of scene.nodes) {
    const layer = [...root.querySelectorAll<HTMLElement>('[data-scene-node]')].find(
      (e) => e.dataset.sceneNode === n.id,
    );
    if (!layer) continue;
    layer.hidden = !timingVisible(n.timing, {
      snapshot: frame.snapshot,
      now: frame.now,
      ...(frame.definition ? { durationMs: frame.definition.durationMs } : {}),
    });
    if (layer.hidden) {
      clearStage(layer);
      continue;
    }
    if (n.kind === 'effects') continue;
    const children: HTMLElement[] = [];
    const viewportWidth = root.clientWidth || 1280,
      viewportHeight = root.clientHeight || (viewportWidth * 9) / 16;
    const compact = viewportWidth <= 600;
    const boxWidth = (viewportWidth * n.rect.width) / 1000,
      boxHeight = (viewportHeight * n.rect.height) / 1000;
    const padding = compact ? 3 : Math.max(3, Math.min(16, viewportWidth * 0.008));
    let fullText = '';

    if (n.kind === 'instructions') {
      const lines = (frame.instructions ?? []).filter((line) => line.trim()).slice(0, 8);
      fullText = lines.join(' · ');
      const font = compact ? 12 : Math.max(12, Math.min(28, viewportWidth * 0.017));
      const rows = Math.max(1, Math.floor((boxHeight - padding * 2) / (font * 1.18)));
      const cols = Math.max(1, Math.floor((boxWidth - padding * 2) / (font * 0.58)));
      const all = linePages(lines, cols, rows);
      const page = all[Math.floor(Math.max(0, frame.now) / 6000) % Math.max(1, all.length)] ?? [];
      for (const line of page) {
        const p = label('scene-text', line);
        p.style.fontSize = `${font}px`;
        children.push(p);
      }
    }
    if (n.kind === 'scoreboard') {
      const { definition: d, snapshot: s } = frame;
      if (d && s) {
        const status = roundStatus(s, frame.now);
        children.push(label('scene-clock', status));
        const teams = d.teams.length ? d.teams : [{ id: 'community', label: 'Community' }];
        const extra = mechanicsLines(d, s, frame.now);
        fullText = [
          status,
          ...teams.map((t) => `${t.label}: ${s.scores[t.id] ?? 0}`),
          ...extra,
        ].join(' · ');
        const maxFont = (boxHeight - padding * 2) / ((teams.length + 1 + extra.length) * 1.18);
        const rotating = compact || maxFont < 12;
        const rotatingTeam = teams[Math.floor(Math.max(0, frame.now) / 3000) % teams.length];
        const visible = rotating && rotatingTeam ? [rotatingTeam] : teams;
        for (const t of visible)
          children.push(
            label(
              'scene-score',
              `${rotating && t.label.length > 7 ? t.label.slice(0, 6) + '…' : t.label}: ${s.scores[t.id] ?? 0}`,
            ),
          );
        // Version 2 lines (round, health, burst, tier); compact views rotate one at a time.
        const shownExtra = rotating
          ? extra.length
            ? [extra[Math.floor(Math.max(0, frame.now) / 3000) % extra.length] ?? '']
            : []
          : extra;
        for (const line of shownExtra) children.push(label('scene-score scene-mechanics', line));
        for (const child of children)
          child.style.fontSize = `${rotating ? 12 : Math.min(32, viewportWidth * 0.02, maxFont)}px`;
      } else if (frame.guides)
        children.push(
          label(
            'scene-text scene-placeholder',
            d ? 'Scoreboard · shows during a round' : 'Scoreboard · not used by this interaction',
          ),
        );
    }
    if (n.kind === 'celebration') {
      const s = frame.snapshot,
        d = frame.definition;
      const winner = d?.teams.find((t) => t.id === s?.winner)?.label;
      const text =
        s?.winner === 'tie'
          ? 'Round complete · tie'
          : winner
            ? `${winner} wins!`
            : s?.outcome === 'goal' || s?.winner === 'community'
              ? 'Community wins!'
              : 'Round complete';
      fullText = text;
      if (n.asset) {
        const sprite = document.createElement('span');
        sprite.className = 'scene-celebration-sprite';
        sprite.innerHTML = assetMarkup(n.asset);
        children.push(sprite);
      }
      const p = label(
        'scene-winner',
        compact && winner && winner.length > 10 ? `${winner.slice(0, 9)}… wins!` : text,
      );
      if (compact) p.style.fontSize = '12px';
      children.push(p);
    }
    // Empty panels draw nothing at all, so an idle scoreboard never leaves a dark box on stream.
    layer.dataset.empty = String(children.length === 0);
    if (children.length) {
      const panel = document.createElement('div');
      panel.className = 'scene-panel';
      panel.append(...children);
      layer.replaceChildren(panel);
    } else layer.replaceChildren();
    // Small previews keep a readable excerpt; full text remains available to assistive tech.
    const spoken = fullText || children.map((c) => c.textContent).join(' ');
    if (spoken) {
      layer.setAttribute('aria-label', spoken);
      layer.title = spoken;
    } else {
      layer.removeAttribute('aria-label');
      layer.removeAttribute('title');
    }
  }
}
export function launchSceneEffect(
  root: HTMLElement,
  effect: { asset: LaunchOptions['asset']; x: number; intensity?: number | undefined },
  options: Omit<LaunchOptions, 'asset' | 'x' | 'target'> = {},
) {
  const layer = root.querySelector<HTMLElement>('[data-scene-kind="effects"]');
  if (!layer || layer.hidden) return false;
  return launch(layer, { ...effect, ...options, target: { x: 0.5, y: 0.45 } });
}
export function clearScene(root: HTMLElement) {
  clearStage(root);
  root.replaceChildren();
  scenes.delete(root);
}
