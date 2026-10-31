import { createHash, randomUUID } from 'node:crypto';
import {
  advanceSession,
  createSessionSnapshot,
  pauseSession,
  resumeSession,
  sessionDefinitionSchema,
  sessionSnapshotSchema,
  type ExecutionEngine,
} from '@riff/sandbox';
import type {
  ChatEvent,
  ExecutionDecision,
  ExperienceDefinition,
  PermissionManifest,
} from '@riff/sdk';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { Hub } from '../hub.js';
import type { OverlayBroker } from '../overlay/broker.js';

export class SessionConfigurationError extends Error {}
export const experienceOf = (version: VersionRow) => {
  const definition = (version.manifest as PermissionManifest).experience;
  return definition ? sessionDefinitionSchema.parse(definition) : null;
};
const sameDefinition = (a: ExperienceDefinition, b: ExperienceDefinition) =>
  JSON.stringify(sessionDefinitionSchema.parse(a)) ===
  JSON.stringify(sessionDefinitionSchema.parse(b));
export function sessionSeed(id: string) {
  return createHash('sha256').update(id).digest().readUInt32LE() || 1;
}

/** Durable semantic state. No guest work or external effects run in a transaction. */
export function createSessionControl(deps: {
  repo: ChannelRepository;
  overlay: OverlayBroker;
  hub: Hub;
  now: () => number;
}) {
  const { repo, overlay, hub, now } = deps;
  const notify = () => hub.publish('studio', null);
  const requiredSession = (automationId: string) => {
    const row = repo.session(automationId);
    if (!row) throw new Error('Session storage is unavailable');
    return row;
  };
  function configure(version: VersionRow, reset = false) {
    const definition = experienceOf(version);
    const current = repo.session(version.automationId);
    if (current && (!definition || !sameDefinition(current.definition, definition)) && !reset)
      throw new SessionConfigurationError(
        'This change alters session rules. Confirm an explicit session reset to replace progress and resources.',
      );
    if (!definition) {
      if (current) repo.removeSession(version.automationId);
      return null;
    }
    if (!current || reset) {
      const snapshot = createSessionSnapshot(definition, now(), randomUUID());
      repo.replaceSession({
        automationId: version.automationId,
        versionId: version.id,
        definition,
        snapshot,
      });
    } else if (current.versionId !== version.id) {
      repo.updateSessionControl(
        version.automationId,
        resumeSession(current.snapshot, now()),
        version.id,
      );
    }
    return requiredSession(version.automationId);
  }
  function publish(panicked = false) {
    overlay.setSessions(
      panicked
        ? []
        : repo.sessions().flatMap((row) => {
            const automation = repo.automation(row.automationId);
            const version = repo.version(row.versionId);
            if (
              !automation ||
              automation.activeVersionId !== row.versionId ||
              !version ||
              !experienceOf(version)
            )
              return [];
            return [
              {
                automationId: row.automationId,
                title: automation.title,
                definition: row.definition,
                snapshot: sessionSnapshotSchema.parse(row.snapshot),
              },
            ];
          }),
    );
  }
  function pause(automationId: string, at = now()) {
    const current = repo.session(automationId);
    if (current)
      repo.updateSessionControl(
        automationId,
        pauseSession(
          current.snapshot,
          Math.max(at, current.snapshot.updatedAt),
          current.definition,
        ),
      );
  }
  function resume(automationId: string) {
    const current = repo.session(automationId);
    if (current) repo.updateSessionControl(automationId, resumeSession(current.snapshot, now()));
  }
  function recover(version: VersionRow) {
    const current = configure(version);
    if (!current) return null;
    const snapshot = advanceSession(current.snapshot, now(), current.definition);
    if (JSON.stringify(snapshot) !== JSON.stringify(current.snapshot))
      repo.updateSessionControl(version.automationId, snapshot);
    // Old effects are cosmetic and never replay after recovery. HUD is authoritative.
    for (const pending of repo.sessionOutbox(version.automationId))
      repo.claimSessionEffect(pending.id);
    return requiredSession(version.automationId);
  }
  function drain(automationId: string, valid: () => boolean) {
    let sent = 0;
    for (const pending of repo.sessionOutbox(automationId)) {
      const current = repo.session(automationId);
      const automation = repo.automation(automationId);
      // Claim before dispatch provides at-most-once cosmetic delivery. It does not
      // claim exactly-once delivery across process/network failure.
      if (!repo.claimSessionEffect(pending.id)) continue;
      if (
        !valid() ||
        current?.id !== pending.sessionId ||
        current.versionId !== pending.versionId ||
        automation?.activeVersionId !== pending.versionId ||
        automation.status !== 'live' ||
        current.snapshot.phase === 'paused' ||
        pending.at < now() - 2000
      )
        continue;
      sent += overlay.deliver(pending.decision, pending.viewer);
    }
    return sent;
  }
  return {
    configure,
    publish,
    pause,
    resume,
    recover,
    reset(version: VersionRow) {
      const result = configure(version, true);
      if (repo.automation(version.automationId)?.status === 'paused') pause(version.automationId);
      notify();
      return result;
    },
    async process(
      version: VersionRow,
      engine: ExecutionEngine,
      event: ChatEvent,
      viewer: string,
      valid: () => boolean,
    ) {
      const original = repo.session(version.automationId);
      if (!original) throw new Error('Missing durable session');
      engine.restoreSession(original.snapshot);
      if (repo.hasAutomationEvent(version.automationId, event.id)) {
        const decision: ExecutionDecision = {
          eventId: event.id,
          artifactId: engine.artifactId,
          mode: 'live',
          code: 'DUPLICATE',
          reason: 'This event was already processed for this interaction.',
          effects: [],
          viewerId: event.viewerId,
          at: event.at,
          allowance: null,
          session: original.snapshot,
        };
        return { decision, delivered: 0 };
      }
      const decision = await engine.dispatch(event);
      if (!valid())
        return {
          decision: {
            ...decision,
            code: 'STOPPED' as const,
            reason: 'Session changed while this event was running.',
            effects: [],
            session: repo.session(version.automationId)?.snapshot ?? original.snapshot,
          },
          delivered: 0,
        };
      const next = engine.session;
      if (!next || decision.code === 'INCIDENT') return { decision, delivered: 0 };
      const changed = JSON.stringify(next) !== JSON.stringify(original.snapshot);
      if (decision.code === 'UNRELATED' && !changed) return { decision, delivered: 0 };
      try {
        const committed = repo.commitSession({
          automationId: version.automationId,
          versionId: version.id,
          expectedRevision: original.revision,
          snapshot: next,
          event,
          decision,
          viewer,
        });
        if (!committed) throw new Error('Session revision changed before commit');
      } catch {
        engine.restoreSession(original.snapshot);
        throw new Error('Session storage failed; the contribution and its effects were discarded.');
      }
      // State and identity are already committed. Cosmetic delivery or subscriber
      // failures must never rewind progress or report the contribution as lost.
      let delivered = 0;
      let cosmeticFailure = false;
      try {
        delivered = drain(version.automationId, valid);
      } catch {
        cosmeticFailure = true;
      }
      try {
        publish();
        notify();
      } catch {
        cosmeticFailure = true;
      }
      return {
        decision: cosmeticFailure
          ? {
              ...decision,
              reason: 'Progress committed; cosmetic overlay delivery is temporarily unavailable.',
            }
          : decision,
        delivered,
      };
    },
    tick(automationId: string, engine: ExecutionEngine) {
      const current = repo.session(automationId);
      if (!current || current.snapshot.phase !== 'running') return;
      const next = advanceSession(current.snapshot, now(), current.definition);
      if (JSON.stringify(next) === JSON.stringify(current.snapshot)) return;
      if (
        repo.commitSession({
          automationId,
          versionId: current.versionId,
          expectedRevision: current.revision,
          snapshot: next,
        })
      ) {
        engine.restoreSession(next);
        publish();
        notify();
      }
    },
  };
}
