import { afterEach, expect, it } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('an echoed broadcaster command cannot stop the receiving channel', async () => {
  const app = await createApp({ logger: false });
  apps.push(app);
  const echo: LiveChatMessage = {
    id: 'echo',
    channelId: '200',
    sourceChannelId: '100',
    sourceMessageId: 'original',
    viewerId: '100',
    viewerName: 'Owner elsewhere',
    roles: ['viewer', 'broadcaster'],
    text: '!riff panic',
    source: 'twitch',
  };
  await app.riff.runtime.handleChat(echo);
  expect(app.riff.runtime.panicked).toBe(false);
  await app.riff.runtime.handleChat({ ...echo, channelId: '100' });
  expect(app.riff.runtime.panicked).toBe(true);
});
