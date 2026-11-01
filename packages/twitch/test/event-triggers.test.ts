import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_VIEWER_ID,
  MAX_EVENT_AMOUNT,
  normalizeTwitchEvent,
} from '../src/normalize-events.js';
import { MAX_CHAT_TEXT_LENGTH } from '../src/normalize.js';
import {
  EVENT_TRIGGER_NAMES,
  TRIGGERS,
  missingScopes,
  scopesForTriggers,
  triggerCondition,
  triggerForSubscription,
  type EventTriggerName,
} from '../src/triggers.js';
import { fixture } from './support.js';

const meta = { messageId: 'befa7b53-d79d-478f-86b9-120f112b044e', receivedAt: 1_700_000_000_000 };
const eventOf = (name: EventTriggerName, edit?: (event: Record<string, unknown>) => void) => {
  const payload = structuredClone(fixture(TRIGGERS[name].fixture));
  const event = payload['event'] as Record<string, unknown>;
  edit?.(event);
  return event;
};

describe('F19 trigger table ↔ fixtures', () => {
  it('lists exactly the five platform event families besides chat', () => {
    expect(EVENT_TRIGGER_NAMES).toEqual(['subscribe', 'gift', 'resub', 'cheer', 'raid']);
  });

  it.each(Object.keys(TRIGGERS) as (keyof typeof TRIGGERS)[])(
    '%s has a sourced documentation fixture matching its type, version and condition',
    (name) => {
      const trigger = TRIGGERS[name];
      const raw = JSON.parse(
        readFileSync(new URL(`../fixtures/${trigger.fixture}`, import.meta.url), 'utf8'),
      ) as { _source: string };
      expect(raw._source.startsWith(trigger.docs.split('#')[0]!)).toBe(true);
      expect(raw._source).toBe(trigger.docs);
      const subscription = fixture(trigger.fixture)['subscription'] as Record<string, unknown>;
      expect(subscription['type']).toBe(trigger.type);
      expect(subscription['version']).toBe(trigger.version);
      expect(Object.keys(subscription['condition'] as object).sort()).toEqual(
        [...trigger.condition].sort(),
      );
      expect(triggerForSubscription(trigger.type, trigger.version)).toBe(name);
    },
  );

  it('builds conditions and scope sets from the table only', () => {
    expect(triggerCondition('raid', '42')).toEqual({ to_broadcaster_user_id: '42' });
    expect(triggerCondition('cheer', '42')).toEqual({ broadcaster_user_id: '42' });
    expect(scopesForTriggers(['chat.message', 'subscribe', 'gift', 'cheer', 'raid'])).toEqual([
      'user:read:chat',
      'channel:read:subscriptions',
      'bits:read',
    ]);
    expect(missingScopes('cheer', ['user:read:chat'])).toEqual(['bits:read']);
    expect(missingScopes('raid', [])).toEqual([]);
    expect(triggerForSubscription('channel.cheer', '2')).toBeNull();
  });
});

