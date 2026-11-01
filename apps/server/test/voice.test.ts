import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import {
  createMockTranscription,
  createOpenAiTranscription,
  type TranscriptionTransport,
} from '../src/services/voice/transport.js';
import { createVoiceService, VoiceError } from '../src/services/voice/service.js';
import { sanitizeTranscript, VOICE_LIMITS } from '../src/services/voice/contract.js';

const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function app(transcription: TranscriptionTransport | null) {
  const created = await createApp({ logger: false, transcription });
  apps.push(created);
  return created;
}
const audio = Buffer.from('RIFF-test-audio-frame'.repeat(40));
const upload = (target: RiffApp, body: Buffer, headers: Record<string, string> = {}) =>
  target.inject({
    method: 'POST',
    url: '/api/voice/transcribe',
    payload: body,
    headers: {
      'content-type': 'audio/webm;codecs=opus',
      'x-riff-request': '1',
      'x-riff-audio-duration-ms': '4200',
      ...headers,
    },
  });

describe('transcript sanitization', () => {
  it('strips control characters, collapses whitespace and caps length', () => {
    expect(sanitizeTranscript('  Let\u0000 viewers\n\n throw‮tomatoes  ')).toBe(
      'Let viewers throw tomatoes',
    );
    expect(sanitizeTranscript('a'.repeat(5000))).toHaveLength(VOICE_LIMITS.maxTranscriptChars);
  });
});

describe('voice service', () => {
  it('reports no provider when transcription is not configured and refuses uploads', async () => {
    const service = createVoiceService({ transport: null });
    expect(service.status()).toMatchObject({ provider: 'none', maxDurationMs: 60_000 });
    await expect(
      service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('returns deterministic mock transcripts and never retains audio', async () => {
    const transport = createMockTranscription();
    const spy = vi.spyOn(transport, 'transcribe');
    const service = createVoiceService({ transport });
    const first = await service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 4000 });
    const second = await service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 4000 });
    expect(first.text).toBe(second.text);
    expect(first.text.length).toBeGreaterThan(8);
    expect(first).toMatchObject({ provider: 'mock' });
    expect(spy).toHaveBeenCalledTimes(2);
    // The result carries only the transcript and metadata, never the audio bytes.
    expect(JSON.stringify(first)).not.toContain('RIFF-test-audio');
  });

  it('rejects unsupported types, oversize audio, overlong durations and empty audio', async () => {
    const service = createVoiceService({ transport: createMockTranscription() });
    await expect(
      service.transcribe({ audio, mimeType: 'video/webm', durationMs: 1000 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    await expect(
      service.transcribe({
        audio: Buffer.alloc(VOICE_LIMITS.maxBytes + 1),
        mimeType: 'audio/webm',
        durationMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(
      service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 65_000 }),
    ).rejects.toMatchObject({ code: 'TOO_LONG' });
    await expect(
      service.transcribe({ audio: Buffer.alloc(0), mimeType: 'audio/webm', durationMs: 100 }),
    ).rejects.toMatchObject({ code: 'EMPTY' });
  });

  it('rate-limits transcriptions per rolling minute and allows one at a time', async () => {
    let clock = 0;
    let release: () => void = () => undefined;
    const slow: TranscriptionTransport = {
      kind: 'mock',
      transcribe: () =>
        new Promise((resolve) => {
          release = () => resolve({ text: 'slow transcript' });
        }),
    };
    const busy = createVoiceService({ transport: slow, now: () => clock });
    const pending = busy.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 });
    await expect(
      busy.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await pending;

    const service = createVoiceService({ transport: createMockTranscription(), now: () => clock });
    for (let i = 0; i < VOICE_LIMITS.perMinute; i++)
      await service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 });
    await expect(
      service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    clock += 60_001;
    await expect(
      service.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 }),
    ).resolves.toMatchObject({ provider: 'mock' });
  });

  it('maps provider failures to explicit, user-safe errors', async () => {
    const failing: TranscriptionTransport = {
      kind: 'openai',
      transcribe: () => Promise.reject(new VoiceError('PROVIDER_REJECTED', 'secret detail')),
    };
    const service = createVoiceService({ transport: failing });
    const error = await service
      .transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as VoiceError).message).not.toContain('secret');

    const silent = createVoiceService({
      transport: { kind: 'mock', transcribe: () => Promise.resolve({ text: ' \u0000 ' }) },
    });
    await expect(
      silent.transcribe({ audio, mimeType: 'audio/webm', durationMs: 1000 }),
    ).rejects.toMatchObject({ code: 'NO_SPEECH' });
  });
});

