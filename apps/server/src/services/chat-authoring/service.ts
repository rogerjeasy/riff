import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PermissionManifest } from '@riff/sdk';
import type { ChatAuthoringRepository } from '../../db/repositories/chat-authoring.js';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import type { AuthoringService, RunSnapshot } from '../authoring/service.js';
import { versionView } from '../automations/views.js';
import { reportHashOf } from '../../db/version-health.js';
import type { Hub } from '../hub.js';
import type { LiveChatMessage } from '../live/runtime.js';
import { ProposalError } from '../proposals/service.js';
import {
  generateApprovalCode,
  normalizeApprovalCode,
  parseAuthorCommand,
  sanitizeIntent,
  systemReply,
} from './commands.js';

/** Host limits for chat-initiated authoring. Documented in the service README. */
export const CHAT_AUTHORING_LIMITS = {
  codeTtlMs: 5 * 60_000,
  compilesPerWindow: 3,
  compileWindowMs: 15 * 60_000,
  missesPerWindow: 5,
  missWindowMs: 10 * 60_000,
  repliesPerMinute: 10,
  rejectionsLoggedPerMinute: 6,
  minIntent: 8,
  retainedCodes: 20,
  retainedCandidates: 50,
  retainedEvents: 200,
} as const;

export class ChatAuthoringError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

const codeStatus = z.enum([
  'active',
  'approved',
  'failed',
  'rejected',
  'revoked',
  'expired',
  'invalidated',
]);
const codeSchema = z.object({
  id: z.string(),
  code: z.string(),
  versionId: z.string(),
  automationId: z.string(),
  artifactId: z.string(),
  /** Test-report identity the code was issued for; codes issued before binding lack it. */
  reportHash: z.string().optional(),
  expectedActiveVersionId: z.string().nullable(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  status: codeStatus,
  closedAt: z.number().nullable(),
  reason: z.string().nullable(),
});
const stateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
  pending: z
    .object({
      kind: z.enum(['create', 'edit']),
      intent: z.string(),
      baseVersionId: z.string().nullable(),
      runId: z.string(),
      requestedAt: z.number(),
      status: z.enum(['compiling', 'awaiting']),
      codeId: z.string().nullable(),
    })
    .nullable(),
  codes: z.array(codeSchema),
  candidates: z.array(
    z.object({
      versionId: z.string(),
      runId: z.string(),
      kind: z.enum(['create', 'edit']),
      requestedAt: z.number(),
    }),
  ),
  compiles: z.array(z.number()),
  misses: z.array(z.number()),
  events: z.array(z.string()),
});
type State = z.infer<typeof stateSchema>;
type Code = z.infer<typeof codeSchema>;
export type ApprovalCode = Code;

const initial = (): State => ({
  version: 1,
  enabled: false,
  revision: 0,
  updatedAt: null,
  pending: null,
  codes: [],
  candidates: [],
  compiles: [],
  misses: [],
  events: [],
});

export interface ChatReplies {
  /** Sends one host-owned system reply; never generated-code output. */
  send(text: string, replyParentMessageId?: string): Promise<void>;
  status(): { available: boolean; reason: string | null };
}

/** Bounded, control-free broadcaster name for the approval record. */
const chatActor = (message: LiveChatMessage) =>
  (sanitizeIntent(message.viewerName) || message.viewerId).toLowerCase().slice(0, 40);
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
const sameCode = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Broadcaster-only `!riff create|edit|approve|reject|status|cancel`. Chat starts the same
 * compiler queue and verifier as the console; activation uses the same exact-approval
 * path, bound by a short-lived single-use code to one candidate artifact. Roles come only
 * from EventSub badges plus the authenticated chatter identity, never from text.
 */
