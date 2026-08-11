/**
 * Tailscale adapter — read-only, retained for the NetBird migration.
 *
 * This fleet is mid-move: some hosts are still only reachable over Tailscale
 * while NetBird enrollment proceeds. Keeping this provider lets the /mesh
 * screen show both overlays side by side and tell the operator exactly which
 * hosts are safe to cut over, instead of discovering a stranded machine after
 * Tailscale is already gone.
 *
 * Deliberately has no `planEnrollment` implementation that installs anything —
 * we are not adding hosts to Tailscale. It throws, so a misconfiguration that
 * points provisioning at this provider fails loudly rather than quietly
 * enrolling into the overlay we are trying to leave.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  EnrollOptions,
  EnrollmentPlan,
  MeshHealth,
  MeshPeer,
  MeshProvider,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Shape of `tailscale status --json`, limited to the fields we read. */
interface TailscaleStatus {
  BackendState?: string;
  MagicDNSSuffix?: string;
  Self?: TailscaleNode;
  Peer?: Record<string, TailscaleNode>;
}

interface TailscaleNode {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
  LastSeen?: string;
  PublicKey?: string;
}

export interface TailscaleConfig {
  /** Path to the tailscale binary; differs across the three operator OSes. */
  binary: string;
  timeoutMs?: number;
}

export class TailscaleProvider implements MeshProvider {
  readonly name = 'tailscale' as const;

  constructor(private readonly config: TailscaleConfig) {}

  async listPeers(): Promise<MeshPeer[]> {
    const status = await this.status();
    const nodes: TailscaleNode[] = [
      ...(status.Self ? [status.Self] : []),
      ...Object.values(status.Peer ?? {}),
    ];

    return nodes
      .map((node) => this.toPeer(node))
      .filter((p): p is MeshPeer => p !== null);
  }

  async getPeerAddress(hostnameOrId: string): Promise<string | null> {
    const peers = await this.listPeers();
    const needle = hostnameOrId.toLowerCase();
    const hit = peers.find(
      (p) => p.id === hostnameOrId || p.hostname.toLowerCase() === needle,
    );
    return hit?.ip ?? null;
  }

  /** `tailscale status --json` reports the local node explicitly as `Self`. */
  async getSelfPeer(): Promise<MeshPeer | null> {
    const status = await this.status();
    return status.Self ? this.toPeer(status.Self) : null;
  }

  planEnrollment(_opts: EnrollOptions): EnrollmentPlan {
    throw new Error(
      'Tailscale is read-only in Fleet Console. It exists to track migration ' +
        'progress; set MESH_PROVIDER=netbird to enroll hosts.',
    );
  }

  async healthCheck(): Promise<MeshHealth> {
    try {
      const status = await this.status();
      const peers = await this.listPeers();
      const running = status.BackendState === 'Running';
      return {
        provider: this.name,
        reachable: running,
        detail: running
          ? `Backend running${status.MagicDNSSuffix ? `, MagicDNS ${status.MagicDNSSuffix}` : ''}`
          : `Backend state: ${status.BackendState ?? 'unknown'}`,
        peerCount: peers.length,
      };
    } catch (err) {
      return {
        provider: this.name,
        reachable: false,
        detail: `tailscale CLI unavailable: ${(err as Error).message}`,
      };
    }
  }

  private toPeer(node: TailscaleNode): MeshPeer | null {
    // Prefer IPv4; the whole app addresses hosts by 100.x and guacd/ssh2 are
    // simpler for it. Nodes without an IPv4 are skipped rather than guessed at.
    const ip = node.TailscaleIPs?.find((addr) => !addr.includes(':'));
    if (!ip) return null;

    const hostname = node.HostName ?? node.DNSName?.split('.')[0];
    if (!hostname) return null;

    // Tailscale reports LastSeen as the zero time for currently-connected
    // peers; treating that as a real timestamp would show "last seen year 1".
    const lastSeen =
      node.LastSeen && !node.LastSeen.startsWith('0001-01-01')
        ? new Date(node.LastSeen)
        : undefined;

    return {
      id: node.ID ?? ip,
      hostname,
      ip,
      os: node.OS,
      connected: node.Online ?? false,
      lastSeen,
      publicKey: node.PublicKey,
    };
  }

  private async status(): Promise<TailscaleStatus> {
    const { stdout } = await execFileAsync(
      this.config.binary,
      ['status', '--json'],
      { timeout: this.config.timeoutMs ?? 10_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as TailscaleStatus;
  }
}
