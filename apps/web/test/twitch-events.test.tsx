// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Rehearsal } from '../src/console/rehearsal/stage.js';
import { TwitchEventsPanel } from '../src/console/twitch/event-triggers.js';
import { TwitchEventSimulator } from '../src/console/twitch/simulator.js';
import { explain, triggerInstruction, triggerSummary } from '../src/console/format.js';
import type { Decision, Manifest, Studio, Version } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const trigger = (name: string, extra: Record<string, unknown>) => ({
  name,
  label: {
    subscribe: 'New subscriptions',
    gift: 'Gifted subscriptions',
    resub: 'Resubscription messages',
    cheer: 'Cheers (Bits)',
    raid: 'Incoming raids',
  }[name],
  eventSubType: `channel.${name}`,
  version: '1',
  docs: 'https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/',
  consent: name === 'cheer' ? 'bits' : name === 'raid' ? 'raids' : 'subscriptions',
  scopes: name === 'cheer' ? ['bits:read'] : name === 'raid' ? [] : ['channel:read:subscriptions'],
  missingScopes: [],
  inUse: false,
  subscription: 'idle',
  message: null,
  ...extra,
});
const studio = (state = 'connected') =>
  ({ twitch: { state, configured: true }, automations: [] }) as unknown as Studio;

it('shows which families are listening, in use and missing consent, with scoped consent links', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            configured: true,
            triggers: [
              trigger('subscribe', {
                missingScopes: ['channel:read:subscriptions'],
                subscription: 'missing-consent',
              }),
              trigger('gift', {
                missingScopes: ['channel:read:subscriptions'],
                subscription: 'missing-consent',
              }),
              trigger('resub', {
                missingScopes: ['channel:read:subscriptions'],
                subscription: 'missing-consent',
              }),
              trigger('cheer', {
                missingScopes: ['bits:read'],
                subscription: 'missing-consent',
                inUse: true,
              }),
              trigger('raid', { inUse: true, subscription: 'active' }),
            ],
          }),
          { status: 200 },
        ),
    ),
  );
  render(<TwitchEventsPanel studio={studio()} />);
  // Opens by default because a live interaction cannot hear its event.
  expect(await screen.findByText(/A live interaction can’t hear its event yet/)).toBeTruthy();
  const list = screen.getByRole('list');
  const cheer = within(list).getByText('Cheers (Bits)').closest('li')!;
  expect(within(cheer).getByText('Needs consent')).toBeTruthy();
  expect(within(cheer).getByText('In use')).toBeTruthy();
  const raid = within(list).getByText('Incoming raids').closest('li')!;
  expect(within(raid).getByText('Listening')).toBeTruthy();
  expect(within(raid).getByText('no extra permission')).toBeTruthy();
  expect(screen.getByRole('link', { name: /Allow cheer events/ }).getAttribute('href')).toBe(
    '/auth/twitch?triggers=cheer',
  );
  expect(screen.getByRole('link', { name: /Allow subscription events/ }).getAttribute('href')).toBe(
    `/auth/twitch?triggers=${encodeURIComponent('subscribe,gift,resub')}`,
  );
  expect(screen.getByText('Needs consent', { selector: '.panel-head .pill' })).toBeTruthy();
});

it('reports an explicit error with retry, and a not-connected state', async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetcher);
  render(<TwitchEventsPanel studio={studio('disconnected')} />);
  fireEvent.click(screen.getByRole('button', { name: /Twitch event triggers/ }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Connect Twitch' }).getAttribute('href')).toBe(
    '/auth/twitch',
  );
  const calls = fetcher.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(fetcher.mock.calls.length).toBe(calls + 1);
});

