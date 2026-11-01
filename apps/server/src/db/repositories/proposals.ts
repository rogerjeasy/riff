import { and, asc, count, desc, eq, gt, inArray, isNull, lte, max, ne, sql } from 'drizzle-orm';
import type { DatabaseConnection } from '../client.js';
import {
  proposals,
  proposalContributors,
  proposalHistory,
  proposalGrants,
  proposalCredit,
  proposalReceipts,
  proposalBallots,
  proposalBallotOptions,
  proposalVotes,
  proposalSelections,
} from '../schema.js';
export type ProposalRow = typeof proposals.$inferSelect;
export type SelectionRow = typeof proposalSelections.$inferSelect;
export type BallotRow = typeof proposalBallots.$inferSelect;
/** All access, including transactions and audit pages, retains the channel scope. */
export function proposalRepository(connection: DatabaseConnection, channelId: string) {
  const { db } = connection;
  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn, { behavior: 'immediate' });
    },
    getProposal(id: string) {
      return db
        .select()
        .from(proposals)
        .where(and(eq(proposals.channelId, channelId), eq(proposals.id, id)))
        .get();
    },
    proposalByNumber(number: number) {
      return db
        .select()
        .from(proposals)
        .where(and(eq(proposals.channelId, channelId), eq(proposals.number, number)))
        .get();
    },
    /** One grouped read per page instead of loading every contributor row. */
    stateCounts() {
      const counts = { pending: 0, shortlisted: 0, selected: 0, hidden: 0 };
      for (const row of db
        .select({ state: proposals.state, n: count() })
        .from(proposals)
        .where(eq(proposals.channelId, channelId))
        .groupBy(proposals.state)
        .all())
        counts[row.state] = row.n;
      return counts;
    },
    contributorCounts(ids: string[]) {
      const counts = new Map<string, number>();
      if (!ids.length) return counts;
      for (const row of db
        .select({ id: proposalContributors.proposalId, n: count() })
        .from(proposalContributors)
        .where(
          and(
            eq(proposalContributors.channelId, channelId),
            inArray(proposalContributors.proposalId, ids),
          ),
        )
        .groupBy(proposalContributors.proposalId)
        .all())
        counts.set(row.id, row.n);
      return counts;
    },
    /** Earliest consenting contributors only; a single bounded join, run every overlay tick. */
    creditedAuthors(proposalId: string, limit = 5) {
      return db
        .select({ displayName: proposalContributors.displayName })
        .from(proposalContributors)
        .innerJoin(
          proposalCredit,
          and(
            eq(proposalCredit.channelId, channelId),
            eq(proposalCredit.accountId, proposalContributors.accountId),
            eq(proposalCredit.enabled, true),
          ),
        )
        .where(
          and(
            eq(proposalContributors.channelId, channelId),
            eq(proposalContributors.proposalId, proposalId),
          ),
        )
        .orderBy(asc(proposalContributors.createdAt), sql`proposal_contributors.rowid`)
        .limit(limit)
        .all()
        .map((row) => row.displayName);
    },
    findNormalized(text: string) {
      return db
        .select()
        .from(proposals)
        .where(and(eq(proposals.channelId, channelId), eq(proposals.normalizedText, text)))
        .get();
    },
    /** Numbers are assigned here, inside the caller's immediate transaction. */
    insertProposal(row: Omit<typeof proposals.$inferInsert, 'channelId' | 'number'>) {
      const number =
        (db
          .select({ n: max(proposals.number) })
          .from(proposals)
          .where(eq(proposals.channelId, channelId))
          .get()?.n ?? 0) + 1;
      db.insert(proposals)
        .values({ ...row, number, channelId })
        .run();
    },
    updateProposal(id: string, revision: number, state: ProposalRow['state'], at: number) {
      return (
        db
          .update(proposals)
          .set({ state, revision: revision + 1, updatedAt: at })
          .where(
            and(
              eq(proposals.channelId, channelId),
              eq(proposals.id, id),
              eq(proposals.revision, revision),
            ),
          )
          .run().changes === 1
      );
    },
    visibleCount() {
      return (
        db
          .select({ n: count() })
          .from(proposals)
          .where(and(eq(proposals.channelId, channelId), ne(proposals.state, 'hidden')))
          .get()?.n ?? 0
      );
    },
    list(state: ProposalRow['state'] | undefined, limit: number, offset: number) {
      return db
        .select()
        .from(proposals)
        .where(
          and(eq(proposals.channelId, channelId), state ? eq(proposals.state, state) : undefined),
        )
        .orderBy(desc(proposals.createdAt), desc(proposals.number), asc(proposals.id))
        .limit(limit)
        .offset(offset)
        .all();
    },
    contributors(id: string, limit = 1000) {
      return db
        .select()
        .from(proposalContributors)
        .where(
          and(
            eq(proposalContributors.channelId, channelId),
            eq(proposalContributors.proposalId, id),
          ),
        )
        .orderBy(asc(proposalContributors.createdAt))
        .limit(limit)
        .all();
    },
    addContributor(row: Omit<typeof proposalContributors.$inferInsert, 'channelId'>) {
      db.insert(proposalContributors)
        .values({ ...row, channelId })
        .onConflictDoNothing()
        .run();
    },
    history(id: string, limit: number, offset: number) {
      return db
        .select()
        .from(proposalHistory)
        .where(and(eq(proposalHistory.channelId, channelId), eq(proposalHistory.proposalId, id)))
        .orderBy(desc(proposalHistory.id))
        .limit(limit)
        .offset(offset)
        .all();
    },
    recordHistory(row: Omit<typeof proposalHistory.$inferInsert, 'channelId'>) {
      db.insert(proposalHistory)
        .values({ ...row, channelId })
        .run();
    },
    grants() {
      return db
        .select()
        .from(proposalGrants)
        .where(eq(proposalGrants.channelId, channelId))
        .limit(100)
        .all();
    },
    hasGrant(accountId: string) {
      return !!db
        .select()
        .from(proposalGrants)
        .where(
          and(eq(proposalGrants.channelId, channelId), eq(proposalGrants.accountId, accountId)),
        )
        .get();
    },
    grant(row: Omit<typeof proposalGrants.$inferInsert, 'channelId'>) {
      db.insert(proposalGrants)
        .values({ ...row, channelId })
        .onConflictDoNothing()
        .run();
    },
    removeGrant(accountId: string) {
      db.delete(proposalGrants)
        .where(
          and(eq(proposalGrants.channelId, channelId), eq(proposalGrants.accountId, accountId)),
        )
        .run();
    },
    credit(accountId: string) {
      return (
        db
          .select()
          .from(proposalCredit)
          .where(
            and(eq(proposalCredit.channelId, channelId), eq(proposalCredit.accountId, accountId)),
          )
          .get()?.enabled ?? false
      );
    },
    setCredit(row: Omit<typeof proposalCredit.$inferInsert, 'channelId'>) {
      db.insert(proposalCredit)
        .values({ ...row, channelId })
        .onConflictDoUpdate({
          target: [proposalCredit.channelId, proposalCredit.accountId],
          set: { enabled: row.enabled, updatedAt: row.updatedAt },
        })
        .run();
    },
    pruneReceipts(before: number) {
      db.delete(proposalReceipts)
        .where(and(eq(proposalReceipts.channelId, channelId), lte(proposalReceipts.at, before)))
        .run();
    },
    receipt(eventId: string) {
      return db
        .select()
        .from(proposalReceipts)
        .where(
          and(eq(proposalReceipts.channelId, channelId), eq(proposalReceipts.eventId, eventId)),
        )
        .get();
    },
    receiptCount() {
      return (
        db
          .select({ n: count() })
          .from(proposalReceipts)
          .where(eq(proposalReceipts.channelId, channelId))
          .get()?.n ?? 0
      );
    },
    attempts(since: number, accountId?: string) {
      return (
        db
          .select({ n: count() })
          .from(proposalReceipts)
          .where(
            and(
              eq(proposalReceipts.channelId, channelId),
              eq(proposalReceipts.kind, 'suggest'),
              gt(proposalReceipts.at, since),
              accountId ? eq(proposalReceipts.accountId, accountId) : undefined,
            ),
          )
          .get()?.n ?? 0
      );
    },
    recordReceipt(row: Omit<typeof proposalReceipts.$inferInsert, 'channelId'>) {
      db.insert(proposalReceipts)
        .values({ ...row, channelId })
        .run();
    },
    expireBallots(now: number) {
      db.update(proposalBallots)
        .set({
          closedAt: sql`${proposalBallots.deadlineAt}`,
          revision: sql`${proposalBallots.revision}+1`,
        })
        .where(
          and(
            eq(proposalBallots.channelId, channelId),
            isNull(proposalBallots.closedAt),
            lte(proposalBallots.deadlineAt, now),
          ),
        )
        .run();
    },
    openBallot() {
      return db
        .select()
        .from(proposalBallots)
        .where(and(eq(proposalBallots.channelId, channelId), isNull(proposalBallots.closedAt)))
        .get();
    },
    ballotByNumber(number: number) {
      return db
        .select()
        .from(proposalBallots)
        .where(and(eq(proposalBallots.channelId, channelId), eq(proposalBallots.number, number)))
        .get();
    },
    ballot(id: string) {
      return db
        .select()
        .from(proposalBallots)
        .where(and(eq(proposalBallots.channelId, channelId), eq(proposalBallots.id, id)))
        .get();
    },
    ballots(limit = 5) {
      return db
        .select()
        .from(proposalBallots)
        .where(eq(proposalBallots.channelId, channelId))
        .orderBy(desc(proposalBallots.createdAt), desc(proposalBallots.id))
        .limit(limit)
        .all();
    },
    insertBallot(row: Omit<typeof proposalBallots.$inferInsert, 'channelId' | 'number'>) {
      const number =
        (db
          .select({ n: max(proposalBallots.number) })
          .from(proposalBallots)
          .where(eq(proposalBallots.channelId, channelId))
          .get()?.n ?? 0) + 1;
      db.insert(proposalBallots)
        .values({ ...row, number, channelId })
        .run();
    },
    closeBallot(id: string, revision: number, at: number) {
      return (
        db
          .update(proposalBallots)
          .set({ closedAt: at, revision: revision + 1 })
          .where(
            and(
              eq(proposalBallots.channelId, channelId),
              eq(proposalBallots.id, id),
              eq(proposalBallots.revision, revision),
              isNull(proposalBallots.closedAt),
            ),
          )
          .run().changes === 1
      );
    },
    options(ballotId: string) {
      return db
        .select()
        .from(proposalBallotOptions)
        .where(
          and(
            eq(proposalBallotOptions.channelId, channelId),
            eq(proposalBallotOptions.ballotId, ballotId),
          ),
        )
        .orderBy(asc(proposalBallotOptions.option))
        .limit(5)
        .all();
    },
    insertOption(row: Omit<typeof proposalBallotOptions.$inferInsert, 'channelId'>) {
      db.insert(proposalBallotOptions)
        .values({ ...row, channelId })
        .run();
    },
    vote(ballotId: string, accountId: string) {
      return db
        .select()
        .from(proposalVotes)
        .where(
          and(
            eq(proposalVotes.channelId, channelId),
            eq(proposalVotes.ballotId, ballotId),
            eq(proposalVotes.accountId, accountId),
          ),
        )
        .get();
    },
    voteCount(ballotId: string, option?: number) {
      return (
        db
          .select({ n: count() })
          .from(proposalVotes)
          .where(
            and(
              eq(proposalVotes.channelId, channelId),
              eq(proposalVotes.ballotId, ballotId),
              option === undefined ? undefined : eq(proposalVotes.option, option),
            ),
          )
          .get()?.n ?? 0
      );
    },
    insertVote(row: Omit<typeof proposalVotes.$inferInsert, 'channelId'>) {
      db.insert(proposalVotes)
        .values({ ...row, channelId })
        .run();
    },
    selection(id: string) {
      return db
        .select()
        .from(proposalSelections)
        .where(and(eq(proposalSelections.channelId, channelId), eq(proposalSelections.id, id)))
        .get();
    },
    selections(limit = 50) {
      return db
        .select()
        .from(proposalSelections)
        .where(eq(proposalSelections.channelId, channelId))
        .orderBy(desc(proposalSelections.createdAt), desc(proposalSelections.id))
        .limit(limit)
        .all();
    },
    authorizedSelections(limit = 5) {
      return db
        .select({ selection: proposalSelections })
        .from(proposalSelections)
        .innerJoin(
          proposals,
          and(eq(proposals.id, proposalSelections.proposalId), eq(proposals.channelId, channelId)),
        )
        .where(
          and(
            eq(proposalSelections.channelId, channelId),
            isNull(proposalSelections.revokedAt),
            eq(proposals.revision, proposalSelections.proposalRevision),
            ne(proposals.state, 'hidden'),
            ne(proposals.state, 'pending'),
          ),
        )
        .orderBy(desc(proposalSelections.createdAt), desc(proposalSelections.id))
        .limit(limit)
        .all()
        .map((row) => row.selection);
    },
    insertSelection(row: Omit<typeof proposalSelections.$inferInsert, 'channelId'>) {
      db.insert(proposalSelections)
        .values({ ...row, channelId })
        .run();
    },
    revokeSelections(proposalId: string, at: number) {
      db.update(proposalSelections)
        .set({ revokedAt: at })
        .where(
          and(
            eq(proposalSelections.channelId, channelId),
            eq(proposalSelections.proposalId, proposalId),
            isNull(proposalSelections.revokedAt),
          ),
        )
        .run();
    },
    revokeSelection(id: string, at: number) {
      db.update(proposalSelections)
        .set({ revokedAt: at })
        .where(
          and(
            eq(proposalSelections.channelId, channelId),
            eq(proposalSelections.id, id),
            isNull(proposalSelections.revokedAt),
          ),
        )
        .run();
    },
  };
}
