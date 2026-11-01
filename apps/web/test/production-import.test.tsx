// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProductionPanel } from '../src/console/production/panel.js';
import type { Version } from '../src/lib/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const off = { status: 'disconnected', reason: null, url: null, scenes: [], actions: [] };
const state = {
  revision: 0,
  configured: true,
  origin: 'instance',
  connections: { obs: off, streamerbot: off, firebot: off },
  obsReview: null,
  mappingReview: null,
  mappings: [],
  recent: [],
};
const versionId = '11111111-1111-4111-8111-111111111111';
const versions = [
  {
    id: versionId,
    title: 'Tomato toss',
    number: 2,
    status: 'active',
    approvedAt: 1,
    incident: null,
  },
] as unknown as Version[];
const report = {
  tool: 'firebot',
  title: 'Tomato pack',
  counts: { imported: 2, mapped: 1, review: 1, skipped: 1 },
  notes: ['Setup import questions were not answered; their placeholders stay as written.'],
  items: [
    {
      id: 'a'.repeat(16),
      kind: 'event',
      name: 'Cheer alert',
      status: 'mapped',
      trigger: { kind: 'cheer', detail: null },
      actions: [{ kind: 'media', detail: 'cheer.mp3' }],
      review: [],
      reason: null,
      intent: 'Imported from Firebot "Cheer alert": when a viewer cheers bits, play "cheer.mp3".',
      bridge: 'Cheer alert',
      drafted: null,
    },
    {
      id: 'b'.repeat(16),
      kind: 'command',
      name: '!tomato',
      status: 'review',
      trigger: { kind: 'command', detail: '!tomato' },
      actions: [{ kind: 'chat', detail: 'Splat!' }],
      review: ['Custom script effect was not imported or run; review it manually.'],
      reason: null,
      intent:
        'Imported from Firebot "!tomato": when a viewer types "!tomato" in chat, post "Splat!".',
      bridge: '!tomato',
      drafted: null,
    },
    {
      id: 'c'.repeat(16),
      kind: 'component',
      name: '1 Firebot timers',
      status: 'skipped',
      trigger: null,
      actions: [],
      review: [],
      reason: 'Firebot timers have no Riff equivalent and were not imported.',
      intent: null,
      bridge: null,
      drafted: null,
    },
  ],
};

function server() {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/import/preview'))
      return new Response(JSON.stringify({ report }), { status: 200 });
    if (String(url).endsWith('/import/drafts'))
      return new Response(
        JSON.stringify({
          state: {
            ...state,
            mappingReview: {
              digest: 'd'.repeat(64),
              mappings: [
                {
                  id: `import-${'b'.repeat(16)}`,
                  eventName: '!tomato',
                  versionId,
                  control: 'start',
                  actionId: null,
                  tool: 'firebot',
                },
              ],
              unsupported: [],
              differences: ['Add "!tomato" (Firebot) → start version "Tomato toss".'],
            },
          },
          report: {
            ...report,
            items: report.items.map((i) =>
              i.id === 'a'.repeat(16)
                ? { ...i, drafted: 'intent' }
                : i.id === 'b'.repeat(16)
                  ? { ...i, drafted: 'bridge' }
                  : i,
            ),
          },
          intents: [{ id: 'a'.repeat(16), name: 'Cheer alert', text: report.items[0]!.intent }],
        }),
        { status: 200 },
      );
    return new Response(JSON.stringify({ state }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}

it('connects Firebot with a generated event key and explicit discovery consent', async () => {
  const calls = server();
  render(<ProductionPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Production setup/ }));
  const card = await screen.findByRole('article', { name: 'Firebot' });
  const address = within(card).getByLabelText('Firebot address') as HTMLInputElement;
  expect(address.value).toBe('http://127.0.0.1:7472');
  const key = within(card).getByLabelText('Riff event key') as HTMLInputElement;
  const connect = within(card).getByRole('button', {
    name: 'Connect Firebot',
  }) as HTMLButtonElement;
  fireEvent.change(key, { target: { value: 'short' } });
  expect(within(card).getByText(/at least 12 characters/)).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: 'Generate key' }));
  expect(key.value.length).toBeGreaterThanOrEqual(20);
  expect(connect.disabled).toBe(true);
  fireEvent.click(within(card).getByLabelText(/preset effect lists, custom variables/));
  expect(connect.disabled).toBe(false);
  fireEvent.click(connect);
  await vi.waitFor(() =>
    expect(calls.find((c) => c.url.endsWith('/connect'))?.body).toMatchObject({
      kind: 'firebot',
      url: 'http://127.0.0.1:7472',
      discover: true,
    }),
  );
});

