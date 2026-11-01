import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clearStage } from '../effects/projectile.js';
import { renderScene, launchSceneEffect } from '../scenes/render.js';
import type { Scene } from '../scenes/schema.js';

export interface PlayerFrame {
  /** Milliseconds on the synthetic clock. */
  at: number;
  effects: {
    asset: 'tomato' | 'star' | 'heart';
    x: number;
    intensity?: number | undefined;
    label?: string | null;
  }[];
  caption?: ReactNode;
}

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Private playback of precomputed synthetic frames on the real scene renderer.
 * Playback follows the recorded clock (clamped so long gaps stay watchable); it never
 * touches a live overlay.
 */
export function StagePlayer({
  frames,
  scene,
  label,
  instructions,
  reducedMotion = false,
  guides = false,
  playLabel = 'Play',
}: {
  frames: PlayerFrame[];
  scene: Scene;
  label: string;
  instructions: string[];
  reducedMotion?: boolean | undefined;
  guides?: boolean;
  playLabel?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [frames]);
  useEffect(() => {
    if (!playing) return;
    if (index + 1 >= frames.length) {
      setPlaying(false);
      return;
    }
    const gap = (frames[index + 1]?.at ?? 0) - (frames[index]?.at ?? 0);
    const timer = setTimeout(() => setIndex(index + 1), Math.min(1200, Math.max(350, gap)));
    return () => clearTimeout(timer);
  }, [playing, index, frames]);
  const frame = frames[index];
  // Callers pass a fresh array each render; re-render the stage only when its content changes.
  const instructionKey = instructions.join('\n');
  useEffect(() => {
    const root = stage.current;
    if (!root) return;
    clearStage(root);
    renderScene(root, scene, {
      now: frame?.at ?? 0,
      instructions: instructionKey.split('\n'),
      guides,
    });
    for (const effect of frame?.effects ?? [])
      launchSceneEffect(root, effect, {
        label: effect.label ?? null,
        reducedMotion: reducedMotion || prefersReducedMotion(),
      });
    return () => clearStage(root);
  }, [frame, scene, reducedMotion, guides, instructionKey]);
  const last = Math.max(0, frames.length - 1);
  return (
    <div className="panel-player">
      <div className="stage-frame">
        <div ref={stage} className="stage" role="img" aria-label={label} />
      </div>
      <div className="panel-player-bar">
        <button
          type="button"
          className="button small"
          disabled={frames.length < 1}
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (index >= last) setIndex(0);
              setPlaying(true);
            }
          }}
        >
          {playing ? 'Pause' : index >= last && index > 0 ? 'Replay' : playLabel}
        </button>
        <input
          type="range"
          aria-label={`${label} position`}
          min={0}
          max={last}
          value={index}
          disabled={frames.length < 2}
          onChange={(e) => {
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
        />
        <span className="panel-player-position">
          {frames.length ? `${index + 1} / ${frames.length}` : '0 / 0'} ·{' '}
          {((frame?.at ?? 0) / 1000).toFixed(1)} s
        </span>
      </div>
      <p className="panel-player-caption" aria-live="polite">
        {frame?.caption ?? 'Nothing to play yet.'}
      </p>
    </div>
  );
}
