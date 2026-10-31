import assert from 'node:assert/strict';
import { createApp } from '../apps/server/src/app.js';
import { openDatabase } from '../apps/server/src/db/client.js';

const database = openDatabase(':memory:');
const app = await createApp({
  checkDatabase: () => Boolean(database.client.prepare('SELECT 1').get()),
  logger: false,
});
try {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ mode: string }>().mode, 'studio');
  console.log('Smoke passed: Fastify → SQLite → health response.');
} finally {
  await app.close();
  database.close();
}
