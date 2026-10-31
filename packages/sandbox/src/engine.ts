import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  HOST_LIMITS,
  type ExecutionDecision,
  type DecisionCode,
  type ProjectileEffect,
} from '@riff/sdk';
import { z } from 'zod';
import { instrumentHandler } from './instrument.js';
import { artifactSchema, eventSchema, effectSchema } from './contract.js';

const messages: Record<DecisionCode, string> = {
  ACCEPTED: 'Action accepted in private preview.',
  UNRELATED: 'Command does not match.',
  AUDIENCE: 'Viewer is outside the eligible audience.',
  VIEWER_LIMIT: 'Viewer rolling allowance exhausted.',
  CHANNEL_LIMIT: 'Preview channel effect budget exhausted.',
  DUPLICATE: 'Event already processed.',
  INVALID_EVENT: 'Invalid, out-of-order or cross-channel event.',
  INCIDENT: 'Execution rejected; this preview is quarantined.',
  DISABLED: 'Preview quarantined after an execution incident.',
  STOPPED: 'Preview stopped; effects discarded.',
};
const workerResult = z.object({ ok: z.boolean(), effects: z.array(effectSchema).max(10) }).strict();

/** Create isolated host state. Example: const engine = createPreviewEngine(artifact, 42). */
export function createPreviewEngine(candidate: unknown, seed: number) {
  const artifact = artifactSchema.parse(candidate);
  const program = instrumentHandler(artifact.source);
  z.number().int().min(1).max(0xffff_ffff).parse(seed);
  const artifactId = createHash('sha256')
    .update(JSON.stringify({ artifact, limits: HOST_LIMITS, policy: 1 }))
    .digest('hex');
  const seen = new Set<string>();
  const viewers = new Map<string, number[]>();
  let channel = '';
  let lastAt = -1;
  let channelEffects: number[] = [];
  let disabled = false;
  let stopped = false;
  let active: Worker | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const decision = (
    id: string,
    code: DecisionCode,
    effects: ProjectileEffect[] = [],
  ): ExecutionDecision => ({
    eventId: id,
    artifactId,
    code,
    reason: messages[code],
    effects,
    mode: 'preview',
  });

  async function run(raw: unknown): Promise<ExecutionDecision> {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return decision('', 'INVALID_EVENT');
    const event = parsed.data;
    if (stopped) return decision(event.id, 'STOPPED');
    if (disabled) return decision(event.id, 'DISABLED');
    if (channel && channel !== event.channelId) return decision(event.id, 'INVALID_EVENT');
    if (seen.has(event.id)) return decision(event.id, 'DUPLICATE');
    if (event.at < lastAt) return decision(event.id, 'INVALID_EVENT');
    channel = event.channelId;
    lastAt = event.at;
    // The first release bounds each replay session. It never evicts identities and
    // accidentally admits old duplicates; callers start another isolated replay.
    if (seen.size >= 256) return decision(event.id, 'STOPPED');
    seen.add(event.id);
    if (event.text.trim() !== artifact.manifest.trigger.command)
      return decision(event.id, 'UNRELATED');
    if (!event.roles.some((role) => artifact.manifest.trigger.audience.includes(role)))
      return decision(event.id, 'AUDIENCE');
    const history = (viewers.get(event.viewerId) ?? []).filter(
      (at) => at > event.at - artifact.manifest.trigger.windowMs,
    );
    if (history.length >= artifact.manifest.trigger.maxPerViewer)
      return decision(event.id, 'VIEWER_LIMIT');
    channelEffects = channelEffects.filter((at) => at > event.at - 60_000);
    if (channelEffects.length >= artifact.manifest.limits.effectsPerMinute)
      return decision(event.id, 'CHANNEL_LIMIT');
    const eventSeed =
      createHash('sha256').update(`${seed}:${event.id}`).digest().readUInt32LE() || 1;
    const reply = await new Promise<z.infer<typeof workerResult> | null>((resolve) => {
      const worker = new Worker(new URL('./guest-worker.js', import.meta.url), {
        workerData: { artifact, event, seed: eventSeed, program },
        execArgv: [],
      });
      active = worker;
      let settled = false;
      const finish = (result: z.infer<typeof workerResult> | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        active = undefined;
        void worker.terminate();
        resolve(result);
      };
      let ready = false;
      let timeout = setTimeout(() => finish(null), HOST_LIMITS.workerStartupMs);
      worker.on('message', (raw: unknown) => {
        if (
          !ready &&
          z
            .object({ type: z.literal('ready') })
            .strict()
            .safeParse(raw).success
        ) {
          ready = true;
          clearTimeout(timeout);
          timeout = setTimeout(() => finish(null), HOST_LIMITS.wallTimeoutMs);
          return;
        }
        const parsed = workerResult.safeParse(raw);
        finish(parsed.success ? parsed.data : null);
      });
      worker.once('error', () => finish(null));
      worker.once('exit', () => finish(null));
    });
    if (stopped) return decision(event.id, 'STOPPED');
    if (!reply?.ok || reply.effects.length > artifact.manifest.limits.effectsPerEvent) {
      disabled = true;
      return decision(event.id, 'INCIDENT');
    }
    if (channelEffects.length + reply.effects.length > artifact.manifest.limits.effectsPerMinute)
      return decision(event.id, 'CHANNEL_LIMIT');
    if (reply.effects.length) {
      viewers.set(event.viewerId, [...history, event.at]);
      channelEffects.push(...reply.effects.map(() => event.at));
    }
    return decision(event.id, 'ACCEPTED', reply.effects);
  }
  return {
    artifactId,
    /** Serialize admission and run the guest. Example: await engine.dispatch(event). */
    dispatch(event: unknown): Promise<ExecutionDecision> {
      const next = queue.then(() => run(event));
      queue = next.catch(() => undefined);
      return next;
    },
    /** Fence queued and in-flight effects. Example: engine.stop(). */
    stop() {
      stopped = true;
      void active?.terminate();
    },
  };
}
