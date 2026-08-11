/**
 * The mesh seam (PRD Appendix C).
 *
 * Everything above this interface is provider-agnostic: the dashboard, the
 * telemetry poller, the terminal and the RDP shim all consume `MeshPeer` and
 * never learn which overlay is underneath. Swapping providers is meant to be a
 * single-module change, and the migration path depends on that holding.
 *
 * Enrollment deliberately returns a *script* rather than performing an API
 * call. Joining a mesh happens on the managed host, over SSH, as one step in
 * the provisioning DAG — so the provider's job is to say what to run, and the
 * provisioner's job is to run it, stream it, and record it.
 */
import type { OsFamily } from '../shell/escape.js';

export type MeshProviderName = 'netbird' | 'tailscale' | 'none';

export interface MeshPeer {
  /** Provider-assigned peer id. Stable across reconnects. */
  id: string;
  /** Hostname as the provider knows it. Primary key for host matching. */
  hostname: string;
  /** Overlay address (100.x.x.x). The whole point of the mesh. */
  ip: string;
  os?: string;
  connected: boolean;
  lastSeen?: Date;
  /** WireGuard public key, used to disambiguate when hostnames collide. */
  publicKey?: string;
}

export interface MeshHealth {
  provider: MeshProviderName;
  reachable: boolean;
  /** Human-readable state for the /mesh screen. */
  detail: string;
  peerCount?: number;
}

export interface EnrollmentPlan {
  /** Script to execute on the managed host to join it to the mesh. */
  script: string;
  /**
   * Values injected as environment variables rather than inlined into the
   * script body, so setup keys never appear in provisioning logs or `ps`.
   */
  env: Record<string, string>;
  /** Rendered into the UI so the operator knows what a step will do. */
  description: string;
}

export interface EnrollOptions {
  os: OsFamily;
  /** Hostname to register the peer under. */
  hostname: string;
  /** Per-host override; falls back to the provider's configured key. */
  setupKey?: string;
}

export interface MeshProvider {
  readonly name: MeshProviderName;

  /** All peers the control plane knows about. */
  listPeers(): Promise<MeshPeer[]>;

  /**
   * Resolve one peer's overlay address by hostname (case-insensitive) or peer
   * id. Returns null when the peer is unknown — callers fall back to the
   * bootstrap address from the inventory.
   */
  getPeerAddress(hostnameOrId: string): Promise<string | null>;

  /** Produce the commands that join a host to this mesh. */
  planEnrollment(opts: EnrollOptions): EnrollmentPlan;

  /** Is the control plane reachable and configured? Drives the /mesh screen. */
  healthCheck(): Promise<MeshHealth>;

  /**
   * The peer representing the machine Fleet Console is running on, when the
   * provider can identify it without guessing.
   *
   * This exists because name matching genuinely cannot solve the local host:
   * one machine in this fleet is spelled `Matha-Windows-3080-5TB` in the
   * inventory, `MATHA-WINDOWS-3` by the OS, and `matha-windows-3080` in the
   * tailnet. No normalisation reconciles those, and a fuzzy match that did
   * would risk binding the two Mac minis to each other. A provider that knows
   * which peer is local should say so; one that does not returns null and the
   * caller falls back to name matching.
   */
  getSelfPeer?(): Promise<MeshPeer | null>;
}

/**
 * Match a mesh peer to a host record.
 *
 * PRD §F3 specifies: match on hostname, then on public key. Hostnames get
 * mangled in practice — NetBird lowercases, Tailscale substitutes `-` for
 * spaces and apostrophes (this fleet has a peer literally named
 * "Revanth's MacBook Pro") — so comparison is normalised rather than exact.
 */
export function normalizeHostname(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    // Curly and straight apostrophes both vanish rather than becoming separators.
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function matchPeerToHost(
  peers: readonly MeshPeer[],
  host: {
    hostname?: string | null;
    name: string;
    publicKey?: string | null;
    /**
     * Additional known-good names. The inventory's hostname column is a human
     * label and is not always what the machine actually calls itself — host #1
     * is spelled three ways across the sheet, the OS, and the mesh. Callers
     * that have ground truth (e.g. `os.hostname()` for the local machine) pass
     * it here rather than trusting the sheet.
     */
    aliases?: readonly string[];
  },
): MeshPeer | null {
  const candidates = [host.hostname, host.name, ...(host.aliases ?? [])]
    .filter((v): v is string => Boolean(v))
    .map(normalizeHostname);

  for (const peer of peers) {
    if (candidates.includes(normalizeHostname(peer.hostname))) return peer;
  }

  // Hostname changed (a rename, or a rebuild). Fall back to key identity.
  if (host.publicKey) {
    const wanted = host.publicKey.trim();
    for (const peer of peers) {
      if (peer.publicKey && peer.publicKey.trim() === wanted) return peer;
    }
  }

  return null;
}
