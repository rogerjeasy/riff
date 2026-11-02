// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ActivityFeed } from '../src/console/live/live-panel.js';
import { approvalLine } from '../src/console/format.js';
import { api } from '../src/lib/api.js';
import type { Activity } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entry = (patch: Partial<Activity>): Activity => ({
  id: 1,
  at: Date.now(),
  kind: 'decision',
  automationId: 'a1',
  versionId: 'v3',
  eventId: 'e1',
  viewer: 'alice',
  code: 'ACCEPTED',
  message: 'alice used !tomato · 1 cosmetic effect submitted for presentation',
  source: { kind: 'chat', label: '!tomato by alice' },
  interaction: { title: 'Tomato Toss', number: 3 },
  outcome: 'accepted',
  reason: null,
  effects: { allowed: 1, blocked: 0 },
  ...patch,
});
const feed = [
  entry({ id: 3 }),
  entry({
    id: 2,
    code: 'VIEWER_LIMIT',
    outcome: 'blocked',
    message: 'alice already used 3 of 3 in the last minute.',
    reason: 'alice already used 3 of 3 in the last minute.',
    effects: null,
  }),
  entry({
    id: 1,
    kind: 'incident',
    code: 'INCIDENT',
    viewer: null,
    source: { kind: 'system', label: 'Riff host' },
    outcome: 'incident',
    message: 'v3 was stopped: memory limit. Roll back to restore.',
    reason: 'v3 was stopped: memory limit. Roll back to restore.',
    effects: null,
  }),
  entry({
    id: 0,
    kind: 'decision',
    source: { kind: 'timer', label: 'celebrate' },
    message: 'Timer “celebrate” fired · 2 cosmetic effects submitted for presentation',
    effects: { allowed: 1, blocked: 1 },
  }),
];

describe('F16 activity feed', () => {
  it('shows source, exact version, outcome, reason and effect counts', () => {
    render(<ActivityFeed activity={feed} onSelectVersion={() => {}} />);
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain('Accepted');
    expect(rows[0]!.textContent).toContain('Chat · !tomato by alice');
    expect(rows[0]!.textContent).toContain('1 effect allowed');
    expect(rows[1]!.textContent).toContain('Blocked');
    expect(rows[1]!.textContent).toContain('Reason: alice already used 3 of 3');
    expect(rows[2]!.getAttribute('data-outcome')).toBe('incident');
    expect(rows[2]!.textContent).toContain('Incident');
    expect(rows[3]!.textContent).toContain('Timer · celebrate');
    expect(rows[3]!.textContent).toContain('1 effect allowed');
    expect(rows[3]!.textContent).toContain('1 blocked');
  });

  it('selects the exact version for review from a keyboard-reachable button', () => {
    const onSelectVersion = vi.fn();
    render(
      <ActivityFeed activity={feed} selectedVersionId="v3" onSelectVersion={onSelectVersion} />,
    );
    const [first] = screen.getAllByRole('button', { name: 'Review Tomato Toss v3' });
    expect(first!.tagName).toBe('BUTTON');
    expect(first!.getAttribute('aria-current')).toBe('true');
    fireEvent.click(first!);
    expect(onSelectVersion).toHaveBeenCalledWith('v3');
  });

  it('filters to blocked entries or incidents with explicit empty states', () => {
    render(<ActivityFeed activity={feed} />);
    const blocked = screen.getByRole('button', { name: /Blocked/ });
    fireEvent.click(blocked);
    expect(blocked.getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Incidents/ }));
    const only = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(only).toHaveLength(1);
    expect(only[0]!.textContent).toContain('memory limit');
    cleanup();
    render(<ActivityFeed activity={[feed[0]!]} />);
    fireEvent.click(screen.getByRole('button', { name: /Incidents/ }));
    expect(screen.getByText(/No incidents recently/)).toBeTruthy();
  });

  it('shows a removed version as plain text without a review button', () => {
    render(
      <ActivityFeed
        activity={[entry({ versionId: null, interaction: { title: 'Gone', number: null } })]}
        onSelectVersion={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Review/ })).toBeNull();
    expect(screen.getByText('Gone')).toBeTruthy();
  });
});

describe('F06 approval binding in the console', () => {
  it('sends the reviewed test report hash with the artifact', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetcher);
    await api.approve({ id: 'v2', artifactId: 'a'.repeat(64), reportHash: 'b'.repeat(64) }, 'v1');
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/versions/v2/approve',
      expect.objectContaining({
        body: JSON.stringify({
          artifactId: 'a'.repeat(64),
          reportHash: 'b'.repeat(64),
          expectedActiveVersionId: 'v1',
        }),
      }),
    );
  });

  it('names the approving actor', () => {
    expect(approvalLine('console', 0)).toMatch(/^Approved by the console at /);
    expect(approvalLine('chat:streamer', 0)).toMatch(/^Approved by streamer in chat at /);
    expect(approvalLine(null, 0)).toMatch(/\(approver not recorded\)\.$/);
  });
});
