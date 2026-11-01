import { ProposalError, type ProposalService } from '../proposals/service.js';
import { parseProposalCommand, type ProposalCommand } from '../proposals/commands.js';
import {
  createSessionControl,
  experienceOf,
  sessionSeed,
  SessionConfigurationError,
} from './sessions.js';
import {
  ADMISSION_RETENTION_MS,
  recordsAdmission,
  restoreAdmission,
  restoreChannelEffects,
} from './admission.js';
import {
  artifactIdentity,
  advanceSession,
  definitionCommands,
  runSessionMigration,
  sessionDefinitionHash,
  migrationSourceHash,
  transitionIdentity,
  createAdmissionState,
  createEngine,
  DECISION_MESSAGES,
  eventSchema,
  type AdmissionState,
  type ExecutionEngine,
} from '@riff/sandbox';
import {
  EFFECT_LIMITS,
  type ChatEvent,
  type PermissionManifest,
  type ExecutionDecision,
  type PredictionProposal,
} from '@riff/sdk';
import { describeWindow, describeAudience } from '@riff/compiler';
import { transitionEvidenceId } from '../../db/repositories/transitions.js';
import { approvalBlockers } from '../automations/views.js';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { Hub } from '../hub.js';
import type { OverlayBroker } from '../overlay/broker.js';
import { createTimerScheduler, type TimerFire } from '../timers/scheduler.js';

/** Incoming chat, already normalized from an authenticated transport. */
export interface LiveChatMessage extends Omit<ChatEvent, 'at'> {
  viewerName: string;
  source: 'twitch';
  sourceChannelId?: string;
  sourceMessageId?: string;
}
const PANIC_COMMAND = '!riff panic';
/** A Channel Points redemption the host already matched to one linked automation. */
export interface LiveRedemption {
  /** Twitch redemption id; also the durable admission identity. */
  id: string;
  channelId: string;
  viewerId: string;
  viewerName: string;
  /** Sanitized viewer input ('' when the reward takes none). */
  text: string;
  automationId: string;
}
/** A host-validated proposal; the creator decides whether to open it. */
export interface LivePredictionProposal {
  automationId: string;
  versionId: string;
  eventId: string;
  proposal: PredictionProposal;
}

/**
 * The live control plane for one channel. Panic flips an in-memory flag first and
 * persists second, so it works even when the database write path is degraded.
 */
