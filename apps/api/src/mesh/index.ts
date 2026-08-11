import { NetBirdProvider } from './netbird.js';
import { TailscaleProvider } from './tailscale.js';
import type { MeshProvider, MeshProviderName } from './types.js';

export * from './types.js';
export { NetBirdProvider } from './netbird.js';
export { TailscaleProvider } from './tailscale.js';

/** A provider that reports nothing, so hosts fall back to bootstrap addresses. */
class NullMeshProvider implements MeshProvider {
  readonly name = 'none' as const;
  async listPeers() {
    return [];
  }
  async getPeerAddress() {
    return null;
  }
  planEnrollment(): never {
    throw new Error('MESH_PROVIDER is "none" — configure a mesh before provisioning.');
  }
  async healthCheck() {
    return {
      provider: this.name,
      reachable: false,
      detail: 'No mesh provider configured (MESH_PROVIDER=none).',
    };
  }
}

export interface MeshEnv {
  provider: MeshProviderName;
  netbirdMgmtUrl?: string;
  netbirdPat?: string;
  netbirdSetupKey?: string;
  tailscaleBin?: string;
}

export function createMeshProvider(env: MeshEnv): MeshProvider {
  switch (env.provider) {
    case 'netbird':
      if (!env.netbirdMgmtUrl) {
        throw new Error('MESH_PROVIDER=netbird requires NETBIRD_MGMT_URL');
      }
      return new NetBirdProvider({
        managementUrl: env.netbirdMgmtUrl,
        pat: env.netbirdPat ?? '',
        setupKey: env.netbirdSetupKey,
      });
    case 'tailscale':
      return new TailscaleProvider({
        binary: env.tailscaleBin ?? 'tailscale',
      });
    case 'none':
      return new NullMeshProvider();
  }
}

/**
 * Build a secondary provider used only to render migration status.
 *
 * While hosts are moving from Tailscale to NetBird, the /mesh screen shows both
 * overlays so the operator can see which machines are already carried by
 * NetBird and which would be stranded by removing Tailscale. Returns null once
 * the tailscale binary is gone, which is the signal the migration is done.
 */
export function createMigrationWitness(env: MeshEnv): MeshProvider | null {
  if (env.provider !== 'netbird' || !env.tailscaleBin) return null;
  return new TailscaleProvider({ binary: env.tailscaleBin });
}
