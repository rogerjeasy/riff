import {
  SessionAuditBusyError,
  SessionConfigurationError,
  experienceOf,
} from '../live/sessions.js';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { Hub } from '../hub.js';
import type { LiveRuntime } from '../live/runtime.js';
import type { OverlayBroker } from '../overlay/broker.js';
import { approvalBlockers, versionView, type Evidence } from './views.js';
import { PRESERVING_MIGRATION_SOURCE } from '@riff/compiler';

import { StudioError } from './errors.js';
import { createTransitionService } from './transitions.js';
export { StudioError };

/** Approval, activation, pause, rollback and emergency stop for one channel. */
export function createStudioService(deps: {
  repo: ChannelRepository;
  hub: Hub;
  runtime: LiveRuntime;
  overlay: OverlayBroker;
}) {
  const { repo, hub, runtime } = deps;
  const changed = () => hub.publish('studio', null);
  const transitions = createTransitionService(repo, runtime, changed);
  const control = (
    message: string,
    automationId: string | null,
    versionId: string | null,
    code: string,
  ) =>
    hub.publish(
      'activity',
      repo.record({
        at: Date.now(),
        kind: 'control',
        automationId,
        versionId,
        eventId: null,
        viewer: null,
        code,
        message,
      }),
    );
  const mustVersion = (id: string) => {
    const version = repo.version(id);
    if (!version) throw new StudioError('NOT_FOUND', 'That version no longer exists.');
    return version;
  };
  const mustAutomation = (id: string) => {
    const automation = repo.automation(id);
    if (!automation) throw new StudioError('NOT_FOUND', 'That interaction no longer exists.');
    return automation;
  };
  const activeOf = (automationId: string) => {
    const automation = repo.automation(automationId);
    return automation?.activeVersionId ? repo.version(automation.activeVersionId) : undefined;
  };

  function goLive(version: VersionRow, reason: 'approve' | 'rollback', resetSession = false) {
    try {
      repo.atomic(() => {
        runtime.prepareActivation(version, resetSession);
        repo.activate(version.automationId, version.id);
      });
    } catch (error) {
      if (error instanceof SessionConfigurationError)
        throw new StudioError('BLOCKED', error.message);
      throw error;
    }
    const fresh = mustVersion(version.id);
    runtime.activate(version.automationId, fresh);
    control(
      reason === 'approve'
        ? `Approved and activated “${version.title}” v${version.number} (${version.artifactId?.slice(0, 12)}).`
        : `Rolled back “${version.title}” to v${version.number}. Viewer allowances were kept.`,
      version.automationId,
      version.id,
      reason === 'approve' ? 'APPROVED' : 'ROLLBACK',
    );
    changed();
    return fresh;
  }

  return {
    previewTransition(
      versionId: string,
      input: Omit<Parameters<typeof transitions.preview>[1], 'migrationSource'> & {
        migrationSource?: string | undefined;
      },
    ) {
      const version = mustVersion(versionId);
      const generated = (version.evidence as Partial<Evidence>).migration;
      return transitions.preview(version, {
        ...input,
        migrationSource: input.migrationSource ?? generated?.source ?? PRESERVING_MIGRATION_SOURCE,
      });
    },
    approveTransition: transitions.approve,
    cancelTransition: transitions.cancel,
    snapshot() {
      const state = repo.state();
      const automations = repo.automations().map((automation) => {
        const versions = repo.versions(automation.id);
        const active = versions.find((v) => v.id === automation.activeVersionId);
        return {
          ...automation,
          transitions: repo.transitions(automation.id),
          session:
            active && experienceOf(active) ? (repo.session(automation.id)?.snapshot ?? null) : null,
          versions: versions.map((v) => versionView(v, active, runtime.panicked)),
          canRollback: versions.some((v) => v.status === 'superseded' && v.approvedAt),
        };
      });
      return {
        panic: runtime.panicked,
        panicAt: state.panicAt,
        overlay: { connections: deps.overlay.connections },
        running: runtime.running(),
        lastEvent: runtime.lastEvent,
        automations,
        activity: repo.activity(40),
      };
    },
    /**
     * Activate exactly the reviewed artifact. The caller must echo the artifact hash it
     * reviewed and the active version it expects to replace; anything stale is refused.
     */
    approve(
      versionId: string,
      expected: { artifactId: string; activeVersionId: string | null; resetSession?: boolean },
    ) {
      const version = mustVersion(versionId);
      const blockers = approvalBlockers(version, runtime.panicked);
      if (blockers.length) throw new StudioError('BLOCKED', blockers.join(' '));
      if (version.artifactId !== expected.artifactId)
        throw new StudioError('STALE', 'This is not the version you reviewed. Review it again.');
      const automation = mustAutomation(version.automationId);
      if (automation.activeVersionId !== expected.activeVersionId)
        throw new StudioError(
          'STALE',
          'The live version changed while you were reviewing. Review the new difference first.',
        );
      return goLive(version, 'approve', expected.resetSession);
    },
    pause(automationId: string) {
      const automation = mustAutomation(automationId);
      runtime.pause(automation.id);
      repo.updateAutomation(automation.id, { status: 'paused' });
      control(`Paused “${automation.title}”.`, automation.id, automation.activeVersionId, 'PAUSED');
      changed();
    },
    resumeAutomation(automationId: string) {
      const automation = mustAutomation(automationId);
      const active = activeOf(automation.id);
      if (!active || active.status !== 'active')
        throw new StudioError(
          'BLOCKED',
          'There is no healthy approved version to resume. Roll back or approve a new version.',
        );
      repo.updateAutomation(automation.id, { status: 'live' });
      runtime.resumeAutomation(automation.id, active);
      control(
        `Resumed “${automation.title}” v${active.number}.`,
        automation.id,
        active.id,
        'RESUMED',
      );
      changed();
    },
    /** Activate the most recent previously approved version; with none, pause instead. */
    rollback(automationId: string, resetSession = false) {
      const automation = mustAutomation(automationId);
      const previous = repo
        .versions(automation.id)
        .find(
          (v) =>
            v.id !== automation.activeVersionId &&
            v.approvedAt &&
            ['superseded', 'approved'].includes(v.status),
        );
      if (!previous) {
        this.pause(automation.id);
        return null;
      }
      if (runtime.panicked)
        throw new StudioError('BLOCKED', 'Everything is stopped. Resume the channel first.');
      return goLive(previous, 'rollback', resetSession);
    },
    async auditSession(automationId: string) {
      mustAutomation(automationId);
      try {
        const audit = await runtime.auditSession(automationId);
        if (!audit)
          throw new StudioError('NOT_FOUND', 'This interaction has no session round to audit.');
        return audit;
      } catch (error) {
        if (error instanceof SessionAuditBusyError)
          throw new StudioError('BLOCKED', 'A round audit is already running. Try again shortly.');
        throw error;
      }
    },
    resetSession(automationId: string) {
      const automation = mustAutomation(automationId);
      const version = activeOf(automation.id);
      if (runtime.panicked || !version || version.status !== 'active' || !experienceOf(version))
        throw new StudioError(
          'BLOCKED',
          'Resume the channel and select a healthy approved stateful experience before resetting.',
        );
      const snapshot = runtime.resetSession(automationId, version);
      control(
        'Started a new session after explicit reset; previous scores and resources were cleared.',
        automationId,
        version.id,
        'SESSION_RESET',
      );
      changed();
      return snapshot;
    },
    discard(versionId: string) {
      const version = mustVersion(versionId);
      if (version.status !== 'candidate' && version.status !== 'failed')
        throw new StudioError('BLOCKED', 'Only unapproved candidates can be discarded.');
      repo.atomic(() => {
        repo.updateVersion(version.id, { status: 'discarded' });
        repo.invalidateTransitions(version.automationId);
      });
      changed();
    },
    panic(source: string) {
      runtime.panic(source);
    },
    resume() {
      runtime.resume();
    },
  };
}
export type StudioService = ReturnType<typeof createStudioService>;
