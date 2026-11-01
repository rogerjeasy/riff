import { z } from 'zod';
const count = z.number().int().nonnegative();
const id = z.string().max(128);
export const proposalSchema = z.object({
  id,
  channelId: id,
  text: z.string().max(500),
  normalizedText: z.string().max(500),
  number: count.optional(),
  state: z.enum(['pending', 'shortlisted', 'hidden', 'selected']),
  revision: count,
  createdAt: count,
  updatedAt: count,
  contributorCount: count.max(1000).optional(),
});
export const selectionSchema = z.object({
  id,
  channelId: id,
  proposalId: id,
  proposalRevision: count,
  brief: z.string().max(500),
  baseVersionId: id.nullable(),
  createdAt: count,
  revokedAt: count.nullable(),
});
export const ballotSchema = z.object({
  id,
  channelId: id,
  number: count.optional(),
  revision: count,
  createdAt: count,
  deadlineAt: count,
  closedAt: count.nullable(),
  options: z
    .array(
      z.object({
        id,
        channelId: id,
        ballotId: id,
        proposalId: id,
        option: z.number().int().min(1).max(5),
        votes: count.max(10000),
      }),
    )
    .max(5)
    .optional(),
});
export const historySchema = z.object({
  id: count,
  channelId: id,
  proposalId: id,
  actor: z.string().max(200),
  action: z.string().max(50),
  revision: count,
  at: count,
});
export const proposalSnapshotSchema = z.object({
  proposals: z.array(proposalSchema).max(50),
  grants: z.array(z.object({ id, channelId: id, accountId: id, createdAt: count })).max(100),
  ballots: z.array(ballotSchema).max(50),
  selections: z.array(selectionSchema).max(50),
  counts: z
    .object({ pending: count, shortlisted: count, selected: count, hidden: count })
    .optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalSelection = z.infer<typeof selectionSchema>;
export type ProposalSnapshot = z.infer<typeof proposalSnapshotSchema>;
export type ProposalHistory = z.infer<typeof historySchema>;
