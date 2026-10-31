import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/** Open one owned connection; callers close it on shutdown or after a test. */
export interface DatabaseConnection {
  client: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export function openDatabase(path: string): DatabaseConnection {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path);
  try {
    client.pragma('foreign_keys = ON');
    client.pragma('busy_timeout = 1000');
    if (path !== ':memory:') client.pragma('journal_mode = WAL');
    return { client, db: drizzle(client, { schema }), close: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}
