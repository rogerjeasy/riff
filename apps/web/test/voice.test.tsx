// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceInput } from '../src/console/authoring/voice.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { MediaRecorder?: unknown }).MediaRecorder;
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

const status = (provider: 'openai' | 'mock' | 'none') =>
  new Response(
    JSON.stringify({
      voice: { provider, maxDurationMs: 60_000, maxBytes: 2_097_152, mimeTypes: ['audio/webm'] },
    }),
  );

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'audio/webm';
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    setTimeout(() => this.onstop?.(), 0);
  }
}
function microphone(result: 'ok' | 'denied' | 'missing') {
  const track = { stop: vi.fn() };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() =>
        result === 'ok'
          ? Promise.resolve({ getTracks: () => [track] })
          : Promise.reject(
              Object.assign(new Error('x'), {
                name: result === 'denied' ? 'NotAllowedError' : 'NotFoundError',
              }),
            ),
      ),
    },
  });
  (window as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  return track;
}

it('shows an explicit "type instead" state when no provider or browser speech exists', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status('none')),
  );
  render(<VoiceInput disabled={false} onUse={vi.fn()} />);
  expect(await screen.findByText(/Voice unavailable — type instead/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Hold to talk/ })).toBeNull();
});

it('falls back to browser speech recognition when the server has no provider', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status('none')),
  );
  (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
    start() {}
    stop() {}
    abort() {}
  };
  render(<VoiceInput disabled={false} onUse={vi.fn()} />);
  expect(await screen.findByRole('button', { name: /Hold to talk/ })).toBeTruthy();
  expect(screen.getByText(/browser’s speech recognition/)).toBeTruthy();
});

it('explains a denied microphone permission and offers retry and typing', async () => {
  microphone('denied');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status('openai')),
  );
  render(<VoiceInput disabled={false} onUse={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Hold to talk/ }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/Microphone access is blocked/);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Type instead' })).toBeTruthy();
});

it('reports a missing microphone explicitly', async () => {
  microphone('missing');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status('openai')),
  );
  render(<VoiceInput disabled={false} onUse={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Hold to talk/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/No microphone was found/);
});

it('records, uploads, and places the transcript in an editable review — never auto-submitting', async () => {
  const track = microphone('ok');
  const now = vi.spyOn(Date, 'now');
  let clock = 1_000_000;
  now.mockImplementation(() => clock);
  const fetcher = vi.fn(async (url: unknown, _init?: RequestInit) =>
    String(url).endsWith('/transcribe')
      ? new Response(
          JSON.stringify({
            transcript: { text: 'Let viewers throw tomatoes', provider: 'mock', durationMs: 2000 },
          }),
        )
      : status('mock'),
  );
  vi.stubGlobal('fetch', fetcher);
  const onUse = vi.fn();
  render(<VoiceInput disabled={false} onUse={onUse} />);
  const talk = await screen.findByRole('button', { name: /Hold to talk/ });
  fireEvent.click(talk);
  const stop = await screen.findByRole('button', { name: 'Stop recording' });
  expect(stop.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('meter', { name: 'Microphone level' })).toBeTruthy();
  clock += 2000;
  await act(async () => {
    fireEvent.click(stop);
  });
  const review = (await screen.findByLabelText(/Review transcript/)) as HTMLTextAreaElement;
  expect(review.value).toBe('Let viewers throw tomatoes');
  expect(track.stop).toHaveBeenCalled();
  const [, init] = fetcher.mock.calls.find(([url]) => String(url).endsWith('/transcribe'))!;
  expect((init?.headers as Record<string, string>)['x-riff-request']).toBe('1');
  expect((init?.headers as Record<string, string>)['x-riff-audio-duration-ms']).toBe('2000');
  expect(onUse).not.toHaveBeenCalled();
  fireEvent.change(review, { target: { value: 'Let viewers throw stars' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use as description' }));
  expect(onUse).toHaveBeenCalledWith('Let viewers throw stars', 'replace');
});

it('shows a transcription failure with a retry that resends the same recording', async () => {
  microphone('ok');
  let clock = 5_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  let attempts = 0;
  const fetcher = vi.fn(async (url: unknown) => {
    if (!String(url).endsWith('/transcribe')) return status('openai');
    attempts++;
    return attempts === 1
      ? new Response(JSON.stringify({ code: 'FAILED', message: 'Transcription failed. Retry.' }), {
          status: 502,
        })
      : new Response(
          JSON.stringify({ transcript: { text: 'Second try', provider: 'openai', durationMs: 1 } }),
        );
  });
  vi.stubGlobal('fetch', fetcher);
  render(<VoiceInput disabled={false} onUse={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Hold to talk/ }));
  const stop = await screen.findByRole('button', { name: 'Stop recording' });
  clock += 1500;
  await act(async () => {
    fireEvent.click(stop);
  });
  expect((await screen.findByRole('alert')).textContent).toMatch(/Transcription failed/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry transcription' }));
  expect(((await screen.findByLabelText(/Review transcript/)) as HTMLTextAreaElement).value).toBe(
    'Second try',
  );
  expect(attempts).toBe(2);
});

it('is disabled while a generation is running', async () => {
  microphone('ok');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status('openai')),
  );
  render(<VoiceInput disabled onUse={vi.fn()} />);
  expect(
    ((await screen.findByRole('button', { name: /Hold to talk/ })) as HTMLButtonElement).disabled,
  ).toBe(true);
});
