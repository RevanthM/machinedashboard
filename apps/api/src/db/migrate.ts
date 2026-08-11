import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { createDb } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');

const { db, sqlite } = createDb();
migrate(db, { migrationsFolder });
sqlite.close();

console.log(`Migrations applied to ${config.dbPath}`);
