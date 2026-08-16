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

export interface HostLlmInfo {
  chatModel: string;
  benchModel: string;
  where: 'forced_operator' | 'this_host' | 'operator_fallback' | 'unavailable';
  baseUrl: string | null;
  hostOllamaUrl: string | null;
  hostOllamaUp: boolean;
  operatorOllamaUp: boolean;
  summary: string;
}

export interface Host {
  id: string;
  name: string;
  nickname?: string | null;
  displayName?: string;
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
  lastSeenAt: number | null;
  lastCheckedAt: number | null;
  meshLastSeenAt?: number | null;
  lastError: string | null;
  provisionState: string;
  activeAddress: { address: string; source: 'mesh' | 'inventory' | 'hostname' } | null;
  specs: HostSpecs | null;
  latestBenchmark: Benchmark | null;
  llm?: HostLlmInfo | null;
}

export function hostLabel(host: Pick<Host, 'name' | 'nickname' | 'displayName'>): string {
  return host.displayName || host.nickname?.trim() || host.name;
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

export interface ChatSession {
  id: string;
  hostId: string;
  title: string | null;
  createdAt: number;
}

export interface ChatAttachment {
  id: string;
  filename: string;
  kind: 'text' | 'image' | 'binary' | string;
  url: string;
  bytes?: number;
}

export interface ChatSessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  toolCalls?: unknown;
  attachments?: ChatAttachment[] | null;
  ts: number;
}

export interface ChatPending {
  callId: string;
  tool: string;
  hostName: string;
  hostAddress: string;
  subject: string;
  body?: string;
  reason: string;
  requiresTypedConfirmation: boolean;
  typedConfirmationPhrase?: string;
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

  chatSessions: (hostId: string) =>
    request<{ sessions: ChatSession[] }>(`/api/chat/${hostId}/sessions`),
  createChatSession: (hostId: string, title?: string) =>
    request<{ id: string; hostId: string }>(`/api/chat/${hostId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  chatThread: (sessionId: string) =>
    request<{
      session: ChatSession;
      messages: ChatSessionMessage[];
      pending: ChatPending | null;
    }>(`/api/chat/sessions/${sessionId}`),
  sendChatMessage: (sessionId: string, text: string, attachmentIds: string[] = []) =>
    request<{
      finalText: string | null;
      pending: ChatPending | null;
      truncationNotice?: string;
      model: string;
      baseUrl: string;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, attachmentIds }),
    }),
  uploadAttachment: async (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch('/api/attachments', { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body.slice(0, 300) || `${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<{
      id: string;
      filename: string;
      bytes: number;
      kind: 'text' | 'image' | 'binary';
      inlineable: boolean;
      url: string;
    }>;
  },
  approveChat: (sessionId: string, typedConfirmation?: string) =>
    request<{ finalText: string | null; pending: ChatPending | null }>(
      `/api/chat/sessions/${sessionId}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ typedConfirmation }),
      },
    ),
  denyChat: (sessionId: string) =>
    request<{ finalText: string | null; pending: ChatPending | null }>(
      `/api/chat/sessions/${sessionId}/deny`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  patchHost: (id: string, body: Partial<Host> & { nickname?: string | null }) =>
    request<Host>(`/api/hosts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  factorySessions: () =>
    request<{ sessions: Array<{ id: string; title: string | null; createdAt: number }> }>(
      '/api/factory/sessions',
    ),
  createFactorySession: (title?: string) =>
    request<{ id: string }>('/api/factory/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  factoryThread: (sessionId: string) =>
    request<{
      session: { id: string; title: string | null; createdAt: number };
      messages: Array<{
        id: string;
        role: string;
        content: string | null;
        hostIds?: string[] | null;
        jobId?: string | null;
        ts: number;
      }>;
    }>(`/api/factory/sessions/${sessionId}`),
  sendFactoryMessage: (sessionId: string, text: string) =>
    request<{ finalText: string; hostIds: string[]; jobId: string | null; model?: string }>(
      `/api/factory/sessions/${sessionId}/messages`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),

  jobs: () =>
    request<{
      jobs: Array<{
        id: string;
        type: string;
        title: string;
        status: string;
        createdAt: number;
        endedAt: number | null;
        error: string | null;
        runs: Array<{
          id: string;
          hostId: string;
          status: string;
          result: string | null;
          error: string | null;
          artifacts?: Array<{ id: string; filename: string; kind: string; url: string }> | null;
        }>;
      }>;
    }>('/api/jobs'),
  createJob: (body: {
    type: string;
    title?: string;
    hostIds: string[];
    payload?: Record<string, unknown>;
    run?: boolean;
  }) => request<unknown>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  routeJob: (body: Record<string, unknown>) =>
    request<unknown>('/api/jobs/route', { method: 'POST', body: JSON.stringify(body) }),

  schedules: () =>
    request<{
      schedules: Array<{
        id: string;
        name: string;
        enabled: boolean;
        everyMinutes: number;
        jobType: string;
        lastRunAt: number | null;
        nextRunAt: number | null;
      }>;
    }>('/api/schedules'),
  createSchedule: (body: {
    name: string;
    everyMinutes: number;
    jobType: string;
    hostIds?: string[] | null;
    payload?: Record<string, unknown>;
    enabled?: boolean;
  }) => request<unknown>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  deleteSchedule: (id: string) =>
    request<{ deleted: boolean }>(`/api/schedules/${id}`, { method: 'DELETE' }),
};
