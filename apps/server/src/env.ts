import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const optional = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : null));
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    RIFF_HOST: z.enum(['127.0.0.1', '::1', 'localhost', '0.0.0.0']).default('127.0.0.1'),
    RIFF_ALLOW_REMOTE: z.enum(['true', 'false']).default('false'),
    RIFF_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    RIFF_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    RIFF_SERVER_URL: z.string().url().default('http://localhost:8787'),
    RIFF_DB_PATH: z.string().min(1).default('./data/riff.db'),
    /** mock = deterministic offline template compiler; codex = Codex SDK at runtime. */
    RIFF_COMPILER_MODE: z.enum(['mock', 'codex']).default('mock'),
    RIFF_COMPILER_MODEL: optional,
    RIFF_COMPILER_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
    RIFF_SECRET: optional,
    /** Hosted console sign-in. Unset locally: the console is then open on loopback. */
    RIFF_CONSOLE_PASSWORD: optional,
    RIFF_CONSOLE_ACCESS_TOKEN: optional,
    TWITCH_CLIENT_ID: optional,
    TWITCH_CLIENT_SECRET: optional,
    TWITCH_EVENTSUB_WS_URL: optional,
    TWITCH_HELIX_URL: optional,
    /** F09 push-to-talk transcription: off | mock | openai (default: openai when keyed). */
    RIFF_TRANSCRIPTION_MODE: z.preprocess(
      (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
      z.enum(['off', 'mock', 'openai']).optional(),
    ),
    OPENAI_API_KEY: optional,
    RIFF_TRANSCRIPTION_MODEL: optional,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .refine((value) => value.RIFF_HOST !== '0.0.0.0' || value.RIFF_ALLOW_REMOTE === 'true', {
    message:
      'Binding all interfaces requires RIFF_ALLOW_REMOTE=true; keep container ports on loopback.',
    path: ['RIFF_HOST'],
  })
  .refine((value) => !value.RIFF_CONSOLE_PASSWORD || value.RIFF_CONSOLE_PASSWORD.length >= 16, {
    message: 'RIFF_CONSOLE_PASSWORD must be at least 16 characters.',
    path: ['RIFF_CONSOLE_PASSWORD'],
  })
  .refine(
    (value) => !value.RIFF_CONSOLE_ACCESS_TOKEN || value.RIFF_CONSOLE_ACCESS_TOKEN.length >= 32,
    {
      message: 'RIFF_CONSOLE_ACCESS_TOKEN must be at least 32 characters.',
      path: ['RIFF_CONSOLE_ACCESS_TOKEN'],
    },
  )
  .refine((value) => value.RIFF_TRANSCRIPTION_MODE !== 'openai' || !!value.OPENAI_API_KEY, {
    message: 'RIFF_TRANSCRIPTION_MODE=openai requires OPENAI_API_KEY.',
    path: ['RIFF_TRANSCRIPTION_MODE'],
  })
  .refine((value) => !value.RIFF_SECRET || value.RIFF_SECRET.length >= 32, {
    message: 'RIFF_SECRET must be at least 32 characters (try: openssl rand -base64 32).',
    path: ['RIFF_SECRET'],
  });

export function parseEnv(input: Record<string, string | undefined>) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`);
    throw new Error(`Invalid server configuration: ${fields.join('; ')}`);
  }
  const env = result.data;
  return {
    environment: env.NODE_ENV,
    host: env.RIFF_HOST,
    port: env.RIFF_PORT,
    publicUrl: env.RIFF_PUBLIC_URL.replace(/\/$/, ''),
    databasePath: resolve(workspaceRoot, env.RIFF_DB_PATH),
    compilerMode: env.RIFF_COMPILER_MODE,
    compilerModel: env.RIFF_COMPILER_MODEL,
    compilerEffort: env.RIFF_COMPILER_EFFORT,
    secret: env.RIFF_SECRET,
    console: {
      password: env.RIFF_CONSOLE_PASSWORD,
      accessToken: env.RIFF_CONSOLE_ACCESS_TOKEN,
    },
    twitch:
      env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET
        ? {
            clientId: env.TWITCH_CLIENT_ID,
            clientSecret: env.TWITCH_CLIENT_SECRET,
            redirectUri: `${env.RIFF_SERVER_URL.replace(/\/$/, '')}/auth/twitch/callback`,
            eventSubUrl: env.TWITCH_EVENTSUB_WS_URL,
            helixBaseUrl: env.TWITCH_HELIX_URL,
          }
        : null,
    transcription: {
      mode: env.RIFF_TRANSCRIPTION_MODE ?? (env.OPENAI_API_KEY ? 'openai' : 'off'),
      apiKey: env.OPENAI_API_KEY,
      model: env.RIFF_TRANSCRIPTION_MODEL ?? 'gpt-transcribe',
    },
    logLevel: env.LOG_LEVEL,
  };
}
