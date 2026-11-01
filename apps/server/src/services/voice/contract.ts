import { z } from 'zod';

/**
 * Host bounds for push-to-talk authoring. 60 s of browser Opus/AAC is well under 1 MiB;
 * the byte cap is the enforceable bound because the host never decodes audio.
 */
export const VOICE_LIMITS = {
  maxDurationMs: 60_000,
  maxBytes: 2 * 1024 * 1024,
  maxTranscriptChars: 1200,
  perMinute: 6,
  timeoutMs: 30_000,
} as const;

/**
 * Container types accepted by the OpenAI file-transcription workflow that browsers'
 * MediaRecorder can produce (verified against the speech-to-text guide, Nov 1 2026).
 */
export const VOICE_MIME_TYPES = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
} as const;
export type VoiceMimeType = keyof typeof VOICE_MIME_TYPES;

export function baseMimeType(value: string | undefined): VoiceMimeType | null {
  const base = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return base in VOICE_MIME_TYPES ? (base as VoiceMimeType) : null;
}

export type VoiceProvider = 'openai' | 'mock' | 'none';
export const voiceStatusSchema = z
  .object({
    provider: z.enum(['openai', 'mock', 'none']),
    maxDurationMs: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
    mimeTypes: z.array(z.string()),
  })
  .strict();
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

export const transcriptSchema = z
  .object({
    text: z.string().min(1).max(VOICE_LIMITS.maxTranscriptChars),
    provider: z.enum(['openai', 'mock']),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type Transcript = z.infer<typeof transcriptSchema>;

// Control characters, bidi overrides and zero-width marks never reach the composer.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Make provider text safe creator-editable input: no control characters, capped. */
export function sanitizeTranscript(text: string) {
  return text
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VOICE_LIMITS.maxTranscriptChars)
    .trim();
}

export type VoiceErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_TYPE'
  | 'TOO_LARGE'
  | 'TOO_LONG'
  | 'EMPTY'
  | 'INVALID'
  | 'BUSY'
  | 'RATE_LIMITED'
  | 'PROVIDER_REJECTED'
  | 'NO_SPEECH'
  | 'TIMEOUT'
  | 'FAILED';

const MESSAGES: Record<VoiceErrorCode, string> = {
  NOT_CONFIGURED: 'Voice transcription is not configured on this server. Type your idea instead.',
  UNSUPPORTED_TYPE: 'This recording format is not supported. Try another browser or type instead.',
  TOO_LARGE: 'The recording is too large. Keep it under 60 seconds.',
  TOO_LONG: 'Recordings are limited to 60 seconds. Try a shorter description.',
  EMPTY: 'Nothing was recorded. Check your microphone and try again.',
  INVALID: 'The recording could not be read. Try again.',
  BUSY: 'Another recording is still being transcribed. Wait a moment, then retry.',
  RATE_LIMITED: 'Too many recordings in a short time. Wait a minute or type instead.',
  PROVIDER_REJECTED:
    'The transcription provider refused the request. Check the server key, or type instead.',
  NO_SPEECH: 'No speech was detected. Speak closer to the microphone and try again.',
  TIMEOUT: 'Transcription took too long. Retry, or type instead.',
  FAILED: 'Transcription failed. Retry, or type instead — your text is unchanged.',
};

export const VOICE_HTTP_STATUS: Record<VoiceErrorCode, number> = {
  NOT_CONFIGURED: 503,
  UNSUPPORTED_TYPE: 415,
  TOO_LARGE: 413,
  TOO_LONG: 400,
  EMPTY: 400,
  INVALID: 400,
  BUSY: 429,
  RATE_LIMITED: 429,
  PROVIDER_REJECTED: 502,
  NO_SPEECH: 422,
  TIMEOUT: 504,
  FAILED: 502,
};

/** Typed voice failure: `message` is user-safe, `detail` is for logs only (never a key). */
export class VoiceError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    readonly detail: string = '',
  ) {
    super(MESSAGES[code]);
  }
}
