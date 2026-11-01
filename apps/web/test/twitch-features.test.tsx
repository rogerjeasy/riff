// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TwitchFeaturesPanel } from '../src/console/twitch-features/panel.js';
import { explain } from '../src/console/format.js';

it('explains rehearsed native actions as simulated, never sent', () => {
  const text = explain(
    {
      eventId: 'e',
      artifactId: 'a',
      code: 'ACCEPTED',
      reason: '',
      effects: [],
      actions: [{ kind: 'poll.start', title: 'Next?', choices: ['A', 'B'], durationSeconds: 60 }],
      mode: 'preview',
      viewerId: 'owner',
      at: 0,
      allowance: null,
    },
    '!poll',
    'owner',
    {
      sdkVersion: '0.4.0',
      capabilities: ['polls'],
      trigger: { command: '!poll', audience: ['broadcaster'], maxPerViewer: 1, windowMs: 60_000 },
      limits: { effectsPerEvent: 1, effectsPerMinute: 2 },
    } as never,
  );
  expect(text).toBe(
    'owner typed !poll — simulated Twitch, nothing sent: would start the poll “Next?” (A / B) for 60 s.',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const feature = (
  name: 'polls' | 'announcements' | 'shoutouts',
  state: string,
  message = 'Ready.',
) => ({
  feature: name,
  capability: { polls: 'polls', announcements: 'chat.announce', shoutouts: 'shoutout' }[name],
  scope: {
    polls: 'channel:manage:polls',
    announcements: 'moderator:manage:announcements',
    shoutouts: 'moderator:manage:shoutouts',
  }[name],
  state,
  message,
  usedBy: name === 'polls' ? [{ automationId: 'a1', title: 'Channel Poll', live: true }] : [],
});
const base = {
  connected: true,
  login: 'streamer',
  stopped: false,
  broadcasterType: 'affiliate',
  features: [
    feature('polls', 'ready'),
    feature('announcements', 'needs-grant', 'Grant “moderator:manage:announcements” on Twitch.'),
    feature('shoutouts', 'ready'),
  ],
  poll: null,
  shoutout: { mode: 'off', allowlist: [], raiders: [], availableAt: null },
  budgets: {
    announcements: { used: 0, limit: 6, windowMs: 60_000, availableAt: null },
    polls: { used: 0, limit: 12, windowMs: 3_600_000 },
    shoutouts: { used: 0, limit: 10, windowMs: 3_600_000 },
  },
  history: [],
};
function stub(snapshot: unknown, post?: (url: string, body: unknown) => Response) {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST' && post) return post(String(url), JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ features: snapshot }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Twitch features/ }));
  await screen.findByRole('list', { name: 'Feature permissions' });
};

it('shows per-feature consent with a separate grant link and how automations use it', async () => {
  stub(base);
  render(<TwitchFeaturesPanel panic={false} />);
  await open();
  const cards = within(screen.getByRole('list', { name: 'Feature permissions' })).getAllByRole(
    'listitem',
  );
  expect(cards).toHaveLength(3);
  expect(within(cards[1]!).getByText('Not granted')).toBeTruthy();
  expect(
    within(cards[1]!)
      .getByRole('link', { name: /Grant on Twitch/ })
      .getAttribute('href'),
  ).toBe('/auth/twitch?feature=announcements');
  expect(within(cards[0]!).queryByRole('link')).toBeNull();
  expect(within(cards[0]!).getByRole('switch', { name: 'Use in Riff' })).toHaveProperty(
    'checked',
    true,
  );
  expect(within(cards[0]!).getByText(/Channel Poll/)).toBeTruthy();
  expect(screen.getByText('2 of 3 ready')).toBeTruthy();
});

it('validates poll input inline and starts the poll with the exact request', async () => {
  const fetcher = stub(base, (_url, body) => {
    const poll = {
      id: 'p1',
      title: (body as { title: string }).title,
      choices: [
        { id: 'c1', title: 'Speedrun', votes: 3 },
        { id: 'c2', title: 'Hardcore', votes: 1 },
      ],
      status: 'ACTIVE',
      startedAt: Date.now(),
      endsAt: Date.now() + 120_000,
      endedAt: null,
      origin: 'manual',
      automationId: null,
      refreshedAt: Date.now(),
    };
    return new Response(JSON.stringify({ features: { ...base, poll } }), { status: 200 });
  });
  render(<TwitchFeaturesPanel panic={false} />);
  await open();
  const start = screen.getByRole('button', { name: 'Start poll on Twitch' });
  expect(start).toHaveProperty('disabled', true);
  expect(screen.getByText('Write the poll question.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Question/), { target: { value: 'What next?' } });
  fireEvent.change(screen.getByLabelText(/Choice 1/), { target: { value: 'Speedrun' } });
  fireEvent.change(screen.getByLabelText(/Choice 2/), { target: { value: 'speedrun' } });
  expect(screen.getByText('Choices must be different.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Choice 2/), { target: { value: 'Hardcore' } });
  expect(start).toHaveProperty('disabled', false);
  fireEvent.click(start);
  await screen.findByText('Poll started on Twitch.');
  const call = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(call?.[0]).toBe('/api/twitch/polls');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    title: 'What next?',
    choices: ['Speedrun', 'Hardcore'],
    durationSeconds: 120,
  });
  const results = screen.getByRole('list', { name: 'Results' });
  expect(within(results).getByText('3 votes · 75%')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'End poll now' })).toBeTruthy();
  expect(screen.getByText('● Poll live')).toBeTruthy();
});

it('explains refusals from the server and disables actions for missing grants', async () => {
  stub(
    base,
    () =>
      new Response(
        JSON.stringify({
          code: 'NOT_ELIGIBLE',
          message: 'Twitch polls are available to Affiliates and Partners only.',
        }),
        { status: 403 },
      ),
  );
  render(<TwitchFeaturesPanel panic={false} />);
  await open();
  fireEvent.change(screen.getByLabelText(/Question/), { target: { value: 'What next?' } });
  fireEvent.change(screen.getByLabelText(/Choice 1/), { target: { value: 'A' } });
  fireEvent.change(screen.getByLabelText(/Choice 2/), { target: { value: 'B' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start poll on Twitch' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Affiliates and Partners');
  fireEvent.click(screen.getByRole('tab', { name: 'Announcement' }));
  expect(screen.getByRole('button', { name: 'Send announcement' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getAllByText(/Grant “moderator:manage:announcements”/).length).toBeGreaterThan(0);
});

it('requires an approved shoutout list before any shoutout can be sent', async () => {
  const fetcher = stub(base, (_url, body) => {
    const logins = (body as { logins: string[] }).logins;
    return new Response(
      JSON.stringify({
        features: {
          ...base,
          shoutout: {
            mode: 'allowlist',
            allowlist: logins.map((login, i) => ({ id: String(i + 1), login, displayName: login })),
            raiders: [],
            availableAt: null,
          },
        },
      }),
      { status: 200 },
    );
  });
  render(<TwitchFeaturesPanel panic={false} />);
  await open();
  fireEvent.click(screen.getByRole('tab', { name: 'Shoutout' }));
  expect(screen.getByText('Save an approved channel first.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approved channels' }));
  fireEvent.change(screen.getByLabelText(/Approved channels/), {
    target: { value: '@TwitchDev, bad login!' },
  });
  expect(screen.getByText(/Not a valid login/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Approved channels/), {
    target: { value: '@TwitchDev' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await screen.findByText('Shoutout policy saved.');
  const call = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ mode: 'allowlist', logins: ['twitchdev'] });
  expect(screen.getByRole('combobox', { name: 'Channel' })).toBeTruthy();
});

it('says when everything is stopped', async () => {
  stub({ ...base, stopped: true });
  render(<TwitchFeaturesPanel panic />);
  await open();
  expect(screen.getAllByText(/Everything is stopped/).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'Start poll on Twitch' })).toHaveProperty(
    'disabled',
    true,
  );
});
