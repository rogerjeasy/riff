import { migrateDatabase } from './db/migrate.js';
import { parseEnv } from './env.js';

const environment = parseEnv(process.env);
migrateDatabase(environment.databasePath);
console.log('Database migrations applied.');
