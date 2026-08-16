/**
 * Lists peers from the configured mesh provider, plus the migration witness.
 *
 * Run this before and after moving a host between overlays. The "stranded"
 * column is the one that matters: a host carried only by Tailscale will lose
 * connectivity the moment Tailscale is removed, so it must show a NetBird peer
 * first.
 *
 *   npx tsx scripts/verify-mesh-live.ts
 */
import '../src/env.js';
import { config } from '../src/config.js';
import { createMeshProvider, createMigrationWitness, type MeshEnv } from '../src/mesh/index.js';
import type { MeshPeer } from '../src/mesh/types.js';
import { normalizeHostname } from '../src/mesh/types.js';

const env: MeshEnv = {
  provider: config.mesh.provider,
  netbirdMgmtUrl: config.mesh.netbirdMgmtUrl,
  netbirdPat: config.mesh.netbirdPat,
  netbirdSetupKey: config.mesh.netbirdSetupKey,
  tailscaleBin:
    process.env.TAILSCALE_BIN ??
    (process.platform === 'win32'
      ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
      : 'tailscale'),
};

function table(title: string, peers: MeshPeer[]): void {
  console.log(`\n${title}`);
  if (peers.length === 0) {
    console.log('  (no peers)');
    return;
  }
  for (const p of peers) {
    const state = p.connected ? 'connected' : 'offline';
    console.log(
      `  ${p.hostname.padEnd(26)} ${p.ip.padEnd(16)} ${(p.os ?? '?').padEnd(8)} ${state}`,
    );
  }
}

let primaryPeers: MeshPeer[] = [];

try {
  const primary = createMeshProvider(env);
  const health = await primary.healthCheck();
  console.log(`primary provider : ${health.provider}`);
  console.log(`reachable        : ${health.reachable}`);
  console.log(`detail           : ${health.detail}`);
  if (health.reachable) {
    primaryPeers = await primary.listPeers();
    table(`${health.provider} peers`, primaryPeers);
  }
} catch (err) {
  console.log(`primary provider : unavailable — ${(err as Error).message}`);
}

const witness = createMigrationWitness(env);
if (witness) {
  const health = await witness.healthCheck();
  console.log(`\nmigration witness: ${health.provider} (reachable=${health.reachable})`);
  if (health.reachable) {
    const tsPeers = await witness.listPeers();
    table('tailscale peers', tsPeers);

    const covered = new Set(primaryPeers.map((p) => normalizeHostname(p.hostname)));
    const stranded = tsPeers.filter((p) => !covered.has(normalizeHostname(p.hostname)));

    console.log(`\nSTRANDED IF TAILSCALE IS REMOVED NOW (${stranded.length}):`);
    if (stranded.length === 0) {
      console.log('  none — every Tailscale peer has a NetBird peer. Safe to cut over.');
    } else {
      for (const p of stranded) {
        console.log(`  ${p.hostname.padEnd(26)} ${p.ip.padEnd(16)} <- enroll in NetBird first`);
      }
    }
  }
}
