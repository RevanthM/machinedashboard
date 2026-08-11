/**
 * Reconcile mesh peers onto host records (PRD §F3).
 *
 * Without this the dashboard shows `mesh: unknown` for machines that are
 * plainly connected — the peer list and the host list exist but nothing joins
 * them. Runs on a timer (`MESH_POLL_MS`, default 30s) and on demand.
 *
 * The join is deliberately conservative. `matchPeerToHost` normalises hostnames
 * before comparing and falls back to public key, because the same machine is
 * spelled three different ways across the inventory, the OS, and the mesh
 * control plane. A host that cannot be matched is marked `disconnected` rather
 * than being bound to a near-miss neighbour — a wrong match would point the
 * terminal and RDP session at the wrong machine.
 */
import { hostname as localHostname } from 'node:os';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hosts } from '../db/schema.js';
import { matchPeerToHost, type MeshPeer, type MeshProvider } from './types.js';

export interface ReconcileResult {
  provider: string;
  reachable: boolean;
  matched: Array<{ name: string; peer: string; ip: string; connected: boolean }>;
  unmatched: string[];
  /** Peers with no host record — usually a machine not yet imported. */
  orphanPeers: string[];
}

export async function reconcileMesh(
  db: Db,
  provider: MeshProvider,
): Promise<ReconcileResult> {
  const health = await provider.healthCheck();
  if (!health.reachable) {
    return {
      provider: provider.name,
      reachable: false,
      matched: [],
      unmatched: [],
      orphanPeers: [],
    };
  }

  const peers = await provider.listPeers();
  const rows = await db.select().from(hosts);

  // Resolved once rather than per-host; only one record can be the local one.
  const selfPeer = provider.getSelfPeer ? await provider.getSelfPeer() : null;

  const matched: ReconcileResult['matched'] = [];
  const unmatched: string[] = [];
  const claimedPeerIds = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  for (const host of rows) {
    // The local host is identified by the provider, not by its name. Falls
    // through to name matching when the provider cannot tell us.
    const peer: MeshPeer | null =
      (host.isSelf ? selfPeer : null) ??
      matchPeerToHost(peers, {
        hostname: host.hostname,
        name: host.name,
        publicKey: host.publicKey,
        aliases: host.isSelf ? [localHostname()] : undefined,
      });

    if (!peer) {
      unmatched.push(host.name);
      // Only downgrade records this provider previously owned; leaving a stale
      // address from another provider would silently route traffic nowhere.
      if (host.meshProvider === provider.name) {
        await db
          .update(hosts)
          .set({ meshStatus: 'disconnected', updatedAt: now })
          .where(eq(hosts.id, host.id));
      }
      continue;
    }

    claimedPeerIds.add(peer.id);
    await db
      .update(hosts)
      .set({
        meshProvider: provider.name,
        meshIp: peer.ip,
        meshPeerId: peer.id,
        meshStatus: peer.connected ? 'connected' : 'disconnected',
        meshLastSeenAt: peer.lastSeen ? Math.floor(peer.lastSeen.getTime() / 1000) : null,
        updatedAt: now,
      })
      .where(eq(hosts.id, host.id));

    matched.push({
      name: host.name,
      peer: peer.hostname,
      ip: peer.ip,
      connected: peer.connected,
    });
  }

  return {
    provider: provider.name,
    reachable: true,
    matched,
    unmatched,
    orphanPeers: peers.filter((p) => !claimedPeerIds.has(p.id)).map((p) => p.hostname),
  };
}

/**
 * Start the reconciliation loop. Returns a stop function.
 *
 * Errors are logged and swallowed: a control plane that is briefly unreachable
 * must not take the API process down with it.
 */
export function startMeshPoller(
  db: Db,
  provider: MeshProvider,
  intervalMs: number,
  onError: (err: unknown) => void,
): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // Skip rather than overlap on a slow control plane.
    running = true;
    try {
      await reconcileMesh(db, provider);
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
