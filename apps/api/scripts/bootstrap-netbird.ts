/**
 * Everything that can be automated once a PAT exists.
 *
 * Creating the owner account is the one step that stays manual — it is account
 * creation and password entry. This script picks up immediately after it and
 * does the rest via the Management API, so the human part is ~60 seconds of
 * clicking rather than a configuration project.
 *
 * It is idempotent: re-running finds existing objects instead of duplicating
 * them, so it is safe to run again after a partial failure.
 *
 *   npm run netbird:bootstrap -w @fleet/api
 *
 * Requires NETBIRD_MGMT_URL and NETBIRD_PAT in .env. Prints a reusable setup
 * key at the end — paste that into .env as NETBIRD_SETUP_KEY.
 */
import '../src/env.js';
import { config } from '../src/config.js';

const BASE = config.mesh.netbirdMgmtUrl.replace(/\/+$/, '');
const PAT = config.mesh.netbirdPat;
const GROUP_NAME = 'fleet-console';

if (!BASE || !PAT) {
  console.error(
    'Missing NETBIRD_MGMT_URL or NETBIRD_PAT in .env.\n\n' +
      `  1. Open ${BASE || 'https://<your-control-plane>'} and create the owner account\n` +
      '  2. Team -> your user -> generate token\n' +
      '  3. Put it in .env as NETBIRD_PAT, then re-run this script\n',
  );
  process.exit(2);
}

// The control plane deployed with NETBIRD_DOMAIN=use-ip serves a self-signed
// certificate, because Let's Encrypt cannot validate a private IP. Accept it
// for this loopback-scoped admin call only.
if (BASE.startsWith('https://') && /^\d+\.\d+\.\d+\.\d+/.test(BASE.replace('https://', ''))) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('note: accepting the self-signed certificate for an IP-based control plane\n');
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

interface Group { id: string; name: string }
interface SetupKey { id: string; name: string; key: string; state: string; revoked: boolean; type: string }
interface Policy { id: string; name: string }

console.log(`Bootstrapping ${BASE}\n`);

// --- 1. Group ---------------------------------------------------------------
const groups = await api<Group[]>('/api/groups');
let group = groups.find((g) => g.name === GROUP_NAME);
if (group) {
  console.log(`group      : "${GROUP_NAME}" already exists (${group.id})`);
} else {
  group = await api<Group>('/api/groups', {
    method: 'POST',
    body: JSON.stringify({ name: GROUP_NAME }),
  });
  console.log(`group      : created "${GROUP_NAME}" (${group.id})`);
}

// --- 2. Reusable setup key --------------------------------------------------
// Auto-assigning the group means every host enrolled with this key lands in the
// fleet group, so the ACL below covers it without per-host configuration.
const keys = await api<SetupKey[]>('/api/setup-keys');
const existing = keys.find((k) => k.name === 'fleet-console' && !k.revoked && k.state === 'valid');

let setupKey: string | null = null;
if (existing) {
  // NetBird returns the plaintext key only at creation time.
  console.log(`setup key  : "fleet-console" already exists (${existing.id}) — value not retrievable`);
  console.log('             revoke it in the dashboard and re-run to mint a fresh one.');
} else {
  const created = await api<SetupKey>('/api/setup-keys', {
    method: 'POST',
    body: JSON.stringify({
      name: 'fleet-console',
      type: 'reusable',
      expires_in: 30 * 24 * 3600,
      revoked: false,
      auto_groups: [group.id],
      usage_limit: 0,
    }),
  });
  setupKey = created.key;
  console.log(`setup key  : created "fleet-console" (${created.id})`);
}

// --- 3. ACL policy ----------------------------------------------------------
// Ports Fleet Console needs: SSH, RDP, VNC, Ollama.
const policies = await api<Policy[]>('/api/policies');
const policyName = 'fleet-console-access';
if (policies.some((p) => p.name === policyName)) {
  console.log(`policy     : "${policyName}" already exists`);
} else {
  await api('/api/policies', {
    method: 'POST',
    body: JSON.stringify({
      name: policyName,
      description: 'Operator access to managed hosts (SSH, RDP, VNC, Ollama)',
      enabled: true,
      rules: [
        {
          name: 'fleet-console-ports',
          enabled: true,
          action: 'accept',
          bidirectional: true,
          protocol: 'tcp',
          sources: [group.id],
          destinations: [group.id],
          ports: ['22', '3389', '5900', '11434'],
        },
      ],
    }),
  });
  console.log(`policy     : created "${policyName}" (tcp 22, 3389, 5900, 11434)`);
}

// --- 4. Report --------------------------------------------------------------
const peers = await api<unknown[]>('/api/peers');
console.log(`peers      : ${peers.length} currently enrolled`);

if (setupKey) {
  console.log('\n' + '='.repeat(64));
  console.log('Add this to .env, then provision any host to enroll it:\n');
  console.log(`  NETBIRD_SETUP_KEY=${setupKey}`);
  console.log('='.repeat(64));
  console.log('\nThis is the only time NetBird will show the key in plaintext.');
} else {
  console.log('\nNo new key minted. Set NETBIRD_SETUP_KEY from an existing key, or revoke');
  console.log('the current "fleet-console" key in the dashboard and re-run.');
}
