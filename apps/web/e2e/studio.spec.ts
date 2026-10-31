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

test('offline stateful examples rehearse shared scores, resources, deadline and collective goal', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByLabel('Describe the interaction in one or two sentences')).toBeVisible();
  const newIdea = page.getByRole('button', { name: 'New idea', exact: true });
  if (await newIdea.isVisible()) await newIdea.click();
  await page.getByRole('button', { name: 'Tomato Battle', exact: true }).click();
  await page.getByRole('button', { name: /^Generate/ }).click();
  await expect(page.getByRole('heading', { name: 'Tomato Battle v1' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText(/offline template compiler/).first()).toBeVisible();
  const rehearsal = page.getByRole('region', { name: /Rehearse “Tomato Battle”/ });
  await rehearsal.getByRole('button', { name: 'Join Red' }).click();
  await expect(rehearsal.getByTestId('decision')).toHaveCount(1);
  for (let i = 0; i < 4; i++) {
    await rehearsal.getByRole('button', { name: 'Contribute !throw' }).click();
    await expect(rehearsal.getByTestId('decision')).toHaveCount(i + 2);
  }
  await expect(rehearsal.getByTestId('decision').first()).toContainText('Resources spent');
  await expect(rehearsal.locator('.session-hud')).toContainText('Red: 3');
  await expect(rehearsal.locator('.session-hud')).toContainText('0 of 3 throws left');
  await rehearsal.getByRole('button', { name: /Bob/ }).click();
  await rehearsal.getByRole('button', { name: 'Join Blue' }).click();
  await expect(rehearsal.getByTestId('decision')).toHaveCount(6);
  await rehearsal.getByRole('button', { name: 'Contribute !throw' }).click();
  await expect(rehearsal.locator('.session-hud')).toContainText('Blue: 1');
  await rehearsal.getByRole('button', { name: 'Redeliver last' }).click();
  await expect(rehearsal.getByTestId('decision').first()).toContainText('Duplicate');
  await expect(rehearsal.locator('.session-hud')).toContainText('Blue: 1');
  await rehearsal.getByRole('button', { name: 'Advance to deadline' }).click();
  await expect(rehearsal.locator('.session-hud')).toContainText('Finished');
  await expect(rehearsal.locator('.session-hud')).toContainText('Red wins');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Approve v1 & go live' }).click();
  const interaction = page
    .locator('.interaction')
    .filter({ has: page.getByRole('heading', { name: 'Tomato Battle', exact: true }) });
  await expect(interaction.locator('.session-hud')).toContainText('Running');
  await interaction.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(interaction.locator('.session-hud')).toContainText('Paused');
  await interaction.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(interaction.locator('.session-hud')).toContainText('Running');
  // The round journal replays privately and proves the live scoreboard.
  await interaction.getByRole('button', { name: 'Verify round' }).click();
  await expect(interaction.getByText('✓ Score verified.')).toBeVisible();
  await expect(interaction.locator('.audit-result')).toContainText(/\d+ clock changes/);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await interaction.getByRole('button', { name: 'Reset session…' }).click();
  await expect(interaction.getByRole('group', { name: 'Confirm session reset' })).toBeVisible();
  await interaction.getByRole('button', { name: 'Confirm reset session' }).click();
  await expect(page.getByText('Session reset. A new round has started.')).toBeVisible();

  await page.getByRole('button', { name: 'New idea', exact: true }).click();
  await page.getByRole('button', { name: 'Community Goal', exact: true }).click();
  await page.getByRole('button', { name: /^Generate/ }).click();
  await expect(page.getByRole('heading', { name: 'Community Goal v1' })).toBeVisible({
    timeout: 30000,
  });
  const cooperative = page.getByRole('region', { name: /Rehearse “Community Goal”/ });
  for (let i = 0; i < 3; i++) {
    await cooperative.getByRole('button', { name: 'Contribute !grow' }).click();
    await expect(cooperative.getByTestId('decision')).toHaveCount(i + 1);
  }
  await cooperative.getByRole('button', { name: /Bob/ }).click();
  for (let i = 0; i < 2; i++) {
    await cooperative.getByRole('button', { name: 'Contribute !grow' }).click();
    await expect(cooperative.getByTestId('decision')).toHaveCount(i + 4);
  }
  await expect(cooperative.locator('.session-hud')).toContainText('Community: 5 / 5');
  await expect(cooperative.locator('.session-hud')).toContainText('Goal reached');
});
