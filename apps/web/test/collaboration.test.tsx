// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollaborationPanel } from '../src/console/collaboration/panel.js';
import { collaborationApi } from '../src/console/collaboration/api.js';
import {
  inviteCode,
  parseInvite,
  projectionSchema,
  type CollaborationStatus,
} from '../src/collaboration/schema.js';
import { renderCollaboration } from '../src/overlay/collaboration.js';

const contract = {
  id: '00000000-0000-4000-8000-000000000001',
  versionId: '00000000-0000-4000-8000-000000000002',
  digest: 'a'.repeat(64),
  artifactId: 'b'.repeat(64),
  title: 'Community ship',
  artifact: {
    source: 'async () => {}',
    manifest: {
      sdkVersion: '0.4.0',
      capabilities: ['overlay', 'session'],
      trigger: { command: '!grow', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
      limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
      experience: {
        version: 1,
        title: 'Ship',
        durationMs: 120000,
        maxParticipants: 256,
        teams: [],
        resource: { name: 'actions', perParticipant: 3 },
        contribution: { command: '!grow', points: 1 },
        objective: { kind: 'collective-goal', target: 20 },
      },
    },
  },
  tests: [{}, {}, {}],
  roles: [
    {
      id: 'repair',
      label: 'Repair',
      channelId: '100',
      command: '!repair',
      required: true,
      fields: ['score'],
    },
    {
      id: 'steer',
      label: 'Steer',
      channelId: '200',
      command: '!steer',
      required: true,
      fields: ['remaining'],
    },
  ],
};
function status(): CollaborationStatus {
  return {
    configured: true,
    ready: true,
    channelId: '100',
    sessions: [],
    member: {
      state: 'review',
      reason: null,
      origin: 'local',
      canRecheck: true,
      projection: null,
      review: {
        contract,
        roleId: 'repair',
        verification: {
          ok: true,
          generated: 3,
          host: 8,
          stages: [{ label: 'Sandbox', status: 'passed' }],
        },
        preview: {
          label: 'Synthetic private replay',
          codes: ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'RESOURCE_LIMIT'],
          score: 3,
        },
      },
    },
  } as CollaborationStatus;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('requires explicit consent to the exact reviewed agreement before approving', async () => {
  const state = status();
  vi.spyOn(collaborationApi, 'status').mockResolvedValue(state);
  const approve = vi
    .spyOn(collaborationApi, 'approve')
    .mockResolvedValue({ ...state.member, state: 'connected' });
  render(<CollaborationPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByText('Shared channels'));
  expect(await screen.findByText('Synthetic private replay')).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Approve my role and view' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(
    screen.getByLabelText(
      'I approve this exact version, my role, and the public fields shown above',
    ),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(approve).toHaveBeenCalledWith('a'.repeat(64), expect.any(AbortSignal)),
  );
});
it('keeps consent through routine refreshes and drops it when readiness changes', async () => {
  const state = status();
  const statusSpy = vi.spyOn(collaborationApi, 'status').mockResolvedValue(state);
  render(<CollaborationPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByText('Shared channels'));
  await screen.findByText('Synthetic private replay');
  const consent = () =>
    screen.getByLabelText(
      'I approve this exact version, my role, and the public fields shown above',
    ) as HTMLInputElement;
  fireEvent.click(consent());
  expect(consent().checked).toBe(true);
  // A poll returning the same review (a fresh object, as the server sends) keeps consent.
  statusSpy.mockResolvedValue(structuredClone(state));
  await waitFor(() => expect(statusSpy.mock.calls.length).toBeGreaterThan(2), { timeout: 5000 });
  expect(consent().checked).toBe(true);
  // A change to what was reviewed invalidates consent without any effect timing.
  statusSpy.mockResolvedValue({ ...structuredClone(state), ready: false });
  await waitFor(() => expect(consent().checked).toBe(false), { timeout: 5000 });
}, 12000);
it('shows disabled configuration and never offers implicit approval while offline', async () => {
  const state = status();
  state.configured = false;
  state.ready = false;
  vi.spyOn(collaborationApi, 'status').mockResolvedValue(state);
  render(<CollaborationPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByText('Shared channels'));
  expect(await screen.findByText(/Configure RIFF_SECRET/)).toBeTruthy();
  fireEvent.click(
    screen.getByLabelText(
      'I approve this exact version, my role, and the public fields shown above',
    ),
  );
  expect(
    (screen.getByRole('button', { name: 'Approve my role and view' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('renders only granted aggregates, explicit pause state, and safe text; null clears', () => {
  const root = document.createElement('section');
  const projection = projectionSchema.parse({
    sessionId: contract.id,
    digest: contract.digest,
    revision: 2,
    title: '<img src=x>',
    roleId: 'repair',
    roleLabel: 'Repair',
    status: 'paused',
    reason: 'Required channel disconnected',
    instructions: 'Type !repair · 3 actions per person',
    score: 3,
    target: 20,
  });
  renderCollaboration(root, projection);
  expect(root.textContent).toContain('Paused');
  expect(root.textContent).toContain('3 / 20');
  expect(root.textContent).not.toContain('seconds');
  expect(root.querySelector('img')).toBeNull();
  renderCollaboration(root, null);
  expect(root.hidden).toBe(true);
  expect(root.textContent).toBe('');
});
it('rejects private or unbounded fields at the public projection boundary', () => {
  const valid = {
    sessionId: contract.id,
    digest: contract.digest,
    revision: 2,
    title: 'Ship',
    roleId: 'repair',
    roleLabel: 'Repair',
    status: 'running',
    reason: null,
    instructions: 'Type !repair',
  };
  expect(projectionSchema.safeParse({ ...valid, participants: { secret: {} } }).success).toBe(
    false,
  );
  expect(projectionSchema.safeParse({ ...valid, remaining: 3600001 }).success).toBe(false);
});
it('clears pending consent when the channel is stopped', async () => {
  vi.spyOn(collaborationApi, 'status').mockResolvedValue(status());
  const approve = vi.spyOn(collaborationApi, 'approve');
  const view = render(<CollaborationPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByText('Shared channels'));
  const consent = await screen.findByLabelText(
    'I approve this exact version, my role, and the public fields shown above',
  );
  fireEvent.click(consent);
  view.rerender(<CollaborationPanel versions={[]} panic={true} />);
  await waitFor(() => expect((consent as HTMLInputElement).checked).toBe(false));
  expect(
    (screen.getByRole('button', { name: 'Approve my role and view' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(approve).not.toHaveBeenCalled();
});

it('keeps local leave available while a review request is pending', async () => {
  const initial = status();
  initial.member.review = null;
  initial.member.state = 'idle';
  vi.spyOn(collaborationApi, 'status').mockResolvedValue(initial);
  let rejectReview: ((error: Error) => void) | undefined;
  vi.spyOn(collaborationApi, 'review').mockImplementation(
    (_origin, _token, signal) =>
      new Promise((_resolve, reject) => {
        rejectReview = reject;
        signal?.addEventListener('abort', () => reject(new Error('Cancelled')));
      }),
  );
  const leave = vi.spyOn(collaborationApi, 'leave').mockResolvedValue({ ok: true });
  render(<CollaborationPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByText('Shared channels'));
  const invitation = await screen.findByLabelText('Private invitation');
  fireEvent.change(invitation, {
    target: {
      value: JSON.stringify({ origin: 'https://coordinator.example', token: 't'.repeat(43) }),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review invitation privately' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Leave shared experience' }));
  await waitFor(() => expect(leave).toHaveBeenCalled());
  rejectReview?.(new Error('Cancelled'));
  expect(screen.queryByRole('button', { name: 'Approve my role and view' })).toBeNull();
});
it('creates an agreement from distinct roles and preserves the creator’s public field choices', async () => {
  const initial = status();
  initial.member.review = null;
  initial.member.state = 'idle';
  vi.spyOn(collaborationApi, 'status').mockResolvedValue(initial);
  const reviewed = status().member.review!;
  const create = vi.spyOn(collaborationApi, 'create').mockResolvedValue({
    contract: reviewed.contract,
    revision: 0,
    status: 'waiting',
    reason: null,
    members: [],
  });
  const versions = [
    {
      id: contract.versionId,
      title: contract.title,
      number: 1,
      status: 'candidate',
      manifest: contract.artifact.manifest,
      evidence: { verification: { ok: true } },
    },
  ] as unknown as Parameters<typeof CollaborationPanel>[0]['versions'];
  render(<CollaborationPanel versions={versions} panic={false} />);
  fireEvent.click(screen.getByText('Shared channels'));
  const channel = await screen.findByLabelText('Role 2 Twitch channel ID');
  fireEvent.change(channel, { target: { value: '200' } });
  fireEvent.click(screen.getAllByLabelText('Shared score and goal')[1]!);
  fireEvent.click(screen.getAllByLabelText('Required for shared play')[1]!);
  fireEvent.click(screen.getByRole('button', { name: 'Create shared agreement' }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]?.[0]).toBe(contract.versionId);
  expect(create.mock.calls[0]?.[1][1]).toMatchObject({
    channelId: '200',
    required: false,
    command: '!steer',
    fields: ['remaining', 'contributions'],
  });
});
it('pages small public views at a readable size while retaining full accessible instructions', () => {
  const root = document.createElement('section');
  const projection = projectionSchema.parse({
    sessionId: contract.id,
    digest: contract.digest,
    revision: 2,
    title: 'Ship',
    roleId: 'repair',
    roleLabel: 'Repair',
    status: 'running',
    reason: null,
    instructions: 'Type !repair to help the ship. Three actions per person.',
    score: 3,
    target: 20,
  });
  renderCollaboration(root, projection, { width: 160, height: 110, now: 0 });
  const first = root.textContent;
  renderCollaboration(root, projection, { width: 160, height: 110, now: 4000 });
  expect(root.textContent).not.toBe(first);
  expect(root.getAttribute('aria-label')).toContain(projection.instructions);
  expect(root.style.fontSize).toBe('14px');
});

it('round-trips one-line invitation codes and still accepts the raw form', () => {
  const token = 'A'.repeat(43);
  const code = inviteCode('https://coordinator.example', token);
  expect(code.startsWith('riff-invite:')).toBe(true);
  expect(code).not.toContain('{');
  expect(parseInvite(`  ${code}\n`)).toEqual({ origin: 'https://coordinator.example', token });
  expect(parseInvite(JSON.stringify({ origin: 'https://c.example', token }))).toEqual({
    origin: 'https://c.example',
    token,
  });
  expect(parseInvite('riff-invite:not-base64!')).toBeNull();
  expect(parseInvite(code.slice(0, -6))).toBeNull();
});
it('guides the host through approve, invite and start with the reason start is blocked', async () => {
  const initial = status();
  initial.member.review = null;
  initial.member.state = 'idle';
  initial.sessions = [
    {
      contract: contract as never,
      revision: 3,
      status: 'waiting',
      reason: 'Waiting for Steer to approve and connect.',
      members: [
        { roleId: 'repair', approved: true, connected: true },
        { roleId: 'steer', approved: false, connected: false },
      ],
    },
  ];
  vi.spyOn(collaborationApi, 'status').mockResolvedValue(initial);
  const invite = vi.spyOn(collaborationApi, 'invite').mockResolvedValue({
    origin: 'https://coordinator.example',
    token: 'B'.repeat(43),
    expiresAt: Date.now() + 900000,
    roleId: 'steer',
  });
  render(<CollaborationPanel versions={[]} panic={false} />);
  const hosted = await screen.findByRole('article', { name: 'Hosted round Community ship' });
  expect(hosted.textContent).toContain('Approved and connected.');
  const start = screen.getByRole('button', { name: 'Start shared round' }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  expect(hosted.textContent).toContain('Waiting for Steer to approve and connect.');
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation for Steer' }));
  await waitFor(() => expect(invite).toHaveBeenCalledWith(contract.id, 'steer', expect.anything()));
  const field = (await screen.findByLabelText('Invitation for Steer')) as HTMLInputElement;
  expect(parseInvite(field.value)?.token).toBe('B'.repeat(43));
  expect(screen.getByRole('button', { name: 'Copy invitation' })).toBeTruthy();
  expect(hosted.textContent).toMatch(/expires in 1[45]:\d\d/);
});
it('leads the stream card with the command, a goal meter and a smooth countdown', () => {
  const root = document.createElement('section');
  const live = projectionSchema.parse({
    sessionId: contract.id,
    digest: contract.digest,
    revision: 4,
    title: 'Ship',
    roleId: 'steer',
    roleLabel: 'Steer',
    status: 'running',
    reason: null,
    instructions: 'Steer: Everyone can type !steer · 3 actions per person this round.',
    score: 3,
    target: 20,
    remaining: 90000,
    partners: ['Repair'],
  });
  const layout = { width: 500, height: 400, now: 10000, receivedAt: 5000 };
  renderCollaboration(root, live, layout);
  expect(root.querySelector('.shared-cta')?.textContent).toBe('Type !steer');
  expect(root.querySelector('.shared-partners')?.textContent).toBe('with Repair');
  expect((root.querySelector('.shared-meter span') as HTMLElement).style.width).toBe('15%');
  expect(root.textContent).toContain('1:25 left');
  renderCollaboration(root, { ...live, status: 'finished', score: 20 }, layout);
  expect(root.textContent).toContain('Goal reached together');
  expect(root.textContent).not.toContain('left');
  expect(root.querySelector('.shared-cta')).toBeNull();
  expect(root.textContent).not.toContain('can type');
});