export function createChatAuthoringService(deps: {
  storage: ChatAuthoringRepository;
  repo: ChannelRepository;
  hub: Hub;
  authoring: Pick<AuthoringService, 'start' | 'cancel'>;
  approve: (
    versionId: string,
    expected: {
      artifactId: string;
      reportHash: string;
      activeVersionId: string | null;
      approvedBy: string;
    },
  ) => VersionRow;
  discard: (versionId: string) => void;
  blocked: () => boolean;
  chat?: ChatReplies | (() => ChatReplies | null);
  now?: () => number;
}) {
  const { repo, hub, storage } = deps;
  const now = deps.now ?? Date.now;
  const L = CHAT_AUTHORING_LIMITS;
  let state: State = (() => {
    try {
      const parsed = stateSchema.safeParse(storage.get());
      return parsed.success ? parsed.data : initial();
    } catch {
      return initial(); // A degraded read fails closed: authoring is off.
    }
  })();
  const replies: number[] = [];
  const rejections: number[] = [];
  let lastReplyError: string | null = null;

  /** Durable-first: on a failed write nothing changes. */
  function commit(mutate: (draft: State) => void) {
    const draft = structuredClone(state);
    mutate(draft);
    prune(draft);
    storage.save(draft as unknown as Record<string, unknown>);
    state = draft;
  }
  /** Memory-first for fences (panic, disable): persistence is best effort. */
  function fence(mutate: (draft: State) => void) {
    const draft = structuredClone(state);
    mutate(draft);
    prune(draft);
    state = draft;
    try {
      storage.save(draft as unknown as Record<string, unknown>);
    } catch {
      /* The in-memory fence already applies; restart re-checks panic. */
    }
  }
  function prune(draft: State) {
    const at = now();
    draft.compiles = draft.compiles.filter((t) => at - t < L.compileWindowMs);
    draft.misses = draft.misses.filter((t) => at - t < L.missWindowMs);
    draft.events = draft.events.slice(-L.retainedEvents);
    draft.candidates = draft.candidates.slice(-L.retainedCandidates);
    const open = draft.codes.filter((c) => c.status === 'active');
    const closed = draft.codes.filter((c) => c.status !== 'active');
    draft.codes = [...closed.slice(-(L.retainedCodes - open.length)), ...open].sort(
      (a, b) => a.issuedAt - b.issuedAt,
    );
  }
  function close(draft: State, code: Code, status: Code['status'], reason: string | null) {
    const target = draft.codes.find((c) => c.id === code.id);
    if (!target || target.status !== 'active') return;
    target.status = status;
    target.closedAt = now();
    target.reason = reason;
    if (draft.pending?.codeId === code.id) draft.pending = null;
  }
  /** Expire codes and drop codes whose candidate was resolved elsewhere (console). */
  function normalize() {
    const at = now();
    const stale = state.codes.filter((c) => {
      if (c.status !== 'active') return false;
      if (c.expiresAt <= at) return true;
      return repo.version(c.versionId)?.status !== 'candidate';
    });
    if (!stale.length) return;
    fence((draft) => {
      for (const c of stale)
        close(
          draft,
          c,
          c.expiresAt <= at ? 'expired' : 'invalidated',
          c.expiresAt <= at ? 'The code expired.' : 'The candidate was resolved in the console.',
        );
    });
  }
  const activeCodes = () => state.codes.filter((c) => c.status === 'active');

  function record(code: string, message: string, versionId: string | null = null) {
    const entry = {
      at: Date.now(),
      kind: 'control' as const,
      automationId: versionId ? (repo.version(versionId)?.automationId ?? null) : null,
      versionId,
      eventId: null,
      viewer: null,
      code,
      message,
      detail: { source: { kind: 'chat' as const, label: 'In-chat authoring' } },
    };
    let row;
    try {
      row = repo.record(entry);
    } catch {
      row = { ...entry, id: -Date.now(), channelId: repo.channelId };
    }
    hub.publish('activity', row);
  }
  const changed = () => hub.publish('studio', null);
  const chat = () => (typeof deps.chat === 'function' ? deps.chat() : (deps.chat ?? null));
  function say(text: string, replyTo?: string) {
    const sink = chat();
    if (!sink || !sink.status().available) return false;
    const at = now();
    while (replies.length && at - (replies[0] ?? 0) >= 60_000) replies.shift();
    if (replies.length >= L.repliesPerMinute) return false;
    replies.push(at);
    void sink.send(systemReply(text), replyTo).then(
      () => {
        lastReplyError = null;
      },
      () => {
        lastReplyError = 'The last chat reply could not be sent.';
      },
    );
    return true;
  }

  function chatBlockers(version: VersionRow) {
    const automation = repo.automation(version.automationId);
    const active = automation?.activeVersionId
      ? repo.version(automation.activeVersionId)
      : undefined;
    const view = versionView(version, active, deps.blocked());
    const blockers = [...view.blockers];
    try {
      repo.assertVersionLineage(version.id);
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error;
      blockers.push('Its audience selection was removed.');
    }
    const wider = view.changes.filter((c) => c.authority === 'more');
    if (wider.length)
      blockers.push(
        `It grants more authority (${wider.map((c) => c.label.toLowerCase()).join(', ')}); review it in the console.`,
      );
    const before = (active?.manifest as PermissionManifest | undefined)?.experience ?? null;
    const after = (version.manifest as PermissionManifest).experience ?? null;
    if (active && JSON.stringify(before) !== JSON.stringify(after))
      blockers.push('It changes live round rules; choose what happens to progress in the console.');
    return blockers;
  }

  function onRun(run: RunSnapshot) {
    const pending = state.pending;
    if (!pending || pending.status !== 'compiling' || pending.runId !== run.id || !run.result)
      return;
    const result = run.result;
    const versionId = result.versionId;
    const version = versionId ? repo.version(versionId) : undefined;
    const provenance = version
      ? [
          {
            versionId: version.id,
            runId: run.id,
            kind: pending.kind,
            requestedAt: pending.requestedAt,
          },
        ]
      : [];
    if (result.status === 'ready' && version) {
      const blockers = deps.blocked()
        ? ['Riff is stopped.']
        : !state.enabled
          ? ['In-chat authoring was turned off.']
          : chatBlockers(version);
      if (blockers.length) {
        fence((draft) => {
          draft.pending = null;
          draft.candidates.push(...provenance);
        });
        record(
          'CHAT_REVIEW',
          `Chat candidate v${version.number} is ready for console review only: ${blockers.join(' ')}`,
          version.id,
        );
        say(`Built it, but it needs console review: ${blockers[0] ?? ''}`);
        changed();
        return;
      }
      const at = now();
      const code: Code = {
        id: randomUUID(),
        code: generateApprovalCode(),
        versionId: version.id,
        automationId: version.automationId,
        artifactId: version.artifactId ?? '',
        reportHash: reportHashOf(version),
        expectedActiveVersionId: repo.automation(version.automationId)?.activeVersionId ?? null,
        issuedAt: at,
        expiresAt: at + L.codeTtlMs,
        status: 'active',
        closedAt: null,
        reason: null,
      };
      try {
        commit((draft) => {
          for (const open of draft.codes.filter((c) => c.status === 'active'))
            close(draft, open, 'invalidated', 'A newer chat candidate replaced it.');
          draft.codes.push(code);
          draft.candidates.push(...provenance);
          draft.pending = { ...pending, status: 'awaiting', codeId: code.id };
        });
      } catch {
        fence((draft) => {
          draft.pending = null;
        });
        record(
          'CHAT_REVIEW',
          'Could not save an approval code; review the candidate in the console.',
          version.id,
        );
        changed();
        return;
      }
      record(
        'CHAT_CODE',
        `Chat candidate v${version.number} passed verification. Approval code ${code.code} expires in ${minutes(L.codeTtlMs)} minutes.`,
        version.id,
      );
      say(
        `Ready: approve with !riff approve ${code.code} (expires in ${minutes(L.codeTtlMs)} min). Full evidence is in your console.`,
      );
      changed();
      return;
    }
    const reason =
      result.status === 'question'
        ? `I need more detail. ${result.question ?? ''}`
        : result.status === 'unsupported'
          ? (result.unsupportedReason ?? 'Riff cannot build that yet.')
          : result.status === 'cancelled'
            ? 'It was cancelled.'
            : (result.error ?? 'It did not pass verification.');
    fence((draft) => {
      draft.pending = null;
      draft.candidates.push(...provenance);
    });
    record(
      'CHAT_COMPILE_FAILED',
      `Chat compile did not produce an approvable candidate: ${reason}`,
      version?.id ?? null,
    );
    say(`Couldn't build that: ${reason}`);
    changed();
  }
  const unsubscribe = hub.subscribe((message) => {
    if (message.type !== 'run') return;
    try {
      onRun(message.payload as RunSnapshot);
    } catch {
      /* A failed reply/record must never detach the listener or touch the compile. */
    }
  });

  function lockedUntil() {
    if (state.misses.length < L.missesPerWindow) return null;
    const oldest = state.misses[state.misses.length - L.missesPerWindow] ?? now();
    const until = oldest + L.missWindowMs;
    return until > now() ? until : null;
  }
  function find(input: string) {
    const code = normalizeApprovalCode(input);
    if (!code) return { code, match: undefined };
    return { code, match: [...state.codes].reverse().find((c) => sameCode(c.code, code)) };
  }
  function lookupFailure(input: string, reply: string | undefined, verb: 'approve' | 'reject') {
    const lock = lockedUntil();
    if (lock) {
      record('CHAT_APPROVE_REJECTED', `Chat ${verb} refused: too many wrong codes.`);
      say(`Too many wrong codes. Use the console or wait ${minutes(lock - now())} min.`, reply);
      return { failed: true as const };
    }
    const { code, match } = find(input);
    if (!code) {
      say(`Include the code: !riff ${verb} <code>.`, reply);
      return { failed: true as const };
    }
    if (!match) {
      try {
        commit((draft) => {
          draft.misses.push(now());
        });
      } catch {
        /* Counting is fail-safe: the guess was still rejected. */
      }
      record(
        'CHAT_APPROVE_REJECTED',
        `Chat ${verb} refused: that code does not match a pending candidate.`,
      );
      say("That code doesn't match a pending candidate.", reply);
      return { failed: true as const };
    }
    if (match.status !== 'active') {
      const why =
        match.status === 'expired'
          ? 'That code expired. Approve in the console or build it again.'
          : match.status === 'revoked'
            ? 'That code was withdrawn.'
            : match.status === 'invalidated'
              ? `That code is no longer valid. ${match.reason ?? ''}`
              : 'That code was already used.';
      record('CHAT_APPROVE_REJECTED', `Chat ${verb} refused: ${why}`, match.versionId);
      say(why, reply);
      return { failed: true as const };
    }
    return { failed: false as const, match };
  }

  function approve(input: string, reply: string | undefined, broadcaster: string) {
    const found = lookupFailure(input, reply, 'approve');
    if (found.failed) return;
    const { match } = found;
    // Single use: the code is consumed durably before activation is attempted.
    try {
      commit((draft) => close(draft, match, 'approved', null));
    } catch {
      say('Could not record the approval. Nothing was activated; use the console.', reply);
      return;
    }
    const refuse = (why: string) => {
      fence((draft) => {
        const target = draft.codes.find((c) => c.id === match.id);
        if (target) {
          target.status = 'failed';
          target.reason = why;
        }
      });
      record('CHAT_APPROVE_REJECTED', `Chat approval refused: ${why}`, match.versionId);
      say(`Not activated: ${why}`, reply);
      changed();
    };
    const version = repo.version(match.versionId);
    const automation = version ? repo.automation(version.automationId) : undefined;
    if (
      !version ||
      !automation ||
      version.status !== 'candidate' ||
      version.artifactId !== match.artifactId ||
      automation.activeVersionId !== match.expectedActiveVersionId
    )
      return refuse('The candidate or live version changed since the code was issued.');
    const blockers = chatBlockers(version);
    if (blockers.length) return refuse(blockers.join(' '));
    try {
      deps.approve(version.id, {
        artifactId: match.artifactId,
        // A code issued before report binding names no report and is refused as stale.
        reportHash: match.reportHash ?? '',
        activeVersionId: match.expectedActiveVersionId,
        approvedBy: `chat:${broadcaster}`,
      });
    } catch (error) {
      return refuse(error instanceof Error ? error.message : 'Approval failed.');
    }
    const command = (version.manifest as PermissionManifest).trigger.command;
    record(
      'CHAT_APPROVED',
      `Broadcaster approved chat candidate “${version.title}” v${version.number} with code ${match.code}.`,
      version.id,
    );
    say(`Live: viewers can now type ${command}.`, reply);
    changed();
  }

  function reject(input: string, reply: string | undefined) {
    const found = lookupFailure(input, reply, 'reject');
    if (found.failed) return;
    const { match } = found;
    try {
      commit((draft) => close(draft, match, 'rejected', 'Rejected from chat.'));
    } catch {
      say('Could not record that. Use the console.', reply);
      return;
    }
    try {
      deps.discard(match.versionId);
    } catch {
      /* The code is spent; the candidate stays reviewable in the console. */
    }
    record(
      'CHAT_REJECTED',
      `Broadcaster rejected chat candidate with code ${match.code}.`,
      match.versionId,
    );
    say('Discarded that candidate.', reply);
    changed();
  }

  function start(kind: 'create' | 'edit', raw: string, reply: string | undefined) {
    const intent = sanitizeIntent(raw);
    if (Array.from(intent).length < L.minIntent) {
      say(`Describe it in a few more words: !riff ${kind} <what should happen>.`, reply);
      return;
    }
    if (state.pending) {
      say('Already working on one. Try !riff status or !riff cancel.', reply);
      return;
    }
    const recent = state.compiles.filter((t) => now() - t < L.compileWindowMs);
    if (recent.length >= L.compilesPerWindow) {
      const wait = (recent[0] ?? now()) + L.compileWindowMs - now();
      record(
        'CHAT_LIMIT',
        `Chat compile refused: ${L.compilesPerWindow} per ${minutes(L.compileWindowMs)} minutes already used.`,
      );
      say(`Chat build limit reached. Try again in ${minutes(wait)} min or use the console.`, reply);
      return;
    }
    let baseVersionId: string | null = null;
    if (kind === 'edit') {
      const live = repo.automations().filter((a) => a.status === 'live' && a.activeVersionId);
      if (live.length !== 1) {
        say(
          live.length
            ? 'Several interactions are live; edit from the console.'
            : 'Nothing is live to edit. Use !riff create instead.',
          reply,
        );
        return;
      }
      baseVersionId = live[0]?.activeVersionId ?? null;
    }
    let run: RunSnapshot;
    try {
      run = deps.authoring.start({ intent, baseVersionId });
    } catch (error) {
      say(
        `Couldn't start: ${error instanceof Error ? error.message : 'try again shortly.'}`,
        reply,
      );
      return;
    }
    try {
      commit((draft) => {
        draft.compiles.push(now());
        draft.pending = {
          kind,
          intent,
          baseVersionId,
          runId: run.id,
          requestedAt: now(),
          status: 'compiling',
          codeId: null,
        };
      });
    } catch {
      try {
        deps.authoring.cancel(run.id);
      } catch {
        /* already finished */
      }
      say('Could not record the request, so it was cancelled. Use the console.', reply);
      return;
    }
    record(
      'CHAT_COMPILE',
      `Broadcaster asked from chat to ${kind === 'edit' ? 'edit the live interaction' : 'create'}: “${intent}”`,
    );
    say('Compiling… I will post an approval code here if it passes verification.', reply);
    changed();
  }

  function status(reply: string | undefined) {
    const pending = state.pending;
    const code = pending?.codeId ? state.codes.find((c) => c.id === pending.codeId) : undefined;
    if (pending?.status === 'compiling') say('Still compiling. Use !riff cancel to stop.', reply);
    else if (code?.status === 'active') {
      const left = Math.max(0, Math.ceil((code.expiresAt - now()) / 1000));
      say(
        `Waiting: !riff approve ${code.code} (${Math.floor(left / 60)}m ${left % 60}s left).`,
        reply,
      );
    } else
      say(
        `Nothing pending. ${Math.max(0, L.compilesPerWindow - state.compiles.length)} chat builds left this window.`,
        reply,
      );
  }

  function cancel(reply: string | undefined) {
    const pending = state.pending;
    if (!pending) return say('Nothing to cancel.', reply);
    if (pending.status === 'compiling') {
      fence((draft) => {
        draft.pending = null;
      });
      try {
        deps.authoring.cancel(pending.runId);
      } catch {
        /* finished meanwhile; its result is no longer followed */
      }
      record('CHAT_CANCELLED', 'Broadcaster cancelled the chat compile.');
      say('Cancelled.', reply);
    } else {
      const code = state.codes.find((c) => c.id === pending.codeId);
      fence((draft) => {
        if (code) close(draft, code, 'revoked', 'Withdrawn from chat.');
        draft.pending = null;
      });
      record(
        'CHAT_CANCELLED',
        'Broadcaster withdrew the chat approval code.',
        code?.versionId ?? null,
      );
      say('Withdrew the approval code. The candidate stays in your console.', reply);
    }
    changed();
  }

  function isOwner(message: LiveChatMessage) {
    // Badge role plus the authenticated chatter id: the broadcaster's own account.
    return (
      message.roles.includes('broadcaster') &&
      message.viewerId === message.channelId &&
      (!message.sourceChannelId || message.sourceChannelId === message.channelId)
    );
  }

  return {
    enabled: () => state.enabled,
    /**
     * F20: one host-owned viewer-directed reply (fixed reviewed text only), sharing the
     * chat reply budget. Only while chat authoring is on (it owns the chat-write scope).
     */
    systemReply: (text: string, replyTo?: string) =>
      state.enabled && !deps.blocked() ? say(text, replyTo) : false,
    /** True when the message is an authoring command and was consumed. */
    handle(message: LiveChatMessage): boolean {
      const command = parseAuthorCommand(message.text);
      if (!command) return false;
      normalize();
      const owner = isOwner(message);
      if (command.kind === 'approve-alias') {
        // Consumed only when unambiguous; otherwise a generated `!approve` keeps working.
        if (!owner || !state.enabled || deps.blocked() || activeCodes().length !== 1) return false;
      }
      if (state.events.includes(message.id)) return true;
      try {
        commit((draft) => {
          draft.events.push(message.id);
        });
      } catch {
        /* Redelivery protection is best effort; EventSub also dedupes. */
      }
      const reply = message.sourceMessageId;
      if (!owner) {
        const at = now();
        while (rejections.length && at - (rejections[0] ?? 0) >= 60_000) rejections.shift();
        if (rejections.length < L.rejectionsLoggedPerMinute) {
          rejections.push(at);
          record(
            'CHAT_AUTHOR_DENIED',
            `Ignored !riff ${command.kind === 'approve-alias' ? 'approve' : command.kind} from a non-owner chatter: only the broadcaster's own badge-verified account can author or approve from chat.`,
          );
        }
        return true;
      }
      if (!state.enabled) {
        say('In-chat authoring is off. Turn it on in the Riff console.', reply);
        return true;
      }
      if (deps.blocked()) {
        say('Riff is stopped. Resume from the console first.', reply);
        return true;
      }
      switch (command.kind) {
        case 'create':
        case 'edit':
          start(command.kind, command.intent, reply);
          break;
        case 'approve':
          approve(command.code, reply, chatActor(message));
          break;
        case 'approve-alias':
          approve(activeCodes()[0]?.code ?? '', reply, chatActor(message));
          break;
        case 'reject':
          reject(command.code, reply);
          break;
        case 'status':
          status(reply);
          break;
        case 'cancel':
          cancel(reply);
          break;
      }
      return true;
    },
    snapshot() {
      normalize();
      const active = activeCodes()[0] ?? null;
      const sink = chat();
      const replyStatus = sink
        ? sink.status()
        : { available: false, reason: 'Connect Twitch to send chat replies.' };
      return {
        enabled: state.enabled,
        revision: state.revision,
        updatedAt: state.updatedAt,
        replies: { ...replyStatus, lastError: lastReplyError },
        pending: state.pending
          ? {
              kind: state.pending.kind,
              intent: state.pending.intent,
              runId: state.pending.runId,
              requestedAt: state.pending.requestedAt,
              status: state.pending.status,
            }
          : null,
        activeCode: active
          ? {
              id: active.id,
              code: active.code,
              versionId: active.versionId,
              issuedAt: active.issuedAt,
              expiresAt: active.expiresAt,
            }
          : null,
        recentCodes: state.codes
          .filter((c) => c.status !== 'active')
          .slice(-5)
          .reverse()
          .map((c) => ({
            id: c.id,
            code: c.code,
            versionId: c.versionId,
            status: c.status,
            closedAt: c.closedAt,
            reason: c.reason,
          })),
        candidates: state.candidates.map((c) => ({
          versionId: c.versionId,
          kind: c.kind,
          requestedAt: c.requestedAt,
        })),
        limits: {
          compilesPerWindow: L.compilesPerWindow,
          compileWindowMs: L.compileWindowMs,
          compilesUsed: state.compiles.filter((t) => now() - t < L.compileWindowMs).length,
          codeTtlMs: L.codeTtlMs,
        },
        lockedUntil: lockedUntil(),
        now: now(),
      };
    },
    setEnabled(enabled: boolean, expectedRevision: number) {
      if (expectedRevision !== state.revision)
        throw new ChatAuthoringError(
          'CONFLICT',
          'In-chat authoring settings changed in another window. Refresh and try again.',
        );
      const pending = state.pending;
      commit((draft) => {
        draft.enabled = enabled;
        draft.revision += 1;
        draft.updatedAt = now();
        if (!enabled) {
          for (const c of draft.codes.filter((x) => x.status === 'active'))
            close(draft, c, 'revoked', 'In-chat authoring was turned off.');
          draft.pending = null;
        }
      });
      if (!enabled && pending?.status === 'compiling')
        try {
          deps.authoring.cancel(pending.runId);
        } catch {
          /* finished meanwhile */
        }
      record(
        enabled ? 'CHAT_AUTHORING_ON' : 'CHAT_AUTHORING_OFF',
        enabled
          ? 'In-chat authoring turned on: the broadcaster can build and approve from chat.'
          : 'In-chat authoring turned off; pending chat codes were withdrawn.',
      );
      changed();
      return this.snapshot();
    },
    revoke(codeId: string) {
      normalize();
      const code = state.codes.find((c) => c.id === codeId);
      if (!code || code.status !== 'active')
        throw new ChatAuthoringError('NOT_FOUND', 'That approval code is no longer active.');
      commit((draft) => close(draft, code, 'revoked', 'Revoked from the console.'));
      record(
        'CHAT_CODE_REVOKED',
        `Approval code ${code.code} was revoked from the console.`,
        code.versionId,
      );
      say('The approval code was withdrawn from the console.');
      changed();
      return this.snapshot();
    },
    /** Panic: fence codes and pending work in memory first; persistence is best effort. */
    stop(reason: string) {
      const pending = state.pending;
      const open = activeCodes();
      if (!pending && !open.length) return;
      fence((draft) => {
        for (const c of open) close(draft, c, 'invalidated', reason);
        draft.pending = null;
      });
      if (pending?.status === 'compiling')
        try {
          deps.authoring.cancel(pending.runId);
        } catch {
          /* finished meanwhile */
        }
      record(
        'CHAT_CODE_INVALIDATED',
        `Chat approval codes and pending chat builds were cancelled: ${reason}`,
      );
    },
    /**
     * Restart semantics: codes survive restart until expiry and are rechecked against the
     * exact candidate; a persisted panic invalidates them; an in-flight compile is lost.
     */
    boot() {
      const pending = state.pending;
      if (pending?.status === 'compiling') {
        fence((draft) => {
          draft.pending = null;
        });
        record(
          'CHAT_COMPILE_FAILED',
          'A chat compile was interrupted by a restart. Ask again from chat.',
        );
      }
      if (repo.state().panic) this.stop('Riff restarted while stopped.');
      normalize();
    },
    close() {
      unsubscribe();
    },
  };
}
export type ChatAuthoringService = ReturnType<typeof createChatAuthoringService>;
