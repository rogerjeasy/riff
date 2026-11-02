import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Version, SessionSnapshot } from '../../lib/types.js';
import { triggerInstruction } from '../format.js';
import {
  sceneSchema,
  defaultScene,
  contains,
  KIND_NAME,
  type Scene,
  type SceneNode,
  type SceneState,
  type Rect,
} from '../../scenes/schema.js';
import { renderScene, clearScene, positionStyle, launchSceneEffect } from '../../scenes/render.js';
import { hasStandardAreas, scoreboardSide } from '../../scenes/layouts.js';
import { sceneApi } from './api.js';
import './editor.css';

type CanvasVersion = Pick<Version, 'id' | 'artifactId' | 'number' | 'status' | 'manifest'>;
type Region = Scene['regions'][number];
interface Props {
  version: CanvasVersion;
  panic: boolean;
  compiler?: 'offline' | 'codex';
  onScene?: (scene: Scene, instructions: string[]) => void;
  onBehaviorEdit?: () => void;
}
const TRIGGER: Record<SceneNode['timing']['trigger'], string> = {
  always: 'Always shown',
  'round-start': 'After the round starts',
  'round-end': 'After the round ends',
};
const SOURCE: Record<SceneState['history'][number]['source'], string> = {
  default: 'default layout',
  direct: 'canvas edit',
  generated: 'described edit',
  undo: 'restored',
  inherited: 'carried over from the previous version',
};
const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`;
function timingText(t: SceneNode['timing']) {
  if (t.trigger === 'always') return TRIGGER.always;
  return `${TRIGGER[t.trigger]}${t.delayMs ? ` + ${seconds(t.delayMs)}` : ''}, for ${seconds(t.durationMs)}`;
}
/** Plain-language differences between the live layout and the one under review. */
function changes(before: Scene, after: Scene): string[] {
  const rows: string[] = [];
  const regionName = (scene: Scene, id: string) =>
    scene.regions.find((r) => r.id === id)?.label ?? id;
  for (const item of after.regions) {
    const old = before.regions.find((x) => x.id === item.id);
    if (!old) {
      rows.push(`Added area “${item.label}”`);
      continue;
    }
    if (old.label !== item.label) rows.push(`Area “${old.label}” renamed “${item.label}”`);
    if (old.rect.x !== item.rect.x || old.rect.y !== item.rect.y)
      rows.push(`Area “${item.label}” moved to ${item.rect.x}, ${item.rect.y}`);
    if (old.rect.width !== item.rect.width || old.rect.height !== item.rect.height)
      rows.push(`Area “${item.label}” resized to ${item.rect.width} × ${item.rect.height}`);
    if (old.protected !== item.protected)
      rows.push(`Area “${item.label}” is ${item.protected ? 'now' : 'no longer'} protected`);
  }
  for (const old of before.regions)
    if (!after.regions.some((x) => x.id === old.id)) rows.push(`Removed area “${old.label}”`);
  for (const item of after.nodes) {
    const name = KIND_NAME[item.kind];
    const old = before.nodes.find((x) => x.id === item.id);
    if (!old) {
      rows.push(`Added ${name}`);
      continue;
    }
    if (old.rect.x !== item.rect.x || old.rect.y !== item.rect.y)
      rows.push(`${name} moved to ${item.rect.x}, ${item.rect.y}`);
    if (old.rect.width !== item.rect.width || old.rect.height !== item.rect.height)
      rows.push(`${name} resized to ${item.rect.width} × ${item.rect.height}`);
    if (old.regionId !== item.regionId)
      rows.push(`${name} now sits in “${regionName(after, item.regionId)}”`);
    if (JSON.stringify(old.timing) !== JSON.stringify(item.timing))
      rows.push(`${name}: ${timingText(item.timing).toLowerCase()}`);
    if (old.asset !== item.asset) rows.push(`${name} sprite: ${item.asset ?? 'text only'}`);
  }
  for (const old of before.nodes)
    if (!after.nodes.some((x) => x.id === old.id)) rows.push(`Removed ${KIND_NAME[old.kind]}`);
  return rows;
}
const clampRect = (r: Rect): Rect => {
  const width = Math.min(1000, Math.max(1, Math.round(r.width))),
    height = Math.min(1000, Math.max(1, Math.round(r.height)));
  return {
    x: Math.min(1000 - width, Math.max(0, Math.round(r.x))),
    y: Math.min(1000 - height, Math.max(0, Math.round(r.y))),
    width,
    height,
  };
};
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
interface Drag {
  mode: 'move' | 'resize';
  target: 'node' | 'region';
  id: string;
  startX: number;
  startY: number;
  base: Scene;
  rect: Rect;
  width: number;
  height: number;
}
export function CanvasEditor({
  version,
  panic,
  compiler = 'offline',
  onScene,
  onBehaviorEdit,
}: Props) {
  const [state, setState] = useState<SceneState | null>(null);
  const [draft, setDraft] = useState<Scene | null>(null);
  const [selected, setSelected] = useState('effects');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [intent, setIntent] = useState('');
  const [mobile, setMobile] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [clock, setClock] = useState(0);
  const [restore, setRestore] = useState('');
  // Layout matters once the behavior is approved; until then it stays out of the way.
  const [open, setOpen] = useState(version.status === 'active');
  const stage = useRef<HTMLDivElement>(null),
    board = useRef<HTMLDivElement>(null);
  const operation = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const drag = useRef<Drag | null>(null);
  const definition = version.manifest.experience;
  const duration = definition?.durationMs ?? 10000;
  const valid = draft ? sceneSchema.safeParse(draft) : null;
  const issues = valid && !valid.success ? valid.error.issues : [];
  const invalidIds = new Set(
    issues.flatMap((i) =>
      i.path[0] === 'nodes' && typeof i.path[1] === 'number'
        ? [draft?.nodes[i.path[1]]?.id ?? '']
        : [],
    ),
  );
  const problems = [...new Set(issues.map((i) => i.message))].slice(0, 3);
  const dirty = !!(state && draft && JSON.stringify(state.scene) !== JSON.stringify(draft));
  const node = draft?.nodes.find((n) => n.id === selected);
  const region = draft?.regions.find((r) => r.id === selected);
  const item = node ?? region;
  const itemName = node ? KIND_NAME[node.kind] : region ? `“${region.label}” area` : '';
  const explanation = state?.history.find((h) => h.revision === state.revision)?.generation
    ?.summary;
  const approved = state?.history.find((h) => h.revision === state.appliedRevision)?.scene;
  const diff = state && draft ? changes(approved ?? defaultScene(), draft) : [];
  const live = version.status === 'active';
  const status = !state
    ? error
      ? 'Layout unavailable'
      : 'Loading layout…'
    : dirty
      ? 'Unsaved changes'
      : state.revision > 0 && state.appliedRevision === state.revision
        ? live
          ? 'This layout is live'
          : 'Approved layout · goes live with this version'
        : state.revision === 0
          ? live
            ? 'Default layout is live'
            : 'Default layout'
          : state.classification === 'configuration'
            ? 'Saved · a small move, ready to apply'
            : 'Saved · review it before it goes live';
  function adopt(next: SceneState) {
    if (next.versionId !== version.id || next.artifactId !== version.artifactId)
      throw new Error('Scene identity changed. Reload it before editing.');
    setState(next);
    setDraft(next.scene);
    setReviewed(false);
    setError(null);
    setRestore('');
  }
  async function perform(action: (signal: AbortSignal) => Promise<SceneState>, message: string) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const own = ++epoch.current;
    setBusy(true);
    setError(null);
    setNotice('');
    setReviewed(false);
    try {
      const next = await action(controller.signal);
      if (controller.signal.aborted || own !== epoch.current) return;
      adopt(next);
      setNotice(message);
    } catch (cause) {
      if (!controller.signal.aborted && own === epoch.current)
        setError(
          cause instanceof Error ? cause.message : 'Layout operation failed. Reload and try again.',
        );
    } finally {
      if (!controller.signal.aborted && own === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    setState(null);
    setDraft(null);
    setSelected('effects');
    setIntent('');
    setClock(0);
    setNotice('');
    void perform((signal) => sceneApi.read(version.id, signal), '');
    return () => {
      epoch.current++;
      operation.current?.abort();
    };
    // The keyed identity is the request lifecycle; status updates must not discard a draft.
  }, [version.id, version.artifactId]);
  useEffect(() => {
    if (draft && valid?.success)
      onScene?.(draft, state?.instructions ?? [triggerInstruction(version.manifest)]);
  }, [draft, onScene, valid?.success, state?.instructions, version.manifest.trigger.command]);
  useEffect(() => {
    if (!stage.current || !draft) return;
    const snapshot: SessionSnapshot | null = definition
      ? {
          id: 'visual-sample',
          phase: clock >= duration ? 'finished' : 'running',
          startedAt: 0,
          deadlineAt: duration,
          remainingMs: Math.max(0, duration - clock),
          updatedAt: clock >= duration ? duration : clock,
          revision: 0,
          participants: {},
          scores: Object.fromEntries(definition.teams.map((t, i) => [t.id, i === 0 ? 3 : 1])),
          winner: clock >= duration ? (definition.teams[0]?.id ?? 'community') : null,
          outcome: clock >= duration ? 'deadline' : null,
        }
      : null;
    renderScene(stage.current, draft, {
      now: clock,
      definition,
      snapshot,
      instructions: state?.instructions ?? [triggerInstruction(version.manifest)],
      guides: true,
    });
  }, [
    draft,
    clock,
    definition,
    duration,
    version.manifest.trigger.command,
    state?.instructions,
    mobile,
    open,
  ]);
  useEffect(
    () => () => {
      if (stage.current) clearScene(stage.current);
    },
    [],
  );
  function edit(next: Scene) {
    setDraft(next);
    setReviewed(false);
    setNotice('');
    setError(null);
  }
  /** Move or resize an object; dropping it inside another open area re-homes it there. */
  function placeNode(base: Scene, id: string, next: Rect) {
    const rect = clampRect(next);
    edit({
      ...base,
      nodes: base.nodes.map((n) => {
        if (n.id !== id) return n;
        const home = base.regions.find((r) => r.id === n.regionId);
        const regionId =
          home && !home.protected && contains(home.rect, rect)
            ? n.regionId
            : (base.regions.find((r) => !r.protected && contains(r.rect, rect))?.id ?? n.regionId);
        return { ...n, rect, regionId };
      }),
    });
  }
  /** Moving an area carries the objects inside it; resizing leaves them in place. */
  function placeRegion(base: Scene, id: string, next: Rect) {
    const old = base.regions.find((r) => r.id === id);
    if (!old) return;
    const rect = clampRect(next);
    const dx = rect.x - old.rect.x,
      dy = rect.y - old.rect.y;
    const moving = rect.width === old.rect.width && rect.height === old.rect.height;
    edit({
      ...base,
      regions: base.regions.map((r) => (r.id === id ? { ...r, rect } : r)),
      nodes: base.nodes.map((n) =>
        moving && n.regionId === id && (dx || dy)
          ? { ...n, rect: clampRect({ ...n.rect, x: n.rect.x + dx, y: n.rect.y + dy }) }
          : n,
      ),
    });
  }
  function field(name: keyof Rect, value: number) {
    if (!draft || !item || !Number.isFinite(value)) return;
    const rect = { ...item.rect, [name]: value };
    if (node) placeNode(draft, node.id, rect);
    else placeRegion(draft, item.id, rect);
  }
  function nudge(e: KeyboardEvent, target: 'node' | 'region', id: string, rect: Rect) {
    const d = ARROWS[e.key];
    if (!d || !draft || busy) return;
    e.preventDefault();
    setSelected(id);
    const step = e.shiftKey ? 1 : 10;
    const next =
      e.altKey && target === 'node'
        ? { ...rect, width: rect.width + d[0] * step, height: rect.height + d[1] * step }
        : { ...rect, x: rect.x + d[0] * step, y: rect.y + d[1] * step };
    if (target === 'node') placeNode(draft, id, next);
    else placeRegion(draft, id, next);
  }
  function startDrag(
    e: PointerEvent<HTMLElement>,
    target: Drag['target'],
    mode: Drag['mode'],
    id: string,
    rect: Rect,
  ) {
    if (e.button !== 0 || !draft || busy) return;
    e.stopPropagation();
    setSelected(id);
    const box = board.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    drag.current = {
      mode,
      target,
      id,
      startX: e.clientX,
      startY: e.clientY,
      base: draft,
      rect,
      width: box.width,
      height: box.height,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function moveDrag(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.startX) / d.width) * 1000,
      dy = ((e.clientY - d.startY) / d.height) * 1000;
    const rect =
      d.mode === 'resize'
        ? { ...d.rect, width: d.rect.width + dx, height: d.rect.height + dy }
        : { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy };
    if (d.target === 'node') placeNode(d.base, d.id, rect);
    else placeRegion(d.base, d.id, rect);
  }
  const endDrag = () => {
    drag.current = null;
  };
  const canApply =
    state &&
    state.revision > 0 &&
    !dirty &&
    !busy &&
    !panic &&
    live &&
    state.appliedRevision !== state.revision &&
    (state.classification === 'configuration' || reviewed);
  const bodyId = `canvas-body-${version.id}`;
  return (
    <section className="card canvas-editor" aria-label="Visual canvas">
      <header className="card-head">
        <div>
          <p className="step-label">Stream layout</p>
          <h2>Arrange the overlay</h2>
          <p className="canvas-status" role="status">
            {status}
          </p>
        </div>
        <div className="canvas-head-actions">
          <span className="pill private">Private canvas</span>
          <button
            type="button"
            className="button small"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide layout editor' : 'Edit layout'}
          </button>
        </div>
      </header>
      <div id={bodyId} className="canvas-body" hidden={!open}>
        <p className="note">
          Drag objects and areas, or describe a change. Rehearsal and the live overlay draw this
          same layout. Camera and caption areas stay protected.
        </p>
        <div className="canvas-toolbar canvas-viewbar">
          <label>
            <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />{' '}
            Phone-size preview
          </label>
          <label>
            <input
              type="checkbox"
              checked={reduced}
              onChange={(e) => setReduced(e.target.checked)}
            />{' '}
            Reduced motion
          </label>
          <button
            className="button small ghost"
            disabled={busy}
            onClick={() =>
              void perform(
                (signal) => sceneApi.read(version.id, signal),
                'Layout reloaded. Unsaved changes discarded.',
              )
            }
          >
            Reload saved layout
          </button>
        </div>
        {state && draft ? (
          <>
            <p className="note canvas-revision">
              Layout revision {state.revision} · behavior v{version.number}
              {state.appliedRevision !== null && state.appliedRevision !== state.revision
                ? ` · revision ${state.appliedRevision} is applied`
                : ''}
            </p>
            {hasStandardAreas(draft) && (
              <div className="canvas-toolbar canvas-quick" role="group" aria-label="Quick layouts">
                <span className="note">Quick layouts</span>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy}
                  onClick={() => edit(scoreboardSide(draft, 'left'))}
                >
                  Scoreboard on the left
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy}
                  onClick={() => edit(scoreboardSide(draft, 'right'))}
                >
                  Scoreboard on the right
                </button>
              </div>
            )}
            <div className="canvas-workspace">
              <div className="canvas-stagecol">
                <div className="canvas-artboard">
                  <div className="canvas-board" data-mobile={mobile} ref={board}>
                    <div className="canvas-picture" ref={stage} />
                    <div className="canvas-handles" aria-label="Scene objects">
                      {draft.nodes.map((n) => (
                        <button
                          type="button"
                          key={n.id}
                          className="canvas-handle"
                          data-selected={selected === n.id}
                          data-invalid={invalidIds.has(n.id) || undefined}
                          style={positionStyle(n.rect)}
                          aria-label={`Select ${n.kind}`}
                          aria-pressed={selected === n.id}
                          disabled={busy}
                          onClick={() => setSelected(n.id)}
                          onKeyDown={(e) => nudge(e, 'node', n.id, n.rect)}
                          onPointerDown={(e) => startDrag(e, 'node', 'move', n.id, n.rect)}
                          onPointerMove={moveDrag}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        >
                          <span
                            className="canvas-handle-name"
                            data-x={n.rect.x + n.rect.width / 2 > 500 ? 'start' : 'end'}
                            data-y={n.rect.y + n.rect.height / 2 > 500 ? 'start' : 'end'}
                          >
                            {invalidIds.has(n.id) ? '⚠ ' : ''}
                            {KIND_NAME[n.kind]}
                          </span>
                          {selected === n.id && (
                            <span
                              className="canvas-resize"
                              aria-hidden="true"
                              onPointerDown={(e) => startDrag(e, 'node', 'resize', n.id, n.rect)}
                              onPointerMove={moveDrag}
                              onPointerUp={endDrag}
                              onPointerCancel={endDrag}
                            />
                          )}
                        </button>
                      ))}
                      {draft.regions.map((r) => (
                        <button
                          type="button"
                          key={r.id}
                          className="canvas-region-grip"
                          data-selected={selected === r.id}
                          data-protected={r.protected}
                          style={{
                            // Top-right corner: panels hug their text from the left,
                            // so the grip never covers what the area shows.
                            left: `${(r.rect.x + r.rect.width) / 10}%`,
                            top: `${r.rect.y / 10}%`,
                          }}
                          aria-label={`Move ${r.label} area`}
                          aria-pressed={selected === r.id}
                          disabled={busy}
                          onClick={() => setSelected(r.id)}
                          onKeyDown={(e) => nudge(e, 'region', r.id, r.rect)}
                          onPointerDown={(e) => startDrag(e, 'region', 'move', r.id, r.rect)}
                          onPointerMove={moveDrag}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        >
                          ⠿ {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {problems.length > 0 && (
                  <div role="alert" className="answer bad canvas-problems">
                    <strong>Fix before saving:</strong>
                    <ul>
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="note">
                  Sample round for layout only, not test evidence. Drag to move; drag the corner to
                  resize. Arrow keys move the selected item 10 units (Shift: 1); Alt + arrows
                  resize.
                </p>
                <div className="canvas-toolbar canvas-playbar">
                  <button
                    className="button small"
                    disabled={!valid?.success}
                    onClick={() => {
                      if (stage.current)
                        launchSceneEffect(
                          stage.current,
                          { asset: 'tomato', x: 0.5 },
                          {
                            reducedMotion:
                              reduced ||
                              (typeof matchMedia === 'function' &&
                                matchMedia('(prefers-reduced-motion: reduce)').matches),
                          },
                        );
                    }}
                  >
                    Preview tomato
                  </button>
                  <label>
                    Sample round · {(clock / 1000).toFixed(1)} s
                    <input
                      aria-label="Visual sample time"
                      type="range"
                      min="0"
                      max={duration + 120000}
                      step="100"
                      value={clock}
                      onChange={(e) => setClock(Number(e.target.value))}
                    />
                  </label>
                  <button
                    className="button small ghost"
                    disabled={!definition}
                    onClick={() => setClock(duration)}
                  >
                    Show round end
                  </button>
                </div>
                <div className="canvas-tracks-wrap">
                  <table className="canvas-tracks">
                    <caption>When each object shows</caption>
                    <thead>
                      <tr>
                        <th>Object</th>
                        <th>Shows</th>
                        <th>Delay</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.nodes.map((n) => (
                        <tr key={n.id}>
                          <th>
                            <button
                              className="button small ghost"
                              onClick={() => setSelected(n.id)}
                            >
                              {KIND_NAME[n.kind]}
                            </button>
                          </th>
                          <td>{TRIGGER[n.timing.trigger]}</td>
                          <td>{n.timing.trigger === 'always' ? '—' : seconds(n.timing.delayMs)}</td>
                          <td>
                            {n.timing.trigger === 'always'
                              ? 'Continuous'
                              : seconds(n.timing.durationMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="canvas-inspector">
                <div className="canvas-properties">
                  <label>
                    Selected object or area
                    <select
                      value={selected}
                      disabled={busy}
                      onChange={(e) => setSelected(e.target.value)}
                    >
                      {draft.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {KIND_NAME[n.kind]}
                        </option>
                      ))}
                      {draft.regions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label} area{r.protected ? ' (protected)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button small ghost"
                    disabled={busy || draft.regions.length >= 12}
                    onClick={() => {
                      const ids = new Set([...draft.regions, ...draft.nodes].map((x) => x.id));
                      let i = 1;
                      while (ids.has(`area-${i}`)) i++;
                      const id = `area-${i}`;
                      edit({
                        ...draft,
                        regions: [
                          ...draft.regions,
                          {
                            id,
                            label: `Area ${i}`,
                            kind: 'custom',
                            protected: false,
                            rect: { x: 20, y: 20, width: 100, height: 100 },
                          },
                        ],
                      });
                      setSelected(id);
                    }}
                  >
                    Add named area
                  </button>
                  {item && (
                    <fieldset disabled={busy}>
                      <legend>{itemName} position and size · 0–1000</legend>
                      <div className="canvas-numbers">
                        {(['x', 'y', 'width', 'height'] as const).map((f) => (
                          <label key={f}>
                            {f === 'x'
                              ? 'X position'
                              : f === 'y'
                                ? 'Y position'
                                : f === 'width'
                                  ? 'Width'
                                  : 'Height'}
                            <input
                              type="number"
                              min={f === 'x' || f === 'y' ? 0 : 1}
                              max="1000"
                              step="1"
                              value={item.rect[f]}
                              onChange={(e) => field(f, Number(e.target.value))}
                            />
                          </label>
                        ))}
                      </div>
                      {region && (
                        <p className="note">Moving an area also moves the objects inside it.</p>
                      )}
                    </fieldset>
                  )}
                  {region && (
                    <RegionFields
                      region={region}
                      busy={busy}
                      onChange={(next) =>
                        edit({
                          ...draft,
                          regions: draft.regions.map((r) => (r.id === region.id ? next : r)),
                        })
                      }
                    />
                  )}
                  {node && (
                    <fieldset disabled={busy}>
                      <legend>{KIND_NAME[node.kind]} placement and timing</legend>
                      <label>
                        Area
                        <select
                          value={node.regionId}
                          onChange={(e) =>
                            edit({
                              ...draft,
                              nodes: draft.nodes.map((n) =>
                                n.id === node.id ? { ...n, regionId: e.target.value } : n,
                              ),
                            })
                          }
                        >
                          {draft.regions.map((r) => (
                            <option key={r.id} value={r.id} disabled={r.protected}>
                              {r.label}
                              {r.protected ? ' (protected)' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Show
                        <select
                          value={node.timing.trigger}
                          disabled={node.kind === 'scoreboard' || node.kind === 'instructions'}
                          onChange={(e) => {
                            const trigger = e.target.value as typeof node.timing.trigger;
                            edit({
                              ...draft,
                              nodes: draft.nodes.map((n) =>
                                n.id === node.id
                                  ? {
                                      ...n,
                                      timing: {
                                        trigger,
                                        delayMs: 0,
                                        durationMs: trigger === 'always' ? 0 : 5000,
                                      },
                                    }
                                  : n,
                              ),
                            });
                          }}
                        >
                          <option value="always">Always</option>
                          <option value="round-start">After the round starts</option>
                          <option value="round-end">After the round ends</option>
                        </select>
                      </label>
                      {(node.kind === 'scoreboard' || node.kind === 'instructions') && (
                        <p className="note">Always shown so viewers can always read it.</p>
                      )}
                      {node.timing.trigger !== 'always' && (
                        <div className="canvas-numbers">
                          {(['delayMs', 'durationMs'] as const).map((f) => (
                            <label key={f}>
                              {f === 'delayMs' ? 'Delay (ms)' : 'Duration (ms)'}
                              <input
                                type="number"
                                min={f === 'delayMs' ? 0 : 1}
                                max="60000"
                                value={node.timing[f]}
                                onChange={(e) =>
                                  edit({
                                    ...draft,
                                    nodes: draft.nodes.map((n) =>
                                      n.id === node.id
                                        ? {
                                            ...n,
                                            timing: { ...n.timing, [f]: Number(e.target.value) },
                                          }
                                        : n,
                                    ),
                                  })
                                }
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      {node.kind === 'celebration' && (
                        <label>
                          Celebration sprite
                          <select
                            value={node.asset ?? ''}
                            onChange={(e) =>
                              edit({
                                ...draft,
                                nodes: draft.nodes.map((n) =>
                                  n.id === node.id
                                    ? { ...n, asset: (e.target.value || null) as typeof n.asset }
                                    : n,
                                ),
                              })
                            }
                          >
                            <option value="">Text only</option>
                            <option value="tomato">Tomato</option>
                            <option value="star">Star</option>
                            <option value="heart">Heart</option>
                          </select>
                        </label>
                      )}
                    </fieldset>
                  )}
                </div>
                {error && (
                  <p role="alert" className="answer bad">
                    {error}
                  </p>
                )}
                <div className="canvas-toolbar canvas-savebar">
                  <button
                    className="button small primary"
                    disabled={busy || (!dirty && state.revision !== 0) || !valid?.success}
                    onClick={() =>
                      void perform(
                        (signal) => sceneApi.save(version.id, state.revision, draft, signal),
                        'Layout saved. Review it below before applying.',
                      )
                    }
                  >
                    Save layout
                  </button>
                  <button
                    className="button small ghost"
                    disabled={busy || !dirty}
                    onClick={() => edit(state.scene)}
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            </div>
            <form
              className="canvas-language"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy && !dirty && intent.trim().length >= 8)
                  void perform(
                    (signal) =>
                      sceneApi.generate(
                        version.id,
                        state.revision,
                        selected,
                        intent.trim(),
                        signal,
                      ),
                    'Described change saved. Check its changes below before applying.',
                  );
              }}
            >
              <label>
                Describe a change to {itemName || 'the selection'}
                <textarea
                  value={intent}
                  disabled={busy}
                  maxLength={1200}
                  placeholder={
                    node?.kind === 'celebration'
                      ? 'Show this after the round ends for 5 seconds'
                      : 'Move right by 10 units'
                  }
                  onChange={(e) => setIntent(e.target.value)}
                />
              </label>
              <p className="note">
                {compiler === 'offline'
                  ? 'Offline editor: understands “Move right by 10 units” and “Show this after the round ends for 5 seconds”.'
                  : 'Codex drafts the change; Riff checks it before you review it.'}
                {dirty ? ' Save or discard your changes first.' : ''}
              </p>
              <div className="canvas-toolbar">
                <button
                  className="button small"
                  disabled={busy || dirty || intent.trim().length < 8}
                >
                  Draft this change
                </button>
                {onBehaviorEdit && (
                  <button type="button" className="button small ghost" onClick={onBehaviorEdit}>
                    Change the interaction instead
                  </button>
                )}
              </div>
            </form>
            <section className="canvas-review" aria-label="Review and apply">
              <h3>
                Review and apply <span className="mono note">{state.digest.slice(0, 12)}</span>
              </h3>
              {explanation && <p className="note">Codex’s summary: {explanation}</p>}
              <p className="canvas-review-label">
                {approved ? 'Changes from the applied layout' : 'Changes from the default layout'}
              </p>
              {diff.length ? (
                <ul className="canvas-diff">
                  {diff.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : (
                <p className="note">
                  {approved ? 'Same as the applied layout.' : 'Same as the default layout.'}
                </p>
              )}
              {(state.sharing ?? []).map((note) => (
                <p key={note} className="note canvas-sharing">
                  {note}
                </p>
              ))}
              <details>
                <summary>Riff guarantees for every saved layout</summary>
                <ul>
                  {state.checks.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary>Exact layout document</summary>
                <pre>{JSON.stringify(draft, null, 2)}</pre>
              </details>
              {state.classification === 'review' && state.appliedRevision !== state.revision && (
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={dirty || busy}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />{' '}
                  I reviewed this layout and its changes
                </label>
              )}
              <p className="note">
                {panic
                  ? 'Emergency stop is active.'
                  : !live
                    ? 'You can apply a layout once this version is approved and live.'
                    : state.revision === 0
                      ? 'Save a layout to apply it. Until then the default layout is used.'
                      : state.appliedRevision === state.revision
                        ? 'This exact layout is on stream.'
                        : 'Applies only to this exact live version.'}
              </p>
              {state.appliedRevision !== state.revision && (
                <button
                  className="button small go"
                  disabled={!canApply}
                  onClick={() =>
                    void perform(
                      (signal) => sceneApi.apply(version.id, state.revision, state.digest, signal),
                      'Layout applied. It is now on stream.',
                    )
                  }
                >
                  {state.classification === 'configuration'
                    ? 'Apply layout change'
                    : 'Approve and apply layout'}
                </button>
              )}
            </section>
            <fieldset disabled={busy || dirty}>
              <legend>History · restoring adds a new revision, nothing is overwritten</legend>
              <label>
                Restore revision
                <select value={restore} onChange={(e) => setRestore(e.target.value)}>
                  <option value="">Choose a previous revision</option>
                  <option value="0">Default layout</option>
                  {state.history
                    .filter((h) => h.revision !== state.revision)
                    .map((h) => (
                      <option key={h.revision} value={h.revision}>
                        Revision {h.revision} · {SOURCE[h.source]}
                        {h.revision === state.appliedRevision ? ' · applied' : ''}
                      </option>
                    ))
                    .reverse()}
                </select>
              </label>
              <button
                className="button small ghost"
                disabled={restore === ''}
                onClick={() =>
                  void perform(
                    (signal) => sceneApi.undo(version.id, state.revision, Number(restore), signal),
                    'Earlier layout restored as a new revision. Review it before applying.',
                  )
                }
              >
                Restore as new revision
              </button>
            </fieldset>
          </>
        ) : (
          !error && <p className="note">Loading layout…</p>
        )}
        {!state && error && (
          <p role="alert" className="answer bad">
            {error}
          </p>
        )}
        {busy && (
          <div role="status" className="note">
            Checking layout…{' '}
            <button
              className="button small ghost"
              onClick={() => {
                operation.current?.abort();
                epoch.current++;
                setBusy(false);
                setNotice('Cancelled here. Reload to check whether the server saved a revision.');
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="note">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
function RegionFields(props: {
  region: Region;
  busy: boolean;
  onChange: (region: Region) => void;
}) {
  const { region } = props;
  return (
    <fieldset disabled={props.busy}>
      <legend>Area properties</legend>
      <label>
        Area name
        <input
          value={region.label}
          maxLength={60}
          onChange={(e) => props.onChange({ ...region, label: e.target.value })}
        />
      </label>
      <label className="canvas-check">
        <input
          type="checkbox"
          checked={region.protected}
          onChange={(e) => props.onChange({ ...region, protected: e.target.checked })}
        />{' '}
        Protect this area from objects and effects
      </label>
    </fieldset>
  );
}
