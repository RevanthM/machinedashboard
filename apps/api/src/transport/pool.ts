/**
 * Transport pool (R-06).
 *
 * The telemetry loop polls every host every 15s. Opening an SSH connection per
 * poll would mean a full TCP + KEX + auth handshake every time — on a 5-host
 * fleet that is 20 handshakes a minute, and each one shows up in the target's
 * auth log. Connections are therefore created once and reused.
 *
 * PRD §14 names the failure mode this guards against: "Long-lived SSH pool
 * leaks / zombie sessions". Three mitigations, all here:
 *   - keepalive on the ssh2 client (see ssh.ts) detects dead peers;
 *   - idle entries are reaped on a timer;
 *   - a hard cap bounds total entries so a runaway import cannot exhaust fds.
 *
 * `/api/debug/pool` exposes the live state, as the PRD requires.
 */
import { LocalTransport } from './local.js';
import { SshTransport, type SshTarget } from './ssh.js';
import type { Transport } from './types.js';

export interface PoolOptions {
  /** Close connections unused for this long. */
  idleMs?: number;
  /** Maximum simultaneous entries. */
  maxEntries?: number;
  sweepMs?: number;
}

interface Entry {
  transport: Transport;
  lastUsedAt: number;
  createdAt: number;
  useCount: number;
  hostName: string;
}

export interface PoolStats {
  size: number;
  maxEntries: number;
  idleMs: number;
  entries: Array<{
    hostId: string;
    hostName: string;
    kind: 'ssh' | 'local';
    ageMs: number;
    idleMs: number;
    useCount: number;
  }>;
}

export class TransportPool {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly maxEntries: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(opts: PoolOptions = {}) {
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 64;
    this.sweeper = setInterval(() => void this.reapIdle(), opts.sweepMs ?? 60_000);
    this.sweeper.unref();
  }

  /**
   * Fetch or create the transport for a host.
   *
   * `factory` is only invoked on a miss, so callers can build an SshTarget
   * lazily — resolving a mesh address and reading the vault costs more than a
   * map lookup.
   */
  async acquire(
    hostId: string,
    hostName: string,
    factory: () => Transport | Promise<Transport>,
  ): Promise<Transport> {
    const existing = this.entries.get(hostId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.useCount += 1;
      return existing.transport;
    }

    if (this.entries.size >= this.maxEntries) {
      await this.evictLeastRecentlyUsed();
    }

    const transport = await factory();
    this.entries.set(hostId, {
      transport,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      useCount: 1,
      hostName,
    });
    return transport;
  }

  /**
   * Drop a host's connection. Called when its address changes (a mesh peer
   * coming up rewrites the active address) or after an auth failure, so the
   * next acquire rebuilds against current facts rather than reusing a
   * connection to the old address.
   */
  async invalidate(hostId: string): Promise<void> {
    const entry = this.entries.get(hostId);
    if (!entry) return;
    this.entries.delete(hostId);
    await entry.transport.dispose().catch(() => undefined);
  }

  stats(): PoolStats {
    const now = Date.now();
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      idleMs: this.idleMs,
      entries: [...this.entries.entries()].map(([hostId, e]) => ({
        hostId,
        hostName: e.hostName,
        kind: e.transport.kind,
        ageMs: now - e.createdAt,
        idleMs: now - e.lastUsedAt,
        useCount: e.useCount,
      })),
    };
  }

  async disposeAll(): Promise<void> {
    clearInterval(this.sweeper);
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.transport.dispose().catch(() => undefined)));
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    for (const [hostId, entry] of this.entries) {
      // The local transport holds nothing open, so reaping it is pointless
      // churn — it would just be recreated on the next telemetry tick.
      if (entry.transport.kind === 'local') continue;
      if (entry.lastUsedAt < cutoff) {
        this.entries.delete(hostId);
        await entry.transport.dispose().catch(() => undefined);
      }
    }
  }

  private async evictLeastRecentlyUsed(): Promise<void> {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [hostId, entry] of this.entries) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestId = hostId;
      }
    }
    if (oldestId) await this.invalidate(oldestId);
  }
}

/** Build the right transport for a host record. */
export function makeTransport(
  isSelf: boolean,
  target: SshTarget,
): Transport {
  return isSelf ? new LocalTransport(target.os) : new SshTransport(target);
}