describe('OpenAI transcription transport', () => {
  it('posts multipart audio to the documented endpoint with the configured model', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ text: 'Let viewers throw tomatoes', languages: [{ code: 'en' }] }),
    );
    const transport = createOpenAiTranscription({
      apiKey: 'sk-test-key',
      model: 'gpt-transcribe',
      fetch: fetcher,
    });
    const result = await transport.transcribe({ audio, mimeType: 'audio/webm' });
    expect(result.text).toBe('Let viewers throw tomatoes');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-transcribe');
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.webm');
    expect(file.size).toBe(audio.length);
  });

  it('never retries and hides provider bodies and keys from errors', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { message: 'Incorrect API key sk-test-key' } }, { status: 401 }),
    );
    const transport = createOpenAiTranscription({
      apiKey: 'sk-test-key',
      model: 'gpt-transcribe',
      fetch: fetcher,
    });
    const error = (await transport
      .transcribe({ audio, mimeType: 'audio/webm' })
      .catch((e: unknown) => e)) as VoiceError;
    expect(error.code).toBe('PROVIDER_REJECTED');
    expect(error.message).not.toContain('sk-test-key');
    expect(error.detail).not.toContain('sk-test-key');
    expect(fetcher).toHaveBeenCalledTimes(1);

    const throttled = createOpenAiTranscription({
      apiKey: 'k',
      model: 'gpt-transcribe',
      fetch: async () => new Response('{}', { status: 429 }),
    });
    await expect(throttled.transcribe({ audio, mimeType: 'audio/webm' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const malformed = createOpenAiTranscription({
      apiKey: 'k',
      model: 'gpt-transcribe',
      fetch: async () => Response.json({ transcript: 'wrong shape' }),
    });
    await expect(malformed.transcribe({ audio, mimeType: 'audio/webm' })).rejects.toMatchObject({
      code: 'FAILED',
    });
  });
});

describe('voice routes', () => {
  it('exposes provider status without secrets', async () => {
    const target = await app(createMockTranscription());
    const response = await target.inject({ method: 'GET', url: '/api/voice' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      voice: { provider: 'mock', maxDurationMs: 60_000, maxBytes: VOICE_LIMITS.maxBytes },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('transcribes a raw audio upload and returns an editable transcript', async () => {
    const target = await app(createMockTranscription());
    const response = await upload(target, audio);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ transcript: { text: string; provider: string } }>();
    expect(body.transcript.provider).toBe('mock');
    expect(body.transcript.text.length).toBeGreaterThan(8);
  });

  it('requires the console request header and same origin', async () => {
    const target = await app(createMockTranscription());
    const missing = await target.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      payload: audio,
      headers: { 'content-type': 'audio/webm' },
    });
    expect(missing.statusCode).toBe(403);
    const crossSite = await upload(target, audio, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.statusCode).toBe(403);
  });

  it('rejects unconfigured providers, wrong types, oversize bodies and missing durations', async () => {
    const none = await app(null);
    expect((await upload(none, audio)).json()).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect((await upload(none, audio)).statusCode).toBe(503);

    const target = await app(createMockTranscription());
    const wrongType = await upload(target, audio, { 'content-type': 'application/octet-stream' });
    expect(wrongType.statusCode).toBe(415);
    const big = await upload(target, Buffer.alloc(VOICE_LIMITS.maxBytes + 10));
    expect(big.statusCode).toBe(413);
    const noDuration = await target.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      payload: audio,
      headers: { 'content-type': 'audio/webm', 'x-riff-request': '1' },
    });
    expect(noDuration.statusCode).toBe(400);
  });
});

describe('voice environment', () => {
  it('defaults to off, selects OpenAI when a key is present, and validates explicit modes', () => {
    expect(parseEnv({}).transcription).toEqual({
      mode: 'off',
      apiKey: null,
      model: 'gpt-transcribe',
    });
    expect(parseEnv({ OPENAI_API_KEY: 'sk-x' }).transcription).toMatchObject({
      mode: 'openai',
      apiKey: 'sk-x',
    });
    expect(parseEnv({ RIFF_TRANSCRIPTION_MODE: 'mock' }).transcription.mode).toBe('mock');
    expect(parseEnv({ RIFF_TRANSCRIPTION_MODE: '' }).transcription.mode).toBe('off');
    expect(
      parseEnv({ OPENAI_API_KEY: 'sk-x', RIFF_TRANSCRIPTION_MODEL: 'custom' }).transcription.model,
    ).toBe('custom');
    expect(() => parseEnv({ RIFF_TRANSCRIPTION_MODE: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });
});
