/**
 * NetBird adapter — the primary mesh provider.
 *
 * Talks to a self-hosted Management API (PRD §F3). The management URL is
 * configuration, not a constant: the control plane can live on a VPS, on
 * another machine on the LAN, or on this laptop, and nothing else in the app
 * changes. See deploy/netbird/README.md for the trade-offs of each.
 *
 * Auth is `Authorization: Token <PAT>` per the NetBird Management API.
 */
import { wrapScript, type OsFamily } from '../shell/escape.js';
import type {
  EnrollOptions,
  EnrollmentPlan,
  MeshHealth,
  MeshPeer,
  MeshProvider,
} from './types.js';

/** Subset of the /api/peers response we rely on. */
interface NetBirdPeer {
  id: string;
  name?: string;
  hostname?: string;
  ip: string;
  connected?: boolean;
  last_seen?: string;
  os?: string;
  key?: string;
}

export interface NetBirdConfig {
  managementUrl: string;
  pat: string;
  setupKey?: string;
  /** Group every managed host joins, so one ACL policy covers the fleet. */
  groupName?: string;
  fetchTimeoutMs?: number;
}

export class NetBirdProvider implements MeshProvider {
  readonly name = 'netbird' as const;

  private readonly baseUrl: string;

  constructor(private readonly config: NetBirdConfig) {
    this.baseUrl = config.managementUrl.replace(/\/+$/, '');
  }

  async listPeers(): Promise<MeshPeer[]> {
    const peers = await this.request<NetBirdPeer[]>('/api/peers');
    return peers.map((p) => ({
      id: p.id,
      // NetBird reports both a display name and the OS-reported hostname; the
      // latter is what actually matches our host records.
      hostname: p.hostname ?? p.name ?? p.id,
      ip: p.ip,
      os: p.os,
      connected: p.connected ?? false,
      lastSeen: p.last_seen ? new Date(p.last_seen) : undefined,
      publicKey: p.key,
    }));
  }

  async getPeerAddress(hostnameOrId: string): Promise<string | null> {
    const peers = await this.listPeers();
    const needle = hostnameOrId.toLowerCase();
    const hit = peers.find(
      (p) => p.id === hostnameOrId || p.hostname.toLowerCase() === needle,
    );
    return hit?.ip ?? null;
  }

  async healthCheck(): Promise<MeshHealth> {
    if (!this.config.pat) {
      return {
        provider: this.name,
        reachable: false,
        detail: 'NETBIRD_PAT is not set — generate one in the NetBird dashboard.',
      };
    }
    try {
      const peers = await this.listPeers();
      return {
        provider: this.name,
        reachable: true,
        detail: `Connected to ${this.baseUrl}`,
        peerCount: peers.length,
      };
    } catch (err) {
      return {
        provider: this.name,
        reachable: false,
        detail: `Cannot reach ${this.baseUrl}: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Enrollment scripts per OS (PRD §F2).
   *
   * The setup key and management URL arrive as environment variables so they
   * stay out of the script body — provisioning stdout is persisted, and a key
   * inlined here would be recoverable from provision_runs even after the
   * scrubber ran.
   *
   * Each script is written to be idempotent: re-running on an already-joined
   * host reports status and exits 0, which is what makes a full re-provision a
   * sub-20s no-op.
   */
  planEnrollment(opts: EnrollOptions): EnrollmentPlan {
    const setupKey = opts.setupKey ?? this.config.setupKey;
    if (!setupKey) {
      throw new Error(
        'No NetBird setup key. Set NETBIRD_SETUP_KEY or provide netbird_setup_key for this host.',
      );
    }

    const env = {
      NB_SETUP_KEY: setupKey,
      NB_MGMT_URL: this.baseUrl,
      NB_HOSTNAME: opts.hostname,
    };

    return {
      script: wrapScript(this.enrollScript(opts.os), opts.os),
      env,
      description: `Join ${opts.hostname} to the NetBird mesh at ${this.baseUrl}`,
    };
  }

  private enrollScript(os: OsFamily): string {
    switch (os) {
      case 'windows':
        return WINDOWS_ENROLL;
      case 'macos':
        return MACOS_ENROLL;
      default:
        return LINUX_ENROLL;
    }
  }

  private async request<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.fetchTimeoutMs ?? 10_000,
    );
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Token ${this.config.pat}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Never echo the body verbatim — an error page from a misconfigured
        // reverse proxy can contain the request headers, PAT included.
        throw new Error(`NetBird API ${res.status} ${res.statusText} for ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// --- Enrollment scripts -----------------------------------------------------
// Written against the reference commands in PRD §F2, hardened for idempotency.

const LINUX_ENROLL = `
set -eu
if ! command -v netbird >/dev/null 2>&1; then
  curl -fsSL https://pkgs.netbird.io/install.sh | sh
fi
# Already up and connected? Nothing to do.
if netbird status 2>/dev/null | grep -qi 'Management: Connected'; then
  echo "already connected"
  netbird status
  exit 0
fi
sudo -n netbird up \\
  --setup-key "$NB_SETUP_KEY" \\
  --management-url "$NB_MGMT_URL" \\
  --hostname "$NB_HOSTNAME"
netbird status
`.trim();

const MACOS_ENROLL = `
set -eu
if ! command -v netbird >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required to install netbird on macOS; install it first" >&2
    exit 1
  fi
  brew install netbirdio/tap/netbird
fi
if netbird status 2>/dev/null | grep -qi 'Management: Connected'; then
  echo "already connected"
  netbird status
  exit 0
fi
sudo -n netbird service install 2>/dev/null || true
sudo -n netbird up \\
  --setup-key "$NB_SETUP_KEY" \\
  --management-url "$NB_MGMT_URL" \\
  --hostname "$NB_HOSTNAME"
netbird status
`.trim();

/**
 * Windows note: winget under a non-interactive SSH session frequently fails to
 * resolve its source, so failure to install is reported explicitly rather than
 * left to surface later as "netbird: command not found".
 */
const WINDOWS_ENROLL = `
$ErrorActionPreference = 'Stop'

function Get-NetBirdExe {
  $cmd = Get-Command netbird -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:ProgramFiles 'NetBird\\netbird.exe'
  if (Test-Path $fallback) { return $fallback }
  return $null
}

$exe = Get-NetBirdExe
if (-not $exe) {
  winget install --id NetBird.NetBird -e --silent \`
    --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine')
  $exe = Get-NetBirdExe
}
if (-not $exe) {
  Write-Error "netbird install did not produce an executable; install it manually and re-run"
  exit 1
}

$status = & $exe status 2>&1 | Out-String
if ($status -match 'Management:\\s*Connected') {
  Write-Output "already connected"
  Write-Output $status
  exit 0
}

& $exe up --setup-key $env:NB_SETUP_KEY --management-url $env:NB_MGMT_URL --hostname $env:NB_HOSTNAME
& $exe status
`.trim();
