import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('console identifies the foundation and reports real host readiness', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your next live idea starts here.' }),
  ).toBeVisible();
  await expect(page.getByText('Local host ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /approve|connect|generate/i })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('failed health requests remain a visible recoverable state', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByText('Local host unavailable', { exact: true })).toBeVisible();
});

test('overlay is transparent and contains no console controls', async ({ page }) => {
  await page.goto('/overlay/');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#overlay-root')).toHaveAttribute('data-mode', 'inactive');
});

test('dock has its own compact entry', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto('/dock/');
  await expect(page.getByRole('heading', { name: 'Riff control dock' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
