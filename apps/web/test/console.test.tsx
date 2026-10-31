// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Evidence } from '../src/console/review/evidence.js';
import { explain } from '../src/console/format.js';
import type { Decision, Manifest, Version } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const manifest: Manifest = {
  sdkVersion: '0.3.0',
  capabilities: ['overlay'],
  trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60_000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const decision = (code: Decision['code'], extra: Partial<Decision> = {}): Decision => ({
  eventId: 'e',
  artifactId: 'a',
  code,
  reason: 'reason',
  effects: [],
  mode: 'preview',
  viewerId: 'alice',
  at: 1000,
  allowance: null,
  ...extra,
});
const version = (patch: Partial<Version> = {}): Version => ({
  id: 'v2',
  automationId: 'auto',
  number: 2,
  parentVersionId: 'v1',
  artifactId: 'f'.repeat(64),
  title: 'Tomato Toss',
  intent: 'Change the command to !splat, subscribers only',
  source:
    "async (e, r) => { await r.overlay.emit({ kind: 'projectile', asset: 'tomato', x: 0.5 }) }",
  manifest,
  tests: [],
  behavior: {
    when: 'Someone types !tomato in chat',
    what: 'A tomato flies',
    who: 'Everyone in chat',
    howMuch: 'Up to 3 per viewer',
  },
  assumptions: [],
  evidence: {
    verification: {
      ok: true,
      artifactId: 'f'.repeat(64),
      stages: [
        {
          id: 'manifest',
          label: 'Permission manifest',
          status: 'passed',
          durationMs: 1,
          summary: 'ok',
        },
      ],
      findings: [],
      capabilitiesUsed: ['overlay'],
      generated: [],
      host: [],
      failureReport: null,
    },
    intent: [
      {
        aspect: 'command',
        label: 'Command',
        stated: '!tomato',
        actual: '!tomato',
        previous: null,
        status: 'match',
      },
    ],
  },
  origin: 'codex',
  compileRunId: null,
  status: 'candidate',
  incident: null,
  approvedAt: null,
  activatedAt: null,
  createdAt: Date.now(),
  changes: [],
  blockers: [],
  ...patch,
});

describe('plain-language decisions', () => {
  it('explains limits with the time until the next action', () => {
    const text = explain(
      decision('VIEWER_LIMIT', {
        allowance: { used: 3, max: 3, windowMs: 60_000, nextAt: 60_000 },
      }),
      '!tomato',
      'Alice',
      manifest,
    );
    expect(text).toContain('Alice already used 3 of 3 in the last minute');
    expect(text).toContain('next one in 0:59');
    expect(text).toContain('keeps running');
  });
  it('explains duplicates, unrelated chat and eligibility', () => {
    expect(explain(decision('DUPLICATE'), '!tomato', 'Alice', manifest)).toContain('counted once');
    expect(explain(decision('UNRELATED'), 'hello', 'Alice', manifest)).toContain('isn’t !tomato');
    expect(
      explain(decision('AUDIENCE'), '!tomato', 'Alice', {
        ...manifest,
        trigger: { ...manifest.trigger, audience: ['subscriber'] },
      }),
    ).toContain('only subscribers');
  });
});

describe('approval card', () => {
  it('shows the five facts in order and approves the exact artifact', async () => {
    const onApprove = vi.fn(async () => undefined);
    render(
      <Evidence
        version={version()}
        automation={undefined}
        panic={false}
        previewed
        onApprove={onApprove}
        onDiscard={async () => undefined}
      />,
    );
    const facts = within(screen.getByLabelText('What this version does'))
      .getAllByRole('term')
      .map((t) => t.textContent);
    expect(facts).toEqual([
      'When it runs',
      'What it does',
      'Who can trigger it',
      'How much it may do',
      'What passed',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Approve v2/ }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'f'.repeat(64) }));
  });
  it('blocks approval with stated reasons and requires consent for wider authority', () => {
    const { rerender } = render(
      <Evidence
        version={version({ blockers: ['Verification did not pass.'] })}
        automation={undefined}
        panic={false}
        previewed
        onApprove={async () => undefined}
        onDiscard={async () => undefined}
      />,
    );
    expect(screen.getByText('Verification did not pass.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve v2/ }).hasAttribute('disabled')).toBe(true);
    rerender(
      <Evidence
        version={version({
          changes: [
            {
              field: 'maxPerViewer',
              label: 'Per-viewer allowance',
              from: '3',
              to: '10',
              authority: 'more',
            },
          ],
        })}
        automation={undefined}
        panic={false}
        previewed
        onApprove={async () => undefined}
        onDiscard={async () => undefined}
      />,
    );
    const approve = screen.getByRole('button', { name: /Approve v2/ });
    expect(approve.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(approve.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('↑ more authority')).toBeTruthy();
  });
});