export function createLiveRuntime(deps: {
  repo: ChannelRepository;
  hub: Hub;
  overlay: OverlayBroker;
  now?: () => number;
  proposals?: ProposalService;
  onHelpChat?: (message: LiveChatMessage) => boolean;
  /** Owner-only in-chat authoring (`!riff create|edit|approve|…`); true when consumed. */
  onAuthorChat?: (message: LiveChatMessage) => boolean;
  onSharedChat?: (message: LiveChatMessage) => Promise<boolean>;
  onStop?: () => void;
  onProposalChange?: (kind: ProposalCommand['kind'] | undefined) => void;
  onPredictionProposal?: (proposal: LivePredictionProposal) => void;
}) {
  const { repo, hub, overlay } = deps;
  const now = deps.now ?? Date.now;
  const sessions = createSessionControl({ repo, hub, overlay, now });
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let pendingChat = 0;
  const engines = new Map<string, { engine: ExecutionEngine; version: VersionRow }>();
  // Admission counters live per automation, not per version: edits and rollbacks
  // never hand a viewer a fresh allowance.
  const admissions = new Map<string, AdmissionState>();
  const channelBudget = { effects: [] as number[], perMinute: EFFECT_LIMITS.perMinute };
  let panic = false;
  let generation = 0;
  let lastAt = 0;
  let lastEvent: { at: number; viewer: string; code: string } | null = null;

  let lastPrune = 0;
  const recentAdmissions = () => repo.admissionsSince(now() - ADMISSION_RETENTION_MS);
  // Counters are rebuilt from durable records, so a restart never hands a viewer a
  // fresh allowance, forgets a delivered event, or refills the effect budget.
  try {
    channelBudget.effects = restoreChannelEffects(recentAdmissions(), now());
  } catch {
    /* A degraded read starts empty; writes still fail closed below. */
  }
  const admissionFor = (automationId: string) => {
    let state = admissions.get(automationId);
    if (!state) {
      try {
        state = restoreAdmission(recentAdmissions(), automationId);
      } catch {
        state = createAdmissionState();
      }
      admissions.set(automationId, state);
      lastAt = Math.max(lastAt, state.lastAt);
    }
    return state;
  };
  function publishActivity(entry: Parameters<ChannelRepository['record']>[0]) {
    let row;
    try {
      row = repo.record(entry);
    } catch {
      row = { ...entry, id: -Date.now(), channelId: repo.channelId };
    }
    hub.publish('activity', row);
  }
  function refreshInstructions() {
    const lines = [...engines.values()].map(({ version }) => {
      const t = (version.manifest as PermissionManifest).trigger;
      if (t.kind === 'points.redeem')
        return `Redeem “${t.reward ?? ''}” with Channel Points · ${t.maxPerViewer} per ${describeWindow(t.windowMs)}`;
      const who = t.audience.includes('viewer') ? '' : ` (${describeAudience(t.audience)})`;
      const experience = experienceOf(version);
      if (!experience)
        return `Type ${t.command} in chat${who} · ${t.maxPerViewer} per ${describeWindow(t.windowMs)}`;
      // Rounds spend a lifetime allowance and may need a team first; never imply a
      // rolling window or let a late viewer type a command that is rejected.
      const { teams, contribution, resource, objective } = experience;
      const each = `${resource.perParticipant} ${resource.name} each this round`;
      // Version 2 rules add heal, burst and unlock commands; name them on stream too.
      const more = definitionCommands(experience).filter(
        (command) =>
          command !== contribution.command && !teams.some((team) => team.joinCommand === command),
      );
      const also = more.length ? ` · also ${more.join(', ')}` : '';
      return (
        (teams.length
          ? `Type ${teams
              .map((team) => team.joinCommand)
              .join(', ')
              .replace(
                /, ([^,]*)$/,
                ' or $1',
              )} to join a team${who}, then ${contribution.command} · ${each}`
          : `Type ${contribution.command}${who} to help reach ${objective.target ?? ''} together · ${each}`) +
        also
      );
    });
    overlay.setInstructions(panic ? [] : lines);
    sessions.publish(panic);
  }
  const timers = createTimerScheduler({ repo, record: publishActivity });
  /** Fenced, best-effort timer cancellation: in-memory stop always happens first. */
  function cancelTimers(automationId: string | null, reason: string) {
    try {
      timers.cancel(automationId, reason);
    } catch {
      /* Boot and resume reconcile timers again before anything can fire. */
    }
  }
  /** Commit staged timer operations; a failed write is visible and never fires later. */
  function applyTimers(automationId: string, versionId: string, decision: ExecutionDecision) {
    try {
      timers.apply(automationId, versionId, decision);
    } catch {
      publishActivity({
        at: Date.now(),
        kind: 'incident',
        automationId,
        versionId,
        eventId: decision.eventId,
        viewer: null,
        code: 'TIMER_FAILED',
        message: 'Riff could not save a timer this interaction asked for, so it will not fire.',
      });
    }
  }
  function quarantine(automationId: string, version: VersionRow, fault: string) {
    engines.get(automationId)?.engine.stop();
    engines.delete(automationId);
    cancelTimers(automationId, 'the version was stopped after an incident');
    try {
      repo.updateVersion(version.id, { status: 'quarantined', incident: fault });
      repo.updateAutomation(automationId, { status: 'paused' });
      sessions.pause(automationId);
    } catch {
      /* The engine is already stopped; persistence is best effort. */
    }
    publishActivity({
      at: Date.now(),
      kind: 'incident',
      automationId,
      versionId: version.id,
      eventId: null,
      viewer: null,
      code: 'INCIDENT',
      message: `v${version.number} was stopped: ${fault}. Your previous approved version can be restored with rollback.`,
    });
    refreshInstructions();
    hub.publish('studio', null);
  }
  function start(automationId: string, version: VersionRow) {
    overlay.invalidatePresentation();
    engines.get(automationId)?.engine.stop();
    const stored = experienceOf(version) ? sessions.recover(version) : null;
    const engine = createEngine(
      { source: version.source, manifest: version.manifest },
      {
        seed: stored ? sessionSeed(stored.id) : (now() % 0xfffffff) + 1,
        mode: 'live',
        ...(stored
          ? { session: stored.snapshot, effectBudget: admissionFor(automationId) }
          : { admission: admissionFor(automationId) }),
        channelBudget,
        timers: { active: () => timers.active(automationId) },
      },
    );
    void engine.warm();
    engines.set(automationId, { engine, version });
    refreshInstructions();
  }
  function stop(automationId: string) {
    engines.get(automationId)?.engine.stop();
    engines.delete(automationId);
    refreshInstructions();
  }

  async function processChat(message: LiveChatMessage): Promise<ExecutionDecision[]> {
    if (message.sourceChannelId && message.sourceChannelId !== message.channelId) return [];
    const text = message.text.trim().toLowerCase();
    if (text === PANIC_COMMAND || text.startsWith(`${PANIC_COMMAND} `)) {
      if (message.roles.includes('broadcaster') || message.roles.includes('moderator'))
        api.panic(`!riff panic by ${message.viewerName}`);
      return [];
    }
    if (!panic && deps.onAuthorChat?.(message)) return [];
    if (!panic && deps.onHelpChat?.(message)) return [];
    const command = deps.proposals?.handleCommand(
      {
        kind: 'chat',
        accountId: message.viewerId,
        displayName: message.viewerName,
        roles: message.roles,
      },
      { eventId: message.id, text: message.text },
    );
    if (command?.consumed) {
      deps.onProposalChange?.(parseProposalCommand(message.text)?.kind);
      return [];
    }
    if (panic) return [];
    if (await deps.onSharedChat?.(message)) return [];
    if (panic || closed) return [];
    if (now() - lastPrune > 60_000) {
      lastPrune = now();
      try {
        repo.pruneAdmissions(now() - ADMISSION_RETENTION_MS);
      } catch {
        /* Retention is housekeeping; admission still reads only the recent span. */
      }
    }
    lastAt = Math.max(lastAt, now());
    const event = eventSchema.safeParse({
      id: message.id,
      channelId: message.channelId,
      viewerId: message.viewerId,
      roles: message.roles,
      text: message.text,
      at: lastAt,
    });
    if (!event.success) return [];
    const fence = generation;
    const results = [];
    for (const [automationId, { engine, version }] of [...engines.entries()]) {
      let decision: ExecutionDecision;
      let sessionDelivered = 0;
      try {
        if (experienceOf(version)) {
          const result = await sessions.process(
            version,
            engine,
            event.data,
            message.viewerName,
            () => fence === generation && !panic && !closed,
          );
          decision = result.decision;
          sessionDelivered = result.delivered;
        } else if (repo.hasAdmission(automationId, event.data.id)) {
          // Durable identity outlives the engine's in-memory dedupe window and restarts.
          decision = {
            eventId: event.data.id,
            artifactId: engine.artifactId,
            mode: 'live',
            code: 'DUPLICATE',
            reason: DECISION_MESSAGES.DUPLICATE,
            effects: [],
            viewerId: event.data.viewerId,
            at: event.data.at,
            allowance: null,
          };
        } else {
          decision = await engine.dispatch(event.data);
          // Recorded before any effect leaves the host; a failed write sends nothing.
          if (recordsAdmission(decision.code))
            repo.recordAdmission({
              automationId,
              eventId: event.data.id,
              viewerId: event.data.viewerId,
              at: event.data.at,
              code: decision.code,
              effects: decision.effects.length,
            });
        }
      } catch {
        generation++;
        engine.stop();
        engines.delete(automationId);
        // In-memory counters may include the unrecorded event; rebuild from storage.
        admissions.delete(automationId);
        try {
          channelBudget.effects = restoreChannelEffects(recentAdmissions(), now());
        } catch {
          /* Keep conservative in-memory charges if the durable history cannot be read. */
        }
        try {
          repo.updateAutomation(automationId, { status: 'paused' });
          sessions.pause(automationId);
        } catch {
          /* memory fence already applied */
        }
        cancelTimers(automationId, 'the interaction was paused after a storage failure');
        refreshInstructions();
        hub.publish('studio', null);
        decision = {
          eventId: event.data.id,
          artifactId: engine.artifactId,
          mode: 'live',
          code: 'STOPPED',
          reason:
            'Riff could not save this event, so no effect was sent and the interaction was paused. Resume to retry.',
          effects: [],
          viewerId: event.data.viewerId,
          at: event.data.at,
          allowance: null,
        };
      }
      results.push(decision);
      if (decision.code === 'UNRELATED') continue;
      if (decision.code === 'INCIDENT') {
        quarantine(automationId, version, engine.incident?.fault ?? 'execution incident');
        continue;
      }
      // A generation change (panic, swap, pause) while the handler ran fences its effects.
      const delivered =
        fence === generation && !panic
          ? experienceOf(version)
            ? sessionDelivered
            : overlay.deliver(decision, message.viewerName, automationId, version.id)
          : 0;
      // Timer operations commit only for accepted, unfenced work, after admission is durable.
      if (fence === generation && !panic && decision.timers?.length)
        applyTimers(automationId, version.id, decision);
      if (decision.proposals?.length && fence === generation && !panic)
        for (const proposal of decision.proposals)
          deps.onPredictionProposal?.({
            automationId,
            versionId: version.id,
            eventId: message.id,
            proposal,
          });
      lastEvent = { at: Date.now(), viewer: message.viewerName, code: decision.code };
      publishActivity({
        at: Date.now(),
        kind: 'decision',
        automationId,
        versionId: version.id,
        eventId: message.id,
        viewer: message.viewerName,
        code: fence === generation ? decision.code : 'STOPPED',
        message:
          decision.code === 'ACCEPTED'
            ? `${message.viewerName} used ${(version.manifest as PermissionManifest).trigger.command} · ${delivered} cosmetic effect${delivered === 1 ? '' : 's'} submitted for presentation`
            : decision.reason,
      });
    }
    await applyPending();
    return results;
  }

  /** Deliver due timers through the same engine, budgets and overlay fences as chat. */
  async function fireTimers(fence: number) {
    const valid = () => fence === generation && !panic && !closed;
    if (!valid()) return;
    lastAt = Math.max(lastAt, now());
    await timers.fireDue(
      lastAt,
      (automationId) => {
        const entry = engines.get(automationId);
        return (
          entry && {
            ...entry,
            channelId: admissions.get(automationId)?.channelId || repo.channelId,
          }
        );
      },
      onTimerFire,
      valid,
    );
  }
  function onTimerFire({ row, event, decision, target }: TimerFire) {
    if (decision.code === 'INCIDENT') {
      const entry = engines.get(row.automationId);
      if (entry?.engine === target.engine)
        quarantine(
          row.automationId,
          entry.version,
          entry.engine.incident?.fault ?? 'execution incident',
        );
      return;
    }
    const current = engines.get(row.automationId);
    const fenced = panic || closed || current?.engine !== target.engine;
    const delivered = fenced ? 0 : overlay.deliver(decision, null, row.automationId, row.versionId);
    if (!fenced && decision.timers?.length) applyTimers(row.automationId, row.versionId, decision);
    publishActivity({
      at: Date.now(),
      kind: 'decision',
      automationId: row.automationId,
      versionId: row.versionId,
      eventId: event.id,
      viewer: null,
      code: fenced ? 'STOPPED' : decision.code,
      message:
        decision.code === 'ACCEPTED'
          ? `Timer “${row.name}” fired${event.missed ? ` ${Math.round((event.firedAt - event.scheduledAt) / 1000)} s late (missed while Riff was unavailable)` : ''} · ${delivered} cosmetic effect${delivered === 1 ? '' : 's'} submitted for presentation`
          : `Timer “${row.name}”: ${decision.reason}`,
    });
    hub.publish('studio', null);
  }

  /** One redemption, one linked automation, the same durable admission as chat. */
  async function processRedemption(input: LiveRedemption): Promise<ExecutionDecision | null> {
    const entry = engines.get(input.automationId);
    if (!entry || panic || closed) return null;
    const { engine, version } = entry;
    const trigger = (version.manifest as PermissionManifest).trigger;
    if (trigger.kind !== 'points.redeem' || experienceOf(version)) return null;
    lastAt = Math.max(lastAt, now());
    const event = eventSchema.safeParse({
      id: input.id,
      channelId: input.channelId,
      viewerId: input.viewerId,
      roles: ['viewer'],
      text: input.text,
      at: lastAt,
      kind: 'points.redeem',
    });
    if (!event.success) return null;
    const fence = generation;
    let decision: ExecutionDecision;
    try {
      if (repo.hasAdmission(input.automationId, event.data.id))
        return {
          eventId: event.data.id,
          artifactId: engine.artifactId,
          mode: 'live',
          code: 'DUPLICATE',
          reason: DECISION_MESSAGES.DUPLICATE,
          effects: [],
          viewerId: event.data.viewerId,
          at: event.data.at,
          allowance: null,
        };
      decision = await engine.dispatch(event.data);
      if (recordsAdmission(decision.code))
        repo.recordAdmission({
          automationId: input.automationId,
          eventId: event.data.id,
          viewerId: event.data.viewerId,
          at: event.data.at,
          code: decision.code,
          effects: decision.effects.length,
        });
    } catch {
      generation++;
      engine.stop();
      engines.delete(input.automationId);
      admissions.delete(input.automationId);
      try {
        repo.updateAutomation(input.automationId, { status: 'paused' });
      } catch {
        /* memory fence already applied */
      }
      refreshInstructions();
      hub.publish('studio', null);
      return null;
    }
    if (decision.code === 'INCIDENT') {
      quarantine(input.automationId, version, engine.incident?.fault ?? 'execution incident');
      return decision;
    }
    const live = fence === generation && !panic;
    const delivered = live
      ? overlay.deliver(decision, input.viewerName, input.automationId, version.id)
      : 0;
    lastEvent = { at: Date.now(), viewer: input.viewerName, code: decision.code };
    publishActivity({
      at: Date.now(),
      kind: 'decision',
      automationId: input.automationId,
      versionId: version.id,
      eventId: input.id,
      viewer: input.viewerName,
      code: live ? decision.code : 'STOPPED',
      message:
        decision.code === 'ACCEPTED'
          ? `${input.viewerName} redeemed “${trigger.reward ?? ''}” · ${delivered} cosmetic effect${delivered === 1 ? '' : 's'} submitted for presentation`
          : decision.reason,
    });
    return live ? decision : { ...decision, code: 'STOPPED', effects: [] };
  }

  async function applyTransition(id: string) {
    const reviewed = repo.transition(id);
    if (!reviewed || !['review', 'pending'].includes(reviewed.status))
      throw new SessionConfigurationError('This transition is no longer available.');
    if (
      transitionEvidenceId(reviewed.plan, reviewed.migrationSource, reviewed.evidence) !==
      reviewed.evidenceId
    )
      throw new SessionConfigurationError('The transition evidence changed. Review again.');
    const version = repo.version(reviewed.targetVersionId);
    const source = repo.version(reviewed.sourceVersionId);
    const targetDefinition = version ? experienceOf(version) : null;
    const current = repo.session(reviewed.automationId);
    const automation = repo.automation(reviewed.automationId);
    if (panic || closed || repo.state().panic || repo.state().transitionEpoch !== reviewed.epoch)
      throw new SessionConfigurationError(
        'Everything is stopped or this approval was cancelled. Review again.',
      );
    if (
      !version ||
      !source ||
      !targetDefinition ||
      !current ||
      automation?.activeVersionId !== source.id ||
      current.versionId !== source.id ||
      current.id !== reviewed.sourceSessionId ||
      source.artifactId !== reviewed.plan.sourceArtifactId ||
      artifactIdentity({ source: source.source, manifest: source.manifest }) !==
        reviewed.plan.sourceArtifactId ||
      version.artifactId !== reviewed.plan.targetArtifactId ||
      sessionDefinitionHash(current.definition) !== reviewed.plan.sourceDefinitionHash ||
      sessionDefinitionHash(targetDefinition) !== reviewed.plan.targetDefinitionHash ||
      migrationSourceHash(reviewed.migrationSource) !== reviewed.plan.migrationSourceHash
    )
      throw new SessionConfigurationError(
        'The source session or reviewed artifacts changed. Review again.',
      );
    transitionIdentity(reviewed.plan);
    const blockers = approvalBlockers(version, panic);
    if (blockers.length) throw new SessionConfigurationError(blockers.join(' '));
    if (
      reviewed.plan.boundary === 'stopped' &&
      (automation.status !== 'paused' || current.snapshot.phase !== 'paused')
    )
      throw new SessionConfigurationError(
        'Stop this interaction before approving a stopped transition.',
      );
    if (reviewed.plan.boundary === 'round-end' && current.snapshot.phase !== 'finished')
      return false;
    const fence = generation;
    const at = Math.max(now(), current.snapshot.updatedAt);
    const advanced = advanceSession(current.snapshot, at, current.definition);
    // Normalize the boundary privately; its control journal row commits with migration.
    const snapshot = await runSessionMigration(reviewed.migrationSource, {
      oldDefinition: current.definition,
      newDefinition: targetDefinition,
      snapshot: advanced,
      at,
    }).catch(() => {
      throw new SessionConfigurationError(
        'The migration no longer preserves current progress. Review again or choose an explicit reset.',
      );
    });
    const prepared = createEngine(
      { source: version.source, manifest: version.manifest },
      {
        seed: sessionSeed(snapshot.id),
        mode: 'live',
        session: snapshot,
        effectBudget: admissionFor(reviewed.automationId),
        channelBudget,
      },
    );
    try {
      if (!(await prepared.warm().catch(() => false)))
        throw new SessionConfigurationError(
          'The target worker could not start. Current progress was kept; try reviewing again.',
        );
      if (fence !== generation || panic || closed)
        throw new SessionConfigurationError('Activation was stopped. Review and approve again.');
      const currentTarget = repo.version(version.id);
      if (!currentTarget || approvalBlockers(currentTarget, panic).length)
        throw new SessionConfigurationError(
          'The target health changed while preparing activation. Review again.',
        );
      if (!repo.commitTransition(id, current.revision, snapshot, at))
        throw new SessionConfigurationError(
          'The session or approval changed before activation. Review again.',
        );
    } catch (error) {
      prepared.stop();
      throw error;
    }
    // No await separates the committed version from replacing the prepared engine.
    overlay.invalidatePresentation();
    engines.get(reviewed.automationId)?.engine.stop();
    engines.delete(reviewed.automationId);
    if (automation.status === 'live')
      engines.set(reviewed.automationId, { engine: prepared, version });
    else prepared.stop();
    refreshInstructions();
    hub.publish('studio', null);
    return true;
  }
  async function applyPending() {
    if (panic || closed) return;
    for (const pending of repo.pendingTransitions()) {
      const current = repo.session(pending.automationId);
      if (current?.snapshot.phase !== 'finished') continue;
      try {
        await applyTransition(pending.id);
      } catch {
        repo.cancelTransition(pending.id);
        hub.publish('studio', null);
      }
    }
  }
  let transitionJobs = 0;

  const api = {
    get panicked() {
      return panic;
    },
    get lastEvent() {
      return lastEvent;
    },
    running() {
      return [...engines.entries()].map(([automationId, { engine, version }]) => ({
        automationId,
        versionId: version.id,
        artifactId: engine.artifactId,
        status: engine.status,
      }));
    },
    /** Restore live engines after boot. A persisted panic keeps everything stopped. */
    boot() {
      panic = repo.state().panic;
      if (panic) {
        overlay.clear('panic');
        repo.invalidateTransitions();
        cancelTimers(null, 'everything is stopped');
        return;
      }
      for (const automation of repo.automations()) {
        if (automation.status !== 'live' || !automation.activeVersionId) continue;
        const version = repo.version(automation.activeVersionId);
        if (version?.status === 'active') start(automation.id, version);
      }
      // Pending timers resume only for the version that is live now; overdue ones are
      // delivered or expired by the first tick under the shared grace policy.
      timers.reconcile((automationId) => engines.get(automationId)?.version.id ?? null);
    },
    /** Swap to an approved version with a generation fence; in-flight old work is discarded. */
    activate(automationId: string, version: VersionRow) {
      generation++;
      cancelTimers(automationId, `v${version.number} replaced the previous version`);
      if (!panic) start(automationId, version);
    },
    pause(automationId: string) {
      generation++;
      stop(automationId);
      cancelTimers(automationId, 'the interaction was paused');
      sessions.pause(automationId);
      overlay.clear('pause');
      refreshInstructions();
    },
    resumeAutomation(automationId: string, version: VersionRow) {
      repo.assertVersionLineage(version.id);
      if (!panic) {
        sessions.resume(automationId);
        start(automationId, version);
      }
    },
    panic(source: string) {
      panic = true; // in-memory first: nothing below can delay the stop
      deps.onStop?.();
      generation++;
      for (const { engine } of engines.values()) engine.stop();
      engines.clear();
      overlay.clear('panic');
      overlay.setInstructions([]);
      const panicAt = now();
      cancelTimers(null, 'everything was stopped');
      try {
        repo.updateState({
          panic: true,
          panicAt,
          transitionEpoch: repo.state().transitionEpoch + 1,
        });
      } catch {
        /* Remain stopped in memory. */
      }
      try {
        repo.invalidateTransitions();
      } catch {
        /* epoch or resume also invalidates pending work */
      }
      // Never roll back a durable panic because a secondary session write fails.
      // panicAt also lets explicit resume recover the frozen clock after a restart.
      try {
        for (const row of repo.sessions()) {
          try {
            sessions.pause(row.automationId, panicAt);
          } catch {
            /* Best effort; durable panic remains. */
          }
        }
      } catch {
        /* Reading sessions may also be degraded. */
      }
      publishActivity({
        at: Date.now(),
        kind: 'control',
        automationId: null,
        versionId: null,
        eventId: null,
        viewer: null,
        code: 'PANIC',
        message: `Everything stopped (${source}). The overlay was cleared. Already-sent effects cannot be recalled.`,
      });
      hub.publish('studio', null);
    },
    resume() {
      const panicAt = repo.state().panicAt;
      repo.atomic(() => {
        repo.invalidateTransitions();
        for (const automation of repo.automations()) {
          if (automation.status !== 'live') continue;
          if (automation.activeVersionId) {
            try {
              repo.assertVersionLineage(automation.activeVersionId);
            } catch (error) {
              if (!(error instanceof ProposalError)) throw error;
              // Explicit channel recovery must not reactivate removed content. Keep
              // its progress paused so a reviewed clean rollback remains reachable.
              const current = repo.session(automation.id);
              if (current?.snapshot.phase === 'running' && panicAt !== null)
                sessions.pause(automation.id, panicAt);
              repo.updateAutomation(automation.id, { status: 'paused' });
              continue;
            }
          }
          const current = repo.session(automation.id);
          if (current?.snapshot.phase === 'running' && panicAt !== null)
            sessions.pause(automation.id, panicAt);
          sessions.resume(automation.id);
        }
        repo.updateState({ panic: false, panicAt: null });
      });
      panic = false;
      // Resuming never silently recreates timers cancelled by panic.
      cancelTimers(null, 'the channel resumed without restoring cancelled timers');
      overlay.resumeCommunity();
      publishActivity({
        at: Date.now(),
        kind: 'control',
        automationId: null,
        versionId: null,
        eventId: null,
        viewer: null,
        code: 'RESUME',
        message:
          'Channel resumed. Removed audience versions remain paused; review a clean version to restore them.',
      });
      for (const automation of repo.automations()) {
        if (automation.status !== 'live' || !automation.activeVersionId) continue;
        const version = repo.version(automation.activeVersionId);
        if (version?.status === 'active') {
          sessions.resume(automation.id);
          start(automation.id, version);
        }
      }
      hub.publish('studio', null);
    },
    /** Serialize one channel, including state changes spanning multiple automations. */
    handleChat(message: LiveChatMessage): Promise<ExecutionDecision[]> {
      if (message.sourceChannelId && message.sourceChannelId !== message.channelId)
        return Promise.resolve([]);
      const text = message.text.trim().toLowerCase();
      if (text === PANIC_COMMAND || text.startsWith(`${PANIC_COMMAND} `)) {
        if (message.roles.includes('broadcaster') || message.roles.includes('moderator'))
          this.panic(`!riff panic by ${message.viewerName}`);
        return Promise.resolve([]);
      }
      if (closed || panic) return Promise.resolve([]);
      if (pendingChat >= 128) {
        const reason =
          'The gameplay queue is full. This action was not admitted or counted; try again shortly.';
        const at = now();
        const decisions: ExecutionDecision[] = [...engines.values()].map(({ engine }) => ({
          eventId: message.id,
          artifactId: engine.artifactId,
          mode: 'live',
          code: 'CAPACITY',
          reason,
          effects: [],
          viewerId: message.viewerId,
          at,
          allowance: null,
        }));
        publishActivity({
          at,
          kind: 'decision',
          automationId: null,
          versionId: null,
          eventId: message.id,
          viewer: message.viewerName,
          code: 'CAPACITY',
          message: reason,
        });
        lastEvent = { at, viewer: message.viewerName, code: 'CAPACITY' };
        return Promise.resolve(decisions);
      }
      const fence = generation;
      pendingChat++;
      const next = queue
        .then(() => (fence === generation && !closed ? processChat(message) : []))
        .finally(() => {
          pendingChat--;
        });
      queue = next.catch(() => undefined);
      return next;
    },
    /**
     * Route a linked redemption through admission and budgets. Null means it never reached
     * a live engine (stopped, panicked, not live); the caller refunds per host policy.
     */
    handleRedemption(input: LiveRedemption): Promise<ExecutionDecision | null> {
      if (closed || panic) return Promise.resolve(null);
      const fence = generation;
      const next = queue.then(() =>
        fence === generation && !closed && !panic ? processRedemption(input) : null,
      );
      queue = next.catch(() => undefined);
      return next;
    },
    tick(): Promise<void> {
      const fence = generation;
      const next = queue.then(async () => {
        if (fence !== generation || panic || closed) return;
        for (const [automationId, { engine, version }] of engines) {
          if (experienceOf(version)) sessions.tick(automationId, engine);
        }
        await fireTimers(fence);
        await applyPending();
      });
      queue = next.catch(() => undefined);
      return next;
    },
    /** Queue reviewed activation with chat/ticks; preparation completes before commit. */
    activateTransition(id: string): Promise<boolean> {
      if (transitionJobs >= 8)
        return Promise.reject(
          new SessionConfigurationError('The activation queue is full. Try again shortly.'),
        );
      transitionJobs++;
      const next = queue.then(() => applyTransition(id));
      queue = next.catch(() => undefined);
      return next.finally(() => {
        transitionJobs--;
      });
    },
    /** Pending named timers for the console. */
    timers(automationId?: string) {
      return timers.views(automationId);
    },
    /** Creator cancellation, serialized with chat and fires so it never races a delivery. */
    cancelTimer(automationId: string, name: string): Promise<number> {
      const next = queue.then(() =>
        timers.cancel(automationId, 'cancelled from the console', name),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    /** Read-only: replays the round journal privately; never touches engines or the overlay. */
    auditSession(automationId: string) {
      return sessions.audit(automationId);
    },
    prepareActivation(version: VersionRow, resetSession = false) {
      repo.invalidateTransitions(version.automationId);
      sessions.configure(version, resetSession);
      generation++;
    },
    resetSession(automationId: string, version: VersionRow) {
      repo.assertVersionLineage(version.id);
      overlay.invalidatePresentation();
      generation++;
      stop(automationId);
      repo.atomic(() => {
        repo.assertVersionLineage(version.id);
        repo.invalidateTransitions(automationId);
        sessions.reset(version);
      });
      if (!panic && repo.automation(automationId)?.status === 'live') start(automationId, version);
      refreshInstructions();
      return repo.session(automationId)?.snapshot ?? null;
    },
    close() {
      closed = true;
      generation++;
      clearInterval(timer);
      for (const { engine } of engines.values()) engine.stop();
      engines.clear();
    },
  };
  const timer = setInterval(
    () =>
      void api.tick().catch(() => {
        api.panic('session timer storage failure');
      }),
    250,
  );
  timer.unref();
  return api;
}
export type LiveRuntime = ReturnType<typeof createLiveRuntime>;
