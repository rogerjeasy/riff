import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';

describe('SQLite connection', () => {
  it('applies committed migrations idempotently and persists schema-backed data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'riff-migrate-'));
    const path = join(directory, 'test.db');
    const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
    try {
      const first = openDatabase(path);
      try {
        migrate(first.db, { migrationsFolder });
        first.client
          .prepare('INSERT INTO channels (id, display_name, created_at) VALUES (?, ?, ?)')
          .run('test-channel', 'Test channel', 0);
      } finally {
        first.close();
      }
      const second = openDatabase(path);
      try {
        migrate(second.db, { migrationsFolder });
        expect(
          second.client
            .prepare('SELECT display_name FROM channels WHERE id = ?')
            .get('test-channel'),
        ).toEqual({ display_name: 'Test channel' });
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('persists a real file and closes cleanly', () => {
    const directory = mkdtempSync(join(tmpdir(), 'riff-db-'));
    try {
      const path = join(directory, 'nested', 'test.db');
      const first = openDatabase(path);
      try {
        first.client.exec('CREATE TABLE probe (value TEXT NOT NULL)');
        first.client.prepare('INSERT INTO probe VALUES (?)').run('persisted');
        expect(first.client.pragma('foreign_keys', { simple: true })).toBe(1);
      } finally {
        first.close();
      }
      const second = openDatabase(path);
      try {
        expect(second.client.prepare('SELECT value FROM probe').get()).toEqual({
          value: 'persisted',
        });
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
