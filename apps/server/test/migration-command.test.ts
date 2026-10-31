import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { workspaceRoot } from '../src/env.js';

it('migrates a fresh nested database path through the public command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'riff-migration-command-'));
  const databasePath = join(directory, 'previously-absent', 'nested', 'riff.db');
  try {
    const result = spawnSync('pnpm', ['--filter', '@riff/server', 'db:migrate'], {
      cwd: workspaceRoot,
      env: { ...process.env, RIFF_DB_PATH: databasePath },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const database = openDatabase(databasePath);
    try {
      expect(database.client.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
