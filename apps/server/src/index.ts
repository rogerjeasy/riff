import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, migrateConnection } from './app.js';
import { openDatabase } from './db/client.js';
import { parseEnv, workspaceRoot } from './env.js';
import { createLoggerOptions } from './log.js';
import { createCodexTransport } from './services/authoring/codex-transport.js';
import { createOfflineTransport } from '@riff/compiler';

const environment = parseEnv(process.env);
const database = openDatabase(environment.databasePath);
const webRoot = resolve(workspaceRoot, 'apps/web/dist');
try {
  // Committed migrations are applied at boot so a fresh checkout runs from the README.
  migrateConnection(database);
  const app = await createApp({
    checkDatabase: () => Boolean(database.client.prepare('SELECT 1').get()),
    logger: createLoggerOptions(environment.logLevel) ?? false,
    database,
    publicUrl: environment.publicUrl,
    secret: environment.secret,
    console: environment.console,
    twitch: environment.twitch,
    transport:
      environment.compilerMode === 'codex'
        ? createCodexTransport({
            model: environment.compilerModel,
            reasoningEffort: environment.compilerEffort,
          })
        : createOfflineTransport({ delayMs: 400 }),
    ...(existsSync(webRoot) ? { webRoot } : {}),
  });
  app.addHook('onClose', () => {
    database.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // Graceful close first; never let a lingering socket keep the process alive.
      setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    await app.listen({ host: environment.host, port: environment.port });
  } catch (error) {
    await app.close();
    throw error;
  }
} catch (error) {
  if (database.client.open) database.close();
  throw error;
}
