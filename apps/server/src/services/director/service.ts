import { randomUUID } from 'node:crypto';
import type {
  DirectorEnvelope,
  DirectorFrame,
  DirectorMode,
  DirectorSettings,
  DirectorState,
  ExecutionDecision,
} from '@riff/sdk';
import { artifactIdentity, RehearsalError } from '@riff/sandbox';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import type { directorRepository, StoredDirector } from '../../db/repositories/director.js';
import { directorDigest, directorEnvelopeSchema, DirectorError } from './contract.js';
import { createDirectorPolicy, type DirectorPolicy } from './policy.js';
import { rehearseDirector } from './rehearsal.js';
const HISTORY_LIMIT = 50;
export type PresentationClear = 'panic' | 'pause' | 'rotate' | 'reset';
const CLEAR_REASONS: Record<PresentationClear, string> = {
  panic: 'Emergency stop: queued effects were cleared and presentation is stopped.',
  pause: 'The interaction was paused; queued effects were cleared.',
  rotate: 'The overlay key was rotated; queued effects were cleared.',
  reset: 'The live version or round changed; queued effects from before were cleared.',
};
/** Channel-local presentation authority; generated code cannot control it. */
export function createDirectorService(deps: {
  storage: ReturnType<typeof directorRepository>;
  repo: ChannelRepository;
  blocked: () => boolean;
  emit: (frame: DirectorFrame) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const initial: StoredDirector = {
    revision: 0,
    draft: null,
    approved: null,
    enabled: false,
    mode: 'balanced',
    settings: null,
    history: [],
  };
  let state = deps.storage.get() ?? initial;
  let policy: DirectorPolicy | null = null;
  try {
    policy = state.approved ? createDirectorPolicy(state.approved.envelope) : null;
    // A stopped latch is never recovered from a persisted enabled flag. Explicit control is required.
    if (policy && state.settings) {
      policy.configure('manual', state.settings);
      policy.configure(state.mode, state.mode === 'manual' ? state.settings : undefined);
    }
  } catch {
    // Unreadable stored settings fail closed: presentation stays stopped until a new approval.
    policy = null;
    state = { ...state, approved: null, enabled: false, mode: 'balanced', settings: null };
  }
  let enabled = false,
    closed = false;
  let active: AbortController | null = null;
  const pendingContext = new Map<
    string,
    { automationId: string; versionId: string; roundId: string | null }
  >();
  const view = (): DirectorState => {
    const telemetry = policy?.snapshot() ?? null;
    return structuredClone({ ...state, enabled, settings: telemetry?.settings ?? null, telemetry });
  };
  function current(expected: number) {
    if (closed || expected !== state.revision || expected !== (deps.storage.get()?.revision ?? 0))
      throw new DirectorError('STALE', 'Director settings changed. Reload before continuing.');
  }
  function commit(next: StoredDirector) {
    deps.storage.save(state.revision, next);
    state = next;
  }
  function allowed() {
    if (closed || deps.blocked())
      throw new DirectorError('BLOCKED', 'Resume the channel before enabling presentation.');
  }
  function clear(reason: string) {
    policy?.clear(reason, now());
    pendingContext.clear();
  }
  function valid(frame: DirectorFrame) {
    const context = pendingContext.get(frame.id);
    if (!context) return false;
    const automation = deps.repo.automation(context.automationId);
    const version = deps.repo.version(context.versionId);
    const session = deps.repo.session(context.automationId);
    return (
      automation?.status === 'live' &&
      automation.activeVersionId === context.versionId &&
      version?.status === 'active' &&
      (!context.roundId || (session?.id === context.roundId && session.snapshot.phase !== 'paused'))
    );
  }
  const api = {
    view,
    /** Approved participation policy while presentation is enabled; null otherwise. */
    participation() {
      return enabled && state.approved && !closed ? state.approved.envelope.participation : null;
    },
    save(expected: number, raw: DirectorEnvelope) {
      current(expected);
      const parsed = directorEnvelopeSchema.safeParse(raw);
      if (!parsed.success)
        throw new DirectorError(
          'INVALID',
          'Invalid presentation envelope. Gameplay rules require behavior review.',
        );
      const revision = (state.history.at(-1)?.revision ?? 0) + 1;
      // History is bounded by dropping the oldest revisions; the approved one is always kept.
      const history = [...state.history];
      while (history.length >= HISTORY_LIMIT) {
        const index = history.findIndex((item) => item.revision !== state.approved?.revision);
        history.splice(index, 1);
      }
      const draft = {
        revision,
        digest: directorDigest(parsed.data),
        envelope: parsed.data,
        evidence: null,
      };
      commit({
        ...state,
        revision: state.revision + 1,
        draft,
        history: [...history, { revision, digest: draft.digest, envelope: parsed.data }],
      });
      return view();
    },
    async rehearse(expected: number, versionId: string) {
      current(expected);
      if (!state.draft) throw new DirectorError('BLOCKED', 'Save an envelope before rehearsing.');
      if (active) throw new DirectorError('BUSY', 'A director rehearsal is already running.');
      const version = deps.repo.version(versionId);
      if (!version) throw new DirectorError('NOT_FOUND', 'Choose a version from this channel.');
      const draft = structuredClone(state.draft);
      const controller = new AbortController();
      active = controller;
      const timer = setTimeout(() => controller.abort(), 60_000);
      timer.unref();
      try {
        let evidence;
        try {
          evidence = await rehearseDirector(version, draft.envelope, controller.signal);
        } catch (error) {
          if (
            controller.signal.aborted ||
            (error instanceof RehearsalError && error.code === 'ABORTED')
          )
            throw new DirectorError(
              'BLOCKED',
              closed
                ? 'The server is shutting down; the private stress test stopped.'
                : 'The private stress test stopped before it finished (stop, emergency stop or the 60 s limit). Run it again.',
            );
          throw error;
        }
        current(expected);
        commit({ ...state, revision: state.revision + 1, draft: { ...draft, evidence } });
        return view();
      } finally {
        clearTimeout(timer);
        if (active === controller) active = null;
      }
    },
    approve(expected: number, digest: string, evidenceHash: string) {
      current(expected);
      allowed();
      const draft = state.draft,
        evidence = draft?.evidence;
      const version = evidence ? deps.repo.version(evidence.versionId) : undefined;
      if (
        !draft ||
        draft.digest !== digest ||
        !evidence?.passed ||
        evidence.hash !== evidenceHash ||
        evidence.digest !== digest ||
        !version ||
        artifactIdentity({ source: version.source, manifest: version.manifest }) !==
          evidence.artifactId
      )
        throw new DirectorError(
          'BLOCKED',
          'Approval needs the exact saved envelope and passing private rehearsal evidence.',
        );
      const next = createDirectorPolicy(draft.envelope);
      const approved = {
        revision: draft.revision,
        digest,
        envelope: draft.envelope,
        evidenceHash,
        approvedAt: now(),
      };
      commit({
        ...state,
        revision: state.revision + 1,
        approved,
        enabled: true,
        mode: 'balanced',
        settings: next.snapshot().settings,
      });
      clear('A new approved envelope replaced the presentation queue.');
      policy = next;
      enabled = true;
      return view();
    },
    control(expected: number, mode: DirectorMode, settings?: DirectorSettings) {
      current(expected);
      allowed();
      if (!policy || !state.approved)
        throw new DirectorError('BLOCKED', 'Approve a rehearsed envelope first.');
      // Validate on a separate policy before mutating the running instance or storage.
      const trial = createDirectorPolicy(state.approved.envelope);
      trial.configure('manual', policy.snapshot().settings);
      trial.configure(mode, settings);
      commit({
        ...state,
        revision: state.revision + 1,
        enabled: true,
        mode,
        settings: trial.snapshot().settings,
      });
      policy.configure(mode, settings);
      enabled = true;
      return view();
    },
    stop() {
      enabled = false;
      clear('Creator stopped presentation; accepted gameplay is unchanged.');
      active?.abort();
      commit({ ...state, revision: state.revision + 1, enabled: false });
      return view();
    },
    clear(reason: PresentationClear) {
      if (reason === 'panic') {
        // Memory stop precedes every persistence dependency.
        enabled = false;
        active?.abort();
      }
      clear(CLEAR_REASONS[reason]);
      if (reason === 'panic') {
        try {
          commit({ ...state, revision: state.revision + 1, enabled: false });
        } catch {
          /* Remains stopped in memory. */
        }
      }
    },
    submit(
      decision: ExecutionDecision,
      viewer: string | null,
      automationId?: string,
      versionId?: string,
    ) {
      if (decision.mode !== 'live')
        throw new DirectorError('BLOCKED', 'Private replay cannot reach live destinations.');
      if (decision.code !== 'ACCEPTED' || closed || deps.blocked()) return 0;
      // Until the first approval the existing immediate delivery path stays in use.
      if (!state.approved) return null;
      if (!enabled || !policy || !automationId || !versionId) return 0;
      const roundId = deps.repo.session(automationId)?.id ?? null;
      const effects = decision.effects.map((effect) => ({
        id: randomUUID(),
        asset: effect.asset,
        x: effect.x,
        viewer,
        automationId,
        versionId,
      }));
      const at = now();
      // The map covers only this bounded queue; no viewer identity leaves the service.
      policy.enqueue({
        key: JSON.stringify([automationId, roundId, decision.eventId]),
        viewerId: decision.viewerId ?? 'anonymous',
        roundId: roundId ?? versionId,
        at,
        effects,
      });
      const ids = new Set(policy.pendingIds());
      for (const id of pendingContext.keys()) if (!ids.has(id)) pendingContext.delete(id);
      for (const effect of effects)
        if (ids.has(effect.id)) pendingContext.set(effect.id, { automationId, versionId, roundId });
      return effects.length;
    },
    tick() {
      const approved = state.approved;
      if (!enabled || !policy || !approved || closed || deps.blocked()) return;
      let selected: DirectorFrame[] = [];
      try {
        const frames = policy.tick(now());
        for (const frame of frames) {
          if (valid(frame)) selected.push(frame);
          else
            policy.discard(
              1,
              'Queued effect cleared because its live version or round is no longer current.',
            );
        }
        if (selected.length) {
          if (deps.storage.claimBatch(now(), approved.envelope.interruptionsPerMinute)) {
            const ready = selected;
            selected = [];
            for (const frame of ready) deps.emit(frame);
          } else {
            policy.discard(
              selected.length,
              'The durable interruption limit is reached; cosmetics suppressed, gameplay unchanged.',
            );
            selected = [];
          }
        }
        if (policy.pendingCount() === 0) pendingContext.clear();
      } catch {
        policy.discard(selected.length, 'Presentation could not verify its durable budget.');
        enabled = false;
        clear('Presentation stopped because current authority could not be checked.');
      }
    },
    close() {
      closed = true;
      enabled = false;
      active?.abort();
      clear('Server stopped.');
    },
  };
  return api;
}
export type DirectorService = ReturnType<typeof createDirectorService>;
