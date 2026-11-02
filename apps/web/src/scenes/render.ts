import { assetMarkup, clearStage, launch, type LaunchOptions } from '../effects/projectile.js';
import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import { sceneSchema, sceneShapeSchema, type Scene, type SceneNode, type Rect } from './schema.js';
import { mechanicsLines } from '../sessions/mechanics-hud.js';
import { formatLines, formatSlot, formatTally } from '../sessions/formats-hud.js';
import { sessionText, type SessionLanguage } from '../sessions/mechanics-copy.js';
import './scene.css';

export interface SceneFrame {
  now: number;
  definition?: ExperienceDefinition | null | undefined;
  snapshot?: SessionSnapshot | null | undefined;
  instructions?: string[];
  guides?: boolean;
  /** Reviewed viewer language for scoreboard and celebration text (F40). */
  language?: SessionLanguage;
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
export function roundStatus(
  snapshot: SessionSnapshot,
  now: number,
  language: SessionLanguage = 'en',
): string {
  if (snapshot.phase === 'finished') return sessionText(language, 'roundOver');
  const remaining =
    snapshot.phase === 'running' && snapshot.deadlineAt !== null
      ? Math.max(0, snapshot.deadlineAt - now)
      : snapshot.remainingMs;
  const seconds = Math.ceil(remaining / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return sessionText(language, snapshot.phase === 'paused' ? 'pausedClock' : 'clockLeft', {
    clock,
  });
}
/*
 * Broadcast presentation helpers. Every string still goes through textContent; the extra
 * elements are decorative (aria-hidden) and colours come from fixed host tables, never
 * from creator or viewer text.
 */
type Tag = 'p' | 'span' | 'div';
function el(tag: Tag, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function deco(className: string, tag: Tag = 'span') {
  const node = el(tag, className);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
/** Text that stays in the accessible text but is not drawn (keeps "Red: 14" readable). */
function hidden(text: string) {
  return el('span', 'scene-vh', text);
}
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
/** Decorative meter: a track with a transform-only fill. */
function meter(className: string, ratio: number) {
  const track = deco(`scene-meter ${className}`, 'div');
  const fill = el('span', 'scene-meter-fill');
  fill.style.transform = `scaleX(${clamp01(ratio).toFixed(4)})`;
  track.append(fill);
  return track;
}
/** Chat commands (`!red`) set as chips inside a line, without changing its text. */
function withCommands(p: HTMLElement, text: string) {
  for (const part of text.split(/(![\p{L}\p{N}_-]+)/u)) {
    if (!part) continue;
    if (part.startsWith('!') && part.length > 1) p.append(el('span', 'scene-cmd', part));
    else p.append(part);
  }
  return p;
}
const TEAM_HUES: [RegExp, string][] = [
  [/\b(red|rouge|rojo|rot|crimson|tomato)/i, '#ff5f57'],
  [/\b(blue|bleu|azul|blau)/i, '#4b9dff'],
  [/\b(green|vert|verde|grün|gruen)/i, '#35d07f'],
  [/\b(yellow|jaune|amarillo|gelb|gold)/i, '#ffcc3d'],
  [/\b(orange|naranja)/i, '#ff9340'],
  [/\b(purple|violet|morado|lila)/i, '#b48cff'],
  [/\b(pink|rose|rosa)/i, '#ff6fbf'],
  [/\b(teal|cyan|aqua)/i, '#2fd4c4'],
];
const TEAM_FALLBACK = ['#ff6b5b', '#4b9dff', '#ffcc3d', '#35d07f', '#b48cff', '#2fd4c4'];
const COMMUNITY_HUE = '#a78bff';
/** A fixed display colour per team: named colours first, then a stable palette slot. */
export function teamHue(team: { id: string; label: string }, index: number) {
  if (team.id === 'community') return COMMUNITY_HUE;
  for (const [pattern, hue] of TEAM_HUES)
    if (pattern.test(team.id) || pattern.test(team.label)) return hue;
  return TEAM_FALLBACK[index % TEAM_FALLBACK.length] ?? COMMUNITY_HUE;
}
/** Rows of option chips; falls back to plain text unless the chips spell the exact line. */
function optionChips(
  line: string,
  options: { text: string; label: string; share: number; leading: boolean; correct?: boolean }[],
) {
  const p = el('p', 'scene-score scene-mechanics scene-chips');
  if (options.map((o) => o.text).join(' · ') !== line) {
    p.textContent = line;
    return p;
  }
  options.forEach((option, i) => {
    if (i) p.append(hidden(' · '));
    const chip = el('span', 'scene-chip');
    chip.style.setProperty('--share', clamp01(option.share).toFixed(4));
    if (option.leading) chip.dataset.leading = 'true';
    if (option.correct) chip.dataset.correct = 'true';
    chip.append(deco('scene-chip-fill'));
    const at = option.text.indexOf(option.label);
    if (at < 0 || !option.label) chip.append(el('span', 'scene-chip-label', option.text));
    else {
      const key = option.text.slice(0, at).trim();
      const rest = option.text.slice(at + option.label.length);
      const sep = /^(\s*·\s*)(.*)$/.exec(rest);
      if (key) chip.append(el('span', 'scene-chip-key', key), ' ');
      chip.append(el('span', 'scene-chip-label', option.label));
      const count = el('span', 'scene-chip-count');
      if (sep) count.append(hidden(sep[1] ?? ''), sep[2] ?? '');
      else count.textContent = rest;
      if (count.textContent) chip.append(count);
    }
    p.append(chip);
  });
  return p;
}
/** Progress dots for stages/questions: done, current and upcoming. */
function steps(p: HTMLElement, current: number, count: number) {
  const dots = deco('scene-steps');
  for (let i = 0; i < Math.min(count, 12); i++) {
    const dot = el('span', 'scene-step-dot');
    dot.dataset.state = i < current ? 'done' : i === current ? 'current' : 'next';
    dots.append(dot);
  }
  p.append(dots);
  return p;
}
/** Version 2/3 scoreboard lines with meters, chips and step dots around the same text. */
function richLines(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  now: number,
  language: SessionLanguage,
  mechanics: string[],
  format: string[],
  hues: Map<string, string>,
): HTMLElement[] {
  const plain = (line: string, extra = '') =>
    label(`scene-score scene-mechanics${extra ? ` ${extra}` : ''}`, line);
  const out: HTMLElement[] = [];
  const m = d.mechanics,
    state = s.mechanics;
  for (const line of mechanics) {
    const side = d.teams.length
      ? d.teams.find((t) => line.startsWith(`${t.label}: `))
      : line.startsWith(`${sessionText(language, 'community')}: `)
        ? { id: 'community', label: sessionText(language, 'community') }
        : undefined;
    const standing = side ? state?.standings[side.id] : undefined;
    if (!side || !standing) {
      out.push(plain(line, 'scene-round'));
      continue;
    }
    const p = plain(line, 'scene-side');
    p.style.setProperty('--team', hues.get(side.id) ?? COMMUNITY_HUE);
    out.push(p);
    if (m?.health && standing.health !== null) {
      const ratio = standing.health / m.health.max;
      const bar = meter('scene-health', standing.eliminated ? 0 : ratio);
      bar.style.setProperty('--team', hues.get(side.id) ?? COMMUNITY_HUE);
      bar.dataset.tone = standing.eliminated ? 'out' : ratio <= 0.3 ? 'low' : 'ok';
      out.push(bar);
    }
  }
  const f = d.format;
  if (!f || !format.length) return out;
  if (f.kind === 'mural') {
    const painted = s.format?.canvas.filter((cell) => cell >= 0).length ?? 0;
    out.push(plain(format[0] ?? '', 'scene-step'));
    out.push(meter('scene-progress', painted / Math.max(1, f.width * f.height)));
    return out;
  }
  const { slot, count, slotMs, inSlot, reveal } = formatSlot(d, s, now);
  const tally = formatTally(d, s, slot);
  const total = tally.reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...tally);
  out.push(
    steps(plain(format[0] ?? '', 'scene-step'), s.phase === 'finished' ? count : slot, count),
  );
  if (f.kind === 'quiz') {
    const q = f.questions[slot];
    if (!q) return [...out, ...format.slice(1).map((line) => plain(line))];
    // Answers close before the reveal window: a draining bar shows the time left to answer.
    if (!reveal && s.phase !== 'finished') {
      const window = Math.max(1, slotMs - f.revealMs);
      out.push(meter('scene-answer-time', (window - inSlot) / window));
    }
    if (format[1] !== undefined) out.push(plain(format[1], 'scene-prompt'));
    if (reveal) {
      if (format[2] !== undefined) {
        const answer = plain('', 'scene-answer');
        answer.append(deco('scene-answer-icon'), format[2]);
        out.push(answer);
      }
      if (format[3] !== undefined) out.push(plain(format[3], 'scene-explanation'));
    } else if (format[2] !== undefined)
      out.push(
        optionChips(
          format[2],
          q.options.map((option, i) => ({
            text: sessionText(language, 'answerOption', {
              command: ['!a', '!b', '!c', '!d'][i] ?? '',
              label: option,
              count: tally[i] ?? 0,
            }),
            label: option,
            share: total ? (tally[i] ?? 0) / total : 0,
            leading: top > 0 && tally[i] === top,
          })),
        ),
      );
    return out;
  }
  const stage = f.stages[slot];
  if (format[1] !== undefined) out.push(plain(format[1], 'scene-prompt'));
  if (format[2] !== undefined && stage)
    out.push(
      optionChips(
        format[2],
        stage.options.map((option, i) => ({
          text: sessionText(
            language,
            'stageOption',
            { number: i + 1, label: option.label, votes: tally[i] ?? 0 },
            tally[i] ?? 0,
          ),
          label: option.label,
          share: total ? (tally[i] ?? 0) / total : 0,
          leading: top > 0 && tally[i] === top,
        })),
      ),
    );
  return out;
}
/** Deterministic confetti burst for the round-end moment (decorative, CSS-animated). */
function confetti(hue: string, width: number, height: number) {
  const burst = deco('scene-confetti', 'div');
  const colors = [hue, '#ffd166', '#7c4dff', '#ffffff', '#ff6b5b', '#3dd6f5'];
  for (let i = 0; i < 18; i++) {
    const bit = el('span', 'scene-confetti-bit');
    const angle = (i / 18) * Math.PI * 2 + (i % 3) * 0.35;
    const reach = 0.55 + ((i * 37) % 45) / 100;
    bit.style.setProperty('--x', `${Math.round(Math.cos(angle) * reach * width * 0.45)}px`);
    bit.style.setProperty('--y', `${Math.round(Math.sin(angle) * reach * height * 0.42)}px`);
    bit.style.setProperty('--r', `${((i * 97) % 540) - 270}deg`);
    bit.style.setProperty('--d', `${(i % 6) * 40}ms`);
    bit.style.setProperty('--c', colors[i % colors.length] ?? hue);
    if (i % 3 === 0) bit.dataset.shape = 'dot';
    burst.append(bit);
  }
  return burst;
}

/*
 * Keep panels alive between redraws: the overlay redraws four times a second, so a panel
 * whose structure is unchanged is patched in place. Meters then glide (CSS transitions on
 * transform), entrances play once, and a changed score gets a short pop.
 */
function sameShape(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  const x = a as Element,
    y = b as Element;
  if (
    x.tagName !== y.tagName ||
    x.getAttribute('class') !== y.getAttribute('class') ||
    x.childNodes.length !== y.childNodes.length
  )
    return false;
  for (let i = 0; i < x.childNodes.length; i++) {
    const cx = x.childNodes[i],
      cy = y.childNodes[i];
    if (!cx || !cy || !sameShape(cx, cy)) return false;
  }
  return true;
}
function patch(a: Node, b: Node, changed: (node: Element) => void) {
  if (a.nodeType !== Node.ELEMENT_NODE) {
    if (a.nodeValue !== b.nodeValue) {
      a.nodeValue = b.nodeValue;
      if (a.parentElement) changed(a.parentElement);
    }
    return;
  }
  const x = a as Element,
    y = b as Element;
  for (const attr of [...y.attributes])
    if (x.getAttribute(attr.name) !== attr.value) x.setAttribute(attr.name, attr.value);
  for (const attr of [...x.attributes])
    if (!y.hasAttribute(attr.name)) x.removeAttribute(attr.name);
  for (let i = 0; i < x.childNodes.length; i++) {
    const cx = x.childNodes[i],
      cy = y.childNodes[i];
    if (cx && cy) patch(cx, cy, changed);
  }
}
/**
 * Replace `parent`'s children with `next`, patching in place when the structure is the
 * same. `changed` hears about every element whose text changed. Shared with the overlay
 * cards, which also redraw several times a second.
 */
export function syncChildren(
  parent: HTMLElement,
  next: Node[],
  changed: (node: Element) => void = () => undefined,
) {
  const current = [...parent.childNodes];
  const same =
    current.length === next.length &&
    current.every((node, i) => {
      const other = next[i];
      return !!other && sameShape(node, other);
    });
  if (!same) {
    parent.replaceChildren(...next);
    return;
  }
  current.forEach((node, i) => {
    const other = next[i];
    if (other) patch(node, other, changed);
  });
}
function mount(layer: HTMLElement, next: HTMLElement[], still: boolean) {
  syncChildren(layer, next, (changedNode) => {
    if (still || typeof (changedNode as HTMLElement).animate !== 'function') return;
    const target = changedNode.closest('.scene-team-value, .scene-chip, .scene-text');
    if (!target) return;
    // A new score pops; a new instruction page fades in. Transform/opacity only.
    target.animate(
      target.classList.contains('scene-text')
        ? [
            { opacity: 0, transform: 'translateY(0.3em)' },
            { opacity: 1, transform: 'none' },
          ]
        : [{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  });
}
/** Shrink the panel's base size until its content fits the reserved box (no-op without layout). */
function fitPanel(panel: HTMLElement, start: number, min: number) {
  let size = start;
  panel.style.setProperty('--fs', `${size.toFixed(2)}px`);
  for (
    let i = 0;
    i < 16 &&
    size > min &&
    (panel.scrollHeight > panel.clientHeight + 1 || panel.scrollWidth > panel.clientWidth + 1);
    i++
  ) {
    size = Math.max(min, size * 0.93);
    panel.style.setProperty('--fs', `${size.toFixed(2)}px`);
  }
}
const prefersStill = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const still =
    !!root.closest('[data-reduced-motion="true"], [data-motion="reduced"]') || prefersStill();
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
    const extras: HTMLElement[] = [];
    const viewportWidth = root.clientWidth || 1280,
      viewportHeight = root.clientHeight || (viewportWidth * 9) / 16;
    const compact = viewportWidth <= 600;
    // Panels sit a few pixels inside their box so the drop shadow fades out before the
    // node's clip edge; the text maths below uses the box that remains.
    const inset = compact ? 0 : Math.max(2, Math.min(10, viewportWidth * 0.0045));
    const boxWidth = (viewportWidth * n.rect.width) / 1000 - inset * 2,
      boxHeight = (viewportHeight * n.rect.height) / 1000 - inset * 2;
    const padding = compact ? 3 : Math.max(3, Math.min(16, viewportWidth * 0.008));
    let fullText = '';
    /** Starting size for the panel's fit; `null` keeps the per-line sizes set below. */
    let fit: { start: number; min: number } | null = null;
    const panelClass = ['scene-panel'];
    const panelData: Record<string, string> = {};
    const panelStyle: Record<string, string> = {};

    if (n.kind === 'instructions') {
      const lines = (frame.instructions ?? []).filter((line) => line.trim()).slice(0, 8);
      fullText = lines.join(' · ');
      const font = compact ? 12 : Math.max(12, Math.min(28, viewportWidth * 0.017));
      // Paging keeps its original budget (the full reserved box); the panel's fit pass
      // trims the size slightly if the inset or command chips ever make a page overflow.
      const fullWidth = boxWidth + inset * 2,
        fullHeight = boxHeight + inset * 2;
      const rows = Math.max(1, Math.floor((fullHeight - padding * 2) / (font * 1.18)));
      const cols = Math.max(1, Math.floor((fullWidth - padding * 2) / (font * 0.58)));
      const all = linePages(lines, cols, rows);
      const page = all[Math.floor(Math.max(0, frame.now) / 6000) % Math.max(1, all.length)] ?? [];
      for (const line of page) {
        children.push(withCommands(el('p', 'scene-text'), line));
      }
      if (all.length > 1) panelData.paged = 'true';
      if (compact) panelStyle['--fs'] = `${font}px`;
      else fit = { start: font, min: Math.min(font, 12) };
    }
    if (n.kind === 'scoreboard') {
      const { definition: d, snapshot: s } = frame;
      if (d && s) {
        const language = frame.language ?? 'en';
        const status = roundStatus(s, frame.now, language);
        const teams = d.teams.length
          ? d.teams
          : [{ id: 'community', label: sessionText(language, 'community') }];
        const hues = new Map(teams.map((t, i) => [t.id, teamHue(t, i)]));
        const mechanics = mechanicsLines(d, s, frame.now, language);
        const format = formatLines(d, s, frame.now, language);
        const extra = [...mechanics, ...format];
        fullText = [
          status,
          ...teams.map((t) => `${t.label}: ${s.scores[t.id] ?? 0}`),
          ...extra,
        ].join(' · ');
        const maxFont = (boxHeight - padding * 2) / ((teams.length + 1 + extra.length) * 1.18);
        const rotating = compact || maxFont < 12;
        const clock = label('scene-clock', status);
        clock.prepend(deco('scene-clock-dot'));
        panelClass.push('scene-board');
        panelData.phase = s.phase;
        if (d.format) panelData.format = d.format.kind;
        const scores = teams.map((t) => s.scores[t.id] ?? 0);
        const best = Math.max(0, ...scores);
        const leaders = scores.filter((v) => v === best).length;
        const row = (t: { id: string; label: string }, text: string) => {
          const p = el('p', 'scene-score scene-team');
          p.style.setProperty('--team', hues.get(t.id) ?? COMMUNITY_HUE);
          const value = s.scores[t.id] ?? 0;
          if (teams.length > 1 && best > 0 && value === best && leaders === 1)
            p.dataset.leading = 'true';
          if (s.phase === 'finished' && s.winner === t.id) p.dataset.winner = 'true';
          const name = `${t.label}: `;
          if (text === `${name}${value}`)
            p.append(
              deco('scene-team-swatch'),
              el('span', 'scene-team-label', t.label),
              hidden(': '),
              el('span', 'scene-team-value', String(value)),
            );
          else p.textContent = text; // compact excerpt: plain text
          return p;
        };
        if (rotating) {
          // Compact views rotate one team and one extra line at readable size.
          panelData.compact = 'true';
          children.push(clock);
          const rotatingTeam = teams[Math.floor(Math.max(0, frame.now) / 3000) % teams.length];
          if (rotatingTeam)
            children.push(
              row(
                rotatingTeam,
                `${rotatingTeam.label.length > 7 ? rotatingTeam.label.slice(0, 6) + '…' : rotatingTeam.label}: ${s.scores[rotatingTeam.id] ?? 0}`,
              ),
            );
          const shownExtra = extra.length
            ? [extra[Math.floor(Math.max(0, frame.now) / 3000) % extra.length] ?? '']
            : [];
          for (const line of shownExtra) children.push(label('scene-score scene-mechanics', line));
          panelStyle['--fs'] = '12px';
        } else {
          const head = el('div', 'scene-board-head');
          const title = deco('scene-board-title');
          title.textContent = d.title;
          head.append(title, clock);
          children.push(head);
          if (s.phase !== 'finished') {
            const remaining =
              s.phase === 'running' && s.deadlineAt !== null
                ? Math.max(0, s.deadlineAt - frame.now)
                : s.remainingMs;
            const total =
              d.durationMs + (d.mechanics?.match ? d.mechanics.match.intermissionMs : 0);
            children.push(meter('scene-timebar', remaining / Math.max(1, total)));
          }
          for (const t of teams) children.push(row(t, `${t.label}: ${s.scores[t.id] ?? 0}`));
          if (teams.length === 2) {
            // Tug of war: the first team's share of all points, in its colour over the second.
            const [a, b] = teams;
            const sum = scores.reduce((x, y) => x + y, 0);
            const tug = meter('scene-tug', sum ? (scores[0] ?? 0) / sum : 0.5);
            if (a && b) {
              tug.style.setProperty('--team-a', hues.get(a.id) ?? COMMUNITY_HUE);
              tug.style.setProperty('--team-b', hues.get(b.id) ?? COMMUNITY_HUE);
            }
            children.push(tug);
          }
          children.push(...richLines(d, s, frame.now, language, mechanics, format, hues));
          fit = {
            start: Math.min(34, viewportWidth * 0.019, Math.max(12, maxFont * 1.6)),
            min: 11,
          };
        }
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
      const winnerTeam = d?.teams.find((t) => t.id === s?.winner);
      const winner = winnerTeam?.label;
      const language = frame.language ?? 'en';
      // Elimination keeps its own outcome text rather than a generic finished round.
      const text =
        s?.winner === 'tie'
          ? sessionText(language, 'celebrationTie')
          : winner
            ? sessionText(
                language,
                s?.outcome === 'elimination' ? 'celebrationEliminated' : 'celebrationWinner',
                { team: winner },
              )
            : s?.outcome === 'goal' || s?.winner === 'community'
              ? sessionText(language, 'communityWins')
              : sessionText(language, 'celebrationDone');
      fullText = text;
      const hue =
        winnerTeam && d
          ? teamHue(winnerTeam, d.teams.indexOf(winnerTeam))
          : s?.winner === 'tie'
            ? '#ffd166'
            : COMMUNITY_HUE;
      panelClass.push('scene-celebrate');
      panelStyle['--team'] = hue;
      if (n.asset) {
        const sprite = document.createElement('span');
        sprite.className = 'scene-celebration-sprite';
        sprite.innerHTML = assetMarkup(n.asset);
        children.push(sprite);
      }
      const shown =
        compact && winner && winner.length > 10
          ? sessionText(language, 'celebrationWinner', { team: `${winner.slice(0, 9)}…` })
          : text;
      children.push(label('scene-winner', shown));
      if (compact) panelStyle['--fs'] = '12px';
      else {
        const spriteWidth = n.asset ? boxHeight * 0.5 : 0;
        const byWidth = (boxWidth - padding * 4 - spriteWidth) / Math.max(4, shown.length * 0.6);
        fit = { start: Math.max(12, Math.min(60, boxHeight * 0.34, byWidth)), min: 12 };
        if (!still) extras.push(confetti(hue, boxWidth, boxHeight));
      }
    }
    // Empty panels draw nothing at all, so an idle scoreboard never leaves a dark box on stream.
    layer.dataset.empty = String(children.length === 0);
    if (children.length) {
      const panel = document.createElement('div');
      panel.className = panelClass.join(' ');
      for (const [k, v] of Object.entries(panelData)) panel.dataset[k] = v;
      panel.style.setProperty('--pad', `${padding}px`);
      if (inset) panel.style.setProperty('--inset', `${inset.toFixed(1)}px`);
      for (const [k, v] of Object.entries(panelStyle)) panel.style.setProperty(k, v);
      if (fit) panel.style.setProperty('--fs', `${fit.start.toFixed(2)}px`);
      panel.append(...children);
      mount(layer, [panel, ...extras], still);
      const live = layer.firstElementChild as HTMLElement | null;
      if (fit && live) fitPanel(live, fit.start, fit.min);
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
