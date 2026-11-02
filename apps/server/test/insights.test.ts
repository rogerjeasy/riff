import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DecisionCode } from '@riff/sdk';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import {
  compileRuns,
  proposalBallots,
  proposalContributors,
  proposals,
  proposalVotes,
  sessionJournal,
} from '../src/db/schema.js';
import { createInsightsService } from '../src/services/insights/service.js';
import { insightsSchema } from '../src/services/insights/contract.js';

const NOW = Date.UTC(2026, 10, 1, 20, 0, 0);
const MINUTE = 60_000;
const open: DatabaseConnection[] = [];
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  open.splice(0).forEach((db) => db.close());
});

function setup(channelId = 'home') {
  const database = openDatabase(':memory:');
  open.push(database);
  migrateConnection(database);
  const repo = forChannel(database, channelId);
  repo.ensure('Home');
  return { database, repo };
}
type Repo = ReturnType<typeof forChannel>;
function decide(
  repo: Repo,
  automationId: string | null,
  viewer: string,
  code: DecisionCode,
  at: number,
) {
  repo.record({
    at,
    kind: 'decision',
    automationId,
    versionId: null,
    eventId: randomUUID(),
    viewer,
    code,
    message: `${viewer} did a thing`,
  });
}
function run(database: DatabaseConnection, status: string, durationMs: number | null, at: number) {
  database.db
    .insert(compileRuns)
    .values({
      id: randomUUID(),
      channelId: 'home',
      automationId: null,
      baseVersionId: null,
      intent: 'x',
      status,
      transport: 'offline',
      model: null,
      promptVersion: 'p',
      threadId: null,
      attempts: [],
      usage: null,
      durationMs,
      error: null,
      versionId: null,
      createdAt: at,
    })
    .run();
}