it('guides an import from tool choice to reviewed drafts handed to the composer', async () => {
  const calls = server();
  const onDraftIntent = vi.fn();
  render(<ProductionPanel versions={versions} panic={false} onDraftIntent={onDraftIntent} />);
  fireEvent.click(screen.getByRole('button', { name: /Production setup/ }));
  const section = await screen.findByRole('region', { name: 'Import from another tool' });
  fireEvent.click(within(section).getByRole('button', { name: 'Firebot' }));
  fireEvent.change(within(section).getByLabelText(/Or paste the Firebot setup JSON/), {
    target: { value: '{"components":{}}' },
  });
  fireEvent.click(within(section).getByRole('button', { name: 'Read Firebot export' }));
  await within(section).findByText(/Firebot import report/);
  expect(calls.find((c) => c.url.endsWith('/import/preview'))?.body).toEqual({
    tool: 'firebot',
    text: '{"components":{}}',
  });
  expect(within(section).getByText(/Custom script effect was not imported/)).toBeTruthy();
  expect(within(section).getByText(/timers have no Riff equivalent/)).toBeTruthy();
  // Skipped items offer no decision; nothing is drafted until the creator chooses.
  const create = within(section).getByRole('button', {
    name: 'Create drafts',
  }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  const [cheer, tomato] = within(section).getAllByLabelText('What to do');
  expect(within(section).getAllByLabelText('What to do')).toHaveLength(2);
  fireEvent.change(cheer!, { target: { value: 'intent' } });
  fireEvent.change(tomato!, { target: { value: 'bridge' } });
  const draftButton = within(section).getByRole('button', {
    name: 'Create 2 drafts',
  }) as HTMLButtonElement;
  expect(draftButton.disabled).toBe(true);
  expect(
    within(section).getByText(/Choose the approved interaction for every bridge/),
  ).toBeTruthy();
  fireEvent.change(within(section).getByLabelText('Approved interaction'), {
    target: { value: versionId },
  });
  expect(draftButton.disabled).toBe(false);
  fireEvent.click(draftButton);
  await within(section).findByText(/Nothing was approved or run/);
  expect(calls.find((c) => c.url.endsWith('/import/drafts'))?.body).toEqual({
    tool: 'firebot',
    text: '{"components":{}}',
    decisions: [
      { id: 'a'.repeat(16), decision: 'intent' },
      { id: 'b'.repeat(16), decision: 'bridge', versionId, control: 'start' },
    ],
  });
  expect(within(section).getByText(/Already drafted as a bridge/)).toBeTruthy();
  fireEvent.click(within(section).getByRole('button', { name: 'Open in composer' }));
  expect(onDraftIntent).toHaveBeenCalledWith(report.items[0]!.intent);
  // The staged bridge appears in the existing mapping review, still unapproved.
  expect(screen.getByRole('region', { name: 'Review mapping changes' })).toBeTruthy();
});

it('shows the server reason when an export cannot be read', async () => {
  const fetcher = vi.fn(async (url: unknown) =>
    String(url).endsWith('/import/preview')
      ? new Response(
          JSON.stringify({ code: 'INVALID', message: 'This OBS file could not be read as JSON.' }),
          { status: 400 },
        )
      : new Response(JSON.stringify({ state }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<ProductionPanel versions={[]} panic={false} />);
  fireEvent.click(screen.getByRole('button', { name: /Production setup/ }));
  const section = await screen.findByRole('region', { name: 'Import from another tool' });
  fireEvent.click(within(section).getByRole('button', { name: 'OBS' }));
  fireEvent.change(within(section).getByLabelText(/Or paste/), { target: { value: '{nope' } });
  fireEvent.click(within(section).getByRole('button', { name: 'Read OBS export' }));
  expect((await within(section).findByRole('alert')).textContent).toMatch(/could not be read/);
});
