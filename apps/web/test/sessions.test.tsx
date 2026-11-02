import { defaultScene } from '../src/scenes/schema.js';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSessionHud } from '../src/sessions/presentation.js';
import { overlayMessageSchema } from '../src/overlay/messages.js';
import { Evidence } from '../src/console/review/evidence.js';
import { LivePanel } from '../src/console/live/live-panel.js';
import { Rehearsal } from '../src/console/rehearsal/stage.js';
import { api } from '../src/lib/api.js';
import { ApiError } from '../src/lib/api.js';
import { TransitionReview } from '../src/console/review/transition-review.js';
import type { Transition } from '../src/lib/types.js';
import type { ExperienceDefinition, SessionSnapshot, Studio, Version } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const definition: ExperienceDefinition = {
  version: 1,
  title: 'Tomato Battle',
  durationMs: 120000,
  maxParticipants: 256,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'throws', perParticipant: 3 },
  contribution: { command: '!throw', points: 1 },
  objective: { kind: 'highest-score', target: null },
};
const snapshot: SessionSnapshot = {
  id: 'session-1',
  phase: 'running',
  startedAt: 0,
  deadlineAt: 120000,
  remainingMs: 120000,
  updatedAt: 0,
  revision: 2,
  participants: { alice: { teamId: 'red', remaining: 2, contributions: 1 } },
  scores: { red: 1, blue: 0 },
  winner: null,
  outcome: null,
};
const version: Version = {
  id: 'v1',
  automationId: 'a1',
  number: 1,
  parentVersionId: null,
  artifactId: 'f'.repeat(64),
  title: 'Tomato Battle',
  intent: '',
  source: '',
  manifest: {
    sdkVersion: '0.4.0',
    capabilities: ['overlay', 'session'],
    trigger: { command: '!throw', audience: ['viewer'], maxPerViewer: 3, windowMs: 120000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
    experience: definition,
  },
  tests: [],
  behavior: { when: '', what: '', who: '', howMuch: '' },
  assumptions: [],
  evidence: {
    verification: {
      ok: true,
      artifactId: 'f'.repeat(64),
      stages: [],
      findings: [],
      capabilitiesUsed: [],
      generated: [],
      host: [],
      failureReport: null,
    },
    intent: [],
  },
  origin: 'offline',
  compileRunId: null,
  status: 'active',
  incident: null,
  approvedAt: 1,
  approvedBy: 'console',
  reportHash: 'c'.repeat(64),
  activatedAt: 1,
  createdAt: 1,
  changes: [],
  blockers: [],
};
const automation = {
  id: 'a1',
  title: 'Tomato Battle',
  activeVersionId: 'v1',
  status: 'live' as const,
  createdAt: 1,
  updatedAt: 1,
  versions: [version],
  canRollback: false,
  session: snapshot,
};

it('offers a reviewed preserving change with boundary choice and keeps authority consent', async () => {
  const edited: Version = {
    ...version,
    id: 'v2',
    number: 2,
    status: 'candidate',
    manifest: {
      ...version.manifest,
      experience: {
        ...definition,
        resource: { name: 'throws', perParticipant: 5 },
        contribution: { command: '!splat', points: 1 },
      },
    },
    changes: [{ field: 'maxPerViewer', label: 'Allowance', from: '3', to: '5', authority: 'more' }],
  };
  render(
    <Evidence
      version={edited}
      automation={automation}
      panic={false}
      previewed
      onApprove={async () => undefined}
      onDiscard={async () => undefined}
    />,
  );
  expect(screen.getByRole('group', { name: 'When this change takes effect' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Preview keeping progress' })).toBeTruthy();
  expect(screen.getByText(/stays paused until you resume it/)).toBeTruthy();
  // One path at a time: keeping progress is preselected and the reset approval is not offered.
  expect((screen.getByLabelText(/Keep everyone’s progress/) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(screen.queryByRole('button', { name: /Approve v2 & replace/ })).toBeNull();
  expect(screen.queryByLabelText(/I agree to reset session progress/)).toBeNull();
  fireEvent.click(screen.getByLabelText(/Start a fresh round/));
  expect(screen.queryByRole('group', { name: 'When this change takes effect' })).toBeNull();
  expect(screen.getByLabelText(/I agree to reset session progress/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Approve v2 & replace/ })).toBeTruthy();
});

it('explains why progress cannot carry over and offers only a fresh round', () => {
  const fewer: Version = {
    ...version,
    id: 'v2',
    number: 2,
    status: 'candidate',
    manifest: {
      ...version.manifest,
      experience: { ...definition, resource: { name: 'throws', perParticipant: 2 } },
    },
    progress: {
      kind: 'reset-required',
      reasons: ['Each player would get fewer throws (3 → 2).'],
    },
    changes: [],
  };
  render(
    <Evidence
      version={fewer}
      automation={automation}
      panic={false}
      previewed
      onApprove={async () => undefined}
      onDiscard={async () => undefined}
    />,
  );
  const keep = screen.getByLabelText(/Keep everyone’s progress/) as HTMLInputElement;
  expect(keep.disabled).toBe(true);
  expect(keep.checked).toBe(false);
  expect((screen.getByLabelText(/Start a fresh round/) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Each player would get fewer throws (3 → 2).')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Preview keeping progress' })).toBeNull();
  const approve = screen.getByRole('button', { name: /Approve v2 & replace/ });
  expect(approve.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByLabelText(/I agree to reset session progress/));
  expect(approve.hasAttribute('disabled')).toBe(false);
});

const editedVersion: Version = {
  ...version,
  id: 'v2',
  number: 2,
  status: 'candidate',
  approvedAt: null,
  approvedBy: null,
  reportHash: 'c'.repeat(64),
  manifest: {
    ...version.manifest,
    experience: {
      ...definition,
      resource: { name: 'throws', perParticipant: 5 },
      contribution: { command: '!splat', points: 1 },
    },
  },
  changes: [{ field: 'maxPerViewer', label: 'Allowance', from: '3', to: '5', authority: 'more' }],
};
const transition = (): Transition => ({
  id: 't1',
  sourceVersionId: 'v1',
  targetVersionId: 'v2',
  sourceSessionId: snapshot.id,
  migrationSource: '(input) => input.snapshot',
  evidenceId: 'e'.repeat(64),
  status: 'review',
  plan: { targetArtifactId: editedVersion.artifactId!, boundary: 'immediate' },
  evidence: {
    preserved: ['teams', 'scores', 'contributions', 'time'],
    changed: editedVersion.changes,
    reset: [],
    takesEffect: 'immediate',
    beforeRules: { definition, audience: ['viewer'] },
    afterRules: { definition: editedVersion.manifest.experience!, audience: ['viewer'] },
    migration: {
      before: snapshot,
      after: {
        ...snapshot,
        participants: { alice: { teamId: 'red', remaining: 4, contributions: 1 } },
      },
    },
    comparison: {
      provenance: 'synthetic',
      label: 'Host-generated hypothetical future inputs',
      events: [{ id: 'event1', text: '!splat' }],
      steps: [
        {
          eventId: 'event1',
          before: { code: 'UNRELATED', reason: 'Old command', effects: [] },
          after: { code: 'ACCEPTED', reason: 'New command', effects: [] },
        },
      ],
      before: snapshot,
      after: snapshot,
    },
  },
});

it.each([
  'source-version',
  'source-artifact',
  'target-version',
  'target-artifact',
  'session',
] as const)(
  'requires fresh outer-card authority and reset consent after %s replacement',
  async (change) => {
    const onApprove = vi.fn(async () => undefined);
    const common = { panic: false, previewed: true, onApprove, onDiscard: async () => undefined };
    const { rerender } = render(
      <Evidence version={editedVersion} automation={automation} {...common} />,
    );
    fireEvent.click(screen.getByLabelText(/I understand this grants more authority/));
    fireEvent.click(screen.getByLabelText(/Start a fresh round/));
    fireEvent.click(screen.getByLabelText(/I agree to reset session progress/));
    expect(
      screen.getByRole('button', { name: /Approve v2 & replace/ }).hasAttribute('disabled'),
    ).toBe(false);
    const source = {
      ...version,
      id: change === 'source-version' ? 'v3' : version.id,
      artifactId: change === 'source-artifact' ? 'a'.repeat(64) : version.artifactId,
    };
    const target = {
      ...editedVersion,
      id: change === 'target-version' ? 'v4' : editedVersion.id,
      artifactId: change === 'target-artifact' ? 'b'.repeat(64) : editedVersion.artifactId,
    };
    const nextAutomation = {
      ...automation,
      activeVersionId: source.id,
      versions: [source],
      session: { ...snapshot, id: change === 'session' ? 'replacement-round' : snapshot.id },
    };
    rerender(<Evidence version={target} automation={nextAutomation} {...common} />);
    expect(
      (screen.getByLabelText(/I understand this grants more authority/) as HTMLInputElement)
        .checked,
    ).toBe(false);
    // The progress choice resets with the context, back to the safe default.
    expect((screen.getByLabelText(/Keep everyone’s progress/) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText(/Start a fresh round/));
    expect(
      (screen.getByLabelText(/I agree to reset session progress/) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      screen.getByRole('button', { name: /Approve v2 & replace/ }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByLabelText(/Keep everyone’s progress/));
    const t = transition();
    t.sourceVersionId = source.id;
    t.sourceSessionId = nextAutomation.session.id;
    t.targetVersionId = target.id;
    t.plan.targetArtifactId = target.artifactId!;
    vi.spyOn(api, 'previewTransition').mockResolvedValue(t);
    fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
    const reviewedApproval = await screen.findByRole('button', {
      name: 'Apply now and keep progress',
    });
    expect(reviewedApproval.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Confirm the authority change above/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I understand this grants more authority/));
    expect(reviewedApproval.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: /Approve v2 & replace/ })).toBeNull();
    fireEvent.click(screen.getByLabelText(/Start a fresh round/));
    expect(
      screen.getByRole('button', { name: /Approve v2 & replace/ }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByLabelText(/I agree to reset session progress/));
    expect(
      screen.getByRole('button', { name: /Approve v2 & replace/ }).hasAttribute('disabled'),
    ).toBe(false);
    expect(onApprove).not.toHaveBeenCalled();
  },
);

it('retains outer-card acknowledgements when accepted chat advances the same round', () => {
  const common = {
    version: editedVersion,
    panic: false,
    previewed: true,
    onApprove: async () => undefined,
    onDiscard: async () => undefined,
  };
  const { rerender } = render(<Evidence automation={automation} {...common} />);
  fireEvent.click(screen.getByLabelText(/I understand this grants more authority/));
  fireEvent.click(screen.getByLabelText(/Start a fresh round/));
  fireEvent.click(screen.getByLabelText(/I agree to reset session progress/));
  rerender(
    <Evidence
      automation={{
        ...automation,
        session: {
          ...snapshot,
          revision: snapshot.revision + 1,
          participants: {
            alice: { ...snapshot.participants.alice!, contributions: 2, remaining: 1 },
          },
          scores: { red: 2, blue: 0 },
        },
      }}
      {...common}
    />,
  );
  expect(
    (screen.getByLabelText(/I understand this grants more authority/) as HTMLInputElement).checked,
  ).toBe(true);
  expect(
    (screen.getByLabelText(/I agree to reset session progress/) as HTMLInputElement).checked,
  ).toBe(true);
});

it('compares participants appearing on either side and labels absent membership explicitly', async () => {
  const t = transition();
  t.evidence.comparison.before = {
    ...snapshot,
    participants: { alice: snapshot.participants.alice! },
  };
  t.evidence.comparison.after = {
    ...snapshot,
    participants: { bob: { teamId: null, remaining: 5, contributions: 0 } },
  };
  vi.spyOn(api, 'previewTransition').mockResolvedValue(t);
  render(
    <TransitionReview version={editedVersion} automation={automation} panic={false} allowed />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
  await screen.findByRole('button', { name: 'Apply now and keep progress' });
  const comparison = screen.getByText('Progress after this rehearsal').closest('details')!;
  expect(comparison.textContent).toContain('bob');
  expect(comparison.textContent).toContain('Not joined → Community');
  expect(comparison.textContent).toContain('Not joined → 5');
  expect(comparison.textContent).toContain('Red → Not joined');
  expect(comparison.textContent).toContain('2 → Not joined');
});

it('validates transition wire evidence and sends exact approval identities', async () => {
  const t = transition();
  const fetcher = vi.fn(async (): Promise<{ ok: boolean; json: () => Promise<unknown> }> => ({
    ok: true,
    json: async () => ({ transition: t }),
  }));
  vi.stubGlobal('fetch', fetcher);
  const reviewed = await api.previewTransition('v2', 'immediate');
  expect(reviewed.migrationSource).toBe(t.migrationSource);
  await api.approveTransition(reviewed, 'f'.repeat(64));
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/transitions/t1/approve',
    expect.objectContaining({
      body: JSON.stringify({
        evidenceId: t.evidenceId,
        artifactId: t.plan.targetArtifactId,
        reportHash: 'f'.repeat(64),
        expectedActiveVersionId: 'v1',
        sessionId: snapshot.id,
        boundary: 'immediate',
      }),
    }),
  );
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({ transition: { ...t, evidence: {} } }),
  });
  await expect(api.previewTransition('v2', 'immediate')).rejects.toThrow();
});

it('shows actual transition comparisons and requires existing authority consent before exact approval', async () => {
  const t = transition();
  vi.spyOn(api, 'previewTransition').mockResolvedValue(t);
  const approve = vi.spyOn(api, 'approveTransition').mockResolvedValue({ ...t, status: 'applied' });
  render(
    <Evidence
      version={editedVersion}
      automation={automation}
      panic={false}
      previewed
      onApprove={async () => undefined}
      onDiscard={async () => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
  const button = await screen.findByRole('button', { name: 'Apply now and keep progress' });
  expect(button.hasAttribute('disabled')).toBe(true);
  const row = screen.getByRole('rowheader', { name: '!splat' }).closest('tr')!;
  expect(row.textContent).toContain('Ignored');
  expect(row.textContent).toContain('Old command');
  expect(row.textContent).toContain('Accepted');
  expect(row.textContent).toContain('New command');
  expect(screen.getByText('2 → 4')).toBeTruthy();
  expect(screen.getByText('+2')).toBeTruthy();
  // Rule changes are named in plain language, not as raw definitions.
  expect(screen.getByLabelText('Reviewed transition').textContent).toContain(
    'Command: !throw → !splat',
  );
  expect(screen.getByText(/Synthetic inputs/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/I understand this grants more authority/));
  expect(button.hasAttribute('disabled')).toBe(false);
  fireEvent.click(button);
  await waitFor(() =>
    expect(approve).toHaveBeenCalledWith(t, expect.stringMatching(/^[a-f0-9]{64}$/)),
  );
});

it.each(['boundary', 'source', 'version', 'session'] as const)(
  'rejects a delayed preview after the %s changes',
  async (change) => {
    let resolve!: (t: Transition) => void;
    vi.spyOn(api, 'previewTransition').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { rerender } = render(
      <TransitionReview version={editedVersion} automation={automation} panic={false} allowed />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
    if (change === 'boundary') fireEvent.click(screen.getByLabelText(/When this round ends/));
    if (change === 'source')
      fireEvent.change(screen.getByLabelText('Migration source (optional)'), {
        target: { value: '(input) => ({...input.snapshot})' },
      });
    if (change === 'version')
      rerender(
        <TransitionReview
          version={{ ...editedVersion, id: 'v3' }}
          automation={automation}
          panic={false}
          allowed
        />,
      );
    if (change === 'session')
      rerender(
        <TransitionReview
          version={editedVersion}
          automation={{ ...automation, session: { ...snapshot, id: 'new-round' } }}
          panic={false}
          allowed
        />,
      );
    resolve(transition());
    await screen.findByText(/changed during preview/);
    expect(
      screen.queryByRole('button', { name: /keep progress|Schedule|while paused/ }),
    ).toBeNull();
  },
);

it('invalidates reviewed source changes and shows stale approval errors without retaining proof', async () => {
  vi.spyOn(api, 'previewTransition').mockResolvedValue(transition());
  vi.spyOn(api, 'approveTransition').mockRejectedValue(
    new ApiError('The live version changed. Review again.', 409, 'STALE'),
  );
  render(
    <TransitionReview version={editedVersion} automation={automation} panic={false} allowed />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Apply now and keep progress' }));
  await screen.findByText('The live version changed. Review again.');
  expect(screen.queryByRole('button', { name: 'Apply now and keep progress' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
  await screen.findByRole('button', { name: 'Apply now and keep progress' });
  fireEvent.change(screen.getByLabelText('Migration source (optional)'), {
    target: { value: 'changed source' },
  });
  expect(screen.queryByRole('button', { name: 'Apply now and keep progress' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Preview again');
  fireEvent.change(screen.getByLabelText('Migration source (optional)'), { target: { value: '' } });
  expect(screen.queryByRole('button', { name: 'Apply now and keep progress' })).toBeNull();
});

it('explains stopped timing and prevents panic approval', async () => {
  const t = transition();
  t.plan.boundary = 'stopped';
  t.evidence.takesEffect = 'stopped';
  vi.spyOn(api, 'previewTransition').mockResolvedValue(t);
  const { rerender } = render(
    <TransitionReview version={editedVersion} automation={automation} panic={false} allowed />,
  );
  fireEvent.click(screen.getByLabelText(/While paused/));
  fireEvent.click(screen.getByRole('button', { name: 'Preview keeping progress' }));
  expect(
    (await screen.findByRole('button', { name: 'Apply while paused' })).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText('Pause this interaction before approving this timing.')).toBeTruthy();
  rerender(<TransitionReview version={editedVersion} automation={automation} panic allowed />);
  expect(
    screen.getByRole('button', { name: 'Preview keeping progress' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('button', { name: 'Apply while paused' })).toBeNull();
});

it('shows pending cancellation and routes stateful rollback to review of a healthy approved target', async () => {
  const pending = { ...transition(), targetVersionId: 'older', status: 'pending' as const };
  const cancel = vi
    .spyOn(api, 'cancelTransition')
    .mockResolvedValue({ ...pending, status: 'cancelled' });
  const select = vi.fn();
  const approveReset = vi.spyOn(api, 'approve').mockResolvedValue({});
  const studio = {
    automations: [
      {
        ...automation,
        versions: [
          version,
          {
            ...editedVersion,
            id: 'unhealthy',
            status: 'superseded',
            approvedAt: 2,
            blockers: ['Verification did not pass.'],
          },
          { ...editedVersion, id: 'older', status: 'superseded', approvedAt: 1 },
        ],
        canRollback: true,
        transitions: [pending],
      },
    ],
    overlay: { connections: 0 },
    twitch: { state: 'unconfigured', configured: false },
    panic: false,
  } as unknown as Studio;
  vi.spyOn(api, 'overlay').mockResolvedValue({ url: 'http://localhost/overlay', connections: 0 });
  render(
    <LivePanel
      studio={studio}
      selectedVersionId={null}
      onSelect={select}
      onEdit={() => undefined}
      notify={() => undefined}
    />,
  );
  expect(screen.getByText(/takes over when this round ends/).textContent).toContain('v2');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel pending change' }));
  expect(cancel).toHaveBeenCalledWith('t1');
  // One rollback entry point; it routes to the review where keep-vs-reset is chosen.
  expect(screen.queryByRole('button', { name: /Reset progress and roll back/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review rollback to v2…' }));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'older' }));
  expect(approveReset).not.toHaveBeenCalled();
});

describe('canonical session presentation', () => {
  it('presents score, countdown, participant resource and late-arrival rules as safe text', () => {
    const hud = createSessionHud(definition, snapshot, { now: 30000, viewerId: 'alice' });
    document.body.append(hud);
    expect(hud.textContent).toContain('Running');
    expect(hud.textContent).toContain('1:30');
    expect(hud.textContent).toContain('Red: 1');
    expect(hud.textContent).toContain('2 of 3 throws left');
    expect(hud.textContent).toContain('!red');
    expect(hud.textContent).toContain('!throw');
    const malicious = createSessionHud(
      { ...definition, title: '<img src=x onerror=alert(1)>' },
      snapshot,
    );
    expect(malicious.querySelector('img')).toBeNull();
  });
  it('renders cooperative completion and ties without inventing a team winner', () => {
    const cooperative = {
      ...definition,
      teams: [],
      objective: { kind: 'collective-goal' as const, target: 5 },
    };
    expect(
      createSessionHud(cooperative, {
        ...snapshot,
        phase: 'finished',
        scores: { community: 5 },
        winner: 'community',
        outcome: 'goal',
      }).textContent,
    ).toContain('Goal reached');
    expect(
      createSessionHud(definition, {
        ...snapshot,
        phase: 'finished',
        winner: 'tie',
        outcome: 'deadline',
      }).textContent,
    ).toContain('Tie');
  });
  it('rejects malformed session payloads and accepts legacy overlay effects', () => {
    const envelope = {
      v: 1,
      type: 'sessions',
      payload: { sessions: [{ automationId: 'a', title: 'Battle', definition, snapshot }] },
    };
    expect(overlayMessageSchema.safeParse(envelope).success).toBe(true);
    expect(
      overlayMessageSchema.safeParse({
        ...envelope,
        payload: {
          sessions: [
            {
              automationId: 'a',
              title: 'Bad',
              definition,
              snapshot: { ...snapshot, scores: { red: -1 } },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      overlayMessageSchema.safeParse({
        v: 1,
        type: 'effect',
        payload: { id: 'e', asset: 'tomato', x: 0.5, viewer: null },
      }).success,
    ).toBe(true);
  });
});

describe('session wire validation', () => {
  it('preserves prototype-like viewer identities and validates their resource evidence', async () => {
    const { sessionSnapshotSchema } = await import('../src/sessions/schemas.js');
    const participants = JSON.parse(
      '{"__proto__":{"teamId":"red","remaining":2,"contributions":1}}',
    ) as unknown;
    const parsed = sessionSnapshotSchema.parse({ ...snapshot, participants });
    expect(Object.hasOwn(parsed.participants, '__proto__')).toBe(true);
    expect(parsed.participants['__proto__']?.remaining).toBe(2);
    expect(sessionSnapshotSchema.safeParse({ ...snapshot, phase: 'paused' }).success).toBe(false);
  });
  it('rejects scores and resources that disagree with the canonical definition', () => {
    const envelope = {
      v: 1,
      type: 'sessions',
      payload: {
        sessions: [
          {
            automationId: 'a',
            title: 'Battle',
            definition,
            snapshot: { ...snapshot, scores: { red: 900, blue: 0 } },
          },
        ],
      },
    };
    expect(overlayMessageSchema.safeParse(envelope).success).toBe(false);
  });
});

describe('session controls', () => {
  it('requires explicit reset consent for incompatible approval', () => {
    const onApprove = vi.fn(async () => undefined);
    render(
      <Evidence
        version={{
          ...version,
          id: 'v2',
          number: 2,
          status: 'candidate',
          manifest: { ...version.manifest, experience: { ...definition, durationMs: 60000 } },
          progress: { kind: 'reset-required', reasons: ['The round gets shorter.'] },
        }}
        automation={automation}
        panic={false}
        previewed
        onApprove={onApprove}
        onDiscard={async () => undefined}
      />,
    );
    const button = screen.getByRole('button', { name: /Approve v2/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /reset.*progress/i }));
    fireEvent.click(button);
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: 'v2' }), true);
  });
  it('shows host-owned scenario state evidence beside each decision', () => {
    render(
      <Evidence
        version={{
          ...version,
          evidence: {
            ...version.evidence,
            verification: {
              ...version.evidence.verification,
              host: [
                {
                  name: 'Round resources',
                  kind: 'session',
                  origin: 'host',
                  passed: true,
                  durationMs: 1,
                  steps: [
                    {
                      id: 'e1',
                      viewer: 'alice',
                      roles: ['viewer'],
                      text: '!throw',
                      at: 0,
                      expect: 'ACCEPTED',
                      expectEffects: 1,
                      actual: 'ACCEPTED',
                      actualEffects: 1,
                      passed: true,
                      session: snapshot,
                      expectSession: { phase: 'running', scores: { red: 1 } },
                    },
                  ],
                },
              ],
            },
          },
        }}
        automation={automation}
        panic={false}
        previewed
        onApprove={async () => undefined}
        onDiscard={async () => undefined}
      />,
    );
    expect(screen.getByLabelText('Actual session evidence')).toHaveProperty(
      'textContent',
      expect.stringContaining('"remaining": 2'),
    );
    expect(screen.getByLabelText('Expected session evidence')).toHaveProperty(
      'textContent',
      expect.stringContaining('"red": 1'),
    );
  });
  it('verifies the live round from its journal and explains a mismatch', async () => {
    const base = {
      sessionId: 'session-1',
      entries: 9,
      joins: 2,
      contributions: 4,
      rejections: 1,
      controls: 2,
      durationMs: 12,
    };
    const audit = vi
      .spyOn(api, 'auditSession')
      .mockResolvedValueOnce({
        ...base,
        status: 'verified',
        summary: 'Every recorded decision and transition reproduced exactly.',
        divergence: null,
      })
      .mockResolvedValueOnce({
        ...base,
        status: 'diverged',
        summary:
          'Entry 4 (chat) does not reproduce: expected RESOURCE_LIMIT, replay produced ACCEPTED.',
        divergence: { seq: 4, kind: 'chat', expected: 'RESOURCE_LIMIT', actual: 'ACCEPTED' },
      });
    render(
      <LivePanel
        studio={
          {
            automations: [automation],
            panic: true, // auditing is read-only, so it stays available while stopped
            overlay: { connections: 0 },
            activity: [],
            twitch: { state: 'unconfigured', configured: false },
          } as unknown as Studio
        }
        selectedVersionId={null}
        onSelect={() => undefined}
        onEdit={() => undefined}
        notify={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Verify round' }));
    await waitFor(() => expect(audit).toHaveBeenCalledWith('a1'));
    expect(await screen.findByText('✓ Score verified.')).toBeTruthy();
    expect(document.body.textContent).toContain('4 throws, 1 blocked attempt and 2 clock changes');
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
    expect(await screen.findByText('⚠ The stored round does not match its journal.')).toBeTruthy();
    expect(document.body.textContent).toContain('expected RESOURCE_LIMIT');
  });

  it('starts each new interaction rehearsal as the default viewer', () => {
    const { rerender } = render(<Rehearsal version={version} onPreviewed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Bob/ }));
    expect(screen.getByRole('button', { name: /Bob/ }).getAttribute('aria-pressed')).toBe('true');
    rerender(<Rehearsal version={{ ...version, id: 'v2' }} onPreviewed={() => undefined} />);
    expect(screen.getByRole('button', { name: /Alice/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('confirms reset before sending the explicitly authorized mutation', async () => {
    const reset = vi.spyOn(api, 'resetSession').mockResolvedValue({});
    render(
      <LivePanel
        studio={
          {
            automations: [automation],
            panic: false,
            overlay: { connections: 0 },
            activity: [],
            twitch: { state: 'unconfigured', configured: false },
          } as unknown as Studio
        }
        selectedVersionId={null}
        onSelect={() => undefined}
        onEdit={() => undefined}
        notify={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset session…' }));
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset session' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('a1'));
  });
  it('replays join commands and an exact-deadline event through the preview API', async () => {
    const preview = vi.spyOn(api, 'preview').mockResolvedValue({
      provenance: 'synthetic',
      artifactId: 'f'.repeat(64),
      seed: 42,
      decisions: [],
      durationMs: 1,
      session: snapshot,
    });
    render(<Rehearsal version={version} onPreviewed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join Red' }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ text: '!red', viewerId: 'alice', at: 0 }),
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Advance to deadline' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advance to deadline' }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(preview.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ at: 120000 })]),
    );
  });
});

describe('overlay session lifecycle', () => {
  it('clears scores, instructions and effects on panic, watchdog, disconnect and rotation', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    window.history.replaceState({}, '', '/overlay/?key=test');
    document.body.innerHTML =
      '<div id="overlay-root"><div id="stage"></div><div id="instructions"></div><div id="notice"></div></div>';
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    class FakeSocket {
      static current: FakeSocket | undefined;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      constructor() {
        FakeSocket.current = this;
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    try {
      await import('../src/overlay/main.js');
      const send = (type: string, payload: unknown) =>
        FakeSocket.current?.onmessage?.({ data: JSON.stringify({ v: 1, type, payload }) });
      const populate = () => {
        send('sessions', {
          sessions: [
            { automationId: 'a1', versionId: 'v1', title: definition.title, definition, snapshot },
          ],
        });
        send('scenes', {
          scenes: [
            {
              automationId: 'a1',
              versionId: 'v1',
              revision: 1,
              digest: 'a'.repeat(64),
              scene: defaultScene(),
              instructions: ['Type !throw'],
            },
          ],
        });
        send('instructions', { lines: ['Type !throw'] });
        send('effect', {
          id: 'e',
          automationId: 'a1',
          versionId: 'v1',
          asset: 'tomato',
          x: 0.5,
          viewer: null,
        });
        expect(document.querySelector('[data-scene-kind=scoreboard]')).not.toBeNull();
      };
      const expectClear = () => {
        expect(document.querySelector('[data-scene-kind=scoreboard]')).toBeNull();
        expect(document.querySelector('[data-projectile]')).toBeNull();
        expect(document.getElementById('instructions')?.textContent).toBe('');
      };
      populate();
      send('clear', { reason: 'panic' });
      expectClear();
      populate();
      vi.advanceTimersByTime(5000);
      expectClear();
      populate();
      FakeSocket.current?.onclose?.({ code: 1006 });
      expectClear();
      vi.advanceTimersByTime(1000);
      populate();
      FakeSocket.current?.onclose?.({ code: 4001 });
      expectClear();
      expect(document.getElementById('overlay-root')?.dataset.mode).toBe('unauthorized');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      window.history.replaceState({}, '', '/');
    }
  });
});
it('renders an accepted quick-proof effect with the newly returned session timing', async () => {
  const scene = defaultScene();
  scene.nodes.find((n) => n.kind === 'effects')!.timing = {
    trigger: 'round-start',
    delayMs: 0,
    durationMs: 5000,
  };
  const atStart = {
    ...snapshot,
    phase: 'running' as const,
    remainingMs: definition.durationMs,
    deadlineAt: definition.durationMs,
    updatedAt: 0,
  };
  vi.spyOn(api, 'preview').mockResolvedValue({
    provenance: 'synthetic',
    artifactId: version.artifactId!,
    seed: 42,
    durationMs: 1,
    session: atStart,
    decisions: [
      {
        eventId: 'first',
        artifactId: version.artifactId!,
        viewerId: 'alice',
        at: 0,
        mode: 'preview',
        allowance: null,
        code: 'ACCEPTED',
        reason: 'Accepted',
        effects: [{ kind: 'projectile', asset: 'tomato', x: 0.5 }],
      },
    ],
  });
  const rendered = render(
    <Rehearsal version={version} scene={scene} onPreviewed={() => undefined} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByTestId('decision');
  await waitFor(() => expect(rendered.container.querySelector('[data-projectile]')).not.toBeNull());
});
it('uses the host instruction projection verbatim in private rehearsal', () => {
  const instructions = ['Join a team: !red / !blue', 'Everyone: !throw · 3 throws per round'];
  const result = render(
    <Rehearsal version={version} instructions={instructions} onPreviewed={() => undefined} />,
  );
  expect(
    result.container.querySelector('[data-scene-kind=instructions]')?.getAttribute('aria-label'),
  ).toBe(instructions.join(' · '));
});
