import { z } from 'zod';
import { request } from '../../lib/api.js';
import {
  statusSchema,
  sharedViewSchema,
  reviewSchema,
  memberSchema,
  issuedInvitationSchema,
  type SharedRole,
} from '../../collaboration/schema.js';
// Console lives two levels below src; use explicit browser-only HTTP boundaries.
const post = (suffix: string, body: unknown, signal?: AbortSignal) =>
  request('POST', `/api/collaboration/${suffix}`, body, signal);
export const collaborationApi = {
  async status(signal?: AbortSignal) {
    return statusSchema.parse(await request('GET', '/api/collaboration', undefined, signal));
  },
  async create(versionId: string, roles: SharedRole[], signal?: AbortSignal) {
    return z
      .object({ session: sharedViewSchema })
      .parse(await post('create', { versionId, roles }, signal)).session;
  },
  async invite(sessionId: string, roleId: string, signal?: AbortSignal) {
    return issuedInvitationSchema.parse(await post('invite', { sessionId, roleId }, signal));
  },
  async ownerReview(sessionId: string, signal?: AbortSignal) {
    return z
      .object({ review: reviewSchema })
      .parse(await post('review-owner', { sessionId }, signal)).review;
  },
  async review(origin: string, token: string, signal?: AbortSignal) {
    return z.object({ review: reviewSchema }).parse(await post('review', { origin, token }, signal))
      .review;
  },
  async recheck(signal?: AbortSignal) {
    return z.object({ review: reviewSchema }).parse(await post('recheck', {}, signal)).review;
  },
  async approve(digest: string, signal?: AbortSignal) {
    return z.object({ member: memberSchema }).parse(await post('approve', { digest }, signal))
      .member;
  },
  async control(
    sessionId: string,
    expectedRevision: number,
    action: 'start' | 'pause' | 'resume',
    signal?: AbortSignal,
  ) {
    return z
      .object({ session: sharedViewSchema })
      .parse(await post('control', { sessionId, expectedRevision, action }, signal)).session;
  },
  leave: (signal?: AbortSignal) => post('leave', {}, signal),
};
