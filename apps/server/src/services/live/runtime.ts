import { createSessionControl, experienceOf, sessionSeed } from './sessions.js';
import {
  createAdmissionState,
  createEngine,
  eventSchema,
  type AdmissionState,
  type ExecutionEngine,
} from '@riff/sandbox';
import {
  EFFECT_LIMITS,
  type ChatEvent,
  type PermissionManifest,
  type ExecutionDecision,
} from '@riff/sdk';
import { describeWindow, describeAudience } from '@riff/compiler';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { Hub } from '../hub.js';
import type { OverlayBroker } from '../overlay/broker.js';

/** Incoming chat, already normalized from an authenticated transport. */
export interface LiveChatMessage extends Omit<ChatEvent, 'at'> {
  viewerName: string;
  source: 'twitch';
}
const PANIC_COMMAND = '!riff panic';

/**
 * The live control plane for one channel. Panic flips an in-memory flag first and
 * persists second, so it works even when the database write path is degraded.
 */
export function createLiveRuntime(deps: {
  repo: ChannelRepository;
  hub: Hub;
  overlay: OverlayBroker;
  now?: () => number;
}) {
  const { repo, hub, overlay } = deps;
  const now = deps.now ?? Date.now;
  const sessions = createSessionControl({ repo, hub, overlay, now });
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const engines = new Map<string, { engine: ExecutionEngine; version: VersionRow }>();
  // Admission counters live per automation, not per version: edits and rollbacks
  // never hand a viewer a fresh allowance.
  const admissions = new Map<string, AdmissionState>();
  const channelBudget = { effects: [] as number[], perMinute: EFFECT_LIMITS.perMinute };
  let panic = false;
  let generation = 0;
  let lastAt = 0;
  let lastEvent: { at: number; viewer: string; code: string } | null = null;

  const admissionFor = (automationId: string) => {
    let state = admissions.get(automationId);
    if (!state) admissions.set(automationId, (state = createAdmissionState()));
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
      const who = t.audience.includes('viewer') ? '' : ` (${describeAudience(t.audience)})`;
      const experience = experienceOf(version);
      if (!experience)
        return `Type ${t.command} in chat${who} · ${t.maxPerViewer} per ${describeWindow(t.windowMs)}`;
      // Rounds spend a lifetime allowance and may need a team first; never imply a
      // rolling window or let a late viewer type a command that is rejected.
      const { teams, contribution, resource, objective } = experience;
      const each = `${resource.perParticipant} ${resource.name} each this round`;
      return teams.length
        ? `Type ${teams
            .map((team) => team.joinCommand)
            .join(', ')
            .replace(
              /, ([^,]*)$/,
              ' or $1',
            )} to join a team${who}, then ${contribution.command} · ${each}`
        : `Type ${contribution.command}${who} to help reach ${objective.target ?? ''} together · ${each}`;
    });
    overlay.setInstructions(panic ? [] : lines);
    sessions.publish(panic);
  }
  function quarantine(automationId: string, version: VersionRow, fault: string) {
    engines.get(automationId)?.engine.stop();
    engines.delete(automationId);
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
    engines.get(automationId)?.engine.stop();
    const stored = experienceOf(version) ? sessions.recover(version) : null;
    const engine = createEngine(
      { source: version.source, manifest: version.manifest },
      {
        seed: stored ? sessionSeed(stored.id) : (now() % 0xfffffff) + 1,
        mode: 'live',
        ...(stored ? { session: stored.snapshot } : { admission: admissionFor(automationId) }),
        channelBudget,
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
    const text = message.text.trim().toLowerCase();
    if (text === PANIC_COMMAND || text.startsWith(`${PANIC_COMMAND} `)) {
      if (message.roles.includes('broadcaster') || message.roles.includes('moderator'))
        api.panic(`!riff panic by ${message.viewerName}`);
      return [];
    }
    if (panic) return [];
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
        } else decision = await engine.dispatch(event.data);
      } catch {
        generation++;
        engine.stop();
        engines.delete(automationId);
        try {
          repo.updateAutomation(automationId, { status: 'paused' });
          sessions.pause(automationId);
        } catch {
          /* memory fence already applied */
        }
        refreshInstructions();
        hub.publish('studio', null);
        decision = {
          eventId: event.data.id,
          artifactId: engine.artifactId,
          mode: 'live',
          code: 'STOPPED',
          reason:
            'Session storage failed; progress and effects were not committed. Resume to retry.',
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
            : overlay.deliver(decision, message.viewerName)
          : 0;
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
            ? `${message.viewerName} used ${(version.manifest as PermissionManifest).trigger.command} · ${delivered} effect${delivered === 1 ? '' : 's'} sent to the overlay`
            : decision.reason,
      });
    }
    return results;
  }

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
      if (panic) return;
      for (const automation of repo.automations()) {
        if (automation.status !== 'live' || !automation.activeVersionId) continue;
        const version = repo.version(automation.activeVersionId);
        if (version?.status === 'active') start(automation.id, version);
      }
    },
    /** Swap to an approved version with a generation fence; in-flight old work is discarded. */
    activate(automationId: string, version: VersionRow) {
      generation++;
      if (!panic) start(automationId, version);
    },
    pause(automationId: string) {
      generation++;
      stop(automationId);
      sessions.pause(automationId);
      overlay.clear('pause');
      refreshInstructions();
    },
    resumeAutomation(automationId: string, version: VersionRow) {
      if (!panic) {
        sessions.resume(automationId);
        start(automationId, version);
      }
    },
    panic(source: string) {
      panic = true; // in-memory first: nothing below can delay the stop
      generation++;
      for (const { engine } of engines.values()) engine.stop();
      engines.clear();
      overlay.clear('panic');
      overlay.setInstructions([]);
      const panicAt = now();
      try {
        repo.updateState({ panic: true, panicAt });
      } catch {
        /* Remain stopped in memory. */
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
        for (const automation of repo.automations()) {
          if (automation.status !== 'live') continue;
          const current = repo.session(automation.id);
          if (current?.snapshot.phase === 'running' && panicAt !== null)
            sessions.pause(automation.id, panicAt);
          sessions.resume(automation.id);
        }
        repo.updateState({ panic: false, panicAt: null });
      });
      panic = false;
      publishActivity({
        at: Date.now(),
        kind: 'control',
        automationId: null,
        versionId: null,
        eventId: null,
        viewer: null,
        code: 'RESUME',
        message: 'Channel resumed. Live automations are running again.',
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
      const text = message.text.trim().toLowerCase();
      if (text === PANIC_COMMAND || text.startsWith(`${PANIC_COMMAND} `)) {
        if (message.roles.includes('broadcaster') || message.roles.includes('moderator'))
          this.panic(`!riff panic by ${message.viewerName}`);
        return Promise.resolve([]);
      }
      const fence = generation;
      const next = queue.then(() => (fence === generation && !closed ? processChat(message) : []));
      queue = next.catch(() => undefined);
      return next;
    },
    tick(): Promise<void> {
      const fence = generation;
      const next = queue.then(() => {
        if (fence !== generation || panic || closed) return;
        for (const [automationId, { engine, version }] of engines) {
          if (experienceOf(version)) sessions.tick(automationId, engine);
        }
      });
      queue = next.catch(() => undefined);
      return next;
    },
    /** Read-only: replays the round journal privately; never touches engines or the overlay. */
    auditSession(automationId: string) {
      return sessions.audit(automationId);
    },
    prepareActivation(version: VersionRow, resetSession = false) {
      sessions.configure(version, resetSession);
      generation++;
    },
    resetSession(automationId: string, version: VersionRow) {
      generation++;
      stop(automationId);
      repo.atomic(() => sessions.reset(version));
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