describe('normalizeTwitchEvent', () => {
  it('maps the documented channel.subscribe example', () => {
    expect(normalizeTwitchEvent('subscribe', eventOf('subscribe'), meta)).toEqual({
      id: meta.messageId,
      kind: 'subscribe',
      channelId: '1337',
      viewerId: '1234',
      viewerLogin: 'cool_user',
      viewerName: 'Cool_User',
      amount: 1,
      tier: '1000',
      anonymous: false,
      gift: false,
      text: '',
      at: meta.receivedAt,
    });
  });

  it('maps gifts, including anonymous gifts without any account identity', () => {
    expect(normalizeTwitchEvent('gift', eventOf('gift'), meta)).toMatchObject({
      kind: 'gift',
      viewerId: '1234',
      amount: 2,
      tier: '1000',
      anonymous: false,
    });
    const anonymous = normalizeTwitchEvent(
      'gift',
      eventOf('gift', (event) => {
        event['is_anonymous'] = true;
        event['user_id'] = null;
        event['user_login'] = null;
        event['user_name'] = null;
        event['cumulative_total'] = null;
      }),
      meta,
    );
    expect(anonymous).toMatchObject({
      viewerId: ANONYMOUS_VIEWER_ID,
      viewerLogin: null,
      viewerName: 'Anonymous',
      anonymous: true,
    });
    // An anonymous flag wins even if a payload unexpectedly carried a user id.
    expect(
      normalizeTwitchEvent(
        'gift',
        eventOf('gift', (event) => (event['is_anonymous'] = true)),
        meta,
      )?.viewerId,
    ).toBe(ANONYMOUS_VIEWER_ID);
  });

  it('maps resubscriptions to cumulative months and sanitizes the message', () => {
    const result = normalizeTwitchEvent('resub', eventOf('resub'), meta);
    expect(result).toMatchObject({ kind: 'resub', amount: 15, text: 'Love the stream! FevziGG' });
    const noisy = normalizeTwitchEvent(
      'resub',
      eventOf('resub', (event) => {
        event['message'] = { text: `hi\u0000\u0007${'x'.repeat(900)}`, emotes: [] };
      }),
      meta,
    );
    expect(noisy?.text.startsWith('hix')).toBe(true);
    expect(Array.from(noisy?.text ?? '')).toHaveLength(MAX_CHAT_TEXT_LENGTH);
  });

  it('maps cheers with bits and anonymous cheers', () => {
    expect(normalizeTwitchEvent('cheer', eventOf('cheer'), meta)).toMatchObject({
      kind: 'cheer',
      viewerId: '1234',
      amount: 1000,
      tier: null,
      text: 'pogchamp',
    });
    expect(
      normalizeTwitchEvent(
        'cheer',
        eventOf('cheer', (event) => {
          event['is_anonymous'] = true;
          event['user_id'] = null;
          event['user_login'] = null;
          event['user_name'] = null;
        }),
        meta,
      ),
    ).toMatchObject({ viewerId: ANONYMOUS_VIEWER_ID, anonymous: true, amount: 1000 });
  });

  it('maps incoming raids to the receiving channel with the viewer count', () => {
    expect(normalizeTwitchEvent('raid', eventOf('raid'), meta)).toMatchObject({
      kind: 'raid',
      channelId: '1337',
      viewerId: '1234',
      viewerName: 'Cool_User',
      amount: 9001,
    });
    expect(
      normalizeTwitchEvent(
        'raid',
        eventOf('raid', (event) => (event['viewers'] = 0)),
        meta,
      )?.amount,
    ).toBe(1);
  });

  it('fails closed on malformed payloads, zero amounts and missing identity', () => {
    expect(
      normalizeTwitchEvent(
        'cheer',
        eventOf('cheer', (e) => (e['bits'] = 0)),
        meta,
      ),
    ).toBeNull();
    expect(
      normalizeTwitchEvent(
        'cheer',
        eventOf('cheer', (e) => (e['bits'] = '5')),
        meta,
      ),
    ).toBeNull();
    expect(
      normalizeTwitchEvent(
        'gift',
        eventOf('gift', (e) => (e['total'] = 0)),
        meta,
      ),
    ).toBeNull();
    expect(
      normalizeTwitchEvent(
        'subscribe',
        eventOf('subscribe', (e) => (e['tier'] = 'prime')),
        meta,
      ),
    ).toBeNull();
    expect(normalizeTwitchEvent('raid', {}, meta)).toBeNull();
    expect(normalizeTwitchEvent('raid', eventOf('raid'), { ...meta, messageId: '' })).toBeNull();
  });

  it('caps extreme amounts and strips control characters from display names', () => {
    const result = normalizeTwitchEvent(
      'cheer',
      eventOf('cheer', (event) => {
        event['bits'] = MAX_EVENT_AMOUNT * 10;
        event['user_name'] = 'Cool\u0000_User';
      }),
      meta,
    );
    expect(result?.amount).toBe(MAX_EVENT_AMOUNT);
    expect(result?.viewerName).toBe('Cool_User');
  });
});
