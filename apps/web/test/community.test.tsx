// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { overlayMessageSchema } from '../src/overlay/messages.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCommunity } from '../src/overlay/community.js';
// Read from disk: a `?raw` CSS import is empty under the test transform.
const overlayStyles = readFileSync(resolve(__dirname, '../src/overlay/overlay.css'), 'utf8');
const publicProposal = {
  proposalId: 'p',
  text: '<img src=x onerror=alert(1)>',
  authors: ['Alice'],
};
const community = {
  commands: ['!riff suggest <text>'],
  creditNotice: 'Attribution defaults off.',
  ballot: {
    id: 'b',
    revision: 0,
    deadlineAt: 10000,
    closedAt: null,
    tied: false,
    options: [{ ...publicProposal, option: 1, votes: 2 }],
  },
  outcomes: [],
  selections: [{ ...publicProposal, id: 's', status: 'candidate' as const }],
};
afterEach(() => vi.unstubAllGlobals());
it('validates bounded community frames and strips private fields at every level', () => {
  const parsed = overlayMessageSchema.parse({
    v: 1,
    type: 'community',
    payload: {
      ...community,
      brief: 'PRIVATE',
      grants: ['PRIVATE'],
      ballot: {
        ...community.ballot,
        options: [{ ...community.ballot.options[0], accountId: 'PRIVATE' }],
      },
    },
  });
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
  expect(
    overlayMessageSchema.safeParse({
      v: 1,
      type: 'community',
      payload: { ...community, outcomes: Array(6).fill(community.ballot) },
    }).success,
  ).toBe(false);
  expect(
    overlayMessageSchema.safeParse({
      v: 1,
      type: 'community',
      payload: {
        ...community,
        selections: [{ ...community.selections[0], authors: Array(6).fill('a') }],
      },
    }).success,
  ).toBe(false);
});
it('renders text nodes, replaces withdrawn text and credit, and clears null projections', () => {
  const root = document.createElement('div');
  renderCommunity(root, community, 0);
  expect(root.querySelector('img')).toBeNull();
  expect(root.textContent).toContain(publicProposal.text);
  expect(root.textContent).toContain('Alice');
  renderCommunity(
    root,
    {
      ...community,
      ballot: {
        ...community.ballot,
        options: community.ballot.options.map((o) => ({ ...o, authors: [] })),
      },
      selections: community.selections.map((item) => ({ ...item, authors: [] })),
    },
    0,
  );
  expect(root.textContent).not.toContain('Alice');
  expect(root.textContent).toContain(publicProposal.text);
  renderCommunity(root, { ...community, ballot: null, selections: [] }, 0);
  expect(root.textContent).not.toContain('Alice');
  expect(root.textContent).not.toContain(publicProposal.text);
  renderCommunity(root, null, 0);
  expect(root.childNodes.length).toBe(0);
});
it('community obeys overlay panic, disconnect and heartbeat clearing', async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<div id="overlay-root"><div id="stage"></div><div id="instructions"></div><div id="notice"></div></div>';
  history.replaceState({}, '', '/?key=test');
  let socket!: { onmessage: (v: { data: string }) => void; onclose: (e: { code: number }) => void };
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('WebSocket', function (this: unknown) {
    socket = this as never;
  });
  await import('../src/overlay/main.js');
  const send = (type: string, payload: unknown) =>
    socket.onmessage({ data: JSON.stringify({ v: 1, type, payload }) });
  send('community', community);
  expect(document.body.textContent).toContain('Alice');
  send('community', { ...community, outcomes: Array(6).fill(community.ballot) });
  expect(document.body.textContent).not.toContain('Alice');
  send('community', community);
  send('clear', { reason: 'pause' });
  expect(document.body.textContent).toContain('Alice');
  send('clear', { reason: 'panic' });
  expect(document.body.textContent).not.toContain('Alice');
  send('heartbeat', { at: Date.now() });
  expect(document.body.textContent).not.toContain('Alice');
  // The trusted server publishes fresh community only after explicit resume.
  send('community', community);
  expect(document.body.textContent).toContain('Alice');
  vi.advanceTimersByTime(5001);
  expect(document.body.textContent).not.toContain('Alice');
  send('hello', { channel: 'c' });
  send('community', community);
  socket.onclose({ code: 4001 });
  expect(document.body.textContent).not.toContain('Alice');
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  { commands: Array(4).fill('command') },
  { ballot: { ...community.ballot, options: Array(6).fill(community.ballot.options[0]) } },
  { selections: Array(6).fill(community.selections[0]) },
  { selections: [{ ...community.selections[0], text: 'x'.repeat(501) }] },
  { ballot: { ...community.ballot, options: [{ ...community.ballot.options[0], votes: 10001 }] } },
])('rejects an over-budget public field %#', (patch) => {
  expect(
    overlayMessageSchema.safeParse({ v: 1, type: 'community', payload: { ...community, ...patch } })
      .success,
  ).toBe(false);
});

