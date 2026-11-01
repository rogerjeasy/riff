import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createProposalService, type ChatActor } from '../src/services/proposals/service.js';
import { proposalRepository } from '../src/db/repositories/proposals.js';
import { parseProposalCommand } from '../src/services/proposals/commands.js';
const creator = { kind: 'creator' as const };
const actor = (accountId = 'alice', roles: string[] = ['viewer']): ChatActor => ({
  kind: 'chat',
  accountId,
  displayName: 'Alice\u0000 <safe>',
  roles,
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'riff-proposals-'));
  const path = join(directory, 'test.db');
  migrateDatabase(path);
  let connection = openDatabase(path);
  forChannel(connection, 'home').ensure('Home');
  forChannel(connection, 'other').ensure('Other');
  let clock = 100000;
  const options = { now: () => clock };
  cleanups.push(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return createProposalService(connection, 'home', options);
    },
    get other() {
      return createProposalService(connection, 'other', options);
    },
    get connection() {
      return connection;
    },
    advance: (ms: number) => (clock += ms),
    restart() {
      connection.close();
      connection = openDatabase(path);
    },
  };
}
it('durably groups normalized contributions, deduplicates events, and isolates channels', () => {
  const f = setup();
  const p = f.service.submit(actor(), { eventId: '1', text: '  Add   two throws ' });
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(f.service.submit(actor('bob'), { eventId: '2', text: 'add two THROWS' })).toMatchObject({
    ok: true,
    proposalId: p.proposalId,
    grouped: true,
  });
  expect(f.service.submit(actor(), { eventId: '1', text: 'different words' })).toEqual(p);
  f.restart();
  expect(f.service.snapshot().proposals).toMatchObject([
    { id: p.proposalId, contributorCount: 2, state: 'pending' },
  ]);
  expect(f.other.snapshot().proposals).toEqual([]);
  expect(JSON.stringify(f.service.publicProjection())).not.toContain('throws');
});
it('counts rejected and duplicate suggestions in durable rolling attempt limits', () => {
  const f = setup();
  expect(f.service.submit(actor(), { eventId: '1', text: 'short' })).toMatchObject({
    ok: false,
    code: 'INVALID',
  });
  f.service.submit(actor(), { eventId: '2', text: 'Add two throws' });
  f.service.submit(actor(), { eventId: '3', text: 'Add two throws' });
  f.restart();
  expect(f.service.submit(actor(), { eventId: '4', text: 'Add three throws' })).toMatchObject({
    ok: false,
    code: 'ACCOUNT_LIMIT',
  });
  expect(f.service.submit(actor('bob'), { eventId: '5', text: 'Add three throws' })).toMatchObject({
    ok: true,
  });
  f.advance(60000);
  expect(f.service.submit(actor(), { eventId: '6', text: 'Add three throws' })).toMatchObject({
    ok: true,
  });
});
it('requires moderator role and creator grant and rejects stale moderation atomically', () => {
  const f = setup();
  const p = f.service.submit(actor(), { eventId: '1', text: 'Add two throws' });
  if (!p.ok || !p.proposalId) throw Error();
  const input = { proposalId: p.proposalId, expectedRevision: 0, action: 'shortlist' as const };
  expect(() => f.service.moderate(actor('mod', ['moderator']), input)).toThrow('FORBIDDEN');
  f.service.setGrant(creator, 'mod', true);
  expect(() => f.service.moderate(actor('mod'), input)).toThrow('FORBIDDEN');
  f.service.moderate(actor('mod', ['moderator']), input);
  expect(() => f.service.moderate(creator, { ...input, action: 'hide' })).toThrow('STALE');
  f.service.setGrant(creator, 'mod', false);
  expect(() =>
    f.service.moderate(actor('mod', ['moderator']), {
      ...input,
      expectedRevision: 1,
      action: 'hide',
    }),
  ).toThrow('FORBIDDEN');
});
it('uses explicit ballots, first valid account vote and exact durable deadlines with ties', () => {
  const f = setup();
  const ids = ['Add two throws', 'Add three throws'].map((text, i) => {
    const p = f.service.submit(actor(String(i)), { eventId: String(i), text });
    if (!p.ok || !p.proposalId) throw Error();
    f.service.moderate(creator, {
      proposalId: p.proposalId,
      expectedRevision: 0,
      action: 'shortlist',
    });
    return { id: p.proposalId, revision: 1 };
  });
  const b = f.service.createBallot(creator, { proposalIds: ids, durationSeconds: 15 });
  expect(() => f.service.createBallot(creator, { proposalIds: ids, durationSeconds: 15 })).toThrow(
    'BALLOT_OPEN',
  );
  expect(f.service.vote(actor(), { eventId: 'v1', ballotId: b.id, option: 9 })).toMatchObject({
    ok: false,
  });
  expect(f.service.vote(actor(), { eventId: 'v2', ballotId: b.id, option: 1 })).toMatchObject({
    ok: true,
  });
  expect(f.service.vote(actor(), { eventId: 'v3', ballotId: b.id, option: 2 })).toMatchObject({
    ok: false,
    code: 'ALREADY_VOTED',
  });
  f.service.vote(actor('bob'), { eventId: 'v4', ballotId: b.id, option: 2 });
  f.restart();
  f.advance(15000);
  expect(
    f.service.vote(actor('carol'), { eventId: 'v5', ballotId: b.id, option: 1 }),
  ).toMatchObject({ ok: false, code: 'BALLOT_CLOSED' });
  expect(f.service.publicProjection().outcomes[0]).toMatchObject({
    id: b.id,
    tied: true,
    options: [{ votes: 1 }, { votes: 1 }],
  });
  expect(() => f.service.closeBallot(creator, { ballotId: b.id, expectedRevision: 0 })).toThrow(
    'STALE',
  );
});
it('hiding withdraws ballot text and invalidates immutable selection; restore never revives authorization', () => {
  const f = setup();
  const p = f.service.submit(actor(), { eventId: '1', text: 'Add two throws' });
  if (!p.ok || !p.proposalId) throw Error();
  f.service.moderate(creator, {
    proposalId: p.proposalId,
    expectedRevision: 0,
    action: 'shortlist',
  });
  f.service.setCredit(actor(), true);
  const b = f.service.createBallot(creator, {
    proposalIds: [{ id: p.proposalId, revision: 1 }],
    durationSeconds: 15,
  });
  const selected = f.service.select(creator, {
    proposalId: p.proposalId,
    expectedRevision: 1,
    brief: 'Add two throws safely',
    baseVersionId: null,
  });
  expect(f.service.assertSelectionAuthorized(selected.id).brief).toBe('Add two throws safely');
  expect(JSON.stringify(f.service.publicProjection())).toContain('Alice <safe>');
  f.service.setCredit(actor(), false);
  expect(JSON.stringify(f.service.publicProjection())).not.toContain('Alice');
  f.service.moderate(creator, { proposalId: p.proposalId, expectedRevision: 2, action: 'hide' });
  expect(f.service.submit(actor('bob'), { eventId: '2', text: 'Add two throws' })).toMatchObject({
    ok: true,
    grouped: true,
  });
  expect(f.service.publicProjection().ballot?.options).toEqual([]);
  expect(JSON.stringify(f.service.publicProjection())).not.toContain('throws');
  expect(() => f.service.assertSelectionAuthorized(selected.id)).toThrow('REVOKED');
  expect(f.service.vote(actor(), { eventId: 'v', ballotId: b.id, option: 1 })).toMatchObject({
    ok: false,
    code: 'INELIGIBLE',
  });
  f.service.moderate(creator, { proposalId: p.proposalId, expectedRevision: 3, action: 'restore' });
  f.restart();
  expect(() => f.service.assertSelectionAuthorized(selected.id)).toThrow('REVOKED');
});
it('consumes malformed reserved commands without allowing role or identity impersonation', () => {
  expect(parseProposalCommand('!riff vote b 2')).toEqual({
    kind: 'vote',
    ballotId: 'b',
    option: 2,
  });
  expect(parseProposalCommand('!riff suggest hello world')).toEqual({
    kind: 'suggest',
    text: 'hello world',
  });
  expect(parseProposalCommand('!riff unknown')).toEqual({ kind: 'invalid' });
  expect(parseProposalCommand('!riff panic')).toEqual({ kind: 'panic' });
  expect(parseProposalCommand('!grow')).toBeNull();
  const f = setup();
  expect(
    f.service.handleCommand(actor(), { eventId: 'bad', text: '!riff role broadcaster' }),
  ).toMatchObject({ consumed: true, result: { ok: false } });
});

