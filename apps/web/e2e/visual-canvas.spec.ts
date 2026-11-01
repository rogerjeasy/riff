import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('canvas edits round-trip through review, rehearsal and the live scene', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  // Earlier specs share this database: start a fresh interaction if one is selected.
  const fresh = page.getByRole('button', { name: 'New idea' });
  if (await fresh.isVisible()) await fresh.click();
  await page
    .getByLabel('Describe the interaction in one or two sentences')
    .fill(
      'Let viewers throw tomatoes with !canvas, limited to three throws per person in any rolling 60 seconds.',
    );
  await page
    .getByRole('button', { name: /^Generate/ })
    .first()
    .click();
  await expect(page.getByText('Ready to review')).toBeVisible({ timeout: 30000 });
  const canvas = page.getByRole('region', { name: 'Visual canvas', exact: true });
  // The layout editor stays collapsed until the creator opens it for a candidate.
  await canvas.getByRole('button', { name: 'Edit layout' }).click();
  await expect(canvas.getByText(/Layout revision 0/)).toBeVisible();
  await canvas.getByRole('button', { name: 'Select effects', exact: true }).press('ArrowRight');
  await expect(canvas.getByLabel('X position')).toHaveValue('470');
  await canvas.getByRole('button', { name: 'Save layout' }).click();
  await expect(canvas.getByText(/Layout revision 1/)).toBeVisible();
  await canvas.getByLabel('Phone-size preview').check();
  await canvas.getByLabel('Reduced motion', { exact: true }).check();
  await canvas.getByRole('button', { name: 'Preview tomato' }).click();
  await expect(canvas.locator('[data-scene-kind=effects] [data-projectile]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('decision')).toHaveCount(1);
  await page.getByRole('button', { name: /Approve v\d+ & go live/ }).click();
  await canvas.getByLabel('I reviewed this layout and its changes').check();
  await canvas.getByRole('button', { name: 'Approve and apply layout' }).click();
  await expect(canvas.getByText('This layout is live')).toBeVisible();
  await canvas.getByRole('button', { name: 'Select effects', exact: true }).click();
  await canvas.getByLabel(/Describe a change/).fill('Move left by 10 units');
  await canvas.getByRole('button', { name: 'Draft this change' }).click();
  await expect(canvas.getByText(/Layout revision 2/)).toBeVisible();
  await expect(canvas.getByText(/a small move, ready to apply/)).toBeVisible();
  await canvas.getByRole('button', { name: 'Apply layout change' }).click();
  await expect(canvas.getByText('This layout is live')).toBeVisible();
  await expect(canvas.getByText(/Layout revision 2/)).toBeVisible();
  expect((await new AxeBuilder({ page }).include('.canvas-editor').analyze()).violations).toEqual(
    [],
  );
});
