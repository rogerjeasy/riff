// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { formatCountdown, TimerList } from '../src/console/timers/timer-list.js';
import { api, ApiError } from '../src/lib/api.js';
import { resultSchema } from '../src/console/rehearsal/contracts.js';
import type { TimerView } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const timer = (patch: Partial<TimerView> = {}): TimerView => ({
  id: 't1',
  automationId: 'a1',
  versionId: 'v1',
  name: 'celebrate',
  intervalMs: 60_000,
  repeat: false,
  scheduledAt: 61_000,
  createdAt: 1_000,
  fires: 0,
  ...patch,
});
const props = (timers: TimerView[], extra: Partial<Parameters<typeof TimerList>[0]> = {}) => ({
  automationId: 'a1',
  title: 'Countdown',
  timers,
  command: '!start',
  live: true,
  stopped: false,
  notify: vi.fn(),
  ...extra,
});

describe('console timers view', () => {
  it('formats readable countdowns, including hours', () => {
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
    expect(formatCountdown(-10)).toBe('0:00');
  });

  it('lists each pending timer with its countdown, cadence and a labelled cancel control', () => {
    vi.useFakeTimers();
    let now = 1_000;
    render(
      <TimerList
        {...props(
          [
            timer(),
            timer({
              id: 't2',
              name: 'tick',
              repeat: true,
              intervalMs: 600_000,
              fires: 2,
              scheduledAt: 601_000,
            }),
          ],
          { now: () => now },
        )}
      />,
    );
    expect(screen.getByRole('heading', { name: /timers/i }).textContent).toContain('2 pending');
    expect(screen.getByText('1:00')).toBeTruthy();
    expect(screen.getByText('Once · 1 min')).toBeTruthy();
    expect(screen.getByText('Repeats every 10 min')).toBeTruthy();
    expect(screen.getByText('fired 2 times')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Cancel timer celebrate of Countdown' }),
    ).toBeTruthy();
    now = 31_000;
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('0:30')).toBeTruthy();
    now = 61_500;
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Due now')).toBeTruthy();
  });

  it('cancels through the API with an explicit busy state and reports the result', async () => {
    let resolve: (value: { cancelled: number }) => void = () => undefined;
    const cancel = vi
      .spyOn(api, 'cancelTimer')
      .mockImplementation(() => new Promise((r) => (resolve = r)));
    const notify = vi.fn();
    render(<TimerList {...props([timer()], { notify, now: () => 1_000 })} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel timer celebrate/i }));
    expect(cancel).toHaveBeenCalledWith('a1', 'celebrate');
    const busy = screen.getByRole('button', { name: /cancel timer celebrate/i });
    expect(busy.textContent).toBe('Cancelling…');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    resolve({ cancelled: 1 });
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/will not fire/)),
    );
  });

  it('shows the server message when a timer already fired', async () => {
    vi.spyOn(api, 'cancelTimer').mockRejectedValue(
      new ApiError('That timer already fired or was cancelled.', 404, 'NOT_FOUND'),
    );
    const notify = vi.fn();
    render(<TimerList {...props([timer()], { notify, now: () => 1_000 })} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel timer celebrate/i }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('That timer already fired or was cancelled.', 'bad'),
    );
  });

  it.each([
    [{ live: true, stopped: false }, /typing !start in chat starts one/i],
    [{ live: false, stopped: false }, /paused/i],
    [{ live: true, stopped: true }, /will not come back on resume/i],
  ])('explains the empty state %o', (state, text) => {
    render(<TimerList {...props([], state)} />);
    expect(screen.getByText(text)).toBeTruthy();
  });
});

describe('rehearsal timeline contract', () => {
  it('accepts timer fires and queued timer operations from the host', () => {
    const hash = 'a'.repeat(64);
    const decision = {
      eventId: 'go',
      artifactId: hash,
      code: 'ACCEPTED',
      reason: 'Accepted.',
      effects: [],
      mode: 'preview',
      viewerId: 'ada',
      at: 0,
      allowance: null,
      timers: [{ op: 'start', name: 'celebrate', ms: 60_000, repeat: false }],
    };
    const parsed = resultSchema.safeParse({
      contractVersion: 1,
      artifactId: hash,
      scenarioHash: hash,
      evidenceHash: hash,
      seed: 1,
      initialAt: 0,
      provenance: { kind: 'synthetic' },
      through: 2,
      totalSteps: 2,
      status: 'passed',
      timeline: [
        { through: 1, key: 'go', kind: 'chat', at: 0, decision, stateDigest: hash, summary: null },
        {
          through: 2,
          key: 'wait',
          kind: 'advance',
          at: 60_000,
          decision: null,
          stateDigest: hash,
          summary: null,
          timers: [{ name: 'celebrate', at: 60_000, code: 'ACCEPTED', effects: 3 }],
        },
      ],
      cursor: { at: 60_000, session: null, stateDigest: hash, decision: null },
      checks: [],
    });
    expect(parsed.success).toBe(true);
  });
});
