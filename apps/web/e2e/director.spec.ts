import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { DirectorState } from '../src/console/director/contracts.js';
// Browser protocol fixture; server tests exercise isolated sandbox evidence and approval.
test('private burst review approves the exact draft and stop remains immediate', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settings = { intervalMs: 1500, batchSize: 1, intensity: 35 };
  const telemetry = {
    mode: 'balanced' as const,
    settings,
    accepted: 3,
    offered: 3,
    presented: 1,
    coalesced: 2,
    expired: 0,
    cleared: 0,
    pending: 0,
    decisions: [
      {
        at: 1500,
        reason: 'Synthetic burst: preserve readability',
        settings,
        pending: 0,
        activity: 3,
      },
    ],
  };
  let state: DirectorState = {
    revision: 0,
    draft: null,
    approved: null,
    enabled: false,
    mode: 'balanced',
    settings: null,
    history: [],
    telemetry: null,
  };
  await page.route('**/api/director**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.replace('/api/director', '');
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    if (suffix === '/draft')
      state = {
        ...state,
        revision: state.revision + 1,
        draft: { revision: 1, digest: 'a'.repeat(64), envelope: body.envelope, evidence: null },
      };
    if (suffix === '/rehearse')
      state = {
        ...state,
        revision: state.revision + 1,
        draft: {
          ...state.draft!,
          evidence: {
            hash: 'b'.repeat(64),
            digest: state.draft!.digest,
            versionId: body.versionId,
            artifactId: 'c'.repeat(64),
            scenarioHash: 'd'.repeat(64),
            rehearsalHash: 'e'.repeat(64),
            passed: true,
            accepted: 3,
            blocked: 2,
            scores: { community: 3 },
            contributions: 3,
            stateDigest: 'same',
            replayStateDigest: 'same',
            telemetry,
            samples: [
              {
                at: 1500,
                frames: [
                  {
                    id: 'effect',
                    asset: 'star',
                    x: 0.5,
                    viewer: 'Synthetic viewer',
                    intensity: 35,
                  },
                ],
              },
            ],
            provenance: 'synthetic',
          },
        },
      };
    if (suffix === '/approve') {
      expect(body).toEqual({
        expectedRevision: state.revision,
        digest: 'a'.repeat(64),
        evidenceHash: 'b'.repeat(64),
      });
      state = {
        ...state,
        revision: state.revision + 1,
        approved: { ...state.draft!, evidenceHash: body.evidenceHash, approvedAt: 100 },
        enabled: true,
        settings,
        telemetry,
      };
    }
    if (suffix === '/stop') {
      expect(body).toEqual({});
      state = { ...state, revision: state.revision + 1, enabled: false };
    }
    await route.fulfill({ json: { state } });
  });
  await page.goto('/');
  const fresh = page.getByRole('button', { name: 'New idea' });
  if (await fresh.isVisible()) await fresh.click();
  await page
    .getByLabel('Describe the interaction in one or two sentences')
    .fill(
      'Let viewers throw tomatoes with !director, limited to three throws per person in any rolling 60 seconds.',
    );
  await page
    .getByRole('button', { name: /^Generate/ })
    .first()
    .click();
  await expect(page.getByText('Ready to review')).toBeVisible({ timeout: 30000 });
  const panel = page.getByRole('region', { name: 'Adaptive director' });
  await expect(panel.getByText('Not set up')).toBeVisible();
  await panel.getByRole('button', { name: /Adaptive director/ }).click();
  await panel.getByLabel('Visual intensity during a burst').fill('40');
  await panel.getByRole('button', { name: 'Save draft only' }).click();
  await panel.getByLabel('Stress-test version').selectOption({ index: 1 });
  await panel.getByRole('button', { name: 'Run private synthetic burst' }).click();
  await expect(panel.getByText(/Final scores: community: 3/)).toBeVisible();
  await expect(panel.locator('[data-projectile=star]')).toHaveCount(1);
  expect(
    (await new AxeBuilder({ page }).include('[aria-label="Adaptive director"]').analyze())
      .violations,
  ).toEqual([]);
  await panel.getByRole('button', { name: 'Approve exact tested envelope' }).click();
  await expect(panel.getByText('Adapting · Balanced')).toBeVisible();
  await expect(panel.getByText('This exact draft is approved and adapting live.')).toBeVisible();
  await panel.getByRole('button', { name: 'Stop director cosmetics immediately' }).first().click();
  await expect(panel.getByText('Approved · stopped')).toBeVisible();
});