it('simulates labeled synthetic events, including thresholds and anonymous cheers', () => {
  const sent: unknown[] = [];
  render(
    <TwitchEventSimulator
      kind="cheer"
      minimum={100}
      viewerName="Alice"
      disabled={false}
      onSend={(detail) => sent.push(detail)}
    />,
  );
  expect(screen.getByText('Synthetic')).toBeTruthy();
  expect(screen.getByText(/Nothing reaches Twitch or your stream/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Just below \(99\)/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Anonymous' }));
  fireEvent.change(screen.getByLabelText('Bits'), { target: { value: '300' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send synthetic cheer' }));
  expect(sent).toEqual([
    { kind: 'cheer', amount: 99, tier: null, anonymous: false, gift: false },
    { kind: 'cheer', amount: 300, tier: null, anonymous: true, gift: false },
  ]);
  fireEvent.change(screen.getByLabelText('Bits'), { target: { value: '0' } });
  expect(screen.getByRole('alert').textContent).toMatch(/whole number of bits/);
  expect(
    (screen.getByRole('button', { name: 'Send synthetic cheer' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('describes event triggers in plain words instead of a reserved command', () => {
  const manifest = {
    sdkVersion: '0.4.0',
    capabilities: ['overlay'],
    trigger: {
      command: '@cheer',
      audience: ['viewer'],
      maxPerViewer: 5,
      windowMs: 60_000,
      kind: 'twitch.event',
      event: { kind: 'cheer', minimum: 100 },
    },
    limits: { effectsPerEvent: 5, effectsPerMinute: 60 },
  } as Manifest;
  expect(triggerSummary(manifest)).toBe('Someone cheers 100+ bits');
  expect(triggerInstruction(manifest)).toBe('Someone cheers 100+ bits');
  const decision = {
    code: 'BELOW_MINIMUM',
    effects: [],
    allowance: null,
  } as unknown as Decision;
  expect(explain(decision, '', 'Alice', manifest)).toMatch(/below the 100 minimum/);
  expect(
    triggerInstruction({
      ...manifest,
      trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 5, windowMs: 60_000 },
    }),
  ).toBe('Type !tomato');
  expect(
    triggerSummary({
      trigger: {
        command: '!hydrate',
        audience: ['viewer'],
        maxPerViewer: 5,
        windowMs: 60_000,
        kind: 'points.redeem',
        reward: 'Hydrate',
      },
    }),
  ).toBe('Someone redeems “Hydrate”');
});

it('rehearses an event trigger privately with synthetic events through the preview route', async () => {
  const artifact = 'a'.repeat(64);
  const manifest = {
    sdkVersion: '0.4.0',
    capabilities: ['overlay'],
    trigger: {
      command: '@cheer',
      audience: ['viewer'],
      maxPerViewer: 5,
      windowMs: 60_000,
      kind: 'twitch.event',
      event: { kind: 'cheer', minimum: 100 },
    },
    limits: { effectsPerEvent: 5, effectsPerMinute: 60 },
  } as Manifest;
  const version = {
    id: 'v1',
    automationId: 'a1',
    number: 1,
    parentVersionId: null,
    artifactId: artifact,
    title: 'Cheer Shower',
    intent: 'When someone cheers 100+ bits, rain stars',
    source: '',
    manifest,
    tests: [],
    behavior: { when: '', what: '', who: '', howMuch: '' },
    assumptions: [],
    evidence: {
      verification: {
        ok: true,
        artifactId: artifact,
        stages: [],
        findings: [],
        capabilitiesUsed: [],
        generated: [],
        host: [],
        failureReport: null,
      },
      intent: [],
    },
    origin: 'reference',
    compileRunId: null,
    status: 'candidate',
    incident: null,
    approvedAt: null,
    activatedAt: null,
    createdAt: 0,
    changes: [],
    blockers: [],
  } as unknown as Version;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events: unknown[] };
    return new Response(
      JSON.stringify({
        provenance: 'synthetic',
        artifactId: artifact,
        seed: 42,
        durationMs: 3,
        decisions: body.events.map((_, i) => ({
          eventId: `t${i}`,
          artifactId: artifact,
          code: 'ACCEPTED',
          reason: 'Accepted.',
          effects: [{ kind: 'projectile', asset: 'star', x: 0.5 }],
          mode: 'preview',
          viewerId: 'alice',
          at: 0,
          allowance: { used: 1, max: 5, windowMs: 60_000, nextAt: 60_000 },
        })),
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const previewed = vi.fn();
  render(<Rehearsal version={version} onPreviewed={previewed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send synthetic cheer' }));
  await waitFor(() => expect(previewed).toHaveBeenCalledWith('v1'));
  const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
    events: { text: string; twitch: unknown }[];
  };
  expect(sent.events[0]).toMatchObject({
    text: '',
    twitch: { kind: 'cheer', amount: 100, tier: null, anonymous: false, gift: false },
  });
  expect(await screen.findByText(/Synthetic cheer · 100 bits/)).toBeTruthy();
  expect(screen.getByText(/Someone cheers 100\+ bits \(Alice\)/)).toBeTruthy();
});
