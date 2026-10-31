import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';

test('describe → test → preview → approve → play, then a verified edit', async ({ page }) => {
  // Reduced motion: exercises the accessible path and keeps axe from sampling mid-fade.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'What should your chat be able to do?' }),
  ).toBeVisible();
  await page.getByLabel('Describe the interaction in one or two sentences').fill(TOMATO);
  await page.getByRole('button', { name: /^Generate/ }).click();
  await expect(page.getByText('Ready to review')).toBeVisible({ timeout: 30_000 });

  // Test: real evidence, five facts, intent comparison.
  await expect(page.getByRole('heading', { name: 'Tomato Toss v1' })).toBeVisible();
  await expect(page.getByText(/Verified · \d+\/\d+ checks/)).toBeVisible();
  await expect(page.getByRole('row', { name: /Per-viewer allowance 3 3/ })).toContainText(
    'Matches what you said',
  );

  // Preview: three accepted, fourth blocked, another viewer independent, duplicate ignored.
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('decision')).toHaveCount(i + 1);
  }
  await expect(page.getByTestId('decision').first()).toContainText('Limit reached');
  await page.getByRole('button', { name: /Bob/ }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('decision').first()).toContainText('Thrown');
  await page.getByRole('button', { name: 'Redeliver last' }).click();
  await expect(page.getByTestId('decision').first()).toContainText('Duplicate');
  await expect(page.getByText('Private · not on stream')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Approve the exact version.
  await page.getByRole('button', { name: 'Approve v1 & go live' }).click();
  await expect(page.getByText('This exact version is live.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live · 1' })).toBeVisible();

  // Edit command, cooldown and audience through the same pipeline.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: /^Generate change/ }).click();
  await expect(page.getByRole('heading', { name: /Tomato Toss v2/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Changes from live v1')).toBeVisible();
  await expect(page.locator('.changes')).toContainText('!splat');
  await expect(page.locator('.changes')).toContainText('subscribers');
  // A shorter window grants more authority: approval needs explicit consent.
  await expect(page.getByRole('button', { name: 'Approve v2 & replace v1' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /grants more authority/ }).check();
  await page.getByRole('button', { name: 'Approve v2 & replace v1' }).click();
  await expect(page.getByText('This exact version is live.')).toBeVisible();
  await page.getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByText('Rolled back to the previous approved version.')).toBeVisible();

  // Emergency stop.
  await page.getByRole('button', { name: /Stop everything/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Everything is stopped' })).toBeVisible();
  await page.getByRole('button', { name: /Resume…/ }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: /Stop everything/ })).toBeVisible();
});

test('overlay is transparent, read-only and refuses a wrong key', async ({ page }) => {
  await page.goto('/overlay/?key=wrong');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#overlay-root')).toHaveAttribute('data-mode', 'unauthorized');
});

test('dock keeps the stop control reachable at OBS dock width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto('/dock/');
  await expect(page.getByRole('heading', { name: 'Riff control dock' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Stop everything|Resume/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
