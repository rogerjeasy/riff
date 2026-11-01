import type { RecipeReport, RecipeReview } from '@riff/sdk';
import { RECIPE_LIMITS, RecipeError } from './contract.js';

type ReviewSlot = Pick<RecipeReview, 'sourceDigest' | 'targetVersionId'>;
const sameSlot = (left: ReviewSlot, right: ReviewSlot) =>
  left.sourceDigest === right.sourceDigest && left.targetVersionId === right.targetVersionId;

/**
 * Reviews that can go without losing evidence: never installed, and either failed or
 * replaced by a later review (or the incoming one) of the same source and destination.
 */
function disposableReviews(reviews: RecipeReview[], incoming: ReviewSlot) {
  return reviews.filter(
    (review, index) =>
      !review.installedVersionId &&
      (!review.passed ||
        sameSlot(review, incoming) ||
        reviews.slice(index + 1).some((later) => sameSlot(review, later))),
  );
}
const reviewLimit = () =>
  new RecipeError(
    'LIMIT',
    `This library already keeps ${RECIPE_LIMITS.reviews} installed or current remix reviews. Install or re-adapt an existing review before starting another.`,
  );

/** Fail before any compile/rehearsal work when a new review could not be stored. */
export function assertReviewRoom(reviews: RecipeReview[], incoming: ReviewSlot) {
  if (reviews.length >= RECIPE_LIMITS.reviews && !disposableReviews(reviews, incoming).length)
    throw reviewLimit();
}
/** Drop the oldest disposable reviews until the incoming one fits. */
export function makeReviewRoom(reviews: RecipeReview[], incoming: ReviewSlot) {
  const disposable = disposableReviews(reviews, incoming);
  while (reviews.length >= RECIPE_LIMITS.reviews) {
    const oldest = disposable.shift();
    if (!oldest) throw reviewLimit();
    reviews.splice(reviews.indexOf(oldest), 1);
  }
}

/** Keep the report inbox bounded: resolved reports go first, open reports are never dropped. */
export function makeReportRoom(reports: RecipeReport[], editionDigest: string) {
  const open = reports.filter(
    (report) => report.digest === editionDigest && report.status === 'open',
  ).length;
  if (open >= RECIPE_LIMITS.openReportsPerEdition)
    throw new RecipeError(
      'LIMIT',
      `This edition already has ${RECIPE_LIMITS.openReportsPerEdition} open reports waiting for the operator. Thank you — please check back after they are reviewed.`,
    );
  while (reports.length >= RECIPE_LIMITS.reports) {
    const resolved = reports.findIndex((report) => report.status === 'resolved');
    if (resolved < 0)
      throw new RecipeError(
        'LIMIT',
        'The report inbox is full while the operator reviews open reports. Please try again later.',
      );
    reports.splice(resolved, 1);
  }
}

/**
 * Record one report attempt for a hashed client key. Expired keys are evicted first; if
 * every remaining key is still active, the one seen least recently makes room.
 */
export function recordRateAttempt(
  rateKeys: Record<string, number[]>,
  key: string,
  now: number,
): Record<string, number[]> {
  const since = now - RECIPE_LIMITS.rateWindowMs;
  const recent = (times: number[]) => times.filter((time) => time > since);
  const own = recent(rateKeys[key] ?? []);
  if (own.length >= RECIPE_LIMITS.reportsPerClientPerHour)
    throw new RecipeError(
      'RATE',
      `You can send ${RECIPE_LIMITS.reportsPerClientPerHour} reports per hour. Please wait before sending another.`,
    );
  const active = Object.entries(rateKeys)
    .filter(([other]) => other !== key)
    .map(([other, times]) => [other, recent(times)] as const)
    .filter(([, times]) => times.length > 0)
    .sort(([, left], [, right]) => Math.max(...left) - Math.max(...right));
  const kept = active.slice(Math.max(0, active.length - (RECIPE_LIMITS.rateKeys - 1)));
  return { ...Object.fromEntries(kept), [key]: [...own, now] };
}
