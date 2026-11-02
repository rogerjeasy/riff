import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';
import type { ActivityRow } from '../src/db/repositories/studio.js';
import { activityView } from '../src/services/automations/activity-view.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
const headers = { 'x-riff-request': '1' };
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const row = (over: Partial<ActivityRow>): ActivityRow => ({
  id: 1,
  channelId: 'home',
  at: 1000,
  kind: 'decision',
  automationId: 'a1',
  versionId: 'v1',
  eventId: 'e1',
  viewer: 'alice',
  code: 'ACCEPTED',
  message: 'alice used !tomato · 1 cosmetic effect submitted for presentation',
  detail: null,
  ...over,
});
const lookup = {
  version: (id: string) => (id === 'v1' ? { title: 'Tomato Toss', number: 3 } : undefined),
  automation: (id: string) => (id === 'a1' ? { title: 'Tomato Toss' } : undefined),
};

describe('F16 activity projection', () => {
  it('names source, exact version, outcome and effect counts from stored detail', () => {
    expect(
      activityView(
        row({
          detail: {
            source: { kind: 'chat', label: '!tomato by alice' },
            effects: { allowed: 1, blocked: 0 },
          },
        }),
        lookup,
      ),
    ).toMatchObject({
      source: { kind: 'chat', label: '!tomato by alice' },
      interaction: { title: 'Tomato Toss', number: 3 },
      versionId: 'v1',
      outcome: 'accepted',
      reason: null,
      effects: { allowed: 1, blocked: 0 },
    });
  });

  it('gives blocked decisions and incidents a plain-language reason', () => {
    const blocked = activityView(
      row({ code: 'VIEWER_LIMIT', message: 'You already threw 3 tomatoes in the last minute.' }),
      lookup,
    );
    expect(blocked).toMatchObject({
      outcome: 'blocked',
      reason: 'You already threw 3 tomatoes in the last minute.',
      effects: null,
    });
    const incident = activityView(
      row({ kind: 'incident', code: 'INCIDENT', viewer: null, message: 'v3 was stopped: trap' }),
      lookup,
    );
    expect(incident).toMatchObject({
      outcome: 'incident',
      reason: 'v3 was stopped: trap',
      source: { kind: 'system' },
    });
  });

  it('infers sources for rows written before detail existed and bounds labels', () => {
    expect(
      activityView(
        row({ viewer: null, message: 'Timer “celebrate” fired · 0 cosmetic effects' }),
        lookup,
      ).source,
    ).toEqual({ kind: 'timer', label: 'celebrate' });
    expect(activityView(row({}), lookup).source).toEqual({ kind: 'chat', label: 'alice' });
    expect(
      activityView(row({ kind: 'control', code: 'PAUSED', viewer: null }), lookup),
    ).toMatchObject({
      source: { kind: 'console', label: 'Console' },
      outcome: 'info',
      reason: null,
    });
    const long = activityView(
      row({ detail: { source: { kind: 'twitch', label: 'x'.repeat(400) } } }),
      lookup,
    );
    expect(long.source.label.length).toBeLessThanOrEqual(120);
  });

  it('drops versions it cannot resolve and falls back to the interaction title', () => {
    expect(activityView(row({ versionId: 'gone' }), lookup)).toMatchObject({
      versionId: null,
      interaction: { title: 'Tomato Toss', number: null },
    });
    expect(
      activityView(row({ versionId: null, automationId: null }), lookup).interaction,
    ).toBeNull();
  });

  it('carries the projection through the studio snapshot for live chat', async () => {
    const app = await createApp({ logger: false });
    apps.push(app);
    const started = await app.inject({
      method: 'POST',
      url: '/api/compile-runs',
      headers,
      payload: { intent: TOMATO, baseVersionId: null },
    });
    const id = started.json<{ id: string }>().id;
    let versionId: string | undefined;
    for (let i = 0; i < 200 && !versionId; i++) {
      versionId =
        app.riff.authoring.runs().find((r) => r.id === id)?.result?.versionId ?? undefined;
      if (!versionId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const version = app.riff.repo.version(versionId!)!;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/versions/${version.id}/approve`,
      headers,
      payload: {
        artifactId: version.artifactId,
        reportHash: version.reportHash,
        expectedActiveVersionId: null,
      },
    });
    expect(approved.statusCode).toBe(200);
    const chat = (n: number): LiveChatMessage => ({
      id: `m${n}`,
      channelId: 'broadcaster-1',
      viewerId: 'user-alice',
      viewerName: 'alice',
      roles: ['viewer'],
      text: '!tomato',
      source: 'twitch',
    });
    for (let i = 0; i < 4; i++) await app.riff.runtime.handleChat(chat(i));

    const studio = (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
      activity: ReturnType<typeof activityView>[];
    }>();
    const [limited, accepted] = studio.activity;
    expect(limited).toMatchObject({
      code: 'VIEWER_LIMIT',
      outcome: 'blocked',
      source: { kind: 'chat', label: '!tomato by alice' },
      interaction: { title: version.title, number: version.number },
      versionId: version.id,
    });
    expect(limited?.reason).toBeTruthy();
    expect(accepted).toMatchObject({
      code: 'ACCEPTED',
      outcome: 'accepted',
      effects: { allowed: expect.any(Number), blocked: expect.any(Number) },
    });
    const approval = studio.activity.find((a) => a.code === 'APPROVED');
    expect(approval?.source).toEqual({ kind: 'console', label: 'Console' });
    expect(studio.activity.length).toBeLessThanOrEqual(40);
  }, 30_000);
});
