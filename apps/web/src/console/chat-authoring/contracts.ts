import { z } from 'zod';

const codeStatus = z.enum([
  'active',
  'approved',
  'failed',
  'rejected',
  'revoked',
  'expired',
  'invalidated',
]);

/** Boundary shape of `GET /api/chat-authoring`; unknown fields are ignored. */
export const chatAuthoringSchema = z.object({
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
  replies: z.object({
    available: z.boolean(),
    reason: z.string().max(400).nullable(),
    lastError: z.string().max(400).nullable(),
  }),
  pending: z
    .object({
      kind: z.enum(['create', 'edit']),
      intent: z.string().max(600),
      runId: z.string(),
      requestedAt: z.number(),
      status: z.enum(['compiling', 'awaiting']),
    })
    .nullable(),
  activeCode: z
    .object({
      id: z.string(),
      code: z.string().max(8),
      versionId: z.string(),
      issuedAt: z.number(),
      expiresAt: z.number(),
    })
    .nullable(),
  recentCodes: z
    .array(
      z.object({
        id: z.string(),
        code: z.string().max(8),
        versionId: z.string(),
        status: codeStatus,
        closedAt: z.number().nullable(),
        reason: z.string().max(600).nullable(),
      }),
    )
    .max(20),
  candidates: z
    .array(
      z.object({
        versionId: z.string(),
        kind: z.enum(['create', 'edit']),
        requestedAt: z.number(),
      }),
    )
    .max(100),
  limits: z.object({
    compilesPerWindow: z.number(),
    compileWindowMs: z.number(),
    compilesUsed: z.number(),
    codeTtlMs: z.number(),
  }),
  lockedUntil: z.number().nullable(),
  now: z.number(),
});
export type ChatAuthoring = z.infer<typeof chatAuthoringSchema>;
export type CodeStatus = z.infer<typeof codeStatus>;

export const CODE_STATUS_LABEL: Record<CodeStatus, string> = {
  active: 'Waiting',
  approved: 'Approved from chat',
  failed: 'Refused',
  rejected: 'Rejected from chat',
  revoked: 'Withdrawn',
  expired: 'Expired',
  invalidated: 'Invalidated',
};

/** m:ss for a countdown; never negative. */
export function formatRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
