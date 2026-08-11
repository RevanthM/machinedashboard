/**
 * Turning a host record into something you can connect to.
 *
 * PRD §4 calls the two-phase address the core design idea: bootstrap over the
 * address from the spreadsheet, then switch to the mesh address once the peer
 * is up. `activeAddress` is that rule in one place — every caller (probe,
 * provisioner, telemetry, terminal, RDP shim) goes through it, so no code path
 * can accidentally keep using a LAN IP after the mesh is live.
 */
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { hosts, type Host } from '../db/schema.js';
import type { SecretVault } from '../secrets/vault.js';
import type { OsFamily } from '../shell/escape.js';
import { makeTransport, type TransportPool } from '../transport/pool.js';
import type { SshTarget } from '../transport/ssh.js';
import type { Transport } from '../transport/types.js';

export interface ResolvedAddress {
  address: string;
  /** Which source won, for display and for debugging "why did it use that IP". */
  source: 'mesh' | 'inventory' | 'hostname';
}

/**
 * Prefer the mesh address, but only when the peer is actually connected — a
 * stale 100.x from a peer that has gone offline is worse than the LAN address,
 * because it fails slowly (timeout) rather than fast (connection refused).
 */
export function activeAddress(host: Host): ResolvedAddress | null {
  if (host.meshIp && host.meshStatus === 'connected') {
    return { address: host.meshIp, source: 'mesh' };
  }
  if (host.host) return { address: host.host, source: 'inventory' };
  // Last resort: let DNS/mDNS try. This is the path Mac mini #2 takes, since
  // the inventory records no address for it at all.
  if (host.hostname) return { address: host.hostname, source: 'hostname' };
  return null;
}

export class HostUnreachableError extends Error {
  constructor(readonly host: Host) {
    super(
      `${host.name} has no usable address: no connected mesh peer, no IP in the ` +
        `inventory, and no hostname to resolve. Add an address or enroll it in the mesh.`,
    );
    this.name = 'HostUnreachableError';
  }
}

export interface HostContext {
  db: Db;
  vault: SecretVault;
  pool: TransportPool;
}

/** Build the SSH target for a host, pulling credentials from the vault. */
export function buildSshTarget(host: Host, vault: SecretVault): SshTarget {
  const resolved = activeAddress(host);
  if (!resolved) throw new HostUnreachableError(host);

  const os: OsFamily = host.os ?? 'ubuntu';
  const sudoPassword = vault.get(host.id, 'sudo_password') ?? undefined;

  let auth: SshTarget['auth'];
  switch (host.authMethod) {
    case 'password': {
      const password = vault.get(host.id, 'ssh_password');
      if (!password) {
        throw new Error(
          `${host.name} is configured for password auth but no password is stored. ` +
            `Re-import with a Password column, or switch it to key auth.`,
        );
      }
      auth = { method: 'password', password };
      break;
    }
    case 'key': {
      if (!host.keyPath) {
        throw new Error(
          `${host.name} is configured for key auth but has no key path. ` +
            `Re-import with an SSH Private Key or Private Key Path column.`,
        );
      }
      const passphrase = vault.get(host.id, 'key_passphrase') ?? undefined;
      auth = { method: 'key', privateKeyPath: host.keyPath, passphrase };
      break;
    }
    case 'agent':
      auth = { method: 'agent' };
      break;
  }

  return {
    host: resolved.address,
    port: host.sshPort,
    username: host.username,
    os,
    auth,
    knownHostKey: host.knownHostKey,
    sudoPassword,
  };
}

/**
 * Get a pooled transport for a host.
 *
 * The pool key includes the resolved address, so a host that moves from its LAN
 * IP onto a mesh address gets a fresh connection instead of silently continuing
 * to use the old one.
 */
export async function getTransport(ctx: HostContext, host: Host): Promise<Transport> {
  const resolved = activeAddress(host);
  if (!resolved) throw new HostUnreachableError(host);

  const poolKey = `${host.id}@${resolved.address}:${host.sshPort}`;
  return ctx.pool.acquire(poolKey, host.name, () => {
    const target = buildSshTarget(host, ctx.vault);
    // TOFU: persist the key the first time we see it, so a later change is a
    // detectable event rather than another silent first-connect.
    target.onHostKeyLearned = (fingerprint) => {
      void ctx.db
        .update(hosts)
        .set({ knownHostKey: fingerprint, updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(hosts.id, host.id));
    };
    return makeTransport(host.isSelf, target);
  });
}

export async function loadHost(db: Db, hostId: string): Promise<Host> {
  const rows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
  const host = rows[0];
  if (!host) throw new Error(`No host with id ${hostId}`);
  return host;
}

export async function listHosts(db: Db): Promise<Host[]> {
  return db.select().from(hosts);
}

/**
 * Base URL for a host's Ollama API.
 *
 * The local host is reached over loopback rather than its mesh address. Ollama
 * binds 127.0.0.1 by default, and on the operator's own machine there is no
 * reason to require the `OLLAMA_HOST=0.0.0.0` override just to benchmark it —
 * going out to the mesh and back would fail against a stock install.
 */
export function ollamaUrl(host: Host): string | null {
  if (host.isSelf) return `http://127.0.0.1:${config.ollamaPort}`;
  const resolved = activeAddress(host);
  if (!resolved) return null;
  return `http://${resolved.address}:${config.ollamaPort}`;
}
