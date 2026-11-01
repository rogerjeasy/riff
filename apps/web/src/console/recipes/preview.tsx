import { useMemo } from 'react';
import type { Scene } from '../../scenes/schema.js';
import { StagePlayer, type PlayerFrame } from '../stage-player.js';
import type { RecipeProof } from './contracts.js';

const OUTCOME: Record<string, string> = {
  ACCEPTED: 'Accepted',
  UNRELATED: 'Ignored',
  AUDIENCE: 'Not eligible',
  VIEWER_LIMIT: 'Viewer limit',
  CHANNEL_LIMIT: 'Channel limit',
  DUPLICATE: 'Duplicate',
  NOT_JOINED: 'Not joined',
  RESOURCE_LIMIT: 'Out of resources',
  ALREADY_JOINED: 'Already joined',
  SESSION_FINISHED: 'Round over',
};

/** Step-by-step playback of the precomputed synthetic chat; never connected to a live overlay. */
export function RecipePreview({
  proof,
  scene,
  reducedMotion = true,
}: {
  proof: RecipeProof;
  scene: Scene;
  reducedMotion?: boolean | undefined;
}) {
  const frames = useMemo<PlayerFrame[]>(
    () =>
      proof.steps.map((step) => ({
        at: step.at,
        effects: step.effects,
        caption: (
          <>
            <code>{step.text}</code>{' '}
            <span className={`badge ${step.code === 'ACCEPTED' ? 'good' : 'muted'}`}>
              {OUTCOME[step.code] ?? step.code.toLowerCase().replaceAll('_', ' ')}
            </span>{' '}
            {step.reason}
          </>
        ),
      })),
    [proof],
  );
  const scores = Object.entries(proof.scores);
  return (
    <div className="recipe-preview">
      <div className="recipe-preview-head">
        <h3 className="recipe-preview-title">Synthetic sample chat</h3>
        <span className="panel-hint">
          {proof.accepted} accepted · {proof.blocked} blocked · {proof.contributions} contributions
          {scores.length > 0 &&
            ` · final scores ${scores.map(([team, score]) => `${team}: ${score}`).join(', ')}`}
        </span>
      </div>
      <StagePlayer
        frames={frames}
        scene={scene}
        label="Recipe sample preview"
        instructions={['Synthetic sample chat · private playback']}
        reducedMotion={reducedMotion}
        playLabel="Play sample chat"
      />
    </div>
  );
}