it('treats tab/newline whitespace as duplicate normalization without leaking controls', () => {
  const f = setup();
  const first = f.service.submit(actor(), { eventId: '1', text: 'Add two throws' });
  if (!first.ok) throw Error();
  expect(f.service.submit(actor('bob'), { eventId: '2', text: 'ADD\ttwo\nthrows' })).toMatchObject({
    ok: true,
    proposalId: first.proposalId,
    grouped: true,
  });
});
it('invalidates revision-bound authorization after another selection and enforces creator authority', () => {
  const f = setup();
  const result = f.service.submit(actor(), { eventId: '1', text: 'Add two throws' });
  if (!result.ok || !result.proposalId) throw Error();
  const id = result.proposalId;
  f.service.moderate(creator, { proposalId: id, expectedRevision: 0, action: 'shortlist' });
  expect(() =>
    f.service.select(actor('mod', ['broadcaster']), {
      proposalId: id,
      expectedRevision: 1,
      brief: 'Add two throws',
    }),
  ).toThrow('FORBIDDEN');
  const first = f.service.select(creator, {
    proposalId: id,
    expectedRevision: 1,
    brief: 'Add two throws',
  });
  const second = f.service.select(creator, {
    proposalId: id,
    expectedRevision: 2,
    brief: 'Add two throws differently',
  });
  expect(() => f.service.assertSelectionAuthorized(first.id)).toThrow('STALE');
  expect(f.service.assertSelectionAuthorized(second.id).brief).toContain('differently');
  expect(f.service.publicProjection().selections.map((selection) => selection.id)).toEqual([
    second.id,
  ]);
  f.service.revokeSelection(creator, second.id);
  f.restart();
  expect(() => f.service.assertSelectionAuthorized(second.id)).toThrow('REVOKED');
});
it('bounds channel attempts separately from each authenticated account across restart', () => {
  const f = setup();
  for (let i = 0; i < 20; i++)
    expect(
      f.service.submit(actor(String(i)), { eventId: String(i), text: 'Add two throws' }),
    ).toMatchObject({ ok: true });
  f.restart();
  expect(f.service.submit(actor('next'), { eventId: '21', text: 'Another idea' })).toMatchObject({
    ok: false,
    code: 'CHANNEL_LIMIT',
  });
  f.advance(60000);
  expect(f.service.submit(actor('next'), { eventId: '22', text: 'Another idea' })).toMatchObject({
    ok: true,
  });
});

