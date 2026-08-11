/**
 * Commit parsed inventory rows into the database (PRD §F1).
 *
 * The security-relevant part of this file is what it does *not* write. Nothing
 * that reaches the `hosts` table is a credential:
 *
 *   - inline PEM bodies are written to `<fleetHome>/keys/<name>.pem` at 0600
 *     and only the path is stored;
 *   - passwords, key passphrases, sudo passwords and RDP passwords go into the
 *     AES-GCM vault keyed by host id;
 *   - `no-secrets.test.ts` greps the raw DB file to keep that honest.
 *
 * Upserts on `name`, so re-importing a corrected sheet updates rather than
 * duplicating.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hosts, type NewHost } from '../db/schema.js';
import type { SecretVault } from '../secrets/vault.js';
import { writePrivateKey, type WrittenKey } from './keys.js';
import type { ParsedRow } from './parse.js';

export interface CommitOptions {
  db: Db;
  vault: SecretVault;
  keysDir: string;
  /** Row numbers the operator deselected in the preview. */
  skipRowNumbers?: number[];
}

export interface CommitedHost {
  rowNumber: number;
  hostId: string;
  name: string;
  action: 'created' | 'updated';
  keyWritten?: WrittenKey;
  warnings: string[];
}

export interface CommitResult {
  committed: CommitedHost[];
  skipped: Array<{ rowNumber: number; name: string; reason: string }>;
}

export async function commitInventory(
  rows: readonly ParsedRow[],
  opts: CommitOptions,
): Promise<CommitResult> {
  const { db, vault, keysDir } = opts;
  const skip = new Set(opts.skipRowNumbers ?? []);

  const committed: CommitedHost[] = [];
  const skipped: CommitResult['skipped'] = [];

  for (const row of rows) {
    if (skip.has(row.rowNumber)) {
      skipped.push({ rowNumber: row.rowNumber, name: row.name, reason: 'deselected' });
      continue;
    }
    // A row that failed validation is reported, never silently dropped — and
    // one bad row never aborts the batch.
    if (row.errors.length > 0) {
      skipped.push({
        rowNumber: row.rowNumber,
        name: row.name,
        reason: row.errors.join('; '),
      });
      continue;
    }

    const warnings: string[] = [];

    const existing = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.name, row.name))
      .limit(1);
    const hostId = existing[0]?.id ?? randomUUID();
    const action: 'created' | 'updated' = existing[0] ? 'updated' : 'created';

    // Extract the key first: if it is malformed we want to know before writing
    // a host record that points at a file that does not exist.
    let keyWritten: WrittenKey | undefined;
    let keyPath = row.keyPathHint;

    if (row.inlinePrivateKey) {
      try {
        keyWritten = writePrivateKey(keysDir, row.name, row.inlinePrivateKey);
        keyPath = keyWritten.path;
        if (!keyWritten.wasWellFormed) {
          warnings.push('inline private key was repaired before writing');
        }
        if (!keyWritten.validated && keyWritten.validationError) {
          warnings.push(`key not validated: ${keyWritten.validationError}`);
        }
      } catch (err) {
        skipped.push({
          rowNumber: row.rowNumber,
          name: row.name,
          reason: `inline private key is unusable: ${(err as Error).message}`,
        });
        continue;
      }
    }

    const record: NewHost = {
      id: hostId,
      name: row.name,
      host: row.host,
      hostname: row.hostname,
      sshPort: row.sshPort,
      os: row.os ?? undefined,
      osVersion: row.osVersion,
      username: row.username,
      authMethod: row.authMethod,
      keyPath,
      publicKey: row.publicKey,
      knownHostKey: row.knownHostKey,
      isSelf: row.isSelf,
      rdpProtocol: row.rdpProtocol,
      rdpPort: row.rdpPort,
      rdpUsername: row.rdpUsername ?? row.username,
      tags: row.tags,
      enableOllama: row.enableOllama,
      notes: row.notes,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    if (action === 'created') {
      await db.insert(hosts).values(record);
    } else {
      // Deliberately does not reset status/provisionState/mesh fields — those
      // are live state owned by the pollers, not by the spreadsheet.
      await db.update(hosts).set(record).where(eq(hosts.id, hostId));
    }

    storeSecrets(vault, hostId, row);

    committed.push({ rowNumber: row.rowNumber, hostId, name: row.name, action, keyWritten, warnings });
  }

  return { committed, skipped };
}

function storeSecrets(vault: SecretVault, hostId: string, row: ParsedRow): void {
  const { password, keyPassphrase, sudoPassword, rdpPassword } = row.secrets;
  if (password) vault.set(hostId, 'ssh_password', password);
  if (keyPassphrase) vault.set(hostId, 'key_passphrase', keyPassphrase);
  if (sudoPassword) vault.set(hostId, 'sudo_password', sudoPassword);
  if (rdpPassword) vault.set(hostId, 'rdp_password', rdpPassword);
}
