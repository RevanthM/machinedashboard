import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MeshProviderName } from './mesh/types.js';

function str(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const fleetHome = str('FLEET_HOME') || join(homedir(), '.fleet-console');

export const config = {
  /**
   * v1 binds loopback only (PRD §11). Exposing this app on 0.0.0.0 would put
   * unauthenticated shell access to the entire fleet on the local network, so
   * the value is validated at startup rather than trusted from the environment.
   */
  apiHost: str('API_HOST', '127.0.0.1'),
  apiPort: int('API_PORT', 8080),
  webPort: int('WEB_PORT', 5173),

  fleetHome: resolve(fleetHome),
  dbPath: join(resolve(fleetHome), 'fleet.db'),
  keysDir: join(resolve(fleetHome), 'keys'),
  attachmentsDir: join(resolve(fleetHome), 'attachments'),
  recordingsDir: join(resolve(fleetHome), 'recordings'),
  vaultPath: join(resolve(fleetHome), 'secrets.vault'),

  vaultPassphrase: str('FLEET_VAULT_PASSPHRASE'),

  mesh: {
    provider: (str('MESH_PROVIDER', 'netbird') as MeshProviderName),
    netbirdMgmtUrl: str('NETBIRD_MGMT_URL'),
    netbirdPat: str('NETBIRD_PAT'),
    netbirdSetupKey: str('NETBIRD_SETUP_KEY'),
    tailscaleBin:
      str('TAILSCALE_BIN') ||
      (process.platform === 'win32'
        ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
        : 'tailscale'),
  },

  guac: {
    host: str('GUACD_HOST', '127.0.0.1'),
    port: int('GUACD_PORT', 4822),
    advertiseHost: str('GUAC_SHIM_ADVERTISE_HOST', 'host.docker.internal'),
    tokenSecret: str('GUAC_TOKEN_SECRET'),
  },

  telemetryPollMs: int('TELEMETRY_POLL_MS', 15_000),
  meshPollMs: int('MESH_POLL_MS', 30_000),
  ollamaPort: int('OLLAMA_PORT', 11434),
  ollamaModel: str('OLLAMA_MODEL', 'gemma4:e2b'),

  agent: {
    approvalMode: str('AGENT_APPROVAL_MODE', 'always_ask') as
      | 'always_ask'
      | 'writes_only'
      | 'allowlist',
    model: str('AGENT_MODEL'),
    modelBaseUrl: str('AGENT_MODEL_BASE_URL'),
  },
} as const;

export type Config = typeof config;

/**
 * Fail fast on configurations that are unsafe rather than merely incomplete.
 * Missing mesh credentials degrade gracefully — the dashboard still renders and
 * says so. A non-loopback bind does not.
 */
export function assertSafeConfig(cfg: Config = config): void {
  const problems: string[] = [];

  if (cfg.apiHost !== '127.0.0.1' && cfg.apiHost !== 'localhost' && cfg.apiHost !== '::1') {
    problems.push(
      `API_HOST is "${cfg.apiHost}". v1 has no authentication, so binding beyond ` +
        `loopback would expose shell access to every managed host. Refusing to start.`,
    );
  }

  if (!cfg.vaultPassphrase) {
    problems.push(
      'FLEET_VAULT_PASSPHRASE is not set. Secrets would have nowhere safe to live; ' +
        'set it in .env (any strong passphrase — it derives the vault key via scrypt).',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Unsafe configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