it('fails closed at retained receipt capacity and prunes at exactly seven days', () => {
  const f = setup();
  const repo = proposalRepository(f.connection, 'home');
  repo.transaction(() => {
    for (let i = 0; i < 10000; i++)
      repo.recordReceipt({
        id: `receipt-${i}`,
        eventId: `seed-${i}`,
        accountId: 'seed',
        kind: 'invalid',
        text: null,
        proposalId: null,
        result: { ok: false, code: 'INVALID' },
        at: 100000,
      });
  });
  expect(f.service.submit(actor(), { eventId: 'fresh', text: 'Add two throws' })).toMatchObject({
    ok: false,
    code: 'RECEIPT_CAPACITY',
  });
  expect(repo.receiptCount()).toBe(10000);
  expect(f.other.submit(actor(), { eventId: 'fresh', text: 'Add two throws' })).toMatchObject({
    ok: true,
  });
  f.advance(7 * 86400000);
  f.restart();
  expect(f.service.submit(actor(), { eventId: 'fresh', text: 'Add two throws' })).toMatchObject({
    ok: true,
  });
  expect(proposalRepository(f.connection, 'home').receiptCount()).toBe(1);
});
it('caps visible proposals and grants, while hide frees a slot without reviving grouped hidden text', () => {
  const f = setup();
  const repo = proposalRepository(f.connection, 'home');
  repo.transaction(() => {
    for (let i = 0; i < 100; i++)
      repo.insertProposal({
        id: `p-${i}`,
        text: `Proposal ${i}`,
        normalizedText: `proposal ${i}`,
        state: 'pending',
        revision: 0,
        createdAt: 100000,
        updatedAt: 100000,
      });
  });
  expect(f.service.submit(actor(), { eventId: 'new', text: 'A new proposal' })).toMatchObject({
    ok: false,
    code: 'PROPOSAL_LIMIT',
  });
  f.service.moderate(creator, { proposalId: 'p-0', expectedRevision: 0, action: 'hide' });
  expect(f.service.submit(actor(), { eventId: 'hidden', text: 'Proposal 0' })).toMatchObject({
    ok: true,
    grouped: true,
  });
  expect(repo.getProposal('p-0')?.state).toBe('hidden');
  expect(f.service.submit(actor(), { eventId: 'new2', text: 'A new proposal' })).toMatchObject({
    ok: true,
  });
  for (let i = 0; i < 100; i++) f.service.setGrant(creator, `mod-${i}`, true);
  expect(() => f.service.setGrant(creator, 'mod-100', true)).toThrow('GRANT_LIMIT');
  f.service.setGrant(creator, 'mod-0', true);
  f.service.setGrant(creator, 'mod-0', false);
  f.service.setGrant(creator, 'mod-100', true);
  expect(f.service.snapshot().grants).toHaveLength(100);
  expect(f.service.snapshot({ limit: 1000 }).proposals).toHaveLength(50);
});
it('bounds contributors with account uniqueness and preserves event provenance privately', () => {
  const f = setup();
  const p = f.service.submit(actor(), { eventId: 'source-event-private', text: 'Add two throws' });
  if (!p.ok || !p.proposalId) throw Error();
  const id = p.proposalId;
  const repo = proposalRepository(f.connection, 'home');
  repo.transaction(() => {
    for (let i = 1; i < 1000; i++)
      repo.addContributor({
        id: `c-${i}`,
        proposalId: id,
        accountId: `account-${i}`,
        displayName: 'Private name',
        eventId: `contribution-${i}`,
        createdAt: 100001,
      });
  });
  expect(f.service.submit(actor(), { eventId: 'same', text: 'Add two throws' })).toMatchObject({
    ok: true,
    grouped: true,
  });
  expect(
    f.service.submit(actor('new-account'), { eventId: 'new', text: 'Add two throws' }),
  ).toMatchObject({ ok: false, code: 'CONTRIBUTOR_LIMIT' });
  f.service.moderate(creator, { proposalId: id, expectedRevision: 0, action: 'shortlist' });
  f.service.createBallot(creator, { proposalIds: [{ id, revision: 1 }], durationSeconds: 15 });
  expect(repo.contributors(id)).toHaveLength(1000);
  expect(repo.contributors(id)[0]?.eventId).toBe('source-event-private');
  const projection = JSON.stringify(f.service.publicProjection());
  for (const privateValue of [
    'alice',
    'account-',
    'Private name',
    'contribution-',
    'source-event-private',
    'accountId',
    'eventId',
    'channelId',
    'history',
  ])
    expect(projection).not.toContain(privateValue);
});
it('accepts text boundaries and rejects ballot bounds, duplicates and cross-channel identities atomically', () => {
  const f = setup();
  expect(f.service.submit(actor('short'), { eventId: 'short', text: '1234567' })).toMatchObject({
    ok: false,
    code: 'INVALID',
  });
  expect(f.service.submit(actor('long'), { eventId: 'long', text: 'x'.repeat(501) })).toMatchObject(
    { ok: false, code: 'INVALID' },
  );
  const ids = ['12345678', 'x'.repeat(500)].map((text, i) => {
    const p = f.service.submit(actor(`valid-${i}`), { eventId: `valid-${i}`, text });
    if (!p.ok || !p.proposalId) throw Error();
    f.service.moderate(creator, {
      proposalId: p.proposalId,
      expectedRevision: 0,
      action: 'shortlist',
    });
    return { id: p.proposalId, revision: 1 };
  });
  for (const durationSeconds of [14, 601, 15.5])
    expect(() => f.service.createBallot(creator, { proposalIds: ids, durationSeconds })).toThrow(
      'INVALID',
    );
  expect(() =>
    f.service.createBallot(creator, { proposalIds: [ids[0]!, ids[0]!], durationSeconds: 15 }),
  ).toThrow('INVALID');
  expect(() =>
    f.service.createBallot(creator, {
      proposalIds: [{ ...ids[0]!, revision: 0 }],
      durationSeconds: 15,
    }),
  ).toThrow('STALE');
  expect(() =>
    f.other.moderate(creator, { proposalId: ids[0]!.id, expectedRevision: 1, action: 'hide' }),
  ).toThrow('NOT_FOUND');
  const b = f.service.createBallot(creator, { proposalIds: ids, durationSeconds: 600 });
  expect(f.other.vote(actor(), { eventId: 'other', ballotId: b.id, option: 1 })).toMatchObject({
    ok: false,
    code: 'NOT_FOUND',
  });
  f.service.closeBallot(creator, { ballotId: b.id, expectedRevision: 0 });
  f.restart();
  expect(f.service.vote(actor(), { eventId: 'closed', ballotId: b.id, option: 1 })).toMatchObject({
    ok: false,
    code: 'BALLOT_CLOSED',
  });
});
it('caps ballot votes and keeps results stable without moving the first valid vote', () => {
  const f = setup();
  const p = f.service.submit(actor(), { eventId: 'p', text: 'Add two throws' });
  if (!p.ok || !p.proposalId) throw Error();
  f.service.moderate(creator, {
    proposalId: p.proposalId,
    expectedRevision: 0,
    action: 'shortlist',
  });
  const b = f.service.createBallot(creator, {
    proposalIds: [{ id: p.proposalId, revision: 1 }],
    durationSeconds: 15,
  });
  const repo = proposalRepository(f.connection, 'home');
  repo.transaction(() => {
    for (let i = 0; i < 10000; i++)
      repo.insertVote({
        id: `v-${i}`,
        ballotId: b.id,
        accountId: `voter-${i}`,
        option: 1,
        eventId: `ve-${i}`,
        at: 100000,
      });
  });
  expect(
    f.service.vote(actor('new'), { eventId: 'over', ballotId: b.id, option: 1 }),
  ).toMatchObject({ ok: false, code: 'VOTE_LIMIT' });
  f.advance(15000);
  expect(f.service.publicProjection().outcomes[0]?.options[0]?.votes).toBe(10000);
  f.restart();
  expect(f.service.publicProjection().outcomes[0]?.options[0]?.votes).toBe(10000);
});
it('bounds ballot option and outcome projections and private history pages', () => {
  const f = setup();
  const repo = proposalRepository(f.connection, 'home');
  repo.transaction(() => {
    for (let i = 0; i < 6; i++)
      repo.insertProposal({
        id: `option-${i}`,
        text: `Option number ${i}`,
        normalizedText: `option number ${i}`,
        state: 'shortlisted',
        revision: 1,
        createdAt: 100000,
        updatedAt: 100000,
      });
  });
  const options = Array.from({ length: 6 }, (_, i) => ({ id: `option-${i}`, revision: 1 }));
  expect(() =>
    f.service.createBallot(creator, { proposalIds: options, durationSeconds: 15 }),
  ).toThrow('INVALID');
  for (let i = 0; i < 7; i++) {
    const ballot = f.service.createBallot(creator, {
      proposalIds: options.slice(0, 5),
      durationSeconds: 15,
    });
    expect(f.service.publicProjection().ballot?.options).toHaveLength(5);
    f.service.closeBallot(creator, { ballotId: ballot.id, expectedRevision: 0 });
    f.advance(1);
  }
  expect(f.service.publicProjection().outcomes).toHaveLength(5);
  repo.transaction(() => {
    for (let i = 0; i < 60; i++)
      repo.recordHistory({
        proposalId: 'option-0',
        actor: 'private-moderator-account',
        action: 'review',
        revision: i,
        at: 100000 + i,
      });
  });
  expect(f.service.history('option-0', { limit: 10000 })).toHaveLength(50);
  expect(f.service.history('option-0', { offset: 50, limit: 10000 })).toHaveLength(10);
  expect(f.other.history('option-0')).toEqual([]);
  expect(JSON.stringify(f.service.publicProjection())).not.toContain('private-moderator-account');
});
it('persists moderation command receipts so delayed duplicate events do not reapply after restore', () => {
  const f = setup();
  const p = f.service.submit(actor(), { eventId: 'suggest', text: 'Add two throws' });
  if (!p.ok || !p.proposalId) throw Error();
  f.service.setGrant(creator, 'mod', true);
  const moderator = actor('mod', ['moderator']);
  const first = f.service.handleCommand(moderator, {
    eventId: 'hide',
    text: `!riff hide ${p.proposalId}`,
  });
  expect(first.result).toMatchObject({ ok: true });
  f.service.moderate(creator, { proposalId: p.proposalId, expectedRevision: 1, action: 'restore' });
  f.restart();
  expect(f.service.handleCommand(moderator, { eventId: 'hide', text: '!riff credit on' })).toEqual(
    first,
  );
  expect(f.service.snapshot().proposals[0]?.state).toBe('pending');
});

