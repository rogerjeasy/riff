import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from './client.js';

/** Apply committed migrations with the same path preparation and ownership as the host. */
export function migrateDatabase(databasePath: string): void {
  const database = openDatabase(databasePath);
  try {
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
    });
  } finally {
    database.close();
  }
}
