import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVENT_TRIGGER_NAMES, type EventTriggerName } from '@riff/twitch';
import type { TwitchConnection } from '../services/twitch/connection.js';

// `?triggers=cheer,raid` asks for consent to extra event families (F19).
const authorizeQuery = z
  .object({
    triggers: z
      .string()
      .max(200)
      .optional()
      .transform((value, ctx) => {
        const names = (value ?? '').split(',').filter(Boolean);
        for (const name of names)
          if (!(EVENT_TRIGGER_NAMES as readonly string[]).includes(name)) {
            ctx.addIssue({ code: 'custom', message: `Unknown trigger ${name}` });
            return z.NEVER;
          }
        return [...new Set(names)] as EventTriggerName[];
      }),
  })
  .strip();

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export function registerTwitchRoutes(
  app: FastifyInstance,
  deps: { twitch: TwitchConnection; publicUrl: string },
) {
  app.get('/auth/twitch', async (request, reply) => {
    if (!deps.twitch.configured)
      return reply
        .code(503)
        .type('text/plain')
        .send(
          'Twitch is not configured. Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and RIFF_SECRET.',
        );
    // F19 event-family consent: ?triggers=cheer,raid (unknown families are refused).
    const query = authorizeQuery.safeParse(request.query);
    if (!query.success)
      return reply
        .code(400)
        .type('text/plain')
        .send('Unknown Twitch event family. Start again from the Riff console.');
    // Native feature consent (F21/F23) is granted one feature at a time: ?feature=polls
    const native = z
      .object({ feature: z.enum(['polls', 'announcements', 'shoutouts']).optional() })
      .safeParse(request.query);
    if (!native.success)
      return reply.code(400).type('text/plain').send('Unknown Twitch feature. Nothing changed.');
    // Optional feature consent (F22): ?features=channel-points,predictions
    const features = z
      .object({
        features: z
          .string()
          .max(64)
          .transform((v) => v.split(',').filter(Boolean))
          .pipe(z.array(z.enum(['channel-points', 'predictions'])).max(2))
          .optional(),
      })
      .safeParse(request.query);
    return reply.redirect(
      deps.twitch.beginAuthorization(
        [
          ...(features.success ? (features.data.features ?? []) : []),
          ...(native.data.feature ? [native.data.feature] : []),
        ],
        query.data.triggers,
      ),
    );
  });
  app.get('/api/twitch/triggers', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { configured: deps.twitch.configured, triggers: deps.twitch.triggers() };
  });
  app.get('/auth/twitch/callback', async (request, reply) => {
    const query = z
      .object({
        code: z.string().max(200).optional(),
        state: z.string().max(200),
        error: z.string().max(100).optional(),
      })
      .safeParse(request.query);
    const page = (title: string, body: string) =>
      reply
        .type('text/html')
        .header('Cache-Control', 'no-store')
        .send(
          `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;background:#0f0e14;color:#f4f2ff;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:420px;text-align:center"><h1 style="font-size:22px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a style="color:#ffb37a" href="${escapeHtml(deps.publicUrl)}/">Return to Riff</a></p></main>`,
        );
    if (!query.success || !query.data.code || query.data.error)
      return page(
        'Twitch was not connected',
        'Authorization was cancelled or invalid. Nothing changed.',
      );
    try {
      const login = await deps.twitch.completeAuthorization(query.data.code, query.data.state);
      return reply.redirect(
        `${deps.publicUrl}/?twitch=connected&login=${encodeURIComponent(login ?? '')}`,
      );
    } catch (error) {
      return page(
        'Twitch was not connected',
        error instanceof Error ? error.message : 'Try again from Riff.',
      );
    }
  });
  app.post('/api/twitch/disconnect', async () => {
    deps.twitch.disconnect();
    return { ok: true };
  });
}
