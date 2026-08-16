/**
 * Telemetry loop (R-15, N-09).
 *
 * Polls every host on an interval over the pooled connection and pushes samples
 * to subscribers as one multiplexed stream.
 *
 * The CPU budget (N-09: under 5% of the operator's CPU with 10 hosts) is met by
 * doing as little as possible per tick: hosts are polled concurrently but each
 * runs a single short script, samples are written in one batched transaction,
 * and retention pruning runs on a much slower cadence than collection.
 *
 * Hosts that fail are skipped with backoff rather than retried tightly — an
 * asleep laptop must not cost a connection attempt every 15 seconds.
 */
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hostMetrics, hostSpecs, hosts, type Host } from '../db/schema.js';
import type { Transport } from '../transport/types.js';
import { collectMetrics, resetCounters, type Sample } from './metrics.js';
import { collectSpecs } from './specs.js';

export interface TelemetryEvent {
  type: 'telemetry';
  hostId: string;
  sample: Sample;
  ts: number;
}

export interface PollerOptions {
  db: Db;
  intervalMs: number;
  getTransport(host: Host): Promise<Transport>;
  onSample(event: TelemetryEvent): void;
  onError?(hostId: string, err: unknown): void;
  /** Rolling window for host_metrics. */
  retentionMs?: number;
}

interface Backoff {
  failures: number;
  nextAttemptAt: number;
}

export class TelemetryPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly backoff = new Map<string, Backoff>();
  private lastPrune = 0;

  constructor(private readonly opts: PollerOptions) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Clear a host's backoff, e.g. after a successful manual probe. */
  reset(hostId: string): void {
    this.backoff.delete(hostId);
    resetCounters(hostId);
  }

  private async tick(): Promise<void> {
    // Skip rather than overlap: a slow fleet must not stack ticks.
    if (this.running) return;
    this.running = true;

    try {
      const rows = await this.opts.db.select().from(hosts);
      const now = Date.now();

      const due = rows.filter((host) => {
        if (host.provisionState === 'unprovisioned' && host.status === 'unknown') return false;
        const state = this.backoff.get(host.id);
        return !state || state.nextAttemptAt <= now;
      });

      const failedIds: string[] = [];
      const samples = await Promise.all(
        due.map(async (host) => {
          try {
            const transport = await this.opts.getTransport(host);
            const sample = await collectMetrics(host.id, transport);
            this.backoff.delete(host.id);
            return { host, sample };
          } catch (err) {
            this.recordFailure(host.id);
            failedIds.push(host.id);
            this.opts.onError?.(host.id, err);
            return null;
          }
        }),
      );

      const successful = samples.filter((s): s is { host: Host; sample: Sample } => s !== null);
      const ts = Math.floor(Date.now() / 1000);

      if (successful.length > 0) {
        await this.opts.db.insert(hostMetrics).values(
          successful.map(({ host, sample }) => ({
            hostId: host.id,
            ts,
            cpuPct: sample.cpuPct ?? null,
            ramPct: sample.ramPct ?? null,
            diskPct: sample.diskPct ?? null,
            netRxBps: sample.netRxBps ?? null,
            netTxBps: sample.netTxBps ?? null,
            gpuUtilPct: sample.gpuUtilPct ?? null,
            gpuMemUsedMb: sample.gpuMemUsedMb ?? null,
            gpuTempC: sample.gpuTempC ?? null,
          })),
        );

        for (const { host, sample } of successful) {
          this.opts.onSample({ type: 'telemetry', hostId: host.id, sample, ts: Date.now() });
        }

        await this.opts.db
          .update(hosts)
          .set({ status: 'online', lastSeenAt: ts, lastCheckedAt: ts })
          .where(
            inArray(
              hosts.id,
              successful.map(({ host }) => host.id),
            ),
          );
      }

      if (failedIds.length > 0) {
        await this.opts.db
          .update(hosts)
          .set({ lastCheckedAt: ts })
          .where(inArray(hosts.id, failedIds));
      }

      await this.pruneIfDue();
    } finally {
      this.running = false;
    }
  }

  /** Exponential backoff, capped so a recovered host is picked up promptly. */
  private recordFailure(hostId: string): void {
    const state = this.backoff.get(hostId) ?? { failures: 0, nextAttemptAt: 0 };
    state.failures += 1;
    const delay = Math.min(this.opts.intervalMs * 2 ** state.failures, 10 * 60_000);
    state.nextAttemptAt = Date.now() + delay;
    this.backoff.set(hostId, state);
  }

  private async pruneIfDue(): Promise<void> {
    const retention = this.opts.retentionMs ?? 24 * 60 * 60 * 1000;
    // Hourly is plenty for a 24h window and keeps the hot path free of deletes.
    if (Date.now() - this.lastPrune < 60 * 60_000) return;
    this.lastPrune = Date.now();
    const cutoff = Math.floor((Date.now() - retention) / 1000);
    await this.opts.db.delete(hostMetrics).where(lt(hostMetrics.ts, cutoff));
  }
}

/** Collect specs once and persist them. Called after provisioning and on demand. */
export async function refreshSpecs(
  db: Db,
  host: Host,
  transport: Transport,
): Promise<void> {
  const specs = await collectSpecs(transport);
  const now = Math.floor(Date.now() / 1000);

  const row = {
    hostId: host.id,
    cpuModel: specs.cpuModel ?? null,
    cpuCores: specs.cpuCores ?? null,
    cpuThreads: specs.cpuThreads ?? null,
    cpuMhz: specs.cpuMhz ?? null,
    ramTotalGb: specs.ramTotalGb ?? null,
    ramFreeGb: specs.ramFreeGb ?? null,
    gpu: specs.gpu,
    storage: specs.storage,
    osKernel: specs.osKernel ?? null,
    uptimeS: specs.uptimeS ?? null,
    collectedAt: now,
  };

  const existing = await db
    .select({ hostId: hostSpecs.hostId })
    .from(hostSpecs)
    .where(eq(hostSpecs.hostId, host.id))
    .limit(1);

  if (existing.length > 0) {
    await db.update(hostSpecs).set(row).where(eq(hostSpecs.hostId, host.id));
  } else {
    await db.insert(hostSpecs).values(row);
  }
}

/** Metrics for one host within a window, for the dashboard sparklines. */
export async function metricsSince(db: Db, hostId: string, sinceSec: number) {
  return db
    .select()
    .from(hostMetrics)
    .where(and(eq(hostMetrics.hostId, hostId), gte(hostMetrics.ts, sinceSec)))
    .orderBy(hostMetrics.ts);
}
