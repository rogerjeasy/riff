import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeChatMessage } from '@riff/twitch';
import {
  ECHO_LEDGER_MAX,
  ECHO_WINDOW_MS,
  createEchoLedger,
} from '../src/services/twitch/echo-ledger.js';

const chat = JSON.parse(
  readFileSync(
    new URL('../../../packages/twitch/fixtures/channel.chat.message.json', import.meta.url),
    'utf8',
  ),
) as { event: Record<string, unknown> };
const sent = JSON.parse(
  readFileSync(
    new URL('../../../packages/twitch/fixtures/helix.send-chat-message.json', import.meta.url),
    'utf8',
  ),
) as { data: { message_id: string }[] };
const BROADCASTER = String(chat.event['broadcaster_user_id']);
const SENT_ID = sent.data[0]!.message_id;

/** The documented `channel.chat.message` event as the broadcaster's own line. */
function echo(text: string, messageId = 'other-id', chatter = BROADCASTER) {
  const message = normalizeChatMessage(
    {
      ...chat.event,
      chatter_user_id: chatter,
      badges: [{ set_id: 'broadcaster', id: '1', info: '' }],
      message_id: messageId,
      message: { text, fragments: [] },
    },
    { messageId: `envelope-${messageId}`, receivedAt: 0 },
  )!;
  return {
    channelId: message.channelId,
    chatterId: message.viewerId,
    messageId: message.sourceMessageId,
    text: message.text,
  };
}

describe('Riff output echo ledger', () => {
  it('drops a Send Chat Message echo by the returned message_id, once', () => {
    const clock = { at: 0 };
    const ledger = createEchoLedger({ now: () => clock.at });
    ledger.sending(BROADCASTER, 'Riff · Compiling…', 'chat-message').sent(SENT_ID);
    // Same id, even with text Twitch may have rewritten.
    expect(ledger.match(echo('Riff · Compiling...', SENT_ID))).toEqual({
      origin: 'chat-message',
      by: 'message-id',
    });
    expect(ledger.match(echo('Riff · Compiling…', SENT_ID))).toBeNull();
  });

  it('matches an announcement (204, no id) by normalized text within the window, once', () => {
    const clock = { at: 0 };
    const ledger = createEchoLedger({ now: () => clock.at });
    ledger.sending(BROADCASTER, '  Type !tomato\tto throw! ', 'announcement');
    clock.at = ECHO_WINDOW_MS - 1;
    expect(ledger.match(echo('Type !tomato to throw!'))).toEqual({
      origin: 'announcement',
      by: 'fingerprint',
    });
    // The broadcaster typing the same line afterwards is genuine.
    expect(ledger.match(echo('Type !tomato to throw!'))).toBeNull();
  });

  it('never matches other chatters, other channels or lines outside the window', () => {
    const clock = { at: 0 };
    const ledger = createEchoLedger({ now: () => clock.at });
    ledger.sending(BROADCASTER, '!hydrate', 'announcement');
    expect(ledger.match(echo('!hydrate', 'x', '4145994'))).toBeNull();
    expect(ledger.match({ ...echo('!hydrate'), channelId: 'elsewhere' })).toBeNull();
    clock.at = ECHO_WINDOW_MS + 1;
    expect(ledger.match(echo('!hydrate'))).toBeNull();
    expect(ledger.size()).toBe(0);
  });

  it('forgets a message Twitch reported as not sent', () => {
    const ledger = createEchoLedger({ now: () => 0 });
    ledger.sending(BROADCASTER, 'Riff · hi', 'chat-message').cancel();
    expect(ledger.match(echo('Riff · hi'))).toBeNull();
  });

  it('stays bounded per channel, evicting the oldest entries first', () => {
    const ledger = createEchoLedger({ now: () => 0 });
    for (let i = 0; i < ECHO_LEDGER_MAX + 10; i++)
      ledger.sending(BROADCASTER, `line ${i}`, 'announcement');
    expect(ledger.size()).toBe(ECHO_LEDGER_MAX);
    expect(ledger.match(echo('line 0'))).toBeNull();
    expect(ledger.match(echo(`line ${ECHO_LEDGER_MAX + 9}`))).not.toBeNull();
  });
});