it('deduplicates retained suggestion, vote and credit commands across command kinds and restart', () => {
  const f = setup();
  const submitted = f.service.submit(actor(), {
    eventId: 'shared-suggest',
    text: 'Add two throws to the round',
  });
  if (!submitted.ok || !submitted.proposalId) throw Error('submission failed');
  const p = f.service.moderate(creator, {
    proposalId: submitted.proposalId,
    expectedRevision: 0,
    action: 'shortlist',
  });
  const ballot = f.service.createBallot(creator, {
    proposalIds: [{ id: p.id, revision: p.revision }],
    durationSeconds: 15,
  });
  expect(
    f.service.vote(actor(), { eventId: 'shared-suggest', ballotId: ballot.id, option: 1 }),
  ).toEqual(submitted);
  expect(
    f.service.handleCommand(actor(), { eventId: 'shared-suggest', text: '!riff credit on' }).result,
  ).toEqual(submitted);
  expect(
    f.service.vote(actor(), { eventId: 'shared-vote', ballotId: ballot.id, option: 1 }),
  ).toEqual({ ok: true });
  f.restart();
  expect(
    f.service.submit(actor('bob'), {
      eventId: 'shared-vote',
      text: 'A totally different proposal',
    }),
  ).toEqual({ ok: true });
  expect(f.service.snapshot().proposals).toMatchObject([{ id: p.id, contributorCount: 1 }]);
  expect(f.service.snapshot().ballots[0]!.options[0]!.votes).toBe(1);
  expect(f.service.publicProjection().ballot!.options[0]!.authors).toEqual([]);
  // Neither replay consumes an additional suggestion attempt.
  expect(
    f.service.submit(actor(), { eventId: 'after-replay-1', text: 'Another independent suggestion' })
      .ok,
  ).toBe(true);
  expect(
    f.service.submit(actor(), { eventId: 'after-replay-2', text: 'Third independent suggestion' })
      .ok,
  ).toBe(true);
});

