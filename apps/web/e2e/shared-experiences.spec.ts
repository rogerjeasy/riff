import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// UI protocol fixture only: backend two-instance tests verify real consent and execution.
test('invited creator reviews evidence, approves exact authority and can leave', async ({
  page,
}) => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../packages/compiler/fixtures/stateful-experiences.json', import.meta.url),
      'utf8',
    ),
  );
  const output = fixture.records.find((record: { intent: string }) =>
    record.intent.startsWith('Community Goal'),
  ).output;
  const contract = {
    id: '00000000-0000-4000-8000-000000000001',
    versionId: '00000000-0000-4000-8000-000000000002',
    digest: 'a'.repeat(64),
    artifactId: 'b'.repeat(64),
    title: 'Shared community goal',
    artifact: { source: output.source, manifest: output.manifest },
    tests: output.tests,
    roles: [
      {
        id: 'repair',
        label: 'Repair shields',
        channelId: '100',
        command: '!repair',
        required: true,
        fields: ['score'],
      },
      {
        id: 'steer',
        label: 'Steer ship',
        channelId: '200',
        command: '!steer',
        required: true,
        fields: ['remaining'],
      },
    ],
  };
  const review = {
    contract,
    roleId: 'steer',
    verification: {
      ok: true,
      generated: 3,
      host: 8,
      stages: [{ label: 'Sandbox checks', status: 'passed' }],
    },
    preview: {
      label: 'Synthetic private replay',
      codes: ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'RESOURCE_LIMIT'],
      score: 3,
    },
  };
  let member: {
    state: string;
    reason: string | null;
    origin: string | null;
    canRecheck: boolean;
    projection: null;
    review: typeof review | null;
  } = {
    state: 'idle',
    reason: null,
    origin: null,
    canRecheck: false,
    projection: null,
    review: null,
  };
  let approved: string | null = null;
  await page.route('**/api/collaboration**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.replace('/api/collaboration', '');
    if (!suffix)
      return route.fulfill({
        json: { sessions: [], member, channelId: '200', configured: true, ready: true },
      });
    if (suffix === '/review') {
      member = {
        ...member,
        state: 'review',
        origin: 'https://coordinator.example',
        canRecheck: true,
        review,
      };
      return route.fulfill({ json: { review } });
    }
    if (suffix === '/approve') {
      approved = route.request().postDataJSON().digest;
      member = { ...member, state: 'connected' };
      return route.fulfill({ json: { member } });
    }
    if (suffix === '/leave') {
      member = {
        ...member,
        state: 'stopped',
        review: null,
        canRecheck: false,
        reason: 'You left this shared experience.',
      };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected browser action' } });
  });
  await page.goto('/');
  await page.getByText('Shared channels', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Shared channels workspace' });
  await panel
    .getByLabel('Private invitation', { exact: true })
    .fill(
      `riff-invite:${Buffer.from(
        JSON.stringify({ origin: 'https://coordinator.example', token: 't'.repeat(43) }),
      ).toString('base64url')}`,
    );
  await panel.getByRole('button', { name: 'Review invitation privately' }).click();
  await expect(panel.getByText('Synthetic private replay', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve my role and view' })).toBeDisabled();
  await panel
    .getByLabel('I approve this exact version, my role, and the public fields shown above')
    .check();
  expect((await new AxeBuilder({ page }).include('.shared-panel').analyze()).violations).toEqual(
    [],
  );
  await panel.getByRole('button', { name: 'Approve my role and view' }).click();
  await expect(panel.getByText(/You joined the shared round/)).toBeVisible();
  expect(approved).toBe(contract.digest);
  await panel.getByRole('button', { name: 'Leave shared experience' }).click();
  await expect(panel.getByText(/You left this shared experience\./)).toBeVisible();
});
