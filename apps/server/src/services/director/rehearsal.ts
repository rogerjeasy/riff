import { createHash } from 'node:crypto';
import { createRehearsalPreset, runRehearsal } from '@riff/sandbox';
import type { DirectorEnvelope, DirectorEvidence, DirectorFrame } from '@riff/sdk';
import type { VersionRow } from '../../db/repositories/studio.js';
import { directorDigest, DIRECTOR_POLICY_VERSION } from './contract.js';
import { createDirectorPolicy } from './policy.js';
/**
 * Synthetic chat cadence seen by the director. The sandbox scenario delivers the burst
 * 1 ms apart, which no real chat does; spacing arrivals 150 ms apart (about 6–7 messages
 * per second) lets the replay show regular batches, the switch to calm settings and the
 * recovery. Only presentation timing is spaced: gameplay decisions, scores and state come
 * unchanged from the two identical sandbox runs.
 */
export const DIRECTOR_REHEARSAL_SPACING_MS = 150;
/** Private deterministic rehearsal. No overlay, runtime, transport or persistence dependencies. */
export async function rehearseDirector(
  version: VersionRow,
  envelope: DirectorEnvelope,
  signal: AbortSignal,
): Promise<DirectorEvidence> {
  const artifact = { source: version.source, manifest: version.manifest };
  const scenario = createRehearsalPreset(artifact, 'crowd-burst', 37);
  const baseline = await runRehearsal({ artifact, scenario, signal });
  const replay = await runRehearsal({ artifact, scenario, signal });
  const policy = createDirectorPolicy(envelope);
  const samples: DirectorEvidence['samples'] = [];
  let nextTick = 100;
  const tick = (through: number) => {
    while (nextTick <= through) {
      const frames = policy.tick(nextTick);
      if (frames.length) samples.push({ at: nextTick, frames });
      nextTick += 100;
    }
  };
  let arrival = 0;
  for (const frame of replay.timeline) {
    if (!frame.decision) continue;
    arrival += DIRECTOR_REHEARSAL_SPACING_MS;
    tick(arrival);
    const decision = frame.decision;
    if (decision?.code !== 'ACCEPTED') continue;
    const effects: DirectorFrame[] = decision.effects.map((effect, index) => ({
      id: `${decision.eventId}-${index}`,
      asset: effect.asset,
      x: effect.x,
      viewer: null,
      automationId: version.automationId,
      versionId: version.id,
    }));
    policy.enqueue({
      key: decision.eventId,
      viewerId: decision.viewerId ?? 'anonymous',
      roundId: 'rehearsal',
      at: arrival,
      effects,
    });
  }
  tick(arrival + 6000);
  const accepted = replay.timeline.filter((f) => f.decision?.code === 'ACCEPTED').length;
  const telemetry = policy.snapshot();
  const session = replay.cursor.session;
  const value = {
    digest: directorDigest(envelope),
    versionId: version.id,
    artifactId: replay.artifactId,
    scenarioHash: replay.scenarioHash,
    rehearsalHash: replay.evidenceHash,
    passed:
      accepted > 0 &&
      baseline.status === 'passed' &&
      replay.status === 'passed' &&
      baseline.evidenceHash === replay.evidenceHash &&
      telemetry.accepted === accepted &&
      telemetry.offered ===
        telemetry.presented +
          telemetry.coalesced +
          telemetry.expired +
          telemetry.cleared +
          telemetry.pending,
    accepted,
    blocked: replay.timeline.filter((f) => f.decision && f.decision.code !== 'ACCEPTED').length,
    scores: session?.scores ?? {},
    contributions: Object.values(session?.participants ?? {}).reduce(
      (n, p) => n + p.contributions,
      0,
    ),
    stateDigest: baseline.cursor.stateDigest,
    replayStateDigest: replay.cursor.stateDigest,
    telemetry,
    samples,
    provenance: 'synthetic' as const,
  };
  return {
    ...value,
    hash: createHash('sha256')
      .update(JSON.stringify({ policy: DIRECTOR_POLICY_VERSION, ...value }))
      .digest('hex'),
  };
}