it('withdraws current credit and hidden text from closed ballot history after restart while retaining audit counts', () => {
  const f = setup();
  const submitted = f.service.submit(actor(), {
    eventId: 'closed-proposal',
    text: 'Private closed-history suggestion',
  });
  if (!submitted.ok || !submitted.proposalId) throw Error('submission failed');
  f.service.setCredit(actor(), true);
  const p = f.service.moderate(creator, {
    proposalId: submitted.proposalId,
    expectedRevision: 0,
    action: 'shortlist',
  });
  const ballot = f.service.createBallot(creator, {
    proposalIds: [{ id: p.id, revision: p.revision }],
    durationSeconds: 15,
  });
  f.service.vote(actor(), { eventId: 'closed-vote', ballotId: ballot.id, option: 1 });
  f.service.closeBallot(creator, { ballotId: ballot.id, expectedRevision: 0 });
  const selection = f.service.select(creator, {
    proposalId: p.id,
    expectedRevision: p.revision,
    brief: 'The reviewed private brief',
  });
  f.restart();
  expect(f.service.publicProjection().outcomes[0]!.options[0]!.authors).toHaveLength(1);
  f.service.setCredit(actor(), false);
  expect(f.service.publicProjection().outcomes[0]!.options[0]!.authors).toEqual([]);
  f.service.moderate(creator, {
    proposalId: p.id,
    expectedRevision: selection.proposalRevision,
    action: 'hide',
  });
  const publicJson = JSON.stringify(f.service.publicProjection());
  for (const privateValue of [
    'Private closed-history',
    'Alice',
    'alice',
    'closed-vote',
    'reviewed private',
  ])
    expect(publicJson).not.toContain(privateValue);
  expect(f.service.publicProjection().outcomes[0]!.options).toEqual([]);
  expect(f.service.publicProjection().selections).toEqual([]);
  expect(f.service.snapshot().ballots[0]!.options[0]!.votes).toBe(1);
  expect(f.service.history(p.id).some((h) => h.action === 'hide')).toBe(true);
});

