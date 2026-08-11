/**
 * Inventory parsing (PRD §F1, reshaped by Appendix B).
 *
 * The spec's column set assumed a file written for this tool. The real file is
 * an ad-hoc spreadsheet, so the required set is narrowed to
 * `{name, host|hostname, username}` and everything else is defaulted. A row is
 * never rejected for a missing optional column — it is rejected only when we
 * genuinely cannot identify or reach the machine.
 *
 * Rows fail independently: one bad row never aborts the batch.
 */
import { hostname as localHostname } from 'node:os';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { OsFamily } from '../shell/escape.js';
import { normalizeHostname } from '../mesh/types.js';
import { looksLikePrivateKey } from './keys.js';

export interface ParsedRow {
  rowNumber: number;
  name: string;
  host: string | null;
  hostname: string | null;
  username: string;
  sshPort: number;
  os: OsFamily | null;
  osVersion: string | null;
  osKernel: string | null;
  authMethod: 'password' | 'key' | 'agent';
  keyPathHint: string | null;
  /** Present when the sheet carried an inline PEM body. Never persisted. */
  inlinePrivateKey: string | null;
  /**
   * Credential values lifted from the sheet. Held only long enough for the
   * commit step to move them into the vault, and stripped by the API layer
   * before any parse result crosses the wire.
   */
  secrets: {
    password: string | null;
    keyPassphrase: string | null;
    sudoPassword: string | null;
    rdpPassword: string | null;
  };
  publicKey: string | null;
  knownHostKey: string | null;
  rdpProtocol: 'rdp' | 'vnc';
  rdpPort: number;
  rdpUsername: string | null;
  tags: string[];
  enableOllama: boolean;
  netbirdSetupKey: string | null;
  notes: string | null;
  isSelf: boolean;
  /** Seed values from the sheet, replaced by live probing at provision time. */
  seedCpu: string | null;
  seedGpu: string | null;
  seedRam: string | null;
  errors: string[];
  warnings: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Header text as found, so the UI can offer remapping. */
  detectedColumns: string[];
  sheetName: string | null;
  /** Sheets we deliberately skipped, with the reason. */
  skippedSheets: Array<{ name: string; reason: string }>;
  hasInlineKeys: boolean;
}

/** Canonical field -> accepted header spellings, all compared normalised. */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'machine name', 'machine', 'display name', 'label'],
  host: ['host', 'lan ip', 'ip', 'ip address', 'address', 'lan address'],
  hostname: ['hostname', 'host name', 'dns name', 'fqdn'],
  username: ['username', 'user', 'ssh user', 'login'],
  sshPort: ['ssh port', 'port', 'sshport'],
  os: ['os', 'operating system', 'platform'],
  authMethod: ['auth method', 'auth', 'authentication'],
  password: ['password', 'ssh password'],
  privateKeyPath: ['private key path', 'key path', 'identity file'],
  privateKey: ['ssh private key', 'private key', 'privatekey'],
  publicKey: ['ssh public key', 'public key', 'publickey'],
  keyPassphrase: ['key passphrase', 'passphrase'],
  sudoPassword: ['sudo password', 'sudo'],
  hostKey: ['host key fingerprint', 'host key', 'fingerprint'],
  sshCommand: ['ssh command', 'command', 'connect command'],
  rdpPort: ['rdp port'],
  rdpUsername: ['rdp username', 'rdp user'],
  rdpPassword: ['rdp password'],
  tags: ['tags', 'labels'],
  netbirdSetupKey: ['netbird setup key', 'setup key'],
  enableOllama: ['enable ollama', 'ollama'],
  notes: ['notes', 'comment', 'comments'],
  cpu: ['cpu', 'processor'],
  gpu: ['gpu', 'graphics'],
  ram: ['ram', 'memory'],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function buildColumnMap(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(normalized) && !map.has(field)) {
        map.set(field, index);
        return;
      }
    }
  });
  return map;
}

/**
 * Reject transposed "card" sheets.
 *
 * The real workbook has a second sheet whose first column is a repeated list of
 * field names and whose header is a machine name. Parsing it as a table yields
 * five garbage hosts, so it is detected and skipped rather than silently
 * importing nonsense.
 */
