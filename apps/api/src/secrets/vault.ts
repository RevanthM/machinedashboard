/**
 * Encrypted secret store.
 *
 * PRD §11 specifies "OS keychain via keytar, fallback AES-256-GCM file". We
 * implement the AES path as the primary store instead, because `keytar` was
 * archived by its maintainers in 2023, is an unmaintained native dependency,
 * and needs a compiler toolchain that this operator machine does not have.
 * Taking a dead native dependency for the happy path is a worse trade than
 * owning ~80 lines of well-understood crypto.
 *
 * Construction: scrypt(passphrase, per-vault random salt) -> 32-byte key.
 * Each secret gets a fresh 12-byte IV and its own GCM auth tag. The host id
 * and field name are bound in as additional authenticated data, so a ciphertext
 * cannot be moved from one host's password field to another's.
 *
 * The `SecretVault` interface is the seam — an OS-keychain implementation can
 * be added later without touching callers.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SecretField =
  | 'ssh_password'
  | 'key_passphrase'
  | 'sudo_password'
  | 'rdp_password';

export interface SecretVault {
  set(hostId: string, field: SecretField, value: string): void;
  get(hostId: string, field: SecretField): string | null;
  delete(hostId: string, field: SecretField): void;
  deleteHost(hostId: string): void;
  /** Every stored secret value, for the log scrubber to redact. */
  allValues(): string[];
}

interface VaultEntry {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  version: 1;
  salt: string;
  entries: Record<string, VaultEntry>;
}

const SCRYPT_COST = 2 ** 15;

export class AesFileVault implements SecretVault {
  private readonly key: Buffer;
  private file: VaultFile;

  constructor(
    private readonly path: string,
    passphrase: string,
  ) {
    if (!passphrase) {
      throw new Error('Refusing to open the vault without a passphrase.');
    }
    this.file = this.load();
    this.key = scryptSync(passphrase, Buffer.from(this.file.salt, 'base64'), 32, {
      N: SCRYPT_COST,
      maxmem: 128 * SCRYPT_COST * 8 * 2,
    });
    this.assertPassphraseCorrect();
  }

  set(hostId: string, field: SecretField, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.entryKey(hostId, field), 'utf8'));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.file.entries[this.entryKey(hostId, field)] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    this.persist();
  }

  get(hostId: string, field: SecretField): string | null {
    const entry = this.file.entries[this.entryKey(hostId, field)];
    if (!entry) return null;
    return this.decrypt(this.entryKey(hostId, field), entry);
  }

  delete(hostId: string, field: SecretField): void {
    delete this.file.entries[this.entryKey(hostId, field)];
    this.persist();
  }

  deleteHost(hostId: string): void {
    const prefix = `${hostId}:`;
    for (const key of Object.keys(this.file.entries)) {
      if (key.startsWith(prefix)) delete this.file.entries[key];
    }
    this.persist();
  }

  allValues(): string[] {
    const out: string[] = [];
    for (const [key, entry] of Object.entries(this.file.entries)) {
      if (key === SENTINEL_KEY) continue;
      try {
        out.push(this.decrypt(key, entry));
      } catch {
        // A single unreadable entry must not blind the scrubber to the rest.
      }
    }
    return out;
  }

  private decrypt(aad: string, entry: VaultEntry): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(entry.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private entryKey(hostId: string, field: SecretField): string {
    return `${hostId}:${field}`;
  }

  /**
   * A wrong passphrase yields a different key, which would otherwise surface as
   * a confusing GCM failure on the first unrelated read. Verifying a known
   * sentinel up front turns that into one clear error at startup.
   */
  private assertPassphraseCorrect(): void {
    const existing = this.file.entries[SENTINEL_KEY];
    if (!existing) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from(SENTINEL_KEY, 'utf8'));
      const data = Buffer.concat([
        cipher.update(SENTINEL_PLAINTEXT, 'utf8'),
        cipher.final(),
      ]);
      this.file.entries[SENTINEL_KEY] = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      };
      this.persist();
      return;
    }

    let decoded: string;
    try {
      decoded = this.decrypt(SENTINEL_KEY, existing);
    } catch {
      throw new Error(
        'FLEET_VAULT_PASSPHRASE does not match the existing vault. Fix the ' +
          `passphrase, or delete ${this.path} to start over (all stored secrets are lost).`,
      );
    }
    const a = Buffer.from(decoded);
    const b = Buffer.from(SENTINEL_PLAINTEXT);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('Vault sentinel mismatch; refusing to use this vault.');
    }
  }

  private load(): VaultFile {
    if (!existsSync(this.path)) {
      return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} };
    }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as VaultFile;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported vault version: ${String(parsed.version)}`);
    }
    return parsed;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // 0600 is honoured on POSIX; on Windows the file inherits the profile ACL,
    // which is already user-scoped under %USERPROFILE%.
    writeFileSync(this.path, JSON.stringify(this.file, null, 2), { mode: 0o600 });
  }
}

const SENTINEL_KEY = '__vault__:sentinel';
const SENTINEL_PLAINTEXT = 'fleet-console-vault-v1';

/** In-memory vault for tests. Never persists. */
export class MemoryVault implements SecretVault {
  private store = new Map<string, string>();
  set(hostId: string, field: SecretField, value: string) {
    this.store.set(`${hostId}:${field}`, value);
  }
  get(hostId: string, field: SecretField) {
    return this.store.get(`${hostId}:${field}`) ?? null;
  }
  delete(hostId: string, field: SecretField) {
    this.store.delete(`${hostId}:${field}`);
  }
  deleteHost(hostId: string) {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${hostId}:`)) this.store.delete(key);
    }
  }
  allValues() {
    return [...this.store.values()];
  }
}
