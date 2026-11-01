import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  artifactIdentity,
  verifyCandidate,
  createPreviewEngine,
  manifestSchema,
} from '@riff/sandbox';
import type { DatabaseConnection } from '../../db/client.js';
import { collaborationConnections } from '../../db/schema.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import type { Sealer } from '../auth/secrets.js';
import type { LiveChatMessage } from '../live/runtime.js';
import {
  contractSchema,
  sharedPresentation,
  contractDigest,
  projectionSchema,
  sharedDecisionSchema,
  tokenSchema,
  type SharedContract,
  type SharedProjection,
} from './contract.js';
import { coordinatorUrl, type PeerTransport } from './transport.js';

const storedSchema = z
  .object({ origin: z.string(), token: tokenSchema, contract: contractSchema, roleId: z.string() })
  .strict();
type Connection = z.infer<typeof storedSchema>;
export interface MemberReview {
  contract: SharedContract;
  roleId: string;
  verification: {
    ok: boolean;
    generated: number;
    host: number;
    stages: { label: string; status: string }[];
  };
  preview: { label: string; codes: string[]; score: number };
}
/** One receiving channel; it owns approval, credentials and local output fencing. */
export function createCollaborationMember(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  sealer: Sealer | null;
  identity: () => string | null;
  ready: () => boolean;
  blocked: () => boolean;
  transport: PeerTransport;
  publish: (projection: SharedProjection | null) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let connection: Connection | null = null;
  let review: MemberReview | null = null;
  let projection: (SharedProjection & { partners?: string[] }) | null = null;
  let state: 'idle' | 'review' | 'connected' | 'paused' | 'stopped' = 'idle';
  let reason: string | null = null;
  let epoch = 0;
  let controller = new AbortController();
  let reviewing = false;
  let approving = false;
  let polling = false;
  let closed = false;
  let pendingInputs = 0;
  let inputQueue: Promise<unknown> = Promise.resolve();
  const save = () => {
    if (!connection || !deps.sealer)
      throw new Error('Configure RIFF_SECRET before connecting channels.');
    deps.database.db
      .insert(collaborationConnections)
      .values({
        channelId: deps.repo.channelId,
        sealed: deps.sealer.seal(connection),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: collaborationConnections.channelId,
        set: { sealed: deps.sealer.seal(connection), updatedAt: now() },
      })
      .run();
  };
  try {
    const stored = deps.database.db
      .select()
      .from(collaborationConnections)
      .where(eq(collaborationConnections.channelId, deps.repo.channelId))
      .get();
    if (stored && deps.sealer) {
      connection = storedSchema.parse(deps.sealer.open(stored.sealed));
      state = 'stopped';
      reason = 'Server restarted. Verify and approve this membership again.';
    }
  } catch {
    reason = 'Saved membership is unavailable. Request a new invitation.';
  }
  /** Approved partner role labels come from the local contract, never from the coordinator. */
  const partners = () =>
    connection?.contract.roles.filter((r) => r.id !== connection?.roleId).map((r) => r.label) ?? [];
  const publish = (p: SharedProjection | null) => {
    projection = p ? { ...p, partners: partners() } : null;
    deps.publish(projection);
  };
  function fence() {
    epoch++;
    controller.abort();
    controller = new AbortController();
  }
  function usable() {
    return (
      !closed &&
      !deps.blocked() &&
      deps.ready() &&
      !!connection &&
      connection.contract.roles.find((role) => role.id === connection?.roleId)?.channelId ===
        deps.identity()
    );
  }
  function commandConflict() {
    const command = connection?.contract.roles.find((r) => r.id === connection?.roleId)?.command;
    if (!command) return false;
    return deps.repo.automations().some((automation) => {
      if (automation.status !== 'live' || !automation.activeVersionId) return false;
      const manifest = manifestSchema.safeParse(
        deps.repo.version(automation.activeVersionId)?.manifest,
      );
      return (
        manifest.success &&
        (manifest.data.trigger.command === command ||
          manifest.data.experience?.teams.some((team) => team.joinCommand === command))
      );
    });
  }
  function project(value: unknown) {
    const next = projectionSchema.parse(value);
    const c = connection;
    if (
      !c ||
      next.sessionId !== c.contract.id ||
      next.digest !== c.contract.digest ||
      next.roleId !== c.roleId
    )
      throw new Error('The coordinator changed the approved agreement. Request a new invitation.');
    const approved = sharedPresentation(c.contract, c.roleId);
    if (
      next.title !== approved.title ||
      next.roleLabel !== approved.roleLabel ||
      next.instructions !== approved.instructions ||
      next.target !== approved.target
    )
      throw new Error('The coordinator changed approved public guidance. Request a new agreement.');
    const role = c.contract.roles.find((r) => r.id === c.roleId);
    if (!role) throw new Error('The approved role is missing.');
    if (
      (!role.fields.includes('score') && (next.score !== undefined || next.target !== undefined)) ||
      (!role.fields.includes('remaining') && next.remaining !== undefined) ||
      (!role.fields.includes('contributions') && next.contributions !== undefined)
    )
      throw new Error('The coordinator sent fields outside the approved view.');
    if (projection && next.revision < projection.revision) return;
    publish(next);
  }
  function unavailable() {
    if (state !== 'connected' && state !== 'paused') return;
    state = 'paused';
    reason = 'Coordinator unavailable. Shared play is paused; no local round is running.';
    if (projection) {
      const safe = { ...projection, status: 'paused' as const, reason };
      delete safe.score;
      delete safe.target;
      delete safe.remaining;
      delete safe.contributions;
      publish(safe);
    } else publish(null);
  }
  const api = {
    status() {
      return {
        state,
        reason,
        origin: connection?.origin ?? null,
        review,
        projection,
        canRecheck: !!connection,
      };
    },
    async review(origin: string, token: string): Promise<MemberReview> {
      if (reviewing || state === 'connected' || state === 'paused')
        throw new Error('Leave the current membership before reviewing another invitation.');
      if (closed || deps.blocked())
        throw new Error('Resume your channel before reviewing a collaboration.');
      if (!deps.sealer) throw new Error('Configure RIFF_SECRET before connecting channels.');
      const target = origin === 'local' ? origin : coordinatorUrl(origin);
      tokenSchema.parse(token);
      reviewing = true;
      fence();
      const atEpoch = epoch;
      review = null;
      connection = null;
      publish(null);
      state = 'idle';
      try {
        const result = z
          .object({ contract: contractSchema, roleId: z.string().max(32) })
          .strict()
          .parse(await deps.transport(target, token, 'review', {}, controller.signal));
        const role = result.contract.roles.find((r) => r.id === result.roleId);
        if (!role || role.channelId !== deps.identity())
          throw new Error(
            'This invitation belongs to another Twitch channel. Connect the invited channel.',
          );
        if (
          contractDigest(result.contract) !== result.contract.digest ||
          artifactIdentity(result.contract.artifact) !== result.contract.artifactId
        )
          throw new Error('The invitation content does not match its exact version digest.');
        const verification = await verifyCandidate({
          ...result.contract.artifact,
          tests: result.contract.tests,
        });
        if (!verification.ok || verification.artifactId !== result.contract.artifactId)
          throw new Error(
            'Independent verification failed. Ask the coordinator to create a tested version.',
          );
        const engine = createPreviewEngine(result.contract.artifact, 17);
        const codes: string[] = [];
        let score = 0;
        try {
          for (let i = 0; i < 4; i++) {
            const decision = await engine.dispatch({
              id: `preview-${i}`,
              channelId: 'private-preview',
              viewerId: 'sample-viewer',
              roles: ['viewer'],
              text: result.contract.artifact.manifest.trigger.command,
              at: 1000 + i,
            });
            codes.push(decision.code);
          }
          score = engine.session?.scores.community ?? 0;
        } finally {
          engine.stop();
        }
        if (atEpoch !== epoch || closed || deps.blocked())
          throw new Error('Review was cancelled. Review again.');
        connection = { origin: target, token, ...result };
        review = {
          ...result,
          verification: {
            ok: true,
            generated: verification.generated.length,
            host: verification.host.length,
            stages: verification.stages.map((stage) => ({
              label: stage.label,
              status: stage.status,
            })),
          },
          preview: {
            label: 'Synthetic private replay · four commands from one viewer',
            codes,
            score,
          },
        };
        save();
        state = 'review';
        reason = null;
        return structuredClone(review);
      } finally {
        reviewing = false;
      }
    },
    recheck() {
      if (!connection) throw new Error('Paste a new invitation.');
      return api.review(connection.origin, connection.token);
    },
    async approve(digest: string) {
      if (
        !connection ||
        !review?.verification.ok ||
        digest !== connection.contract.digest ||
        state !== 'review' ||
        approving ||
        !usable()
      )
        throw new Error(
          'Connect Twitch, verify the current agreement, and approve its exact digest.',
        );
      if (commandConflict())
        throw new Error(
          'This shared command is already used by a live local interaction. Pause it or choose a different shared command.',
        );
      const c = connection,
        atEpoch = epoch;
      approving = true;
      try {
        const value = await deps.transport(
          c.origin,
          c.token,
          'approve',
          { digest },
          controller.signal,
        );
        if (atEpoch !== epoch || !usable())
          throw new Error('Approval was stopped locally. Review a new invitation.');
        project(value);
        save();
        state = 'connected';
        reason = null;
      } catch (error) {
        // A timeout/abort can follow a committed remote grant. Revoke it even when
        // no successful response reached this instance; leave itself is idempotent.
        void deps.transport(c.origin, c.token, 'leave', {}).catch(() => undefined);
        if (atEpoch === epoch)
          api.stop('Membership approval could not be confirmed. Request a new invitation.');
        throw error;
      } finally {
        approving = false;
      }
      return api.status();
    },
    async poll() {
      if (polling || closed || (state !== 'connected' && state !== 'paused') || !connection) return;
      try {
        if (commandConflict()) {
          api.stop(
            'A local interaction now uses this shared command. Resolve the conflict and request a new invitation.',
          );
          return;
        }
        if (!usable()) {
          api.stop('Your channel disconnected or stopped. Request a new invitation.');
          return;
        }
      } catch {
        api.stop('Local membership state is unavailable. Shared output was withdrawn.');
        return;
      }
      polling = true;
      const c = connection,
        atEpoch = epoch;
      try {
        const value = await deps.transport(c.origin, c.token, 'heartbeat', {}, controller.signal);
        if (atEpoch !== epoch || !usable()) return;
        project(value);
        state = 'connected';
        reason = null;
      } catch {
        if (atEpoch === epoch) unavailable();
      } finally {
        polling = false;
      }
    },
    async input(message: LiveChatMessage): Promise<boolean> {
      const c = connection;
      const role = c?.contract.roles.find((r) => r.id === c.roleId);
      if (
        !c ||
        !role ||
        !['connected', 'paused'].includes(state) ||
        message.text.trim().toLowerCase() !== role.command
      )
        return false;
      if (
        !usable() ||
        state !== 'connected' ||
        pendingInputs >= 32 ||
        message.sourceChannelId !== message.channelId ||
        message.channelId !== role.channelId
      )
        return true;
      if (commandConflict()) {
        api.stop(
          'A local interaction now uses this shared command. Resolve the conflict and request a new invitation.',
        );
        return true;
      }
      const atEpoch = epoch;
      pendingInputs++;
      const operation = inputQueue
        .then(async () => {
          if (atEpoch !== epoch || !usable() || state !== 'connected') return;
          const result = sharedDecisionSchema.parse(
            await deps.transport(
              c.origin,
              c.token,
              'input',
              {
                id: message.id,
                channelId: message.channelId,
                viewerId: message.viewerId,
                roles: message.roles,
                text: message.text,
                sourceChannelId: message.sourceChannelId,
                sourceMessageId: message.sourceMessageId,
              },
              controller.signal,
            ),
          );
          if (atEpoch === epoch && usable()) project(result.projection);
        })
        .catch(() => {
          if (atEpoch === epoch) unavailable();
        })
        .finally(() => {
          pendingInputs--;
        });
      inputQueue = operation;
      // Claim the message without waiting: the channel's serialized chat pipeline must never
      // stall on a coordinator round trip. Results arrive through projection updates.
      return true;
    },
    /** Resolves once every queued shared contribution has been answered (tests, shutdown). */
    async settled() {
      await inputQueue;
    },
    stop(message = 'You left this shared experience.') {
      const c = connection;
      const wasActive = state === 'connected' || state === 'paused' || approving;
      fence();
      state = 'stopped';
      reason = message;
      review = null;
      publish(null);
      // Revocation is best effort over the network; the local fence is immediate.
      if (c && wasActive)
        void deps.transport(c.origin, c.token, 'leave', {}).catch(() => undefined);
      try {
        deps.database.db
          .delete(collaborationConnections)
          .where(eq(collaborationConnections.channelId, deps.repo.channelId))
          .run();
      } catch {
        /* Local fence remains authoritative. */
      }
      connection = null;
    },
    close() {
      api.stop('Riff stopped.');
      closed = true;
    },
  };
  return api;
}
export type CollaborationMember = ReturnType<typeof createCollaborationMember>;