function looksTransposed(rows: string[][]): boolean {
  const header = rows[0];
  if (!header || header.length > 3) return false;

  const firstColumn = rows.slice(1, 25).map((r) => normalizeHeader(String(r[0] ?? '')));
  const fieldNames = new Set(Object.values(COLUMN_ALIASES).flat());
  const hits = firstColumn.filter((v) => fieldNames.has(v)).length;
  return hits >= 4;
}

export function parseInventory(buffer: Buffer, filename: string): ParseResult {
  const isCsv = /\.csv$/i.test(filename);
  const skippedSheets: Array<{ name: string; reason: string }> = [];

  let grid: string[][] = [];
  let sheetName: string | null = null;

  if (isCsv) {
    const text = buffer.toString('utf8');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    grid = parsed.data;
  } else {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    for (const candidate of wb.SheetNames) {
      const sheet = wb.Sheets[candidate];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        defval: '',
        raw: false,
        blankrows: false,
      });
      if (rows.length < 2) {
        skippedSheets.push({ name: candidate, reason: 'no data rows' });
        continue;
      }
      if (looksTransposed(rows)) {
        skippedSheets.push({
          name: candidate,
          reason: 'looks like a transposed detail card, not a table',
        });
        continue;
      }
      grid = rows;
      sheetName = candidate;
      break;
    }
  }

  if (grid.length < 2) {
    return { rows: [], detectedColumns: [], sheetName, skippedSheets, hasInlineKeys: false };
  }

  const headers = (grid[0] ?? []).map((h) => String(h ?? '').trim());
  const columns = buildColumnMap(headers);
  const self = normalizeHostname(localHostname());

  const rows: ParsedRow[] = [];
  let hasInlineKeys = false;

  for (let i = 1; i < grid.length; i++) {
    const raw = grid[i];
    if (!raw || raw.every((c) => String(c ?? '').trim() === '')) continue;

    const cell = (field: string): string => {
      const index = columns.get(field);
      if (index === undefined) return '';
      return String(raw[index] ?? '').trim();
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    const name = cell('name');
    const hostnameValue = cell('hostname') || null;
    // The sheet uses an em dash for "not applicable"; treat it as empty.
    const hostRaw = cell('host');
    const host = hostRaw && hostRaw !== '—' && hostRaw !== '-' ? hostRaw : null;
    const username = cell('username');

    if (!name) errors.push('name is required');
    if (!username) errors.push('username is required');
    if (!host && !hostnameValue) {
      errors.push('needs a host address or a hostname to resolve');
    }
    if (!host && hostnameValue) {
      warnings.push(
        `no IP address — will try to resolve "${hostnameValue}". ` +
          'Add an address or ensure mDNS resolution works.',
      );
    }

    const sshCommand = cell('sshCommand');
    const hints = parseSshCommand(sshCommand);

    const { os, osVersion, osKernel } = normalizeOs(cell('os'));
    if (!os && cell('os')) {
      warnings.push(`unrecognised OS "${cell('os')}" — will detect on first connect`);
    }

    const inlineKey = cell('privateKey');
    const hasInline = Boolean(inlineKey) && looksLikePrivateKey(inlineKey);
    if (hasInline) hasInlineKeys = true;

    const keyPathHint = cell('privateKeyPath') || hints.identityFile || null;

    let authMethod: 'password' | 'key' | 'agent';
    const declared = normalizeHeader(cell('authMethod'));
    if (declared === 'password' || declared === 'key' || declared === 'agent') {
      authMethod = declared;
    } else if (hasInline || keyPathHint) {
      authMethod = 'key';
    } else if (cell('password')) {
      authMethod = 'password';
    } else {
      authMethod = 'agent';
      warnings.push('no credential in the sheet — defaulting to SSH agent auth');
    }

    const sshPort = toInt(cell('sshPort')) ?? hints.port ?? 22;
    const rdp = defaultRemoteDesktop(os);
    const rdpPort = toInt(cell('rdpPort')) ?? rdp.port;

    const isSelf = Boolean(
      (hostnameValue && normalizeHostname(hostnameValue) === self) ||
        (name && normalizeHostname(name) === self),
    );
    if (isSelf) {
      warnings.push(
        'this is the machine running Fleet Console — it will be managed locally, without SSH',
      );
    }

    rows.push({
      rowNumber: i + 1,
      name,
      host,
      hostname: hostnameValue,
      username,
      sshPort,
      os,
      osVersion,
      osKernel,
      authMethod,
      keyPathHint,
      inlinePrivateKey: hasInline ? inlineKey : null,
      secrets: {
        password: cell('password') || null,
        keyPassphrase: cell('keyPassphrase') || null,
        sudoPassword: cell('sudoPassword') || null,
        rdpPassword: cell('rdpPassword') || null,
      },
      publicKey: cell('publicKey') || null,
      knownHostKey: cleanOptional(cell('hostKey')),
      rdpProtocol: rdp.protocol,
      rdpPort,
      rdpUsername: cell('rdpUsername') || null,
      tags: cell('tags')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean),
      enableOllama: parseBool(cell('enableOllama'), true),
      netbirdSetupKey: cell('netbirdSetupKey') || null,
      notes: cell('notes') || null,
      isSelf,
      seedCpu: cleanOptional(cell('cpu')),
      seedGpu: cleanOptional(cell('gpu')),
      seedRam: cleanOptional(cell('ram')),
      errors,
      warnings,
    });
  }

  return {
    rows,
    detectedColumns: headers,
    sheetName,
    skippedSheets,
    hasInlineKeys,
  };
}

