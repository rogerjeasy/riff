import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { VOICE_HTTP_STATUS, VOICE_LIMITS, VoiceError } from '../services/voice/contract.js';
import type { VoiceService } from '../services/voice/service.js';

const durationHeader = z.coerce
  .number()
  .int()
  .min(0)
  .max(VOICE_LIMITS.maxDurationMs * 2);

/**
 * Push-to-talk upload: a raw `audio/*` body (no multipart dependency) bounded by a
 * route-scoped body limit. The global same-origin + `x-riff-request` guard and optional
 * console session apply because this lives under `/api/`.
 */
export function registerVoiceRoutes(app: FastifyInstance, service: VoiceService) {
  app.get('/api/voice', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { voice: service.status() };
  });
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      /^audio\//,
      { parseAs: 'buffer', bodyLimit: VOICE_LIMITS.maxBytes },
      (_request, body, done) => done(null, body),
    );
    scope.setErrorHandler((error: { statusCode?: number; code?: string }, request, reply) => {
      if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        const voice = new VoiceError('TOO_LARGE');
        return reply.code(413).send({ code: voice.code, message: voice.message });
      }
      if (error.statusCode === 415 || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        const voice = new VoiceError('UNSUPPORTED_TYPE');
        return reply.code(415).send({ code: voice.code, message: voice.message });
      }
      request.log.warn({ code: error.code }, 'voice upload rejected');
      return reply.code(400).send({ code: 'INVALID', message: new VoiceError('INVALID').message });
    });
    scope.post(
      '/api/voice/transcribe',
      { bodyLimit: VOICE_LIMITS.maxBytes },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const duration = durationHeader.safeParse(request.headers['x-riff-audio-duration-ms']);
        if (!Buffer.isBuffer(request.body) || !duration.success)
          return reply
            .code(400)
            .send({ code: 'INVALID', message: 'Send the recording with its duration.' });
        const controller = new AbortController();
        request.raw.once('close', () => {
          if (!reply.sent) controller.abort();
        });
        try {
          const transcript = await service.transcribe({
            audio: request.body,
            mimeType: request.headers['content-type'] ?? '',
            durationMs: duration.data,
            signal: controller.signal,
          });
          return { transcript };
        } catch (error) {
          const voice = error instanceof VoiceError ? error : new VoiceError('FAILED');
          // Log only the code and safe detail; never audio, transcript or credentials.
          request.log.warn({ code: voice.code, detail: voice.detail }, 'transcription failed');
          return reply
            .code(VOICE_HTTP_STATUS[voice.code])
            .send({ code: voice.code, message: voice.message });
        }
      },
    );
  });
}
