import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db/client.js';
import { parseEnv, workspaceRoot } from './env.js';
import { createLoggerOptions } from './log.js';

const environment = parseEnv(process.env);
const database = openDatabase(environment.databasePath);
const webRoot = resolve(workspaceRoot, 'apps/web/dist');
try {
  const app = await createApp({
    checkDatabase: () => Boolean(database.client.prepare('SELECT 1').get()),
    logger: createLoggerOptions(environment.logLevel) ?? false,
    ...(existsSync(webRoot) ? { webRoot } : {}),
  });
  app.addHook('onClose', () => {
    database.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
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
