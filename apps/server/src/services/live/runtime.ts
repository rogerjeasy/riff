import {
  createAdmissionState,
  createEngine,
  eventSchema,
  type AdmissionState,
  type ExecutionEngine,
} from '@riff/sandbox';
import { EFFECT_LIMITS, type ChatEvent, type PermissionManifest } from '@riff/sdk';
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
}) {
  const { repo, hub, overlay } = deps;
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
      return `Type ${t.command} in chat${who} · ${t.maxPerViewer} per ${describeWindow(t.windowMs)}`;
    });
    overlay.setInstructions(panic ? [] : lines);
  }
  function quarantine(automationId: string, version: VersionRow, fault: string) {
    engines.get(automationId)?.engine.stop();
    engines.delete(automationId);
    try {
      repo.updateVersion(version.id, { status: 'quarantined', incident: fault });
      repo.updateAutomation(automationId, { status: 'paused' });
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
    const engine = createEngine(
      { source: version.source, manifest: version.manifest },
      {
        seed: (Date.now() % 0xfffffff) + 1,
        mode: 'live',
        admission: admissionFor(automationId),
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

  return {
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
    },
    resumeAutomation(automationId: string, version: VersionRow) {
      if (!panic) start(automationId, version);
    },
    panic(source: string) {
      panic = true; // in-memory first: nothing below can delay the stop
      generation++;
      for (const { engine } of engines.values()) engine.stop();
      engines.clear();
      overlay.clear('panic');
      overlay.setInstructions([]);
      try {
        repo.updateState({ panic: true, panicAt: Date.now() });
      } catch {
        /* Remain stopped even if persistence fails. */
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
      repo.updateState({ panic: false, panicAt: null });
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
        if (version?.status === 'active') start(automation.id, version);
      }
      hub.publish('studio', null);
    },
    /** Route one authenticated chat message through every live automation. */
    async handleChat(message: LiveChatMessage) {
      const text = message.text.trim().toLowerCase();
      if (text === PANIC_COMMAND || text.startsWith(`${PANIC_COMMAND} `)) {
        if (message.roles.includes('broadcaster') || message.roles.includes('moderator'))
          this.panic(`!riff panic by ${message.viewerName}`);
        return [];
      }
      if (panic) return [];
      lastAt = Math.max(lastAt + 1, Date.now());
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
        const decision = await engine.dispatch(event.data);
        results.push(decision);
        if (decision.code === 'UNRELATED') continue;
        if (decision.code === 'INCIDENT') {
          quarantine(automationId, version, engine.incident?.fault ?? 'execution incident');
          continue;
        }
        // A generation change (panic, swap, pause) while the handler ran fences its effects.
        const delivered =
          fence === generation && !panic ? overlay.deliver(decision, message.viewerName) : 0;
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
    },
    close() {
      for (const { engine } of engines.values()) engine.stop();
      engines.clear();
    },
  };
}
export type LiveRuntime = ReturnType<typeof createLiveRuntime>;
