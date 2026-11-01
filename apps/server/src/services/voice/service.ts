import {
  baseMimeType,
  sanitizeTranscript,
  VOICE_LIMITS,
  VOICE_MIME_TYPES,
  VoiceError,
  type Transcript,
  type VoiceStatus,
} from './contract.js';
import type { TranscriptionTransport } from './transport.js';

export { VoiceError } from './contract.js';

/**
 * Push-to-talk transcription. Audio lives only in this request's memory: it is never
 * written to disk, the database or logs, and only the sanitized transcript returns.
 * The creator reviews and edits that text before anything is compiled.
 */
export function createVoiceService(options: {
  transport: TranscriptionTransport | null;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const recent: number[] = [];
  let inFlight = false;
  return {
    status(): VoiceStatus {
      return {
        provider: options.transport?.kind ?? 'none',
        maxDurationMs: VOICE_LIMITS.maxDurationMs,
        maxBytes: VOICE_LIMITS.maxBytes,
        mimeTypes: Object.keys(VOICE_MIME_TYPES),
      };
    },
    async transcribe(input: {
      audio: Buffer;
      mimeType: string;
      durationMs: number;
      signal?: AbortSignal;
    }): Promise<Transcript> {
      const transport = options.transport;
      if (!transport) throw new VoiceError('NOT_CONFIGURED');
      const mimeType = baseMimeType(input.mimeType);
      if (!mimeType) throw new VoiceError('UNSUPPORTED_TYPE');
      if (input.audio.length === 0) throw new VoiceError('EMPTY');
      if (input.audio.length > VOICE_LIMITS.maxBytes) throw new VoiceError('TOO_LARGE');
      if (!Number.isInteger(input.durationMs) || input.durationMs < 0)
        throw new VoiceError('INVALID');
      // The client-reported duration is advisory (the host never decodes audio); the
      // byte cap above is the enforced bound. A small allowance covers timer rounding.
      if (input.durationMs > VOICE_LIMITS.maxDurationMs + 1500) throw new VoiceError('TOO_LONG');
      if (inFlight) throw new VoiceError('BUSY');
      const at = now();
      while ((recent[0] ?? Infinity) <= at - 60_000) recent.shift();
      if (recent.length >= VOICE_LIMITS.perMinute) throw new VoiceError('RATE_LIMITED');
      recent.push(at);
      inFlight = true;
      try {
        const result = await transport.transcribe({
          audio: input.audio,
          mimeType,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const text = sanitizeTranscript(result.text);
        if (!text) throw new VoiceError('NO_SPEECH');
        return {
          text,
          provider: transport.kind,
          durationMs: Math.min(input.durationMs, VOICE_LIMITS.maxDurationMs),
        };
      } catch (error) {
        if (error instanceof VoiceError) throw error;
        throw new VoiceError('FAILED', (error as Error)?.name ?? 'unknown');
      } finally {
        inFlight = false;
      }
    },
  };
}
export type VoiceService = ReturnType<typeof createVoiceService>;
