import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VOICE_LIMITS, VOICE_MIME_TYPES, VoiceError, type VoiceMimeType } from './contract.js';

export interface TranscriptionInput {
  audio: Buffer;
  mimeType: VoiceMimeType;
  signal?: AbortSignal;
}
/** Server-owned transcription transport; injected so tests never reach the network. */
export interface TranscriptionTransport {
  kind: 'openai' | 'mock';
  transcribe(input: TranscriptionInput): Promise<{ text: string }>;
}

// Deterministic phrases so e2e and route tests can assert exact review text.
const MOCK_PHRASES = [
  'Let viewers throw tomatoes with !tomato, three per person per minute.',
  'Subscribers can type !love to send a heart, once every 30 seconds.',
  'Let everyone use !star to throw stars, at most 5 per minute.',
];

/** Offline transcription: the same audio bytes always yield the same phrase. */
export function createMockTranscription(): TranscriptionTransport {
  return {
    kind: 'mock',
    transcribe: ({ audio }) => {
      const index = (createHash('sha256').update(audio).digest()[0] ?? 0) % MOCK_PHRASES.length;
      return Promise.resolve({ text: MOCK_PHRASES[index] ?? 'Let viewers throw tomatoes.' });
    },
  };
}

/**
 * Response of the default `gpt-transcribe` JSON format: `{ text, languages }`.
 * Unknown fields are allowed; a missing `text` fails closed.
 * Verified against https://developers.openai.com/api/docs/guides/speech-to-text (Nov 1 2026).
 */
const responseSchema = z.object({ text: z.string().max(20_000) }).passthrough();
export const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * OpenAI file transcription over native `fetch` + `FormData` (`file`, `model` fields of
 * the documented multipart request). Never retried: a recording is resubmitted only by
 * an explicit creator retry. Provider bodies and the key never appear in errors.
 */
export function createOpenAiTranscription(options: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  url?: string;
}): TranscriptionTransport {
  const request = options.fetch ?? fetch;
  return {
    kind: 'openai',
    async transcribe({ audio, mimeType, signal }) {
      const form = new FormData();
      form.append('model', options.model);
      form.append(
        'file',
        new Blob([new Uint8Array(audio)], { type: mimeType }),
        `voice.${VOICE_MIME_TYPES[mimeType]}`,
      );
      const deadline = AbortSignal.timeout(VOICE_LIMITS.timeoutMs);
      let response: Response;
      try {
        response = await request(options.url ?? OPENAI_TRANSCRIPTION_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}` },
          body: form,
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
      } catch (error) {
        if (deadline.aborted) throw new VoiceError('TIMEOUT', 'transcription deadline exceeded');
        throw new VoiceError('FAILED', `network: ${(error as Error).name}`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429) throw new VoiceError('RATE_LIMITED', 'provider status 429');
        if (response.status === 401 || response.status === 403)
          throw new VoiceError('PROVIDER_REJECTED', `provider status ${response.status}`);
        if (response.status === 400 || response.status === 413 || response.status === 415)
          throw new VoiceError('INVALID', `provider status ${response.status}`);
        throw new VoiceError('FAILED', `provider status ${response.status}`);
      }
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new VoiceError('FAILED', 'provider response missing text');
      return { text: parsed.data.text };
    },
  };
}