describe('insights service', () => {
  it('reports an empty state before anything has happened', () => {
    const { database } = setup();
    const insights = createInsightsService({ database, channelId: 'home', now: () => NOW });
    const result = insightsSchema.parse(insights.summary('stream'));
    expect(result.empty).toBe(true);
    expect(result.participation.attempts).toBe(0);
    expect(result.takeaways).toEqual([]);
  });

  it('summarizes participation, blocked reasons and automations for the last stream', () => {
    const { database, repo } = setup();
    const tomato = repo.createAutomation('Tomato Battle');
    const hearts = repo.createAutomation('Heart burst');
    const start = NOW - 40 * MINUTE;
    // An older, separate stream (gap > 30 minutes) must not be counted.
    decide(repo, tomato.id, 'old-viewer', 'ACCEPTED', NOW - 5 * 60 * MINUTE);
    const viewers = ['alice', 'bob', 'carol', 'dave'];
    viewers.forEach((viewer, i) => decide(repo, tomato.id, viewer, 'ACCEPTED', start + i * 1000));
    for (let i = 0; i < 12; i++)
      decide(repo, tomato.id, 'alice', 'VIEWER_LIMIT', start + MINUTE + i);
    decide(repo, tomato.id, 'bob', 'SESSION_FINISHED', start + 2 * MINUTE);
    decide(repo, hearts.id, 'carol', 'AUDIENCE', start + 3 * MINUTE);
    decide(repo, hearts.id, 'carol', 'UNRELATED', start + 3 * MINUTE + 1);
    decide(repo, null, 'erin', 'CAPACITY', start + 4 * MINUTE);
    repo.record({
      at: start + 5 * MINUTE,
      kind: 'incident',
      automationId: hearts.id,
      versionId: null,
      eventId: null,
      viewer: null,
      code: 'INCIDENT',
      message: 'trap',
    });

    const result = insightsSchema.parse(
      createInsightsService({ database, channelId: 'home', now: () => NOW }).summary('stream'),
    );
    expect(result.empty).toBe(false);
    expect(result.range.from).toBe(start);
    expect(result.participation).toMatchObject({
      participants: 5,
      attempts: 19,
      admitted: 4,
      blocked: 15,
    });
    expect(result.blocked.total).toBe(15);
    expect(result.blocked.reasons[0]).toMatchObject({ reason: 'viewer-limit', count: 12 });
    expect(result.blocked.reasons.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['finished', 'role', 'capacity']),
    );
    const battle = result.automations.find((a) => a.title === 'Tomato Battle');
    expect(battle).toMatchObject({ triggers: 17, admitted: 4, blocked: 13, participants: 4 });
    const heart = result.automations.find((a) => a.title === 'Heart burst');
    // One participant only: the count is suppressed rather than reported.
    expect(heart).toMatchObject({ triggers: 1, blocked: 1, participants: null, incidents: 1 });
    expect(result.incidents.total).toBe(1);
    expect(result.takeaways.map((t) => t.text).join(' ')).toMatch(
      /12 actions on Tomato Battle were blocked by the per-viewer limit/,
    );
  });

  it('never exposes viewer identities or per-viewer rankings', () => {
    const { database, repo } = setup();
    const automation = repo.createAutomation('Star shower');
    for (const viewer of ['zed-the-whale', 'yvonne', 'xavier'])
      for (let i = 0; i < 5; i++) decide(repo, automation.id, viewer, 'ACCEPTED', NOW - MINUTE + i);
    const serialized = JSON.stringify(
      createInsightsService({ database, channelId: 'home', now: () => NOW }).summary('24h'),
    );
    for (const viewer of ['zed-the-whale', 'yvonne', 'xavier'])
      expect(serialized).not.toContain(viewer);
    expect(serialized).not.toMatch(/leader|rank|top(Viewer|Spender)/i);
  });

  it('suppresses time buckets with fewer than three people', () => {
    const { database, repo } = setup();
    const automation = repo.createAutomation('Tomato Toss');
    decide(repo, automation.id, 'solo', 'ACCEPTED', NOW - 3 * 60 * MINUTE);
    for (const viewer of ['a', 'b', 'c'])
      decide(repo, automation.id, viewer, 'ACCEPTED', NOW - MINUTE);
    const result = createInsightsService({ database, channelId: 'home', now: () => NOW }).summary(
      '24h',
    );
    expect(result.range.bucketMs).toBe(30 * MINUTE);
    const busy = result.participation.series.filter((b) => !b.suppressed && (b.admitted ?? 0) > 0);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ admitted: 3, participants: 3 });
    const hidden = result.participation.series.filter((b) => b.suppressed);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ admitted: null, blocked: null, participants: null });
  });

  it('is tenant-scoped: another channel sees none of this channel’s data', () => {
    const { database, repo } = setup();
    const other = forChannel(database, 'other');
    other.ensure('Other');
    const automation = repo.createAutomation('Private');
    for (const viewer of ['a', 'b', 'c'])
      decide(repo, automation.id, viewer, 'ACCEPTED', NOW - MINUTE);
    run(database, 'ready', 1000, NOW - MINUTE);
    const result = createInsightsService({ database, channelId: 'other', now: () => NOW }).summary(
      '7d',
    );
    expect(result.empty).toBe(true);
    expect(result.automations).toEqual([]);
    expect(result.compiles.total).toBe(0);
  });

  it('reports compile success, latency, sessions and proposal engagement', () => {
    const { database, repo } = setup();
    run(database, 'ready', 1000, NOW - MINUTE);
    run(database, 'ready', 3000, NOW - MINUTE);
    run(database, 'failed', 9000, NOW - MINUTE);
    run(database, 'question', 2000, NOW - MINUTE);
    run(database, 'cancelled', null, NOW - MINUTE);
    run(database, 'ready', 500, NOW - 8 * 24 * 60 * MINUTE); // outside 7d
    const automation = repo.createAutomation('Round');
    const journal = (sessionId: string, kind: 'start' | 'advance', snapshot: unknown) =>
      database.db
        .insert(sessionJournal)
        .values({
          channelId: 'home',
          sessionId,
          automationId: automation.id,
          versionId: 'v',
          kind,
          at: NOW - MINUTE,
          snapshot: snapshot as never,
          digest: 'd',
        })
        .run();
    journal('s1', 'start', { phase: 'running', outcome: null });
    journal('s1', 'advance', { phase: 'finished', outcome: 'goal' });
    journal('s2', 'start', { phase: 'running', outcome: null });
    journal('s2', 'advance', { phase: 'finished', outcome: 'deadline' });
    journal('s3', 'start', { phase: 'running', outcome: null });
    const proposal = randomUUID();
    database.db
      .insert(proposals)
      .values({
        id: proposal,
        channelId: 'home',
        text: 'more tomatoes',
        normalizedText: 'more tomatoes',
        number: 1,
        state: 'pending',
        revision: 0,
        createdAt: NOW - MINUTE,
        updatedAt: NOW - MINUTE,
      })
      .run();
    for (const account of ['1', '2'])
      database.db
        .insert(proposalContributors)
        .values({
          id: randomUUID(),
          channelId: 'home',
          proposalId: proposal,
          accountId: account,
          displayName: `viewer-${account}`,
          eventId: randomUUID(),
          createdAt: NOW - MINUTE,
        })
        .run();
    const ballot = randomUUID();
    database.db
      .insert(proposalBallots)
      .values({
        id: ballot,
        channelId: 'home',
        number: 1,
        revision: 0,
        createdAt: NOW - MINUTE,
        deadlineAt: NOW,
        closedAt: null,
      })
      .run();
    for (const account of ['1', '2', '3'])
      database.db
        .insert(proposalVotes)
        .values({
          id: randomUUID(),
          channelId: 'home',
          ballotId: ballot,
          accountId: account,
          option: 1,
          eventId: randomUUID(),
          at: NOW - MINUTE,
        })
        .run();

    const result = insightsSchema.parse(
      createInsightsService({ database, channelId: 'home', now: () => NOW }).summary('7d'),
    );
    expect(result.compiles).toMatchObject({
      total: 5,
      ready: 2,
      failed: 1,
      question: 1,
      cancelled: 1,
      medianMs: 2500,
    });
    expect(result.compiles.successRate).toBeCloseTo(0.5);
    expect(result.sessions).toEqual({ started: 3, finished: 2, goal: 1, deadline: 1 });
    expect(result.proposals).toMatchObject({
      suggestions: 2,
      contributors: null,
      ballots: 1,
      votes: 3,
    });
    expect(JSON.stringify(result)).not.toContain('viewer-1');
    expect(result.takeaways.map((t) => t.text).join(' ')).toMatch(/suggestion/);
  });
});

describe('insights route', () => {
  it('serves validated insights for a range and rejects unknown ranges', async () => {
    const app = await createApp({ logger: false });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/insights?range=24h' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ insights: unknown }>();
    expect(insightsSchema.parse(body.insights).range.kind).toBe('24h');
    const fallback = await app.inject({ method: 'GET', url: '/api/insights' });
    expect(fallback.json<{ insights: { range: { kind: string } } }>().insights.range.kind).toBe(
      'stream',
    );
    const bad = await app.inject({ method: 'GET', url: '/api/insights?range=forever' });
    expect(bad.statusCode).toBe(400);
  });
});
