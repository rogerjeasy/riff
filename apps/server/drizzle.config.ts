import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { parseEnv, workspaceRoot } from './src/env.js';

const envPath = resolve(workspaceRoot, '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: parseEnv(process.env).databasePath },
  strict: true,
});
