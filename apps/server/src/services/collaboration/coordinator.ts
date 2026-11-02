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
  actionCommand,
  CollaborationError,
  contractSchema,
  objectiveReachable,
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
const WAIT_PREFIX = 'The host is waiting up to';
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
    clearWait(row);
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
    const rule = definition(row);
    const target = rule.objective.target;
    return row.snapshot.outcome === 'goal' ||
      (rule.objective.kind === 'collective-goal' &&
        target !== null &&
        (row.snapshot.scores.community ?? 0) >= target)
      ? 'The goal was reached together.'
      : 'Time ran out before the goal.';
  }
  const roleOf = (row: CollaborationRow, member: SharedMember) =>
    row.contract.roles.find((r) => r.id === member.roleId);
  /** Required roles still gating play: not dropped by the host and not released by a raid. */
  function gating(row: CollaborationRow) {
    return row.members.filter((m) => roleOf(row, m)?.required && !m.dropped && !m.released);
  }
  const connected = (m: SharedMember) => m.approved && m.leaseUntil > now();
  const lostOf = (row: CollaborationRow) => gating(row).filter((m) => !connected(m));
  const labels = (row: CollaborationRow, members: SharedMember[]) =>
    members.map((m) => roleOf(row, m)?.label ?? m.roleId).join(', ');
  const waitDeadline = (row: CollaborationRow) =>
    Math.min(...row.members.map((m) => m.waitUntil ?? Infinity));
  /**
   * The explicit wait marker: every waiting member carries `waitUntil` AND the pause reason
   * is the exact wait text the host chose. Any other pause, stop or restart clears it.
   */
  const waitText = (row: CollaborationRow, lost: SharedMember[]) =>
    `${WAIT_PREFIX} ${SHARED_LIMITS.waitMs / 60000} minutes for ${labels(row, lost)} to reconnect.`;
  const waiting = (row: CollaborationRow) =>
    row.status === 'paused' &&
    waitDeadline(row) !== Infinity &&
    !!row.reason?.startsWith(WAIT_PREFIX);
  function clearWait(row: CollaborationRow) {
    row.members.forEach((m) => delete m.waitUntil);
  }
  /**
   * Persist a host decision with its audit receipt in one transaction. Host-initiated
   * decisions are capped per session; system follow-ups (wait expiry/resume) are bounded by
   * the waits that caused them. Both stay inside the session receipt cap.
   */
  function decide(
    row: CollaborationRow,
    code: string,
    eventId = `audit:${randomUUID()}`,
    host = true,
  ) {
    // System follow-ups (host=false) are never capped: they are bounded by the decisions
    // that caused them and must always be able to settle a wait.
    if (host && store.receiptCount(row.id) >= SHARED_LIMITS.receipts)
      return fail('LIMIT', 'Shared event history is full. Start a new session.');
    if (host && store.decisions(row.id).length >= SHARED_LIMITS.decisions)
      return fail('LIMIT', 'This session reached its host decision limit. End the round.');
    store.atomic(() => {
      save(row);
      store.receipt(row.id, eventId, code, now());
    });
    return row;
  }
  /** Shared resume checks for start, resume, continue-without and an answered wait. */
  function resumable(row: CollaborationRow, all: boolean) {
    if (hostBlocked())
      return fail('BLOCKED', 'Resume this channel before resuming the shared session.');
    ensureHealthy(row);
    const needed = all ? row.members : gating(row);
    if (needed.some((m) => !connected(m)))
      return fail(
        'BLOCKED',
        'Every required channel must approve and connect before shared play starts.',
      );
    if (store.list().some((other) => other.id !== row.id && other.status === 'running'))
      return fail('LIMIT', 'Pause the other shared session before starting this one.');
    fence(row.id);
    row.snapshot = resumeSession(row.snapshot, Math.max(now(), row.snapshot.updatedAt));
    row.status = 'running';
    row.started = true;
    row.reason = null;
    clearWait(row);
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
    const presenter = row.members.find((m) => m.presenting);
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
        ? {
            score: snapshot.scores.community ?? 0,
            ...(rule.objective.kind === 'collective-goal'
              ? { target: present(rule.objective.target) }
              : {}),
          }
        : {}),
      ...(role.fields.includes('remaining') ? { remaining: snapshot.remainingMs } : {}),
      ...(role.fields.includes('contributions')
        ? { contributions: row.contributions[role.id] ?? 0 }
        : {}),
      ...(role.fields.includes('mechanics') && snapshot.mechanics
        ? {
            bursts: snapshot.mechanics.standings.community?.bursts ?? 0,
            tier: snapshot.mechanics.standings.community?.unlocked.length ?? 0,
          }
        : {}),
      ...(presenter ? { presenter: present(roleOf(row, presenter)).label } : {}),
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
        connected: connected(m),
        dropped: !!m.dropped,
        presenting: !!m.presenting,
      })),
      lost: row.status === 'paused' ? lostOf(row).map((m) => m.roleId) : [],
      waitUntil:
        row.status === 'paused' && waitDeadline(row) !== Infinity ? waitDeadline(row) : null,
      decisions: store.decisions(row.id),
    };
  }
  /**
   * An explicit host wait ends either by every lost channel returning or by its deadline.
   * Only the exact wait pause may auto-resume, and never while this channel is stopped:
   * a stop cancels the wait so the host must choose again (local emergency stop wins).
   */
  function settleWait(row: CollaborationRow) {
    if (!waiting(row)) {
      clearWait(row);
      save(row);
      return;
    }
    if (blocked()) {
      clearWait(row);
      row.reason = 'The local channel stopped during the wait. The host must choose again.';
      settle(row, 'POLICY_WAIT_CANCELLED');
      return;
    }
    if (!lostOf(row).length) {
      try {
        resumable(row, false);
      } catch {
        return; // Stay paused; the host still holds the explicit choices.
      }
      settle(row, 'POLICY_RESUMED');
      return;
    }
    if (now() < waitDeadline(row)) return;
    const lost = lostOf(row);
    clearWait(row);
    row.reason = `${labels(row, lost)} did not return in time. The host can continue without them or end the round.`;
    settle(row, 'POLICY_WAIT_EXPIRED');
  }
  /** Record a wait outcome; if the audit receipt cannot be written, still persist the state. */
  function settle(row: CollaborationRow, code: string) {
    const revision = row.revision;
    try {
      decide(row, code, undefined, false);
    } catch {
      row.revision = revision;
      save(row);
    }
  }
  function tickRow(stored: CollaborationRow) {
    if (stored.status !== 'running' && stored.members.some((m) => m.waitUntil !== undefined)) {
      settleWait(required(stored.id));
      return;
    }
    if (stored.status !== 'running') return;
    const row = required(stored.id);
    if (quarantined.has(row.id)) {
      pause(row, INCIDENT_REASON);
      return;
    }
    if (blocked()) {
      pause(row, 'The coordinator has stopped this session.');
      return;
    }
    try {
      ensureHealthy(row);
    } catch {
      pause(row, 'The shared behavior is no longer authorized.');
      return;
    }
    const lost = lostOf(row);
    if (lost.length) {
      pause(
        row,
        `${labels(row, lost)} disconnected. The host can wait, continue without them, or end the round.`,
        Math.min(...lost.map((m) => m.leaseUntil)),
      );
      return;
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
  /** Each session is enforced on its own: one failing row never blocks the others. */
  function tick() {
    if (closed) return;
    let failure: unknown = null;
    for (const stored of store.list()) {
      try {
        tickRow(stored);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  /** Outgoing raids this coordinator observed itself, by target channel (memory only). */
  const raids = new Map<string, { eventId: string; until: number }>();
  function applyHandoff(row: CollaborationRow, roleId: string, hostRoleId: string, raid: string) {
    const eventId = `audit:handoff:${hash(raid)}`;
    // One handoff per session: once a presenter exists, later raids change nothing.
    if (row.members.some((m) => m.presenting) || store.hasReceipt(row.id, eventId)) return false;
    row.members.forEach((m) => {
      m.presenting = m.roleId === roleId;
      if (m.roleId === hostRoleId) m.released = true;
    });
    decide(row, 'HANDOFF', eventId, false);
    return true;
  }
  // Restart never silently advances a shared round. All member leases must be renewed.
  for (const original of store.list()) {
    const row = required(original.id);
    row.members.forEach((m) => {
      m.leaseUntil = 0;
    });
    // A restart cancels any wait: the host must choose again after reconnecting.
    if (waiting(row))
      row.reason = 'The coordinator restarted during a wait. The host must choose again.';
    clearWait(row);
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
    create(versionId: string, rawRoles: unknown, raidHandoff = false): SharedView {
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
        ...(raidHandoff ? { raidHandoff: true } : {}),
      });
      if (!parsed.success)
        return fail(
          'INVALID',
          parsed.error.issues.find((issue) => issue.path.length === 0)?.message ??
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
      // A role the host continued without gates play again once it explicitly rejoins.
      delete member.dropped;
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
            // Each role dispatches only its own approved definition command.
            text: present(actionCommand(definition(row), role.action)),
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
      if (role.required && !member.dropped && !member.released && row.status === 'running')
        pause(
          row,
          `${role.label} left. The host can wait, continue without them, or end the round.`,
        );
      else save(row);
      return { ok: true as const };
    },
    control(
      id: string,
      expectedRevision: number,
      action: 'start' | 'pause' | 'resume' | 'wait' | 'continue' | 'end',
    ): SharedView {
      tick();
      let row = required(id);
      if (row.revision !== expectedRevision)
        return fail('CONFLICT', 'The shared session changed. Review the current membership.');
      if (action === 'pause') {
        if (row.status === 'running') pause(row, 'Paused by the coordinator.');
        return view(id);
      }
      if (action === 'end') {
        // Ending never needs remote channels: it only stops play and reports final results.
        if (!row.started || row.status === 'finished')
          return fail('CONFLICT', 'Only a started, unfinished round can be ended.');
        fence(id);
        if (row.status === 'running')
          row.snapshot = pauseSession(
            row.snapshot,
            Math.max(now(), row.snapshot.updatedAt),
            definition(row),
          );
        const rule = definition(row);
        const score = row.snapshot.scores.community ?? 0;
        row.status = 'finished';
        clearWait(row);
        row.reason =
          rule.objective.kind === 'collective-goal' && rule.objective.target !== null
            ? `The host ended the round at ${score} of ${rule.objective.target} points.`
            : `The host ended the round at ${score} points.`;
        decide(row, 'POLICY_END');
        return view(id);
      }
      if (action === 'wait' || action === 'continue') {
        const lost = lostOf(row);
        if (row.status !== 'paused' || !lost.length)
          return fail('CONFLICT', 'No required channel is missing from a paused round.');
        if (action === 'wait') {
          if (hostBlocked()) return fail('BLOCKED', 'Resume this channel before choosing to wait.');
          if (waiting(row)) return fail('CONFLICT', 'The host is already waiting.');
          const until = now() + SHARED_LIMITS.waitMs;
          lost.forEach((m) => (m.waitUntil = until));
          row.reason = waitText(row, lost);
          decide(row, 'POLICY_WAIT');
          return view(id);
        }
        const gone = new Set([
          ...lost.map((m) => m.roleId),
          ...row.members.filter((m) => m.dropped).map((m) => m.roleId),
        ]);
        const remaining = row.contract.roles.filter((r) => !gone.has(r.id));
        if (!remaining.length || !objectiveReachable(definition(row), remaining))
          return fail(
            'BLOCKED',
            'The remaining channels cannot reach the shared objective. Wait or end the round.',
          );
        // Revoke the lost memberships: they cannot submit input until invited again.
        lost.forEach((m) => {
          m.dropped = true;
          m.tokenHash = null;
          m.approved = false;
          m.leaseUntil = 0;
        });
        resumable(row, false);
        decide(row, 'POLICY_CONTINUE');
        stopped = false;
        return view(id);
      }
      if (
        (action === 'start' && row.started) ||
        (action === 'resume' && !row.started) ||
        row.status === 'finished' ||
        row.status === 'running'
      )
        return fail('CONFLICT', 'This shared session cannot use that control right now.');
      const wasWaiting = waiting(row);
      resumable(row, action === 'start');
      row = wasWaiting ? decide(row, 'POLICY_RESUMED') : save(row);
      stopped = false;
      return view(row.id);
    },
    /**
     * F36 raid handoff, verified by the coordinator itself: this (coordinating) channel's own
     * EventSub reports its outgoing raid. Every started, unfinished, opted-in session whose
     * role belongs to the raided channel makes that role the presenter and releases the
     * host role from gating play. One handoff per session; duplicate raid events are
     * idempotent. Authority, state and tokens stay where they are.
     */
    /** Subscribe to this channel's outgoing raids only while a handoff could apply. */
    wantsRaids() {
      return (
        !closed &&
        store.list().some((r) => r.contract.raidHandoff && r.started && r.status !== 'finished')
      );
    },
    recordRaid(raid: { eventId: string; toChannelId: string }) {
      if (hostBlocked()) return [];
      const at = now();
      raids.set(raid.toChannelId, { eventId: raid.eventId, until: at + SHARED_LIMITS.raidMs });
      const host = deps.repo.state().twitchUserId;
      const changed: string[] = [];
      for (const stored of store.list()) {
        if (!stored.contract.raidHandoff || !stored.started || stored.status === 'finished')
          continue;
        const row = required(stored.id);
        const target = row.contract.roles.find((r) => r.channelId === raid.toChannelId);
        const hostRole = row.contract.roles.find((r) => r.channelId === host);
        if (!target || !hostRole || target.id === hostRole.id) continue;
        if (applyHandoff(row, target.id, hostRole.id, raid.eventId)) changed.push(row.id);
      }
      return changed;
    },
    /**
     * The raided member's confirmation. Accepted only when this coordinator recorded its own
     * outgoing raid to exactly that member's channel within the validity window; a member's
     * claim alone never sets a presenter.
     */
    handoff(token: string, raid: { eventId: string; fromChannelId: string }) {
      if (hostBlocked()) return fail('BLOCKED', 'The coordinator is stopped.');
      tick();
      const { row, member } = authenticate(token);
      if (!row.contract.raidHandoff)
        return fail('BLOCKED', 'This agreement did not opt in to raid handoff.');
      const host = deps.repo.state().twitchUserId;
      const hostRole = row.contract.roles.find((r) => r.channelId === host);
      const role = present(roleOf(row, member));
      if (!hostRole || raid.fromChannelId !== host)
        return fail('UNAUTHORIZED', 'Only a raid from the coordinating channel hands off.');
      if (role.id === hostRole.id)
        return fail('CONFLICT', 'The coordinating channel cannot hand off to itself.');
      if (!row.started || row.status === 'finished')
        return fail('CONFLICT', 'Only a started, unfinished round can hand off.');
      const recorded = raids.get(role.channelId);
      if (!recorded || recorded.until < now())
        return fail(
          'UNAUTHORIZED',
          'The coordinating channel has not recorded a raid to this channel.',
        );
      applyHandoff(row, role.id, hostRole.id, recorded.eventId);
      return projection(required(row.id), member);
    },
    stop(reason: string) {
      stopped = true;
      // Cancel workers before any DB operation, even if durable storage is broken.
      for (const id of engines.keys()) fence(id);
      try {
        for (const row of store.list()) {
          fence(row.id);
          try {
            if (row.status === 'running') pause(row, reason.slice(0, 240) || 'Stopped');
            else if (row.members.some((m) => m.waitUntil !== undefined)) {
              // A stop always cancels a pending wait; the host must choose again.
              clearWait(row);
              row.reason = 'The local channel stopped during the wait. The host must choose again.';
              save(row);
            }
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
