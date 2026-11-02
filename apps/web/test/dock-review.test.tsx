// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Automation, Version } from '../src/lib/types.js';
import { api } from '../src/lib/api.js';
import { DockReviews } from '../src/dock/reviews.js';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const candidate: Version = {
  id: 'candidate',
  automationId: 'interaction',
  number: 1,
  parentVersionId: null,
  artifactId: 'a'.repeat(64),
  title: 'Tomato Toss',
  intent: 'Tomatoes',
  source: 'public source',
  manifest: {
    sdkVersion: '0.3.0',
    capabilities: ['overlay'],
    trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
  },
  tests: [],
  behavior: { when: 'Chat', what: 'Tomatoes', who: 'Everyone', howMuch: 'Three' },
  assumptions: [],
  evidence: {
    intent: [],
    verification: {
      ok: true,
      artifactId: 'a'.repeat(64),
      stages: [],
      findings: [],
      capabilitiesUsed: ['overlay'],
      generated: [],
      host: [],
      failureReport: null,
    },
  },
  origin: 'manual',
  compileRunId: null,
  status: 'candidate',
  incident: null,
  approvedAt: null,
  approvedBy: null,
  reportHash: 'b'.repeat(64),
  activatedAt: null,
  createdAt: 1,
  changes: [],
  blockers: [],
};
const automation: Automation = {
  id: 'interaction',
  title: 'Tomatoes',
  activeVersionId: null,
  status: 'draft',
  createdAt: 1,
  updatedAt: 1,
  versions: [candidate],
  canRollback: false,
  session: null,
};
it('uses existing exact-version evidence and approval in the dock', async () => {
  const approve = vi.spyOn(api, 'approve').mockResolvedValue({});
  const refresh = vi.fn(async () => {});
  render(
    <DockReviews automations={[automation]} panic={false} refresh={refresh} notify={() => {}} />,
  );
  fireEvent.click(screen.getByText(/Review candidates/));
  expect(screen.getByLabelText('Handler source')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve v1 & go live' }));
  await waitFor(() =>
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'candidate',
        artifactId: 'a'.repeat(64),
        reportHash: 'b'.repeat(64),
      }),
      null,
      undefined,
    ),
  );
  expect(refresh).toHaveBeenCalled();
});
it('keeps candidate approval disabled during panic', () => {
  render(
    <DockReviews
      automations={[automation]}
      panic={true}
      refresh={async () => {}}
      notify={() => {}}
    />,
  );
  fireEvent.click(screen.getByText(/Review candidates/));
  expect(
    (screen.getByRole('button', { name: 'Approve v1 & go live' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
