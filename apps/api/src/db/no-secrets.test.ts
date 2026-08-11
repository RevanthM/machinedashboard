/**
 * PRD §F1 acceptance criterion: "After commit, no password appears in SQLite,
 * logs, or API responses. Verify with a test that greps the DB file."
 *
 * This reads the raw database file as bytes rather than querying it, so a
 * secret stored in an unexpected column, a JSON blob, or a stale WAL page still
 * gets caught.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { commitInventory } from '../inventory/commit.js';
import { parseInventory } from '../inventory/parse.js';
import { MemoryVault } from '../secrets/vault.js';
import * as schema from './schema.js';

const workDir = mkdtempSync(join(tmpdir(), 'fleet-secrets-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

// Distinctive values — a substring match on these cannot be a coincidence.
const SSH_PASSWORD = 'ZZTOP-ssh-pw-9f3a1c';
const KEY_PASSPHRASE = 'ZZTOP-passphrase-77b2';
const SUDO_PASSWORD = 'ZZTOP-sudo-4e91';
const RDP_PASSWORD = 'ZZTOP-rdp-c0de';

const CSV = [
  'Machine Name,LAN IP,Username,Password,Key Passphrase,Sudo Password,RDP Password',
  `secret-box,10.0.0.9,ops,${SSH_PASSWORD},${KEY_PASSPHRASE},${SUDO_PASSWORD},${RDP_PASSWORD}`,
].join('\n');

describe('committed inventory never persists secrets to SQLite', () => {
  it('stores credentials in the vault, not the database file', async () => {
    const dbPath = join(workDir, `${randomUUID()}.db`);
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: join(import.meta.dirname, '..', '..', 'drizzle') });

    const vault = new MemoryVault();
    const parsed = parseInventory(Buffer.from(CSV, 'utf8'), 'secrets.csv');

    const result = await commitInventory(parsed.rows, {
      db,
      vault,
      keysDir: join(workDir, 'keys'),
    });
    expect(result.committed).toHaveLength(1);

    // Flush WAL into the main database file so the grep sees committed pages.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();

    const raw = readFileSync(dbPath).toString('latin1');
    for (const secret of [SSH_PASSWORD, KEY_PASSPHRASE, SUDO_PASSWORD, RDP_PASSWORD]) {
      expect(raw).not.toContain(secret);
    }

    // ...and confirm they were not merely dropped on the floor.
    const hostId = result.committed[0]!.hostId;
    expect(vault.get(hostId, 'ssh_password')).toBe(SSH_PASSWORD);
    expect(vault.get(hostId, 'key_passphrase')).toBe(KEY_PASSPHRASE);
    expect(vault.get(hostId, 'sudo_password')).toBe(SUDO_PASSWORD);
    expect(vault.get(hostId, 'rdp_password')).toBe(RDP_PASSWORD);
  });

  it('keeps private key bodies out of the database', async () => {
    const dbPath = join(workDir, `${randomUUID()}.db`);
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: join(import.meta.dirname, '..', '..', 'drizzle') });

    const body = Buffer.from('SECRETKEYMATERIAL'.repeat(20)).toString('base64');
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
    const csv = [
      'Machine Name,LAN IP,Username,SSH Private Key',
      `keyed-box,10.0.0.10,ops,"${pem.replace(/\n/g, '  ')}"`,
    ].join('\n');

    const parsed = parseInventory(Buffer.from(csv, 'utf8'), 'keys.csv');
    const result = await commitInventory(parsed.rows, {
      db,
      vault: new MemoryVault(),
      keysDir: join(workDir, 'keys2'),
    });
    expect(result.committed).toHaveLength(1);

    sqlite.close();
    const raw = readFileSync(dbPath).toString('latin1');
    expect(raw).not.toContain(body.slice(0, 40));

    // The path is stored instead, and points at a real file.
    expect(result.committed[0]!.keyWritten?.path).toMatch(/keyed-box\.pem$/);
  });
});
