/** Typed client for the Fleet API. */

export interface MeshPeer {
  id: string;
  hostname: string;
  ip: string;
  os?: string;
  connected: boolean;
}

export interface MigrationState {
  migrating: boolean;
  note?: string;
  primary?: { provider: string; reachable: boolean; peers: MeshPeer[] };
  legacy?: { provider: string; reachable: boolean; peers: MeshPeer[] };
  stranded: MeshPeer[];
  safeToRemoveLegacy?: boolean;
}

export interface GpuInfo {
  model: string;
  vramMb?: number;
  driver?: string;
  backend?: 'cuda' | 'metal' | 'rocm' | 'cpu';
}

export interface StorageMount {
  mount: string;
  fs?: string;
  totalBytes: number;
  freeBytes: number;
}

export interface HostSpecs {
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  ramTotalGb?: number;
  ramFreeGb?: number;
  gpu?: GpuInfo[];
  storage?: StorageMount[];
  osKernel?: string;
  uptimeS?: number;
}

export interface Benchmark {
  id: number;
  hostId: string;
  ts: number;
  model: string;
  evalTps?: number;
  promptTps?: number;
  ttftMs?: number;
  loadMs?: number;
  numCtx?: number;
  backend?: 'cuda' | 'metal' | 'rocm' | 'cpu';
}

export interface Host {
  id: string;
  name: string;
  host: string | null;
  hostname: string | null;
  os: string | null;
  osVersion: string | null;
  username: string;
  isSelf: boolean;
  meshProvider: string;
  meshIp: string | null;
  meshStatus: 'connected' | 'disconnected' | 'unknown';
  rdpProtocol: 'rdp' | 'vnc' | null;
  rdpPort: number | null;
  tags: string[];
  enableOllama: boolean;
  status: 'unknown' | 'online' | 'unreachable' | 'auth_failed' | 'error';
  lastError: string | null;
  provisionState: string;
  activeAddress: { address: string; source: 'mesh' | 'inventory' | 'hostname' } | null;
  specs: HostSpecs | null;
  latestBenchmark: Benchmark | null;
}

export interface ProbeResult {
  hostId: string;
  name: string;
  ok: boolean;
  address: string | null;
  reachedStage: string;
  failedStage?: string;
  error?: string;
  remedy?: string;
  durationMs: number;
}

export interface StepReport {
  id: string;
  title: string;
  status: 'ok' | 'skipped' | 'failed' | 'blocked' | 'not_applicable' | 'planned';
  detail?: string;
  durationMs: number;
  commands?: string[];
}

export interface ProvisionReport {
  hostId: string;
  hostName: string;
  dryRun: boolean;
  steps: StepReport[];
  ok: boolean;
  durationMs: number;
}

export interface LeaderboardEntry {
  hostId: string;
  name: string;
  os: string | null;
  model: string;
  backend: string;
  evalTps?: number;
  promptTps?: number;
  ttftMs?: number;
  numCtx?: number;
  ts: number;
}

export interface AuditEntry {
  id: string;
  hostId: string;
  source: string;
  command: string;
  approvedBy: string | null;
  exitCode: number | null;
  stdoutHead: string | null;
  ranAt: number;
  durationMs: number | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (body) message = body.slice(0, 300);
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  hosts: () => request<{ hosts: Host[] }>('/api/hosts'),
  host: (id: string) => request<Host & { benchmarks: Benchmark[] }>(`/api/hosts/${id}`),
  migration: () => request<MigrationState>('/api/mesh/migration'),
  leaderboard: () => request<{ entries: LeaderboardEntry[]; byBackend: Record<string, LeaderboardEntry[]> }>('/api/leaderboard'),
  audit: (hostId?: string) =>
    request<{ entries: AuditEntry[] }>(`/api/audit${hostId ? `?hostId=${hostId}` : ''}`),
  probe: (id: string) => request<ProbeResult>(`/api/hosts/${id}/probe`, { method: 'POST' }),
  probeAll: () => request<{ results: ProbeResult[] }>('/api/hosts/probe-all', { method: 'POST' }),
  provision: (id: string, body: { dryRun?: boolean; force?: boolean; steps?: string[] }) =>
    request<ProvisionReport>(`/api/hosts/${id}/provision`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  benchmark: (id: string, model?: string) =>
    request<unknown>(`/api/hosts/${id}/benchmark`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
  refreshSpecs: (id: string) =>
    request<{ refreshed: boolean }>(`/api/hosts/${id}/specs/refresh`, { method: 'POST' }),
  rdpPreflight: (id: string) =>
    request<{
      guacdReachable: boolean;
      hostDesktopReachable: boolean;
      protocol: string;
      address: string;
      port: number;
      note?: string;
    }>(`/api/hosts/${id}/rdp/preflight`),
  settings: () => request<Record<string, unknown>>('/api/settings'),
  pool: () => request<{ size: number; maxEntries: number; entries: unknown[] }>('/api/debug/pool'),
};
