import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(path: string = config.dbPath) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);

  // WAL keeps the 15s telemetry writer from blocking dashboard reads.
  sqlite.pragma('journal_mode = WAL');
  // The schema declares onDelete: cascade; SQLite ignores it unless asked.
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = join(here, '..', '..', 'drizzle');
  migrate(db, { migrationsFolder });

  return { sqlite, db };
}

let singleton: ReturnType<typeof createDb> | null = null;

export function getDb() {
  singleton ??= createDb();
  return singleton;
}
