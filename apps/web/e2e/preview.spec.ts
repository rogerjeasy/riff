import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('private replay explains quotas, independent viewers, duplicates and time advancement', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tomato Toss' })).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Send command' }).click();
    await expect(page.getByTestId('decision')).toHaveCount(i + 1);
  }
  await expect(page.getByTestId('decision').last()).toContainText('VIEWER_LIMIT');
  await expect(page.getByTestId('projectile')).toHaveCount(3);
  await page.getByLabel('Viewer').selectOption('bob');
  await page.getByRole('button', { name: 'Send command' }).click();
  await expect(page.getByTestId('decision')).toHaveCount(5);
  await expect(page.getByTestId('projectile')).toHaveCount(4);
  await page.getByRole('button', { name: 'Replay last event' }).click();
  await expect(page.getByTestId('decision').last()).toContainText('DUPLICATE');
  await expect(page.getByTestId('projectile')).toHaveCount(4);
  await page.getByRole('button', { name: 'Advance 60 seconds' }).click();
  await page.getByLabel('Viewer').selectOption('alice');
  await page.getByRole('button', { name: 'Send command' }).click();
  await expect(page.getByTestId('projectile')).toHaveCount(5);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await expect(page.getByRole('button', { name: 'Send command' })).toBeDisabled();
  await expect(page.getByTestId('projectile')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset preview' }).click();
  await expect(page.getByTestId('decision')).toHaveCount(0);
});
