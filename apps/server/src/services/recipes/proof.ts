import { createRehearsalPreset, runRehearsal } from '@riff/sandbox';
import type { RecipePackage, RecipeProof } from '@riff/sdk';

type Rehearsal = Awaited<ReturnType<typeof runRehearsal>>;
const PROOF_STEPS = 100;

/**
 * Run the fixed synthetic crowd burst for an artifact and summarize it as public proof.
 * Adaptation and publication share this exact evidence so both show the same story.
 */
export async function rehearseArtifact(
  artifact: { source: string; manifest: RecipePackage['manifest'] },
  signal: AbortSignal,
): Promise<{ rehearsal: Rehearsal; proof: RecipeProof }> {
  const scenario = createRehearsalPreset(artifact, 'crowd-burst', 38);
  const rehearsal = await runRehearsal({ artifact, scenario, signal });
  const chatText = (through: number) => {
    const step = scenario.steps[through - 1];
    return step?.kind === 'chat' ? step.event.text : 'Host step';
  };
  const decided = rehearsal.timeline.filter((frame) => frame.decision);
  const proof: RecipeProof = {
    synthetic: true,
    accepted: decided.filter((frame) => frame.decision?.code === 'ACCEPTED').length,
    blocked: decided.filter((frame) => frame.decision?.code !== 'ACCEPTED').length,
    scores: rehearsal.cursor.session?.scores ?? {},
    contributions: Object.values(rehearsal.cursor.session?.participants ?? {}).reduce(
      (total, participant) => total + participant.contributions,
      0,
    ),
    steps: rehearsal.timeline.slice(0, PROOF_STEPS).map((frame) => ({
      at: frame.at,
      text: chatText(frame.through),
      code: frame.decision?.code ?? 'HOST',
      reason: frame.decision?.reason ?? 'Synthetic rehearsal step',
      effects: (frame.decision?.effects ?? []).map((effect) => ({
        asset: effect.asset,
        x: effect.x,
      })),
    })),
  };
  return { rehearsal, proof };
}
