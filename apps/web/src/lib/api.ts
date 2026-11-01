import { z } from 'zod';
import {
  scenarioSchema,
  scenarioRecordSchema,
  rehearsalRunSchema,
  regressionSchema,
  type RehearsalScenario,
  type presets,
} from '../console/rehearsal/contracts.js';
import { communitySchema } from '../community/schema.js';
import {
  proposalSchema,
  proposalSnapshotSchema,
  historySchema,
  selectionSchema,
  ballotSchema,
  type Proposal,
} from '../console/proposals/contracts.js';
import { experienceDefinitionSchema, sessionSnapshotSchema } from '../sessions/schemas.js';
import type {
  PreviewResult,
  Run,
  SessionAudit,
  Studio,
  Transition,
  TransitionBoundary,
} from './types.js';

/** Thrown with a user-safe message; never contains stack traces. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}
const errorBody = z.object({ message: z.string().max(400), code: z.string().optional() });
const boundarySchema = z.enum(['immediate', 'round-end', 'stopped']);
const transitionSummarySchema = z
  .object({
    id: z.string(),
    status: z.enum(['review', 'pending', 'applied', 'cancelled']),
    sourceVersionId: z.string(),
    targetVersionId: z.string(),
    boundary: boundarySchema.optional(),
  })
  .passthrough();
// Boundary validation: shape-check the envelope; nested evidence is rendered defensively.
const studioSchema = z
  .object({
    proposals: proposalSnapshotSchema.optional(),
    community: communitySchema.nullable().optional(),
    panic: z.boolean(),
    automations: z.array(
      z
        .object({
          id: z.string(),
          session: sessionSnapshotSchema.nullable().default(null),
          transitions: z.array(transitionSummarySchema).max(64).default([]),
          versions: z.array(
            z
              .object({
                id: z.string(),
                manifest: z
                  .object({ experience: experienceDefinitionSchema.nullable().optional() })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    activity: z.array(z.object({ id: z.number(), message: z.string() }).passthrough()),
    compiler: z.object({ kind: z.enum(['codex', 'offline']) }).passthrough(),
    runs: z.array(z.object({ id: z.string(), stage: z.string() }).passthrough()),
    twitch: z.object({ state: z.string() }).passthrough(),
  })
  .passthrough();
const count = z.number().int().nonnegative();
const auditSchema = z.object({
  audit: z
    .object({
      status: z.enum(['verified', 'diverged', 'unavailable']),
      sessionId: z.string().max(100),
      summary: z.string().max(400),
      entries: count,
      joins: count,
      contributions: count,
      rejections: count,
      controls: count,
      durationMs: count,
      divergence: z
        .object({
          seq: count,
          kind: z.string().max(20),
          expected: z.string().max(100),
          actual: z.string().max(100),
        })
        .nullable(),
    })
    .passthrough(),
});
const previewSchema = z.object({
  provenance: z.literal('synthetic'),
  session: sessionSnapshotSchema.optional(),
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  seed: z.number(),
  durationMs: z.number(),
  decisions: z
    .array(
      z
        .object({
          code: z.string(),
          session: sessionSnapshotSchema.optional(),
          effects: z.array(
            z
              .object({ asset: z.enum(['tomato', 'star', 'heart']), x: z.number().min(0).max(1) })
              .passthrough(),
          ),
        })
        .passthrough(),
    )
    .max(120),
});

const transitionDecision = z
  .object({
    code: z.string().max(50),
    reason: z.string().max(256),
    effects: z.array(z.unknown()).max(4),
  })
  .passthrough();
const transitionSchema = z
  .object({
    id: z.string(),
    sourceVersionId: z.string(),
    targetVersionId: z.string(),
    sourceSessionId: z.string(),
    migrationSource: z.string().max(32768),
    evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['review', 'pending', 'applied', 'cancelled']),
    plan: z
      .object({
        targetArtifactId: z.string().regex(/^[a-f0-9]{64}$/),
        boundary: z.enum(['immediate', 'round-end', 'stopped']),
      })
      .passthrough(),
    evidence: z
      .object({
        preserved: z.array(z.string()),
        changed: z.array(
          z.object({
            field: z.string(),
            label: z.string(),
            from: z.string(),
            to: z.string(),
            authority: z.enum(['more', 'less', 'same']),
          }),
        ),
        reset: z.array(z.string()),
        takesEffect: z.enum(['immediate', 'round-end', 'stopped']),
        beforeRules: z.object({
          definition: experienceDefinitionSchema,
          audience: z.array(z.string()),
        }),
        afterRules: z.object({
          definition: experienceDefinitionSchema,
          audience: z.array(z.string()),
        }),
        migration: z
          .object({ before: sessionSnapshotSchema, after: sessionSnapshotSchema })
          .passthrough(),
        comparison: z
          .object({
            provenance: z.literal('synthetic'),
            label: z.string(),
            events: z
              .array(z.object({ id: z.string(), text: z.string().max(500) }).passthrough())
              .max(24),
            steps: z
              .array(
                z.object({
                  eventId: z.string(),
                  before: transitionDecision,
                  after: transitionDecision,
                }),
              )
              .max(24),
            before: sessionSnapshotSchema,
            after: sessionSnapshotSchema,
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
async function transitionRequest(url: string, body: unknown): Promise<Transition> {
  return z.object({ transition: transitionSchema }).parse(await request('POST', url, body))
    .transition as unknown as Transition;
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        method !== 'GET' ? { 'Content-Type': 'application/json', 'x-riff-request': '1' } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      // Works for both a local dev server and a hosted instance.
      'Riff’s server is not reachable. Check that it is running and you are online, then refresh.',
      0,
      'OFFLINE',
    );
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorBody.safeParse(json);
    throw new ApiError(
      parsed.success ? parsed.data.message : 'Something went wrong. Try again.',
      response.status,
      parsed.success ? (parsed.data.code ?? null) : null,
    );
  }
  return json as T;
}

export const api = {
  async rehearsalScenario(id: string, signal?: AbortSignal) {
    return z
      .object({ scenario: scenarioRecordSchema })
      .strict()
      .parse(
        await request(
          'GET',
          `/api/rehearsals/scenarios/${encodeURIComponent(id)}`,
          undefined,
          signal,
        ),
      ).scenario;
  },
  async rehearsalScenarios(signal?: AbortSignal) {
    return z
      .object({ scenarios: z.array(scenarioRecordSchema).max(50) })
      .strict()
      .parse(await request('GET', '/api/rehearsals/scenarios', undefined, signal)).scenarios;
  },
  async rehearsalSave(
    input:
      | { name: string; scenario: RehearsalScenario; sourceRunId?: string }
      | { name: string; recording: { versionId: string; sessionId: string; seed: number } },
    saved?: { id: string; revision: number },
    signal?: AbortSignal,
  ) {
    return z
      .object({ scenario: scenarioRecordSchema })
      .strict()
      .parse(
        await request(
          saved ? 'PUT' : 'POST',
          `/api/rehearsals/scenarios${saved ? '/' + encodeURIComponent(saved.id) : ''}`,
          { ...input, ...(saved ? { expectedRevision: saved.revision } : {}) },
          signal,
        ),
      ).scenario;
  },
  rehearsalDeleteScenario: (id: string, expectedRevision: number, signal?: AbortSignal) =>
    request(
      'DELETE',
      `/api/rehearsals/scenarios/${encodeURIComponent(id)}`,
      { expectedRevision },
      signal,
    ),
  async rehearsalPreset(
    versionId: string,
    preset: (typeof presets)[number],
    seed: number,
    signal?: AbortSignal,
  ) {
    return z
      .object({ scenario: scenarioSchema })
      .strict()
      .parse(await request('POST', '/api/rehearsals/presets', { versionId, preset, seed }, signal))
      .scenario;
  },
  async rehearsalRecording(
    versionId: string,
    sessionId: string,
    seed: number,
    signal?: AbortSignal,
  ) {
    return z
      .object({ scenario: scenarioSchema })
      .strict()
      .parse(
        await request('POST', '/api/rehearsals/recordings', { versionId, sessionId, seed }, signal),
      ).scenario;
  },
  async rehearsalRun(
    id: string,
    input: {
      expectedRevision: number;
      versionId: string;
      compareVersionId?: string;
      through?: number;
      freshStart?: boolean;
    },
    signal?: AbortSignal,
  ) {
    return z
      .object({ run: rehearsalRunSchema })
      .strict()
      .parse(
        await request(
          'POST',
          `/api/rehearsals/scenarios/${encodeURIComponent(id)}/run`,
          input,
          signal,
        ),
      ).run;
  },
  async rehearsalMinimize(
    id: string,
    side: 'primary' | 'compare',
    checkId: string,
    signal?: AbortSignal,
  ) {
    return z
      .object({ run: rehearsalRunSchema })
      .strict()
      .parse(
        await request(
          'POST',
          `/api/rehearsals/runs/${encodeURIComponent(id)}/minimize`,
          { side, checkId },
          signal,
        ),
      ).run;
  },
  async rehearsalRegressions(signal?: AbortSignal) {
    return z
      .object({ regressions: z.array(regressionSchema).max(50) })
      .strict()
      .parse(await request('GET', '/api/rehearsals/regressions', undefined, signal)).regressions;
  },
  async rehearsalSaveRegression(
    name: string,
    runId: string,
    checkId: string,
    signal?: AbortSignal,
  ) {
    return z
      .object({ regression: regressionSchema })
      .strict()
      .parse(await request('POST', '/api/rehearsals/regressions', { name, runId, checkId }, signal))
      .regression;
  },
  rehearsalDeleteRegression: (id: string, signal?: AbortSignal) =>
    request('DELETE', `/api/rehearsals/regressions/${encodeURIComponent(id)}`, {}, signal),
  async rehearsalRerun(id: string, versionId: string, signal?: AbortSignal) {
    return z
      .object({ run: rehearsalRunSchema })
      .strict()
      .parse(
        await request(
          'POST',
          `/api/rehearsals/regressions/${encodeURIComponent(id)}/run`,
          { versionId },
          signal,
        ),
      ).run;
  },
  rehearsalRepair: (id: string, intent: string, signal?: AbortSignal) =>
    request<Run>(
      'POST',
      `/api/rehearsals/regressions/${encodeURIComponent(id)}/repair`,
      { intent },
      signal,
    ),
  async proposals(
    input: { state?: Proposal['state']; offset: number; limit: number },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ offset: String(input.offset), limit: String(input.limit) });
    if (input.state) query.set('state', input.state);
    return proposalSnapshotSchema.parse(
      await request('GET', `/api/proposals?${query}`, undefined, signal),
    );
  },
  async proposalHistory(id: string, offset: number, signal?: AbortSignal) {
    return z
      .object({ history: z.array(historySchema).max(50) })
      .parse(
        await request(
          'GET',
          `/api/proposals/${encodeURIComponent(id)}/history?offset=${offset}&limit=50`,
          undefined,
          signal,
        ),
      );
  },
  async moderateProposal(
    id: string,
    expectedRevision: number,
    action: 'shortlist' | 'hide' | 'restore',
  ) {
    return z.object({ proposal: proposalSchema }).parse(
      await request('POST', `/api/proposals/${encodeURIComponent(id)}/moderate`, {
        expectedRevision,
        action,
      }),
    );
  },
  proposalGrant: (accountId: string, enabled: boolean) =>
    request<{ ok: true }>('POST', '/api/proposals/grants', { accountId, enabled }),
  async createProposalBallot(
    proposalIds: { id: string; revision: number }[],
    durationSeconds: number,
  ) {
    return z
      .object({ ballot: ballotSchema })
      .parse(await request('POST', '/api/proposals/ballots', { proposalIds, durationSeconds }));
  },
  async closeProposalBallot(id: string, expectedRevision: number) {
    return z.object({ ballot: ballotSchema }).parse(
      await request('POST', `/api/proposals/ballots/${encodeURIComponent(id)}/close`, {
        expectedRevision,
      }),
    );
  },
  async selectProposal(
    id: string,
    expectedRevision: number,
    brief: string,
    baseVersionId: string | null,
  ) {
    return z.object({ selection: selectionSchema }).parse(
      await request('POST', `/api/proposals/${encodeURIComponent(id)}/select`, {
        expectedRevision,
        brief,
        baseVersionId,
      }),
    );
  },
  async revokeSelection(id: string) {
    return z
      .object({ selection: selectionSchema })
      .parse(
        await request('POST', `/api/proposals/selections/${encodeURIComponent(id)}/revoke`, {}),
      );
  },
  generateSelection: (id: string) =>
    request<Run>('POST', `/api/proposals/selections/${encodeURIComponent(id)}/generate`, {}),
  async studio(signal?: AbortSignal) {
    return studioSchema.parse(
      await request('GET', '/api/studio', undefined, signal),
    ) as unknown as Studio;
  },
  generate: (intent: string, baseVersionId: string | null) =>
    request<Run>('POST', '/api/compile-runs', { intent, baseVersionId }),
  cancel: (id: string) => request<Run>('POST', `/api/compile-runs/${id}/cancel`, {}),
  async preview(versionId: string, events: unknown[], seed: number, signal?: AbortSignal) {
    return previewSchema.parse(
      await request('POST', `/api/versions/${versionId}/preview`, { seed, events }, signal),
    ) as unknown as PreviewResult;
  },
  previewTransition: (versionId: string, boundary: TransitionBoundary, migrationSource?: string) =>
    transitionRequest(`/api/versions/${versionId}/transition/preview`, {
      boundary,
      ...(migrationSource ? { migrationSource } : {}),
    }),
  approveTransition: (t: Transition) =>
    transitionRequest(`/api/transitions/${t.id}/approve`, {
      evidenceId: t.evidenceId,
      artifactId: t.plan.targetArtifactId,
      expectedActiveVersionId: t.sourceVersionId,
      sessionId: t.sourceSessionId,
      boundary: t.plan.boundary,
    }),
  cancelTransition: (id: string) => transitionRequest(`/api/transitions/${id}/cancel`, {}),
  approve: (
    versionId: string,
    artifactId: string,
    expectedActiveVersionId: string | null,
    resetSession = false,
  ) =>
    request('POST', `/api/versions/${versionId}/approve`, {
      artifactId,
      expectedActiveVersionId,
      ...(resetSession ? { resetSession: true } : {}),
    }),
  discard: (versionId: string) => request('POST', `/api/versions/${versionId}/discard`, {}),
  automation: (id: string, action: 'pause' | 'resume' | 'rollback', resetSession = false) =>
    request('POST', `/api/automations/${id}/${action}`, resetSession ? { resetSession: true } : {}),
  resetSession: (id: string) =>
    request('POST', `/api/automations/${id}/session/reset`, { confirm: true }),
  auditSession: async (id: string): Promise<SessionAudit> =>
    auditSchema.parse(await request('POST', `/api/automations/${id}/session/audit`, {}))
      .audit as SessionAudit,
  async session(signal?: AbortSignal) {
    return z
      .object({ required: z.boolean(), authenticated: z.boolean() })
      .strict()
      .parse(await request('GET', '/api/session', undefined, signal));
  },
  login: (password: string) => request('POST', '/api/session/login', { password }),
  logout: () => request('POST', '/api/session/logout', {}),
  panic: () => request('POST', '/api/channel/panic', {}),
  resume: () => request('POST', '/api/channel/resume', { confirm: true }),
  overlay: () => request<{ url: string; connections: number }>('GET', '/api/overlay'),
  testOverlay: () => request<{ delivered: number }>('POST', '/api/overlay/test', {}),
  rotateOverlay: () => request<{ url: string }>('POST', '/api/overlay/rotate', {}),
  disconnectTwitch: () => request('POST', '/api/twitch/disconnect', {}),
};
