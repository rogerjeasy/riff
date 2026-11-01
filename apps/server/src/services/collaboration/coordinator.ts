import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  advanceSession,
  artifactIdentity,
  createEngine,
  createSessionSnapshot,
  pauseSession,
  resumeSession,
  sessionSeed,
  validateSessionSnapshot,
  type ExecutionEngine,
} from '@riff/sandbox';
import type { DatabaseConnection } from '../../db/client.js';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import {
  collaborationRepository,
  type CollaborationRow,
} from '../../db/repositories/collaboration.js';
import {
  CollaborationError,
  contractSchema,
  sharedPresentation,
  contractDigest,
  inputSchema,
  projectionSchema,
  rolesSchema,
  SHARED_LIMITS,
  tokenSchema,
  type SharedContract,
  type SharedDecision,
  type SharedMember,
  type SharedProjection,
  type SharedView,
} from './contract.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (code: CollaborationError['code'], message: string): never => {
  throw new CollaborationError(code, message);
};

const INCIDENT_REASON = 'The shared behavior stopped after an execution incident.';
function present<T>(value: T | null | undefined): T {
  if (value == null) return fail('BLOCKED', 'Shared session evidence is incomplete.');
  return value;
}

/** One authoritative shared runtime, separate from every local automation engine. */
export function createCoordinator(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  now?: () => number;
  blocked?: () => boolean;
}) {
  const store = collaborationRepository(deps.database, deps.repo.channelId);
  const now = deps.now ?? Date.now;
  const engines = new Map<string, ExecutionEngine>();
  const fences = new Map<string, number>();
  const quarantined = new Set<string>();
  let closed = false;
  let stopped = false;
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const hostBlocked = () => closed || deps.blocked?.() || deps.repo.state().panic;
  const blocked = () => stopped || hostBlocked();
  const definition = (row: CollaborationRow) => present(row.contract.artifact.manifest.experience);
  function required(id: string): CollaborationRow {
    const row = store.get(id);
    if (!row) return fail('NOT_FOUND', 'This shared session is not available.');
    const contract = contractSchema.safeParse(row.contract);
    if (
      !contract.success ||
      contractDigest(contract.data) !== row.contract.digest ||
      artifactIdentity(row.contract.artifact) !== row.contract.artifactId
    )
      return fail('BLOCKED', 'The shared agreement no longer matches its saved evidence.');
    validateSessionSnapshot(definition(row), row.snapshot);
    return row;
  }
  function save(row: CollaborationRow) {
    const previous = row.revision;
    row.revision++;
    row.updatedAt = Math.max(now(), row.updatedAt);
    if (!store.save(row, previous))
      fail('CONFLICT', 'The shared session changed. Refresh and try again.');
    return row;
  }
  function fence(id: string) {
    fences.set(id, (fences.get(id) ?? 0) + 1);
    engines.get(id)?.stop();
    engines.delete(id);
  }
  function pause(row: CollaborationRow, reason: string, at = now()) {
    fence(row.id);
    if (row.status === 'finished') return row;
    row.snapshot = pauseSession(
      row.snapshot,
      Math.max(row.snapshot.updatedAt, at),
      definition(row),
    );
    row.status = row.snapshot.phase === 'finished' ? 'finished' : 'paused';
    row.reason = reason;
    try {
      return save(row);
    } catch (error) {
      stopped = true;
      throw error;
    }
  }
  function healthyVersion(version: VersionRow | undefined) {
    if (!version || ['failed', 'quarantined', 'discarded'].includes(version.status)) return false;
    const evidence = version.evidence as {
      verification?: { ok?: unknown };
      intent?: { status?: string }[];
    } | null;
    if (
      evidence?.verification?.ok !== true ||
      !Array.isArray(evidence.intent) ||
      evidence.intent.some((check) => check.status === 'mismatch')
    )
      return false;
    try {
      deps.repo.assertVersionLineage(version.id);
      return (
        artifactIdentity({ source: version.source, manifest: version.manifest }) ===
        version.artifactId
      );
    } catch {
      return false;
    }
  }
  function ensureHealthy(row: CollaborationRow) {
    if (quarantined.has(row.id) || row.reason === INCIDENT_REASON)
      return fail(
        'BLOCKED',
        'This shared version had an execution incident. Create and verify a new version.',
      );
    const version = deps.repo.version(row.contract.versionId);
    if (!healthyVersion(version) || version?.artifactId !== row.contract.artifactId)
      return fail('BLOCKED', 'The shared behavior is no longer verified or authorized.');
  }
  function authenticate(token: string, approval = true) {
    if (closed || !tokenSchema.safeParse(token).success)
      return fail('UNAUTHORIZED', 'This invitation or membership is no longer valid.');
    const tokenHash = hash(token);
    for (const stored of store.list()) {
      const member = stored.members.find((m) => m.tokenHash === tokenHash);
      if (!member) continue;
      const row = required(stored.id);
      const current = present(row.members.find((m) => m.tokenHash === tokenHash));
      if ((!current.approved && now() >= current.expiresAt) || (approval && !current.approved))
        break;
      return { row, member: current };
    }
    return fail('UNAUTHORIZED', 'This invitation or membership is no longer valid.');
  }
  /** How a finished round ended, in the words both channels see. */
  function endReason(row: CollaborationRow) {
    const target = definition(row).objective.target;
    return target !== null && (row.snapshot.scores.community ?? 0) >= target
      ? 'The goal was reached together.'
      : 'Time ran out before the goal.';
  }
  /** While waiting, say exactly who is missing instead of a stale creation-time message. */
  function reasonOf(row: CollaborationRow): string | null {
    if (row.status !== 'waiting') return row.reason;
    const missing = row.contract.roles.filter(
      (role) =>
        !row.members.some((m) => m.roleId === role.id && m.approved && m.leaseUntil > now()),
    );
    return missing.length
      ? `Waiting for ${missing.map((r) => r.label).join(', ')} to approve and connect.`
      : 'Every channel approved. The host can start the round.';
  }
  function projection(row: CollaborationRow, member: SharedMember): SharedProjection {
    const role = present(row.contract.roles.find((r) => r.id === member.roleId));
    const rule = definition(row);
    const snapshot =
      row.status === 'running'
        ? advanceSession(row.snapshot, Math.max(now(), row.snapshot.updatedAt), rule)
        : row.snapshot;

    return projectionSchema.parse({
      sessionId: row.id,
      digest: row.contract.digest,
      revision: row.revision,
      ...sharedPresentation(row.contract, role.id),
      roleId: role.id,
      status: row.status,
      reason: reasonOf(row),
      ...(role.fields.includes('score')
        ? { score: snapshot.scores.community ?? 0, target: present(rule.objective.target) }
        : {}),
      ...(role.fields.includes('remaining') ? { remaining: snapshot.remainingMs } : {}),
      ...(role.fields.includes('contributions')
        ? { contributions: row.contributions[role.id] ?? 0 }
        : {}),
    });
  }
  function view(id: string): SharedView {
    const row = required(id);
    return {
      contract: row.contract,
      revision: row.revision,
      status: row.status,
      reason: reasonOf(row),
      members: row.members.map((m) => ({
        roleId: m.roleId,
        approved: m.approved,
        connected: m.approved && m.leaseUntil > now(),
      })),
    };
  }
  function tick() {
    if (closed) return;
    for (const stored of store.list()) {
      if (stored.status !== 'running') continue;
      const row = required(stored.id);
      if (quarantined.has(row.id)) {
        pause(row, INCIDENT_REASON);
        continue;
      }
      if (blocked()) {
        pause(row, 'The coordinator has stopped this session.');
        continue;
      }
      try {
        ensureHealthy(row);
      } catch {
        pause(row, 'The shared behavior is no longer authorized.');
        continue;
      }
      const requiredMembers = row.members.filter((m) =>
        row.contract.roles.some((role) => role.id === m.roleId && role.required),
      );
      const lost = requiredMembers.filter((m) => !m.approved || m.leaseUntil <= now());
      if (lost.length) {
        pause(
          row,
          'A required channel disconnected. Reconnect it, then explicitly resume.',
          Math.min(...lost.map((m) => m.leaseUntil)),
        );
        continue;
      }
      const advanced = advanceSession(
        row.snapshot,
        Math.max(now(), row.snapshot.updatedAt),
        definition(row),
      );
      if (advanced.phase === 'finished') {
        fence(row.id);
        row.snapshot = advanced;
        row.status = 'finished';
        row.reason = endReason(row);
        save(row);
      }
    }
  }
  // Restart never silently advances a shared round. All member leases must be renewed.
  for (const original of store.list()) {
    const row = required(original.id);
    row.members.forEach((m) => {
      m.leaseUntil = 0;
    });
    if (row.status === 'running') {
      row.snapshot = pauseSession(row.snapshot, row.snapshot.updatedAt, definition(row));
      row.status = 'paused';
      row.reason = 'The coordinator restarted. Reconnect all required channels and resume.';
    }
    save(row);
  }
  function result(
    row: CollaborationRow,
    member: SharedMember,
    code: SharedDecision['code'],
    reason: string,
  ): SharedDecision {
    return { code, reason, projection: projection(row, member) };
  }
  const api = {
    create(versionId: string, rawRoles: unknown): SharedView {
      if (hostBlocked())
        return fail('BLOCKED', 'Resume this channel before creating a shared session.');
      const roles = rolesSchema.safeParse(rawRoles);
      if (!roles.success)
        return fail('INVALID', 'Choose two to four unique channels, roles and commands.');
      const localChannelId = deps.repo.state().twitchUserId;
      if (!localChannelId || !roles.data.some((r) => r.channelId === localChannelId && r.required))
        return fail('INVALID', 'Connect Twitch and include your channel as a required role.');
      if (store.list().length >= SHARED_LIMITS.sessions)
        return fail('LIMIT', 'This channel has reached its shared-session history limit.');
      const version = deps.repo.version(versionId);
      if (!healthyVersion(version) || !version)
        return fail('BLOCKED', 'Choose an exact verified behavior version.');
      const parsed = contractSchema.safeParse({
        id: randomUUID(),
        digest: '0'.repeat(64),
        versionId,
        artifactId: version.artifactId,
        artifact: { source: version.source, manifest: version.manifest },
        tests: version.tests,
        title: version.title,
        roles: roles.data,
      });
      if (!parsed.success)
        return fail(
          'INVALID',
          'Sharing requires a verified teamless cooperative round with its generated tests.',
        );
      const contract: SharedContract = { ...parsed.data, digest: contractDigest(parsed.data) };
      const at = now();
      const snapshot = pauseSession(
        createSessionSnapshot(present(contract.artifact.manifest.experience), at, contract.id),
        at,
      );
      store.insert({
        id: contract.id,
        contract,
        snapshot,
        members: roles.data.map((role) => ({
          roleId: role.id,
          tokenHash: null,
          expiresAt: 0,
          approved: false,
          leaseUntil: 0,
        })),
        contributions: {},
        status: 'waiting',
        reason: 'Waiting for every channel to approve this agreement.',
        revision: 0,
        started: false,
        updatedAt: at,
      });
      return view(contract.id);
    },
    list() {
      tick();
      return store.list().map((row) => view(row.id));
    },
    view(id: string) {
      tick();
      return view(id);
    },
    invite(id: string, roleId: string) {
      if (hostBlocked()) return fail('BLOCKED', 'Resume this channel before issuing invitations.');
      let row = required(id);
      if (row.status === 'finished')
        return fail('CONFLICT', 'This round has finished. Create a new shared session.');
      const role = row.contract.roles.find((r) => r.id === roleId);
      const member = row.members.find((m) => m.roleId === roleId);
      if (!role || !member) return fail('NOT_FOUND', 'This role does not belong to the session.');
      fence(id);
      if (member.approved && role.required && row.status === 'running')
        row = pause(row, 'A required channel must review its new invitation.');
      const current = present(row.members.find((m) => m.roleId === roleId));
      const token = randomBytes(32).toString('base64url');
      Object.assign(current, {
        tokenHash: hash(token),
        approved: false,
        leaseUntil: 0,
        expiresAt: now() + SHARED_LIMITS.inviteMs,
      });
      save(row);
      return { token, contract: row.contract, roleId, expiresAt: current.expiresAt };
    },
    review(token: string) {
      const { row, member } = authenticate(token, false);
      return { contract: row.contract, roleId: member.roleId };
    },
    approve(token: string, digest: string) {
      if (hostBlocked())
        return fail('BLOCKED', 'The coordinator is stopped. Try again after it resumes.');
      tick();
      const { row, member } = authenticate(token, false);
      if (digest !== row.contract.digest)
        return fail('CONFLICT', 'The reviewed agreement changed. Review the exact version again.');
      ensureHealthy(row);
      if (row.status === 'finished') return fail('CONFLICT', 'The shared round has finished.');
      member.approved = true;
      member.leaseUntil = now() + SHARED_LIMITS.leaseMs;
      save(row);
      return projection(row, member);
    },
    heartbeat(token: string) {
      tick();
      const { row, member } = authenticate(token);
      member.leaseUntil = now() + SHARED_LIMITS.leaseMs;
      // Heartbeats do not change gameplay/control revision; later atomic updates reread members.
      if (!store.save(row, row.revision))
        return fail('CONFLICT', 'Membership changed. Reconnect this channel.');
      return projection(row, member);
    },
    input(token: string, rawEvent: unknown): Promise<SharedDecision> {
      const event = inputSchema.safeParse(rawEvent);
      if (!event.success) return fail('INVALID', 'Invalid shared chat input.');
      tick();
      const initial = authenticate(token);
      const role = present(initial.row.contract.roles.find((r) => r.id === initial.member.roleId));
      if (event.data.channelId !== role.channelId)
        return fail('UNAUTHORIZED', 'This membership cannot submit another channel’s input.');
      if (pending >= SHARED_LIMITS.pending)
        return fail('LIMIT', 'The shared input queue is full. Try the next action.');
      const initialFence = fences.get(initial.row.id) ?? 0;
      pending++;
      const work = queue
        .then(async () => {
          tick();
          const { row, member } = authenticate(token);
          if (
            closed ||
            blocked() ||
            (fences.get(row.id) ?? 0) !== initialFence ||
            row.status !== 'running' ||
            member.leaseUntil <= now()
          )
            return result(
              row,
              member,
              'STOPPED',
              'This shared session is paused or its connection changed.',
            );
          if (event.data.sourceChannelId !== role.channelId)
            return result(
              row,
              member,
              'IGNORED',
              'Echoed messages are handled only by their original channel.',
            );
          if (event.data.text.trim().toLowerCase() !== role.command)
            return result(
              row,
              member,
              'UNRELATED',
              'This message does not match this channel’s shared command.',
            );
          ensureHealthy(row);
          const eventId = hash(`${role.channelId}:${event.data.sourceMessageId}`);
          if (store.hasReceipt(row.id, eventId))
            return result(row, member, 'DUPLICATE', 'This source message was already handled.');
          if (store.receiptCount(row.id) >= SHARED_LIMITS.receipts) {
            const paused = pause(row, 'Shared event history is full. Start a new session.');
            return result(paused, member, 'CAPACITY', 'The shared receipt limit was reached.');
          }
          let engine = engines.get(row.id);
          if (!engine) {
            engine = createEngine(row.contract.artifact, {
              mode: 'live',
              seed: sessionSeed(row.id),
              session: row.snapshot,
            });
            engines.set(row.id, engine);
          }
          engine.restoreSession(row.snapshot);
          const at = Math.max(now(), row.snapshot.updatedAt);
          const decision = await engine.dispatch({
            id: eventId,
            channelId: row.id,
            viewerId: hash(`${role.channelId}:${event.data.viewerId}`),
            roles: event.data.roles,
            text: definition(row).contribution.command,
            at,
          });
          // Every required member must still be present when guest work returns.
          tick();
          const latest = required(row.id);
          const latestMember = present(latest.members.find((m) => m.roleId === member.roleId));
          if (
            closed ||
            blocked() ||
            (fences.get(row.id) ?? 0) !== initialFence ||
            latest.revision !== row.revision ||
            latest.status !== 'running' ||
            latestMember.tokenHash !== member.tokenHash ||
            !latestMember.approved ||
            latestMember.leaseUntil <= now()
          ) {
            fence(row.id);
            return result(
              latest,
              latestMember,
              'STOPPED',
              'The shared contribution was stopped before it was committed.',
            );
          }
          if (decision.code === 'INCIDENT' || decision.code === 'DISABLED') {
            quarantined.add(row.id); // cannot be undone by a failed persistence attempt
            const paused = pause(
              latest,
              'The shared behavior stopped after an execution incident.',
            );
            return result(
              paused,
              latestMember,
              'INCIDENT',
              'The shared behavior failed its execution limits.',
            );
          }
          try {
            store.atomic(() => {
              latest.snapshot = present(engine.session);
              if (decision.code === 'ACCEPTED')
                latest.contributions[role.id] = (latest.contributions[role.id] ?? 0) + 1;
              if (latest.snapshot.phase === 'finished') {
                latest.status = 'finished';
                latest.reason = endReason(latest);
              }
              save(latest);
              store.receipt(latest.id, eventId, decision.code, at);
            });
          } catch {
            stopped = true; // storage recovery cannot authorize an automatic restart
            fence(row.id);
            try {
              pause(required(row.id), 'Shared state could not be saved. The session is paused.');
            } catch {
              /* Memory fence is already effective. */
            }
            return fail(
              'BLOCKED',
              'Shared state could not be saved. No shared contribution was published.',
            );
          }
          return result(latest, latestMember, decision.code, decision.reason);
        })
        .finally(() => {
          pending--;
        });
      queue = work.catch(() => undefined);
      return work;
    },
    leave(token: string) {
      const { row, member } = authenticate(token, false);
      fence(row.id);
      const role = present(row.contract.roles.find((r) => r.id === member.roleId));
      member.tokenHash = null;
      member.approved = false;
      member.leaseUntil = 0;
      if (role.required && row.status === 'running')
        pause(row, 'A required channel left. Invite it again, then explicitly resume.');
      else save(row);
      return { ok: true as const };
    },
    control(
      id: string,
      expectedRevision: number,
      action: 'start' | 'pause' | 'resume',
    ): SharedView {
      tick();
      let row = required(id);
      if (row.revision !== expectedRevision)
        return fail('CONFLICT', 'The shared session changed. Review the current membership.');
      if (action === 'pause') {
        if (row.status === 'running') pause(row, 'Paused by the coordinator.');
        return view(id);
      }
      if (hostBlocked())
        return fail('BLOCKED', 'Resume this channel before resuming the shared session.');
      ensureHealthy(row);
      if (
        (action === 'start' && row.started) ||
        (action === 'resume' && !row.started) ||
        row.status === 'finished' ||
        row.status === 'running'
      )
        return fail('CONFLICT', 'This shared session cannot use that control right now.');
      const needed =
        action === 'start' ? row.contract.roles : row.contract.roles.filter((r) => r.required);
      if (
        needed.some(
          (r) => !row.members.some((m) => m.roleId === r.id && m.approved && m.leaseUntil > now()),
        )
      )
        return fail(
          'BLOCKED',
          'Every required channel must approve and connect before shared play starts.',
        );
      if (store.list().some((other) => other.id !== id && other.status === 'running'))
        return fail('LIMIT', 'Pause the other shared session before starting this one.');
      fence(id);
      row.snapshot = resumeSession(row.snapshot, Math.max(now(), row.snapshot.updatedAt));
      row.status = 'running';
      row.started = true;
      row.reason = null;
      row = save(row);
      stopped = false;
      return view(row.id);
    },
    stop(reason: string) {
      stopped = true;
      // Cancel workers before any DB operation, even if durable storage is broken.
      for (const id of engines.keys()) fence(id);
      try {
        for (const row of store.list()) {
          fence(row.id);
          if (row.status === 'running')
            try {
              pause(row, reason.slice(0, 240) || 'Stopped');
            } catch {
              /* Stay stopped in memory. */
            }
        }
      } catch {
        /* Local emergency stop cannot wait for storage. */
      }
    },
    tick,
    close() {
      if (closed) return;
      api.stop('The coordinator disconnected.');
      closed = true;
    },
  };
  return api;
}
export type Coordinator = ReturnType<typeof createCoordinator>;