it('bounds worst-case public ballot rows and keeps every choice and the vote command visible', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const longText = 'W'.repeat(499);
  const projection = {
    ...community,
    commands: ['!riff suggest <idea>', '!riff vote <ballot> <option>', '!riff credit on|off'],
    creditNotice: 'N'.repeat(500),
    ballot: {
      ...community.ballot,
      id,
      number: 7,
      deadlineAt: 60000,
      options: Array.from({ length: 5 }, (_, index) => ({
        proposalId: `p${index}`,
        text: `${longText}${index}`,
        authors: Array(5).fill('A'.repeat(500)),
        option: index + 1,
        votes: 10000,
      })),
    },
    selections: Array.from({ length: 5 }, (_, index) => ({
      ...community.selections[0]!,
      id: `s${index}`,
      text: longText,
      authors: Array(5).fill('B'.repeat(500)),
    })),
  };
  const root = document.createElement('div');
  renderCommunity(root, projection, 0);
  const rows = root.querySelectorAll('.community-option');
  expect(rows).toHaveLength(5);
  for (const row of rows) {
    expect(row.querySelector('.community-excerpt')?.textContent?.length).toBeLessThanOrEqual(73);
    expect(row.textContent?.length).toBeLessThanOrEqual(140);
  }
  // One short typed command: viewers never copy a 36-character identifier off the stream.
  expect(root.querySelector('.community-vote')?.textContent).toBe(
    'Vote in chat !riff vote 7 <number>',
  );
  expect(root.textContent).not.toContain(id);
  expect(root.textContent?.length).toBeLessThanOrEqual(1200);
  const panelRules = overlayStyles.match(/\.overlay-community \{([^}]+)\}/)?.[1] ?? '';
  expect(panelRules).not.toMatch(/overflow:\s*hidden|max-height:/);
  expect(panelRules).toMatch(/right:\s*32px/);
  expect(panelRules).toMatch(/bottom:\s*32px/);
  expect(root.textContent).not.toContain(longText);
  // Small read-only sources rotate one complete option per page.
  vi.stubGlobal('innerHeight', 480);
  for (let index = 0; index < 5; index++) {
    renderCommunity(root, projection, index * 4000);
    expect(root.querySelectorAll('.community-option')).toHaveLength(1);
    expect(root.textContent).toContain(`${index + 1}W`);
    expect(root.textContent).toContain(`Options ${index + 1}/5`);
    expect(root.querySelector('.community-selection')).toBeNull();
  }
});

it('stays a one-line invitation when idle and shows results only briefly', () => {
  const root = document.createElement('div');
  const idle = { ...community, ballot: null, selections: [] };
  renderCommunity(root, idle, 0);
  expect(root.dataset.mode).toBe('invite');
  expect(root.querySelectorAll('.community-option')).toHaveLength(0);
  expect(root.textContent).toContain('!riff suggest <text>');
  expect(root.textContent).toContain(community.creditNotice);
  const closed = { ...community.ballot, number: 2, closedAt: 50_000, deadlineAt: 50_000 };
  renderCommunity(root, { ...idle, outcomes: [{ ...closed, tied: true }] }, 60_000);
  expect(root.dataset.mode).toBe('results');
  expect(root.textContent).toContain('It is a tie. The streamer decides.');
  expect(root.textContent).not.toContain('!riff vote');
  renderCommunity(root, { ...idle, outcomes: [closed] }, 50_000 + 120_000);
  expect(root.dataset.mode).toBe('invite');
  // A creator pick is announced in plain language, then retires after its window.
  const picked = {
    ...community.selections[0]!,
    number: 4,
    selectedAt: 0,
    status: 'applied' as const,
  };
  renderCommunity(root, { ...idle, selections: [picked] }, 1000);
  expect(root.querySelector('.community-selection')?.textContent).toContain(
    'Chat idea #4 · Now live',
  );
  renderCommunity(root, { ...idle, selections: [picked] }, 21 * 60_000);
  expect(root.querySelector('.community-selection')).toBeNull();
});