it('samples manual close time inside the transaction and persists deadline reconciliation despite stale revision', () => {
  const f = setup();
  const submitted = f.service.submit(actor(), {
    eventId: 'clock-proposal',
    text: 'Add some more tomato throws',
  });
  if (!submitted.ok || !submitted.proposalId) throw Error('submission failed');
  const p = f.service.moderate(creator, {
    proposalId: submitted.proposalId,
    expectedRevision: 0,
    action: 'shortlist',
  });
  const ballot = f.service.createBallot(creator, {
    proposalIds: [{ id: p.id, revision: p.revision }],
    durationSeconds: 15,
  });
  let samples = 0;
  const service = createProposalService(f.connection, 'home', {
    now: () => {
      samples++;
      return ballot.deadlineAt;
    },
  });
  expect(() => service.closeBallot(creator, { ballotId: ballot.id, expectedRevision: 0 })).toThrow(
    'STALE',
  );
  expect(samples).toBe(1);
  f.restart();
  expect(f.service.snapshot().ballots[0]).toMatchObject({
    closedAt: ballot.deadlineAt,
    revision: 1,
  });
});

it('gives ideas and ballots short channel numbers that chat can type', () => {
  const f = setup();
  const ids = ['Add two throws now', 'Make shields cheaper', 'Golden tomato bonus'].map(
    (text, index) => {
      const result = f.service.submit(actor(`v${index}`), { eventId: `s${index}`, text });
      if (!result.ok) throw new Error(result.code);
      return result.proposalId!;
    },
  );
  const other = f.other.submit(actor(), { eventId: 'o1', text: 'Another channel idea' });
  expect(other.ok).toBe(true);
  expect(f.service.snapshot().proposals.map((p) => p.number)).toEqual([3, 2, 1]);
  expect(f.other.snapshot().proposals.map((p) => p.number)).toEqual([1]);
  f.service.setGrant(creator, 'mod', true);
  const mod = actor('mod', ['moderator']);
  expect(
    f.service.handleCommand(mod, { eventId: 'm1', text: '!riff shortlist #1' }).result,
  ).toEqual({ ok: true, proposalId: ids[0] });
  expect(f.service.handleCommand(mod, { eventId: 'm2', text: '!riff shortlist 2' }).result).toEqual(
    { ok: true, proposalId: ids[1] },
  );
  expect(f.service.handleCommand(mod, { eventId: 'm3', text: '!riff hide #99' }).result).toEqual({
    ok: false,
    code: 'NOT_FOUND',
  });
  const rows = f.service.snapshot({ state: 'shortlisted' }).proposals;
  const ballot = f.service.createBallot(creator, {
    proposalIds: rows.map((p) => ({ id: p.id, revision: p.revision })),
    durationSeconds: 60,
  });
  expect(ballot.number).toBe(1);
  expect(
    f.service.handleCommand(actor('a'), { eventId: 'v1', text: '!riff vote 1 2' }).result,
  ).toEqual({ ok: true });
  expect(
    f.service.handleCommand(actor('b'), { eventId: 'v2', text: '!riff vote #1 #1' }).result,
  ).toEqual({ ok: true });
  // The explicit number still fences delayed chat from a later ballot.
  expect(
    f.service.handleCommand(actor('c'), { eventId: 'v3', text: '!riff vote 2 1' }).result,
  ).toEqual({ ok: false, code: 'NOT_FOUND' });
  const projection = f.service.publicProjection();
  expect(projection.ballot).toMatchObject({ number: 1, tied: true });
  expect(projection.ballot?.options.map((o) => o.number).sort()).toEqual([1, 2]);
  expect(projection.commands).toContain('!riff vote <ballot> <option>');
});

