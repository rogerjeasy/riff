import { expect, it, vi } from 'vitest';
import { coordinatorUrl, createPeerTransport } from '../src/services/collaboration/transport.js';

it('accepts explicit secure coordinator origins and loopback development only', () => {
  expect(coordinatorUrl('https://riff.example')).toBe('https://riff.example');
  expect(coordinatorUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  for (const url of [
    'http://riff.example',
    'https://name:secret@riff.example',
    'https://riff.example/api',
    'https://riff.example?key=secret',
    'file:///tmp/test',
    'https://169.254.169.254',
    'http://localhost.evil.test',
  ]) {
    expect(() => coordinatorUrl(url)).toThrow();
  }
});

it('uses a scoped authorization header, refuses redirects and bounds response bytes', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  const transport = createPeerTransport(fetcher);
  expect(await transport('https://riff.example', 'member-token', 'heartbeat', {})).toEqual({
    ok: true,
  });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://riff.example/peer/collaboration/heartbeat');
  expect(options).toMatchObject({
    redirect: 'error',
    headers: { authorization: 'Bearer member-token' },
  });
  expect(String(url)).not.toContain('member-token');
  fetcher.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)));
  await expect(transport('https://riff.example', 'member-token', 'review', {})).rejects.toThrow(
    'too large',
  );
});

it('does not relay remote response errors or tokens into user-facing messages', async () => {
  const transport = createPeerTransport(
    async () => new Response('sensitive remote output', { status: 403 }),
  );
  await expect(transport('https://riff.example', 'member-token', 'review', {})).rejects.toThrow(
    'denied',
  );
});

it('shows a short coordinator explanation, but never an oversized or multi-line one', async () => {
  const reply = (message: string, extra = '') =>
    createPeerTransport(
      async () =>
        new Response(JSON.stringify({ code: 'CONFLICT', message }) + extra, {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );
  await expect(
    reply('The shared round has finished.')('https://riff.example', 't', 'approve', {}),
  ).rejects.toThrow('Coordinator: The shared round has finished.');
  await expect(
    reply('line one\nline two')('https://riff.example', 't', 'approve', {}),
  ).rejects.toThrow('could not complete');
  await expect(
    reply('ok', ' '.repeat(4096))('https://riff.example', 't', 'approve', {}),
  ).rejects.toThrow('could not complete');
});
