// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSessionHud } from '../src/sessions/presentation.js';
import { overlayMessageSchema } from '../src/overlay/messages.js';
import { Evidence } from '../src/console/review/evidence.js';
import { LivePanel } from '../src/console/live/live-panel.js';
import { Rehearsal } from '../src/console/rehearsal/stage.js';
import { api } from '../src/lib/api.js';
import type { ExperienceDefinition, SessionSnapshot, Studio, Version } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
          sessions: [{ automationId: 'a1', title: definition.title, definition, snapshot }],
        });
        send('instructions', { lines: ['Type !throw'] });
        send('effect', { id: 'e', asset: 'tomato', x: 0.5, viewer: null });
        expect(document.querySelector('.session-hud')).not.toBeNull();
      };
      const expectClear = () => {
        expect(document.querySelector('.session-hud')).toBeNull();
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
