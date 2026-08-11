/**
 * Handling for private keys pasted inline into the inventory (Appendix B.1).
 *
 * Two things are true about the real file and they are often confused:
 *
 *  1. The keys are *compromised* — they lived unencrypted in a shared
 *     spreadsheet. Rotation is the operator's job and this module cannot do it.
 *     `INLINE_KEY_WARNING` is surfaced prominently on the import screen.
 *
 *  2. The keys are *not necessarily mangled*. Appendix B.1 asserts Excel
 *     collapsed the PEM newlines into double-spaces. In the actual workbook the
 *     bodies carry real newlines and no double-spaces, so the prescribed
 *     re-wrap would be repairing damage that is not there. `repairPemBody`
 *     therefore normalises whatever it is handed and is a no-op on well-formed
 *     input, rather than assuming one specific corruption.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INLINE_KEY_WARNING =
  'This inventory contains unencrypted private keys. They should be treated as ' +
  'compromised: rotate them (generate new ed25519 pairs, install the new public ' +
  'keys, remove the old ones from authorized_keys) before relying on this fleet. ' +
  'Fleet Console has written them to disk with restrictive permissions and stores ' +
  'only their paths, but it cannot un-share a key.';

const PEM_HEADER_RE = /-----BEGIN ([A-Z0-9 ]+?) PRIVATE KEY-----/;
const PEM_FOOTER_RE = /-----END ([A-Z0-9 ]+?) PRIVATE KEY-----/;

export interface PemRepairResult {
  pem: string;
  /** True when the input was already correctly formed. */
  wasWellFormed: boolean;
  keyType: string;
}

/**
 * Normalise a PEM private key body to canonical form: header, base64 wrapped at
 * 70 columns, footer, trailing newline.
 *
 * Accepts input whose body newlines have been replaced by spaces, double
 * spaces, tabs, or CRLF — all of which spreadsheet round-trips produce — and
 * input that is already correct.
 */
export function repairPemBody(raw: string): PemRepairResult {
  const text = raw.trim();

  const header = PEM_HEADER_RE.exec(text);
  const footer = PEM_FOOTER_RE.exec(text);
  if (!header || !footer) {
    throw new Error('Not a PEM private key: missing BEGIN/END markers.');
  }
  if (header[1] !== footer[1]) {
    throw new Error(`PEM header/footer mismatch: ${header[1]} vs ${footer[1]}.`);
  }

  const keyType = header[1]!;
  const bodyStart = text.indexOf(header[0]) + header[0].length;
  const bodyEnd = text.indexOf(footer[0]);
  const body = text.slice(bodyStart, bodyEnd);

  // Strip every whitespace form; whatever remains must be the base64 payload.
  const compact = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(compact)) {
    throw new Error('PEM body contains characters that are not valid base64.');
  }

  // Round-trip through the decoder: a truncated body still matches the charset
  // test above but will not survive this.
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.length === 0) {
    throw new Error('PEM body decoded to zero bytes.');
  }
  if (decoded.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new Error('PEM body is not canonical base64 — it looks truncated or altered.');
  }

  const wrapped = compact.match(/.{1,70}/g)?.join('\n') ?? compact;
  const pem = `${header[0]}\n${wrapped}\n${footer[0]}\n`;

  return { pem, wasWellFormed: text.replace(/\r\n/g, '\n') + '\n' === pem, keyType };
}

export interface WrittenKey {
  path: string;
  keyType: string;
  wasWellFormed: boolean;
  /** Whether `ssh-keygen -y` could derive a public key from it. */
  validated: boolean;
  validationError?: string;
}

/**
 * Write a repaired key to `<keysDir>/<name>.pem` with 0600 and verify it.
 *
 * Only the path is ever persisted to SQLite; the body stays on disk under the
 * operator's profile.
 */
export function writePrivateKey(
  keysDir: string,
  hostName: string,
  rawKey: string,
): WrittenKey {
  const { pem, wasWellFormed, keyType } = repairPemBody(rawKey);

  mkdirSync(keysDir, { recursive: true });
  const path = join(keysDir, `${safeFileName(hostName)}.pem`);
  writeFileSync(path, pem, { mode: 0o600 });
  try {
    // Redundant on POSIX where the mode above applies; harmless on Windows,
    // where ACL inheritance from the user profile is what actually protects it.
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }

  const validation = validateWithSshKeygen(path);
  return { path, keyType, wasWellFormed, ...validation };
}

/**
 * Ask OpenSSH whether the key is usable. Present on all three target OSes and
 * on Windows since the OpenSSH client feature. If the binary is missing we
 * report unvalidated rather than failing the import — the structural checks in
 * `repairPemBody` have already run.
 */
function validateWithSshKeygen(path: string): {
  validated: boolean;
  validationError?: string;
} {
  try {
    execFileSync('ssh-keygen', ['-y', '-P', '', '-f', path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { validated: true };
  } catch (err) {
    const message = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message);
    if (/not recognized|ENOENT|not found/i.test(message)) {
      return { validated: false, validationError: 'ssh-keygen unavailable; skipped validation.' };
    }
    // A passphrase-protected key fails `-P ''` — that is a valid key, not a
    // broken one, and the operator supplies the passphrase separately.
    if (/incorrect passphrase|load failed/i.test(message)) {
      return { validated: false, validationError: 'Key appears passphrase-protected.' };
    }
    return { validated: false, validationError: message.split('\n')[0] };
  }
}

export function looksLikePrivateKey(value: string): boolean {
  return PEM_HEADER_RE.test(value);
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'host';
}
