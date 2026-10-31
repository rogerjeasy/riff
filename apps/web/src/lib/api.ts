import { z } from 'zod';
import type { PreviewResult, Run, Studio } from './types.js';

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
// Boundary validation: shape-check the envelope; nested evidence is rendered defensively.
const studioSchema = z
  .object({
    panic: z.boolean(),
    automations: z.array(
      z
        .object({ id: z.string(), versions: z.array(z.object({ id: z.string() }).passthrough()) })
        .passthrough(),
    ),
    activity: z.array(z.object({ id: z.number(), message: z.string() }).passthrough()),
    compiler: z.object({ kind: z.enum(['codex', 'offline']) }).passthrough(),
    runs: z.array(z.object({ id: z.string(), stage: z.string() }).passthrough()),
    twitch: z.object({ state: z.string() }).passthrough(),
  })
  .passthrough();
const previewSchema = z.object({
  provenance: z.literal('synthetic'),
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  seed: z.number(),
  durationMs: z.number(),
  decisions: z
    .array(
      z
        .object({
          code: z.string(),
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

async function request<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        method === 'POST' ? { 'Content-Type': 'application/json', 'x-riff-request': '1' } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      'Riff’s local server is not reachable. Start it with pnpm dev.',
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
  approve: (versionId: string, artifactId: string, expectedActiveVersionId: string | null) =>
    request('POST', `/api/versions/${versionId}/approve`, { artifactId, expectedActiveVersionId }),
  discard: (versionId: string) => request('POST', `/api/versions/${versionId}/discard`, {}),
  automation: (id: string, action: 'pause' | 'resume' | 'rollback') =>
    request('POST', `/api/automations/${id}/${action}`, {}),
  panic: () => request('POST', '/api/channel/panic', {}),
  resume: () => request('POST', '/api/channel/resume', { confirm: true }),
  overlay: () => request<{ url: string; connections: number }>('GET', '/api/overlay'),
  testOverlay: () => request<{ delivered: number }>('POST', '/api/overlay/test', {}),
  rotateOverlay: () => request<{ url: string }>('POST', '/api/overlay/rotate', {}),
  disconnectTwitch: () => request('POST', '/api/twitch/disconnect', {}),
};
