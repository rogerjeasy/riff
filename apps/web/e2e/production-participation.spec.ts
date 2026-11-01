import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('mobile viewer instructions preserve explicit preferences without private API calls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const privateRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) privateRequests.push(request.url());
  });
  await page.route('**/participation?**', (route) =>
    route.fulfill({
      json: {
        language: new URL(route.request().url()).searchParams.get('language') ?? 'en',
        stopped: false,
        reducedMotion: true,
        highContrast: true,
        helpCommand: '!riff help fr',
        interactions: [
          {
            id: 'public-example',
            title: 'Community garden',
            phase: 'running',
            free: true,
            instructions: ['Tout le monde · Tapez !grow · 3 contributions par manche'],
            objective: 'Atteignez 10 points',
            remainingMs: 60000,
            scores: [{ label: 'Communauté', score: 4 }],
            outcome: null,
            command: '!grow',
            joinCommands: [],
            audience: ['viewer'],
            goal: { target: 10, current: 4 },
          },
        ],
      },
    }),
  );
  await page.goto('/participate');
  await expect(page.getByRole('heading', { name: 'Community garden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy !grow' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  await expect(page.getByRole('heading', { name: 'Participer au direct' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Participer au direct' })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-high-contrast', 'true');
  expect(privateRequests).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('OBS diagnostic is labeled and never opens a live socket', async ({ page }) => {
  const sockets: string[] = [];
  // Only Riff sockets matter; the Vite dev server opens its own hot-reload socket.
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.startsWith('/ws/')) sockets.push(socket.url());
  });
  await page.goto('/production-test');
  await expect(page.getByRole('heading', { name: 'Riff source connected' })).toBeVisible();
  await expect(page.getByText('OBS SETUP TEST · NOT LIVE GAMEPLAY')).toBeVisible();
  expect(sockets).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
