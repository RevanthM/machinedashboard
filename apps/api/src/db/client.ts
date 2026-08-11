import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

let singleton: ReturnType<typeof createDb> | null = null;

export function getDb() {
  singleton ??= createDb();
  return singleton;
}