it('reports zero-vote ballots as untied and credits only consenting contributors in order', () => {
  const f = setup();
  const first = f.service.submit(actor('a'), { eventId: '1', text: 'Add two throws now' });
  if (!first.ok) throw new Error(first.code);
  for (const [index, name] of ['b', 'c', 'd'].entries())
    f.service.submit(
      { ...actor(name), displayName: name.toUpperCase() },
      {
        eventId: `g${index}`,
        text: 'add two THROWS now',
      },
    );
  f.service.setCredit({ ...actor('d'), displayName: 'D' }, true);
  f.service.setCredit(actor('b'), true);
  f.service.setCredit(actor('c'), false);
  const p = f.service.snapshot().proposals[0]!;
  expect(p.contributorCount).toBe(4);
  expect(f.service.snapshot().counts).toEqual({
    pending: 1,
    shortlisted: 0,
    selected: 0,
    hidden: 0,
  });
  const shortlisted = f.service.moderate(creator, {
    proposalId: p.id,
    expectedRevision: p.revision,
    action: 'shortlist',
  });
  f.service.createBallot(creator, {
    proposalIds: [{ id: shortlisted.id, revision: shortlisted.revision }],
    durationSeconds: 30,
  });
  const ballot = f.service.publicProjection().ballot!;
  expect(ballot.tied).toBe(false);
  expect(ballot.options[0]?.authors).toEqual(['B', 'D']);
  const selected = f.service.select(creator, {
    proposalId: shortlisted.id,
    expectedRevision: shortlisted.revision,
    brief: 'Add two throws now',
  });
  expect(f.service.publicProjection().selections[0]).toMatchObject({
    id: selected.id,
    number: 1,
    selectedAt: selected.createdAt,
  });
});
