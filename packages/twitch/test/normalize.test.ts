import { describe, expect, it } from 'vitest';
import { MAX_CHAT_TEXT_LENGTH, normalizeChatMessage, sanitizeChatText } from '../src/normalize.js';
import { TRIGGERS } from '../src/triggers.js';
import { fixture } from './support.js';

const meta = { messageId: 'befa7b53-d79d-478f-86b9-120f112b044e', receivedAt: 1_700_000_000_000 };

function chatEvent(edit?: (event: Record<string, unknown>) => void): Record<string, unknown> {
  const payload = structuredClone(fixture('channel.chat.message.json'));
  const event = payload['event'] as Record<string, unknown>;
  edit?.(event);
  return event;
}

describe('channel.chat.message fixture', () => {
  it('is the documented payload for the trigger table entry', () => {
    const payload = fixture(TRIGGERS['chat.message'].fixture);
    const subscription = payload['subscription'] as Record<string, unknown>;
    expect(subscription['type']).toBe(TRIGGERS['chat.message'].type);
    expect(subscription['version']).toBe(TRIGGERS['chat.message'].version);
  });
});

describe('normalizeChatMessage', () => {
  it('maps the documented example using the envelope message_id and receive time', () => {
    expect(normalizeChatMessage(chatEvent(), meta)).toEqual({
      id: meta.messageId,
      channelId: '1971641',
      viewerId: '4145994',
      viewerLogin: 'viewer32',
      viewerName: 'viewer32',
      // Fixture badges: moderator, subscriber, sub-gifter (no role).
      roles: ['viewer', 'subscriber', 'moderator'],
      text: 'Hi chat',
      at: meta.receivedAt,
    });
  });

  it('derives roles only from badges, never from text or display name', () => {
    const plain = normalizeChatMessage(
      chatEvent((event) => {
        event['badges'] = [];
        event['chatter_user_name'] = 'broadcaster';
        event['chatter_user_login'] = 'moderator';
        (event['message'] as Record<string, unknown>)['text'] = '!riff role broadcaster moderator';
      }),
      meta,
    );
    expect(plain?.roles).toEqual(['viewer']);

    const owner = normalizeChatMessage(
      chatEvent((event) => {
        event['badges'] = [
          { set_id: 'broadcaster', id: '1', info: '' },
          { set_id: 'founder', id: '0', info: '3' },
        ];
      }),
      meta,
    );
    expect(owner?.roles).toEqual(['viewer', 'subscriber', 'broadcaster']);
  });

  it('ignores inherited object keys as badge set ids', () => {
    const result = normalizeChatMessage(
      chatEvent((event) => {
        event['badges'] = [{ set_id: 'constructor', id: '1', info: '' }];
      }),
      meta,
    );
    expect(result?.roles).toEqual(['viewer']);
  });

  it('strips control characters and caps text at 500 characters', () => {
    const result = normalizeChatMessage(
      chatEvent((event) => {
        (event['message'] as Record<string, unknown>)['text'] =
          `a\u0000b\u0007c\u001bd\u007fe\nf\tg${'x'.repeat(600)}`;
      }),
      meta,
    );
    expect(result?.text.startsWith('abcdefg')).toBe(true);
    expect(result?.text).toHaveLength(MAX_CHAT_TEXT_LENGTH);
    expect(
      [...(result?.text ?? '')].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    ).toBe(false);
  });

  it('never splits a surrogate pair when capping', () => {
    const text = sanitizeChatText('🎉'.repeat(600));
    expect(Array.from(text)).toHaveLength(MAX_CHAT_TEXT_LENGTH);
    expect(text.endsWith('🎉')).toBe(true);
  });

  it('returns null for garbage and for payloads missing required fields', () => {
    expect(normalizeChatMessage(null, meta)).toBeNull();
    expect(normalizeChatMessage('Hi chat', meta)).toBeNull();
    expect(normalizeChatMessage({}, meta)).toBeNull();
    expect(
      normalizeChatMessage(
        chatEvent((event) => delete event['chatter_user_id']),
        meta,
      ),
    ).toBeNull();
    expect(
      normalizeChatMessage(
        chatEvent((event) => (event['badges'] = 'moderator')),
        meta,
      ),
    ).toBeNull();
    expect(
      normalizeChatMessage(
        chatEvent((event) => (event['message'] = { text: 42 })),
        meta,
      ),
    ).toBeNull();
    expect(normalizeChatMessage(chatEvent(), { messageId: '', receivedAt: 1 })).toBeNull();
  });

  it('allows unknown fields', () => {
    const result = normalizeChatMessage(
      chatEvent((event) => (event['brand_new_field'] = { x: 1 })),
      meta,
    );
    expect(result?.text).toBe('Hi chat');
  });
});