/**
 * Mine `ssh -i ~/.ssh/key -p 2222 user@host` for hints, then discard the rest.
 * The sheet's SSH Command column is the only place some rows record which key
 * to use.
 */
export function parseSshCommand(command: string): {
  identityFile: string | null;
  port: number | null;
  username: string | null;
  host: string | null;
} {
  if (!command) return { identityFile: null, port: null, username: null, host: null };

  const identity = /-i\s+(\S+)/.exec(command);
  const port = /-p\s+(\d+)/.exec(command);
  const target = /(?:^|\s)(?:([A-Za-z0-9._-]+)@)([A-Za-z0-9._-]+)\s*$/.exec(command);

  const identityFile = identity?.[1] ?? null;
  return {
    // Placeholder text like `<private_key_file>` is a hint that no key is known.
    identityFile: identityFile && !/^<.*>$/.test(identityFile) ? identityFile : null,
    port: port?.[1] ? Number.parseInt(port[1], 10) : null,
    username: target?.[1] ?? null,
    host: target?.[2] ?? null,
  };
}

/**
 * "Ubuntu 26.04 LTS (kernel 7.0.0-28-generic)" -> ubuntu / 26.04 LTS / 7.0.0-28-generic
 */
export function normalizeOs(value: string): {
  os: OsFamily | null;
  osVersion: string | null;
  osKernel: string | null;
} {
  const text = value.trim();
  if (!text) return { os: null, osVersion: null, osKernel: null };

  const kernel = /kernel\s+([^\s)]+)/i.exec(text)?.[1] ?? null;
  const withoutKernel = text.replace(/\(?\s*kernel\s+[^\s)]+\s*\)?/i, '').trim();
  const lower = withoutKernel.toLowerCase();

  let os: OsFamily | null = null;
  if (lower.includes('ubuntu')) os = 'ubuntu';
  else if (lower.includes('debian')) os = 'debian';
  else if (lower.includes('windows') || lower.includes('win')) os = 'windows';
  else if (lower.includes('macos') || lower.includes('mac os') || lower.includes('darwin')) {
    os = 'macos';
  }

  const version = withoutKernel
    .replace(/ubuntu|debian|windows|macos|mac os|darwin/gi, '')
    .trim()
    .replace(/^[-–—:,]\s*/, '');

  return { os, osVersion: version || null, osKernel: kernel };
}

/**
 * Windows Home has no RDP host and macOS uses Screen Sharing, so the default
 * protocol follows the OS (PRD §5 matrix). Windows edition is unknown until
 * detect_os runs; Pro is assumed and corrected then.
 */
function defaultRemoteDesktop(os: OsFamily | null): {
  protocol: 'rdp' | 'vnc';
  port: number;
} {
  if (os === 'macos') return { protocol: 'vnc', port: 5900 };
  return { protocol: 'rdp', port: 3389 };
}

function toInt(value: string): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBool(value: string, fallback: boolean): boolean {
  if (!value) return fallback;
  return /^(1|true|yes|y|on)$/i.test(value.trim());
}

function cleanOptional(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-' || trimmed === 'N/A') return null;
  return trimmed;
}
