import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../db/client.js';
import {
  proposalRepository,
  type BallotRow,
  type ProposalRow,
} from '../../db/repositories/proposals.js';
import { parseProposalCommand } from './commands.js';
export interface ChatActor {
  kind: 'chat';
  accountId: string;
  displayName: string;
  roles: readonly string[];
}
export type ProposalActor = { kind: 'creator' } | ChatActor;
export type CommandResult =
  { ok: true; proposalId?: string; grouped?: boolean } | { ok: false; code: string };
export class ProposalError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new ProposalError(code);
};
const clean = (text: string) =>
  text
    .replace(/\s/g, ' ')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join('')
    .trim();
const publicText = (text: string) => clean(text);
const eligible = (p: ProposalRow | undefined): p is ProposalRow =>
  !!p && (p.state === 'shortlisted' || p.state === 'selected');
const page = (value: number | undefined, fallback: number, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, max)
    : fallback;
/** No external effects: durable, channel-scoped proposal policy with a host-owned clock. */
export function createProposalService(
  connection: DatabaseConnection,
  channelId: string,
  options: { now?: () => number } = {},
) {
  const repo = proposalRepository(connection, channelId);
  const now = options.now ?? Date.now;
  const creator = (actor: ProposalActor) => {
    if (actor.kind !== 'creator') fail('FORBIDDEN');
  };
  const authenticated = (actor: ChatActor) => {
    if (actor.kind !== 'chat' || !actor.accountId || actor.accountId.length > 128)
      fail('FORBIDDEN');
  };
  const mayModerate = (actor: ProposalActor) => {
    if (actor.kind === 'creator') return;
    authenticated(actor);
    if (actor.roles.includes('broadcaster')) return;
    if (!actor.roles.includes('moderator') || !repo.hasGrant(actor.accountId)) fail('FORBIDDEN');
  };
  const proposal = (id: string) => repo.getProposal(id) ?? fail('NOT_FOUND');
  const receipt = (
    actor: ChatActor,
    eventId: string,
    kind: string,
    text: string | null,
    apply: () => CommandResult,
  ): CommandResult =>
    repo.transaction(() => {
      authenticated(actor);
      if (!eventId || eventId.length > 128) return { ok: false, code: 'INVALID' };
      const at = now();
      repo.pruneReceipts(at - 7 * 86400000);
      const previous = repo.receipt(eventId);
      if (previous) return previous.result as CommandResult;
      if (repo.receiptCount() >= 10000) return { ok: false, code: 'RECEIPT_CAPACITY' };
      let result: CommandResult;
      try {
        result = apply();
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
        result = { ok: false, code: error.code };
      }
      repo.recordReceipt({
        id: randomUUID(),
        eventId,
        accountId: actor.accountId,
        kind,
        text: text?.slice(0, 500) ?? null,
        proposalId: result.ok ? (result.proposalId ?? null) : null,
        result,
        at,
      });
      return result;
    });
  function submit(actor: ChatActor, input: { eventId: string; text: string }): CommandResult {
    return receipt(actor, input.eventId, 'suggest', clean(input.text), () => {
      const at = now();
      if (repo.attempts(at - 60000, actor.accountId) >= 3)
        return { ok: false, code: 'ACCOUNT_LIMIT' };
      if (repo.attempts(at - 60000) >= 20) return { ok: false, code: 'CHANNEL_LIMIT' };
      const text = clean(input.text).replace(/\s+/g, ' ');
      if (text.length < 8 || text.length > 500) return { ok: false, code: 'INVALID' };
      const normalizedText = text.toLowerCase();
      const found = repo.findNormalized(normalizedText);
      if (found) {
        const contributors = repo.contributors(found.id);
        if (!contributors.some((c) => c.accountId === actor.accountId)) {
          if (contributors.length >= 1000) return { ok: false, code: 'CONTRIBUTOR_LIMIT' };
          repo.addContributor({
            id: randomUUID(),
            proposalId: found.id,
            accountId: actor.accountId,
            displayName: clean(actor.displayName).slice(0, 80),
            eventId: input.eventId,
            createdAt: at,
          });
        }
        return { ok: true, proposalId: found.id, grouped: true };
      }
      if (repo.visibleCount() >= 100) return { ok: false, code: 'PROPOSAL_LIMIT' };
      const id = randomUUID();
      repo.insertProposal({
        id,
        text,
        normalizedText,
        state: 'pending',
        revision: 0,
        createdAt: at,
        updatedAt: at,
      });
      repo.addContributor({
        id: randomUUID(),
        proposalId: id,
        accountId: actor.accountId,
        displayName: clean(actor.displayName).slice(0, 80),
        eventId: input.eventId,
        createdAt: at,
      });
      return { ok: true, proposalId: id, grouped: false };
    });
  }
  function moderate(
    actor: ProposalActor,
    input: {
      proposalId: string;
      expectedRevision: number;
      action: 'shortlist' | 'hide' | 'restore';
    },
  ) {
    return repo.transaction(() => {
      mayModerate(actor);
      const p = proposal(input.proposalId);
      if (p.revision !== input.expectedRevision) fail('STALE');
      if (!['shortlist', 'hide', 'restore'].includes(input.action)) fail('INVALID');
      if (input.action === 'restore') {
        creator(actor);
        if (p.state !== 'hidden') fail('INELIGIBLE');
        if (repo.visibleCount() >= 100) fail('PROPOSAL_LIMIT');
      }
      if (input.action === 'shortlist' && p.state === 'hidden') fail('INELIGIBLE');
      const state =
        input.action === 'hide' ? 'hidden' : input.action === 'restore' ? 'pending' : 'shortlisted';
      const at = now();
      if (!repo.updateProposal(p.id, p.revision, state, at)) fail('STALE');
      if (input.action === 'hide') repo.revokeSelections(p.id, at);
      repo.recordHistory({
        proposalId: p.id,
        actor: actor.kind === 'creator' ? 'creator' : actor.accountId,
        action: input.action,
        revision: p.revision + 1,
        at,
      });
      return proposal(p.id);
    });
  }
  function setGrant(actor: ProposalActor, accountId: string, enabled: boolean) {
    return repo.transaction(() => {
      creator(actor);
      if (!accountId || accountId.length > 128) fail('INVALID');
      if (!enabled) {
        repo.removeGrant(accountId);
        return;
      }
      if (repo.hasGrant(accountId)) return;
      if (repo.grants().length >= 100) fail('GRANT_LIMIT');
      repo.grant({ id: randomUUID(), accountId, createdAt: now() });
    });
  }
  function setCredit(actor: ChatActor, enabled: boolean) {
    return repo.transaction(() => {
      authenticated(actor);
      repo.setCredit({ id: randomUUID(), accountId: actor.accountId, enabled, updatedAt: now() });
    });
  }
  function createBallot(
    actor: ProposalActor,
    input: { proposalIds: { id: string; revision: number }[]; durationSeconds: number },
  ) {
    return repo.transaction(() => {
      creator(actor);
      const at = now();
      repo.expireBallots(at);
      if (repo.openBallot()) fail('BALLOT_OPEN');
      if (
        !Number.isInteger(input.durationSeconds) ||
        input.durationSeconds < 15 ||
        input.durationSeconds > 600 ||
        input.proposalIds.length < 1 ||
        input.proposalIds.length > 5 ||
        new Set(input.proposalIds.map((p) => p.id)).size !== input.proposalIds.length
      )
        fail('INVALID');
      for (const option of input.proposalIds) {
        const p = proposal(option.id);
        if (p.revision !== option.revision) fail('STALE');
        if (!eligible(p)) fail('INELIGIBLE');
      }
      const id = randomUUID();
      repo.insertBallot({
        id,
        revision: 0,
        createdAt: at,
        deadlineAt: at + input.durationSeconds * 1000,
        closedAt: null,
      });
      input.proposalIds.forEach((p, i) =>
        repo.insertOption({ id: randomUUID(), ballotId: id, proposalId: p.id, option: i + 1 }),
      );
      return repo.ballot(id) ?? fail('NOT_FOUND');
    });
  }
  function closeBallot(
    actor: ProposalActor,
    input: { ballotId: string; expectedRevision: number },
  ) {
    creator(actor);
    const result = repo.transaction(() => {
      const at = now();
      repo.expireBallots(at);
      const ballot = repo.ballot(input.ballotId);
      if (!ballot) return { error: 'NOT_FOUND' } as const;
      if (ballot.revision !== input.expectedRevision) return { error: 'STALE' } as const;
      if (!repo.closeBallot(ballot.id, input.expectedRevision, at))
        return { error: 'BALLOT_CLOSED' } as const;
      return { ballot: repo.ballot(ballot.id) ?? fail('NOT_FOUND') };
    });
    if ('error' in result) fail(result.error);
    return result.ballot;
  }
  function vote(
    actor: ChatActor,
    input: { eventId: string; ballotId: string; option: number },
  ): CommandResult {
    return receipt(actor, input.eventId, 'vote', null, () => {
      repo.expireBallots(now());
      const ballot = repo.ballot(input.ballotId);
      if (!ballot) return { ok: false, code: 'NOT_FOUND' };
      if (ballot.closedAt !== null || now() >= ballot.deadlineAt)
        return { ok: false, code: 'BALLOT_CLOSED' };
      const option = repo.options(ballot.id).find((o) => o.option === input.option);
      if (!option) return { ok: false, code: 'INVALID' };
      if (!eligible(repo.getProposal(option.proposalId))) return { ok: false, code: 'INELIGIBLE' };
      if (repo.vote(ballot.id, actor.accountId)) return { ok: false, code: 'ALREADY_VOTED' };
      if (repo.voteCount(ballot.id) >= 10000) return { ok: false, code: 'VOTE_LIMIT' };
      repo.insertVote({
        id: randomUUID(),
        ballotId: ballot.id,
        accountId: actor.accountId,
        option: input.option,
        eventId: input.eventId,
        at: now(),
      });
      return { ok: true };
    });
  }
  function select(
    actor: ProposalActor,
    input: {
      proposalId: string;
      expectedRevision: number;
      brief: string;
      baseVersionId?: string | null;
    },
  ) {
    return repo.transaction(() => {
      creator(actor);
      const p = proposal(input.proposalId);
      if (p.revision !== input.expectedRevision) fail('STALE');
      if (!eligible(p)) fail('INELIGIBLE');
      const brief = clean(input.brief);
      if (brief.length < 8 || brief.length > 500) fail('INVALID');
      const at = now();
      if (!repo.updateProposal(p.id, p.revision, 'selected', at)) fail('STALE');
      const id = randomUUID();
      repo.insertSelection({
        id,
        proposalId: p.id,
        proposalRevision: p.revision + 1,
        brief,
        baseVersionId: input.baseVersionId ?? null,
        createdAt: at,
        revokedAt: null,
      });
      repo.recordHistory({
        proposalId: p.id,
        actor: 'creator',
        action: 'select',
        revision: p.revision + 1,
        at,
      });
      return repo.selection(id) ?? fail('NOT_FOUND');
    });
  }
  function assertSelectionAuthorized(id: string) {
    const selection = repo.selection(id) ?? fail('NOT_FOUND');
    const p = repo.getProposal(selection.proposalId);
    if (selection.revokedAt !== null || !eligible(p)) fail('REVOKED');
    if (!p || p.revision !== selection.proposalRevision) fail('STALE');
    return selection;
  }
  function revokeSelection(actor: ProposalActor, id: string) {
    return repo.transaction(() => {
      creator(actor);
      const selection = repo.selection(id) ?? fail('NOT_FOUND');
      repo.revokeSelection(id, now());
      return repo.selection(selection.id) ?? fail('NOT_FOUND');
    });
  }
  function snapshot(
    input: {
      state?: ProposalRow['state'] | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    } = {},
  ) {
    return repo.transaction(() => {
      repo.expireBallots(now());
      return {
        proposals: repo
          .list(input.state, page(input.limit, 50, 50), page(input.offset, 0, 1000000))
          .map((p) => ({ ...p, contributorCount: repo.contributors(p.id).length })),
        grants: repo.grants(),
        ballots: repo.ballots(50).map((ballot) => ({
          ...ballot,
          options: repo
            .options(ballot.id)
            .map((o) => ({ ...o, votes: repo.voteCount(ballot.id, o.option) })),
        })),
        selections: repo.selections(),
      };
    });
  }
  function publicProposal(p: ProposalRow) {
    return {
      proposalId: p.id,
      text: publicText(p.text),
      authors: repo
        .contributors(p.id)
        .filter((c) => repo.credit(c.accountId))
        .slice(0, 5)
        .map((c) => publicText(c.displayName)),
    };
  }
  function publicBallot(ballot: BallotRow) {
    const choices = repo.options(ballot.id).flatMap((option) => {
      const p = repo.getProposal(option.proposalId);
      return eligible(p)
        ? [
            {
              option: option.option,
              ...publicProposal(p),
              votes: repo.voteCount(ballot.id, option.option),
            },
          ]
        : [];
    });
    const max = Math.max(0, ...choices.map((c) => c.votes));
    return {
      id: ballot.id,
      revision: ballot.revision,
      deadlineAt: ballot.deadlineAt,
      closedAt: ballot.closedAt,
      options: choices,
      tied: choices.filter((c) => c.votes === max).length > 1,
    };
  }
  function publicProjection() {
    return repo.transaction(() => {
      repo.expireBallots(now());
      const ballot = repo.openBallot();
      return {
        commands: [
          '!riff suggest <text>',
          '!riff vote <ballot-id> <option>',
          '!riff credit on|off',
        ],
        creditNotice:
          'Chat submissions are already public on Twitch. Credit off removes Riff attribution, not the original chat message.',
        ballot: ballot ? publicBallot(ballot) : null,
        outcomes: repo
          .ballots(6)
          .filter((b) => b.closedAt !== null)
          .slice(0, 5)
          .map(publicBallot),
        selections: repo.authorizedSelections(5).flatMap((s) => {
          const p = repo.getProposal(s.proposalId);
          return s.revokedAt === null && eligible(p)
            ? [{ id: s.id, ...publicProposal(p), status: 'selected' as const }]
            : [];
        }),
      };
    });
  }
  function handleCommand(
    actor: ChatActor,
    event: { eventId: string; text: string },
  ): { consumed: boolean; panic?: boolean; result?: CommandResult } {
    const command = parseProposalCommand(event.text);
    if (!command) return { consumed: false };
    if (command.kind === 'panic') return { consumed: true, panic: true };
    if (command.kind === 'suggest')
      return {
        consumed: true,
        result: submit(actor, { eventId: event.eventId, text: command.text }),
      };
    if (command.kind === 'vote')
      return {
        consumed: true,
        result: vote(actor, {
          eventId: event.eventId,
          ballotId: command.ballotId,
          option: command.option,
        }),
      };
    return {
      consumed: true,
      result: receipt(actor, event.eventId, command.kind, null, () => {
        if (command.kind === 'invalid') return { ok: false, code: 'INVALID' };
        if (command.kind === 'credit') {
          setCredit(actor, command.enabled);
          return { ok: true };
        }
        if (command.kind === 'shortlist' || command.kind === 'hide') {
          const p = proposal(command.proposalId);
          moderate(actor, { proposalId: p.id, expectedRevision: p.revision, action: command.kind });
          return { ok: true, proposalId: p.id };
        }
        return { ok: false, code: 'INVALID' };
      }),
    };
  }
  return {
    submit,
    moderate,
    setGrant,
    setCredit,
    createBallot,
    closeBallot,
    vote,
    select,
    revokeSelection,
    getSelection: repo.selection,
    assertSelectionAuthorized,
    snapshot,
    publicProjection,
    handleCommand,
    history: (
      id: string,
      input: { offset?: number | undefined; limit?: number | undefined } = {},
    ) => repo.history(id, page(input.limit, 50, 50), page(input.offset, 0, 1000000)),
  };
}
export type ProposalService = ReturnType<typeof createProposalService>;
