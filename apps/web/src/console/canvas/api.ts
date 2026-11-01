import { z } from 'zod';
import { request } from '../../lib/api.js';
import { sceneStateSchema, type Scene } from '../../scenes/schema.js';
const response = z.object({ state: sceneStateSchema }).strict();
const path = (id: string) => `/api/scenes/${encodeURIComponent(id)}`;
export const sceneApi = {
  async read(id: string, signal?: AbortSignal) {
    return response.parse(await request('GET', path(id), undefined, signal)).state;
  },
  async save(id: string, expectedRevision: number, scene: Scene, signal?: AbortSignal) {
    return response.parse(
      await request('POST', path(id), { expectedRevision, scene, source: 'direct' }, signal),
    ).state;
  },
  async generate(
    id: string,
    expectedRevision: number,
    selectionId: string,
    intent: string,
    signal?: AbortSignal,
  ) {
    return response.parse(
      await request(
        'POST',
        `${path(id)}/generate`,
        { expectedRevision, selectionId, intent },
        signal,
      ),
    ).state;
  },
  async undo(id: string, expectedRevision: number, targetRevision: number, signal?: AbortSignal) {
    return response.parse(
      await request('POST', `${path(id)}/undo`, { expectedRevision, targetRevision }, signal),
    ).state;
  },
  async apply(id: string, expectedRevision: number, digest: string, signal?: AbortSignal) {
    return response.parse(
      await request('POST', `${path(id)}/apply`, { expectedRevision, digest }, signal),
    ).state;
  },
};
