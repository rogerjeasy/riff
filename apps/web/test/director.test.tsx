// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { overlayMessageSchema } from '../src/overlay/messages.js';
import { launch } from '../src/effects/projectile.js';
import { envelopeSchema, defaultEnvelope } from '../src/console/director/contracts.js';
it('rejects authority and inverted director ranges', () => {
  expect(envelopeSchema.safeParse(defaultEnvelope).success).toBe(true);
  expect(
    envelopeSchema.safeParse({ ...defaultEnvelope, intensity: { min: 80, max: 25 } }).success,
  ).toBe(false);
  expect(envelopeSchema.safeParse({ ...defaultEnvelope, cooldown: 1 }).success).toBe(false);
});
it('bounds optional overlay intensity and measurably scales reduced-motion sprites', () => {
  const frame = { v: 1, type: 'effect', payload: { id: 'a', asset: 'star', x: 0.5, viewer: null } };
  expect(overlayMessageSchema.safeParse(frame).success).toBe(true);
  for (const intensity of [24, 101, NaN])
    expect(
      overlayMessageSchema.safeParse({ ...frame, payload: { ...frame.payload, intensity } })
        .success,
    ).toBe(false);
  vi.useFakeTimers();
  const stage = document.createElement('div');
  launch(stage, { asset: 'star', x: 0.5, reducedMotion: true, intensity: 25 });
  launch(stage, { asset: 'star', x: 0.5, reducedMotion: true });
  expect(parseFloat((stage.children[0] as HTMLElement).style.width)).toBe(
    parseFloat((stage.children[1] as HTMLElement).style.width) / 4,
  );
  vi.runAllTimers();
  vi.useRealTimers();
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { DirectorPanel } from '../src/console/director/panel.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('saves only a draft and never enables controls before approval', async () => {
  const state = {
    revision: 0,
    draft: null,
    approved: null,
    enabled: false,
    mode: 'balanced',
    settings: null,
    history: [],
    telemetry: null,
  };
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ state }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<DirectorPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Adaptive director/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save draft only' }).closest('fieldset')?.disabled,
    ).toBe(false),
  );
  expect(screen.getByRole('button', { name: 'Balanced' }).closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save draft only' }));
  // The 2-second poll may also fire under load; assert on the draft request itself.
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/director/draft')).toBe(true),
  );
  const draftCalls = fetcher.mock.calls.filter(([url]) => url === '/api/director/draft');
  expect(draftCalls).toHaveLength(1);
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes('approve'))).toBe(true);
  const init = draftCalls[0]?.[1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({
    expectedRevision: 0,
    envelope: defaultEnvelope,
  });
  expect(init.headers).toMatchObject({ 'x-riff-request': '1' });
});

it('lets the creator choose opportunity rotation and explains it before saving the draft', async () => {
  const state = {
    revision: 0,
    draft: null,
    approved: null,
    enabled: false,
    mode: 'balanced',
    settings: null,
    history: [],
    telemetry: null,
  };
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ state }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<DirectorPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Adaptive director/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save draft only' }).closest('fieldset')?.disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Rotate turns' }));
  expect(screen.getByRole('button', { name: 'Rotate turns' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.getByText(/Priority to viewers who haven’t had a turn yet/)).toBeTruthy();
  expect(screen.getByText(/never by spending or subscription/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save draft only' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/director/draft')).toBe(true),
  );
  const init = fetcher.mock.calls.find(([url]) => url === '/api/director/draft')?.[1];
  expect(JSON.parse(init?.body as string).envelope.participation).toBe('rotation');
});

it('fences a pending draft response after immediate stop and preserves edited inputs', async () => {
  const state = {
    revision: 0,
    draft: null,
    approved: null,
    enabled: false,
    mode: 'balanced',
    settings: null,
    history: [],
    telemetry: null,
  };
  let resolveDraft!: (value: Response) => void;
  const response = (value: unknown) =>
    new Response(JSON.stringify({ state: value }), { status: 200 });
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/draft'))
      return new Promise<Response>((resolve) => {
        resolveDraft = resolve;
      });
    if (String(url).endsWith('/stop')) return response({ ...state, revision: 2 });
    return response(state);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<DirectorPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Adaptive director/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save draft only' }).closest('fieldset')?.disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText('Visual intensity during a burst'), {
    target: { value: '45' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft only' }));
  await waitFor(() => expect(resolveDraft).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Stop director cosmetics immediately' }));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  resolveDraft(response({ ...state, revision: 1, enabled: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/^Adapting/)).toBeNull();
  expect(screen.getByLabelText('Visual intensity during a burst')).toHaveProperty('value', '45');
});

import type { Version } from '../src/lib/types.js';
it('restores saved proof selection on reload, shows bounded reasons and blocks approval in panic', async () => {
  const settings = { intervalMs: 500, batchSize: 1, intensity: 35 };
  const telemetry = {
    mode: 'balanced',
    settings,
    accepted: 3,
    offered: 3,
    presented: 1,
    coalesced: 2,
    expired: 0,
    cleared: 0,
    pending: 0,
    decisions: [
      { at: 1, reason: 'Surge selected calm endpoint', settings, pending: 0, activity: 12 },
      { at: 2, reason: 'Queue returned to normal', settings, pending: 0, activity: 0 },
    ],
  };
  const proof = {
    hash: 'proof',
    digest: 'digest',
    versionId: 'v2',
    artifactId: 'artifact',
    scenarioHash: 'scenario',
    rehearsalHash: 'run',
    passed: true,
    accepted: 3,
    blocked: 1,
    scores: { community: 3 },
    contributions: 3,
    stateDigest: 'same',
    replayStateDigest: 'same',
    telemetry,
    samples: [],
    provenance: 'synthetic',
  };
  const revision = { revision: 1, digest: 'digest', envelope: defaultEnvelope };
  const older = { revision: 0, digest: 'older', envelope: defaultEnvelope };
  const state = {
    revision: 2,
    draft: { ...revision, evidence: proof },
    approved: { ...older, evidenceHash: 'earlier', approvedAt: 1 },
    enabled: false,
    mode: 'balanced',
    settings,
    history: [older, revision],
    telemetry,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ state }), { status: 200 })),
  );
  const versions = [
    { id: 'v1', title: 'Earlier', number: 1 },
    { id: 'v2', title: 'Tested', number: 2 },
  ].map((v) => ({
    ...v,
    artifactId: `artifact-${v.id}`,
    evidence: { verification: { ok: true } },
  })) as unknown as Version[];
  const view = render(<DirectorPanel versions={versions} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Adaptive director/ }));
  await waitFor(() =>
    expect(screen.getByLabelText('Stress-test version')).toHaveProperty('value', 'v2'),
  );
  expect(screen.getByRole('button', { name: 'Approve exact tested envelope' })).toHaveProperty(
    'disabled',
    false,
  );
  fireEvent.click(screen.getByText(/^Decision history/));
  expect(screen.getAllByText(/Surge selected calm endpoint/).length).toBeGreaterThan(0);
  view.rerender(<DirectorPanel versions={versions} panic={true} />);
  expect(screen.getByRole('button', { name: 'Approve exact tested envelope' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(
    screen.getByRole('button', { name: 'Stop director cosmetics immediately' }),
  ).toHaveProperty('disabled', false);
});
