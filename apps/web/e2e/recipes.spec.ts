import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('publish a pinned demo, remix privately, then hand a candidate to local review', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const fresh = page.getByRole('button', { name: 'New idea', exact: true });
  if (await fresh.isVisible()) await fresh.click();
  await page
    .getByLabel('Describe the interaction in one or two sentences')
    .fill(
      'Let viewers throw tomatoes with !recipepublish, limited to three throws per person in any rolling 60 seconds.',
    );
  await page
    .getByRole('button', { name: /^Generate/ })
    .first()
    .click();
  await expect(page.getByText('Ready to review')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Approve v1 & go live' }).click();
  await expect(page.getByText('This exact version is live.')).toBeVisible();
  const library = page.getByRole('region', { name: 'Recipe library' });
  await library.getByRole('button', { name: /^Recipe library/ }).click();
  await library.getByRole('tab', { name: 'Share an interaction' }).click();
  await library.getByLabel('Approved version').selectOption({ index: 1 });
  await library.getByLabel('Public title').fill('Portable tomatoes');
  await library.getByLabel('Public description').fill('Synthetic tomato demonstration');
  await library.getByLabel('Public author credit').fill('Example creator');
  await library.getByRole('checkbox', { name: /I have rights/ }).check();
  await library.getByRole('button', { name: 'Prepare sanitized export' }).click();
  await library.getByRole('button', { name: 'Publish this exact edition' }).click();
  await expect(library.getByRole('status')).toContainText(
    'This exact edition is now in your public directory.',
  );
  await expect(library.getByText('✓ Published')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include('[aria-label="Recipe library"]').analyze()).violations,
  ).toEqual([]);
  const directory = await context.newPage();
  await directory.emulateMedia({ reducedMotion: 'reduce' });
  await directory.goto('/recipes');
  await directory.getByRole('button', { name: 'Open Portable tomatoes' }).click();
  const detail = directory.getByRole('region', { name: 'Published recipe' });
  await expect(detail).toContainText('!recipepublish');
  await detail.getByRole('button', { name: 'Play sample chat' }).click();
  await expect(detail.locator('[data-projectile=tomato]')).toHaveCount(1);
  expect((await new AxeBuilder({ page: directory }).analyze()).violations).toEqual([]);
  // F27: the install link opens a guided, read-only review in the console. This channel's
  // own live !recipepublish makes the command conflict, so installing is blocked.
  await detail.getByRole('link', { name: 'Install in my console' }).click();
  await expect(directory).toHaveURL(/\/recipes\/install\?from=.*&digest=[a-f0-9]{64}$/);
  const install = directory.getByRole('region', { name: 'Install “Portable tomatoes”' });
  await expect(install).toContainText('digest verified');
  await expect(install).toContainText('Example creator');
  await expect(install.getByRole('list', { name: 'Compatibility checks' })).toContainText(
    'already used by a live interaction',
  );
  await expect(
    install.getByRole('button', { name: 'Install as private candidate' }),
  ).toBeDisabled();
  expect(
    (await new AxeBuilder({ page: directory }).include('.recipe-install').analyze()).violations,
  ).toEqual([]);
  await install.getByRole('button', { name: 'Cancel' }).first().click();
  await expect(directory).toHaveURL(/\/$/);
  await expect(directory.locator('.recipe-install')).toHaveCount(0);
  const response = await page.request.get('/api/recipes');
  const { state } = await response.json();
  await library.getByRole('tab', { name: /Remix into my channel/ }).click();
  await library.getByLabel('Recipe JSON').fill(JSON.stringify(state.publications[0].package));
  await library.getByRole('button', { name: 'Import pinned recipe' }).click();
  await expect(
    library.getByRole('heading', { name: 'Portable tomatoes · edition 1' }),
  ).toBeVisible();
  await library.getByLabel('Proposed command').fill('!reciperemix');
  await library.getByLabel('Instruction language').selectOption('fr');
  await library.getByLabel('Reduced motion for this installation').check();
  await library.getByRole('button', { name: 'Save channel profile' }).click();
  await expect(library.getByRole('status')).toContainText('Profile saved');
  await library.getByRole('button', { name: 'Make this fit my channel', exact: true }).click();
  const review = library.getByRole('region', { name: 'Recipe adaptation review' });
  await expect(review).toContainText('Verification passed', { timeout: 30000 });
  await expect(review).toContainText('!reciperemix');
  await review.getByRole('button', { name: 'Install exact reviewed candidate' }).click();
  await expect(library.getByRole('status')).toContainText('Candidate installed');
  const studio = await page.request.get('/api/studio');
  const snapshot = await studio.json();
  expect(JSON.stringify(snapshot)).toContain('!reciperemix');
  const after = (await (await page.request.get('/api/recipes')).json()).state;
  expect(after.reviews[0].installedVersionId).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Approve v1 & go live' })).toBeVisible();
});
