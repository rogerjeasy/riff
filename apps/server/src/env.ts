import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    RIFF_HOST: z.enum(['127.0.0.1', '::1', 'localhost', '0.0.0.0']).default('127.0.0.1'),
    RIFF_ALLOW_REMOTE: z.enum(['true', 'false']).default('false'),
    RIFF_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    RIFF_DB_PATH: z.string().min(1).default('./data/riff.db'),
    RIFF_COMPILER_MODE: z.literal('mock').default('mock'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .refine((value) => value.RIFF_HOST !== '0.0.0.0' || value.RIFF_ALLOW_REMOTE === 'true', {
    message:
      'Binding all interfaces requires RIFF_ALLOW_REMOTE=true; keep container ports on loopback.',
    path: ['RIFF_HOST'],
  });

export function parseEnv(input: Record<string, string | undefined>) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`);
    throw new Error(`Invalid server configuration: ${fields.join('; ')}`);
  }
  return {
    environment: result.data.NODE_ENV,
    host: result.data.RIFF_HOST,
    port: result.data.RIFF_PORT,
    databasePath: resolve(workspaceRoot, result.data.RIFF_DB_PATH),
    compilerMode: result.data.RIFF_COMPILER_MODE,
    logLevel: result.data.LOG_LEVEL,
  };
}
