import { useMemo } from 'react';
import { defaultScene } from '../../scenes/schema.js';
import { StagePlayer, type PlayerFrame } from '../stage-player.js';
import type { DirectorState } from './contracts.js';

type Evidence = NonNullable<NonNullable<DirectorState['draft']>['evidence']>;
const scene = defaultScene();

/** Batch-by-batch replay of the private burst, captioned with the director's reason at that moment. */
export function DirectorReplay({ evidence }: { evidence: Evidence }) {
  const frames = useMemo<PlayerFrame[]>(
    () =>
      evidence.samples.map((sample) => {
        const decision = [...evidence.telemetry.decisions]
          .reverse()
          .find((d) => d.at <= sample.at && !d.reason.startsWith('Showed'));
        const intensity = sample.frames[0]?.intensity;
        return {
          at: sample.at,
          effects: sample.frames.map((f) => ({
            asset: f.asset,
            x: f.x,
            intensity: f.intensity,
            label: f.viewer,
          })),
          caption: (
            <>
              <b>
                {sample.frames.length} {sample.frames.length === 1 ? 'effect' : 'effects'}
                {intensity ? ` at ${intensity}%` : ''}
              </b>
              {decision ? ` · ${decision.reason}` : ''}
            </>
          ),
        };
      }),
    [evidence],
  );
  return (
    <StagePlayer
      frames={frames}
      scene={scene}
      label="Private director evidence replay"
      instructions={['Synthetic crowd burst · private']}
      guides
      playLabel="Play burst"
    />
  );
}
