import { z } from 'zod';
const count = z.number().int().nonnegative();
const publicText = z.string().max(500);
const proposal = z.object({
  proposalId: z.string().max(128),
  number: count.optional(),
  text: publicText,
  authors: z.array(publicText).max(5),
});
export const communityBallotSchema = z.object({
  id: z.string().max(128),
  number: count.optional(),
  revision: count,
  deadlineAt: count,
  closedAt: count.nullable(),
  tied: z.boolean(),
  options: z
    .array(proposal.extend({ option: z.number().int().min(1).max(5), votes: count.max(10000) }))
    .max(5),
});
/** Deliberately strips unknown properties, including private data nested in options. */
export const communitySchema = z.object({
  commands: z.array(z.string().max(200)).max(3),
  creditNotice: publicText,
  ballot: communityBallotSchema.nullable(),
  outcomes: z.array(communityBallotSchema).max(5),
  selections: z
    .array(
      proposal.extend({
        id: z.string().max(128),
        selectedAt: count.optional(),
        status: z.enum(['selected', 'queued', 'generating', 'candidate', 'applied', 'failed']),
      }),
    )
    .max(5),
});
export type Community = z.infer<typeof communitySchema>;
