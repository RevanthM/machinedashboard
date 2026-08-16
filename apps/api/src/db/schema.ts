/**
 * Schema per PRD §7, with the additions Appendix B identified as necessary to
 * ingest the real inventory file (hostname, known_host_key, public_key).
 *
 * Invariant: no column in this file ever holds a secret. Passwords, key
 * passphrases, sudo passwords and RDP credentials live in the vault
 * (src/secrets/) and are referenced here only by the host id that owns them.
 * `apps/api/src/db/no-secrets.test.ts` enforces this against a real DB file.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch())`;

/** Which mesh a host's overlay address came from. */
export type MeshProviderName = 'netbird' | 'tailscale' | 'none';

/** Coarse OS family. `auto` is resolved during detect_os and never persisted. */
export type OsFamily = 'ubuntu' | 'debian' | 'windows' | 'macos';

export const hosts = sqliteTable(
  'hosts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Operator-facing alias; inventory `name` stays stable for imports. */
    nickname: text('nickname'),

    /** Bootstrap address from the inventory: LAN IP or DNS name. */
    host: text('host'),
    /** Reported hostname. Primary key for matching mesh peers (Appendix B). */
    hostname: text('hostname'),
    sshPort: integer('ssh_port').notNull().default(22),

    os: text('os').$type<OsFamily>(),
    osVersion: text('os_version'),
    /** Windows edition decides RDP vs VNC — Home has no RDP host (Appendix D). */
    osEdition: text('os_edition'),

    username: text('username').notNull(),
    authMethod: text('auth_method').$type<'password' | 'key' | 'agent'>().notNull().default('key'),
    /** Path on the operator machine. Key material itself is never stored here. */
    keyPath: text('key_path'),
    /** Public key from the inventory, used to disambiguate mesh peer matching. */
    publicKey: text('public_key'),
    /** Pinned host key (TOFU). Seeded from the sheet where present. */
    knownHostKey: text('known_host_key'),

    /**
     * True when this record is the machine running Fleet Console. Such a host
     * uses LocalTransport rather than SSH-ing to itself.
     */
    isSelf: integer('is_self', { mode: 'boolean' }).notNull().default(false),

    meshProvider: text('mesh_provider').$type<MeshProviderName>().notNull().default('none'),
    meshIp: text('mesh_ip'),
    meshPeerId: text('mesh_peer_id'),
    meshStatus: text('mesh_status').$type<'connected' | 'disconnected' | 'unknown'>().notNull().default('unknown'),
    meshLastSeenAt: integer('mesh_last_seen_at'),

    rdpProtocol: text('rdp_protocol').$type<'rdp' | 'vnc'>(),
    rdpPort: integer('rdp_port'),
    rdpUsername: text('rdp_username'),

    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    enableOllama: integer('enable_ollama', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),

    status: text('status')
      .$type<'unknown' | 'online' | 'unreachable' | 'auth_failed' | 'error'>()
      .notNull()
      .default('unknown'),
    /** Last successful SSH/telemetry contact (unix seconds). */
    lastSeenAt: integer('last_seen_at'),
    /** Last SSH probe or telemetry attempt, success or fail (unix seconds). */
    lastCheckedAt: integer('last_checked_at'),
    lastError: text('last_error'),

    provisionState: text('provision_state')
      .$type<'unprovisioned' | 'in_progress' | 'provisioned' | 'failed' | 'llm_unsupported'>()
      .notNull()
      .default('unprovisioned'),

    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    // Import upserts on name (PRD §F1: re-import updates rather than duplicates).
    uniqueIndex('hosts_name_uniq').on(t.name),
    index('hosts_mesh_ip_idx').on(t.meshIp),
    index('hosts_hostname_idx').on(t.hostname),
  ],
);

export const hostSpecs = sqliteTable('host_specs', {
  hostId: text('host_id')
    .primaryKey()
    .references(() => hosts.id, { onDelete: 'cascade' }),
  cpuModel: text('cpu_model'),
  cpuCores: integer('cpu_cores'),
  cpuThreads: integer('cpu_threads'),
  cpuMhz: real('cpu_mhz'),
  ramTotalGb: real('ram_total_gb'),
  ramFreeGb: real('ram_free_gb'),
  gpu: text('gpu_json', { mode: 'json' }).$type<GpuInfo[]>(),
  storage: text('storage_json', { mode: 'json' }).$type<StorageMount[]>(),
  osKernel: text('os_kernel'),
  uptimeS: integer('uptime_s'),
  collectedAt: integer('collected_at').notNull().default(now),
});

export interface GpuInfo {
  model: string;
  vramMb?: number;
  driver?: string;
  cuda?: string;
  /** Which Ollama backend this GPU implies. */
  backend?: 'cuda' | 'metal' | 'rocm' | 'cpu';
}

export interface StorageMount {
  mount: string;
  fs?: string;
  totalBytes: number;
  freeBytes: number;
}

export const hostMetrics = sqliteTable(
  'host_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull().default(now),
    cpuPct: real('cpu_pct'),
    ramPct: real('ram_pct'),
    diskPct: real('disk_pct'),
    netRxBps: real('net_rx_bps'),
    netTxBps: real('net_tx_bps'),
    gpuUtilPct: real('gpu_util_pct'),
    gpuMemUsedMb: real('gpu_mem_used_mb'),
    gpuTempC: real('gpu_temp_c'),
  },
  // Rolling 24h window; the retention job deletes by (host_id, ts).
  (t) => [index('host_metrics_host_ts_idx').on(t.hostId, t.ts)],
);

export const llmBenchmarks = sqliteTable(
  'llm_benchmarks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull().default(now),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens'),
    evalTokens: integer('eval_tokens'),
    ttftMs: real('ttft_ms'),
    evalTps: real('eval_tps'),
    promptTps: real('prompt_tps'),
    totalMs: real('total_ms'),
    loadMs: real('load_ms'),
    /** Pinned per PRD §F5 so numbers are comparable across hosts. */
    numCtx: integer('num_ctx'),
    quant: text('quant'),
    backend: text('backend').$type<'cuda' | 'metal' | 'rocm' | 'cpu'>(),
  },
  (t) => [
    index('llm_benchmarks_host_ts_idx').on(t.hostId, t.ts),
    index('llm_benchmarks_eval_tps_idx').on(t.evalTps),
  ],
);

export const provisionRuns = sqliteTable(
  'provision_runs',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    status: text('status')
      .$type<'pending' | 'running' | 'ok' | 'failed' | 'skipped'>()
      .notNull()
      .default('pending'),
    /** Already passed through the secret scrubber before it lands here. */
    stdout: text('stdout'),
    stderr: text('stderr'),
    exitCode: integer('exit_code'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
  },
  (t) => [index('provision_runs_host_idx').on(t.hostId, t.startedAt)],
);

export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  hostId: text('host_id')
    .notNull()
    .references(() => hosts.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: integer('created_at').notNull().default(now),
});

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant' | 'tool' | 'system'>().notNull(),
    content: text('content'),
    toolCalls: text('tool_calls_json', { mode: 'json' }),
    attachments: text('attachments_json', { mode: 'json' }),
    ts: integer('ts').notNull().default(now),
  },
  (t) => [index('chat_messages_session_idx').on(t.sessionId, t.ts)],
);

/**
 * Every command executed on a managed host, whichever path invoked it —
 * terminal, one-shot exec, provisioner, or an approved agent tool call.
 * Append-only by convention; nothing in the app issues UPDATE or DELETE here.
 */
export const commandAudit = sqliteTable(
  'command_audit',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    source: text('source')
      .$type<'terminal' | 'exec' | 'provision' | 'agent'>()
      .notNull(),
    command: text('command').notNull(),
    /** How the approval gate resolved: which mode allowed it through. */
    approvedBy: text('approved_by').$type<'operator' | 'allowlist' | 'auto' | 'denied'>(),
    exitCode: integer('exit_code'),
    stdoutHead: text('stdout_head'),
    stderrHead: text('stderr_head'),
    ranAt: integer('ran_at').notNull().default(now),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('command_audit_host_idx').on(t.hostId, t.ranAt)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
  updatedAt: integer('updated_at').notNull().default(now),
});

/** Factory-wide chat (not tied to a single host until a turn resolves one). */
export const factoryChatSessions = sqliteTable('factory_chat_sessions', {
  id: text('id').primaryKey(),
  title: text('title'),
  createdAt: integer('created_at').notNull().default(now),
});

export const factoryChatMessages = sqliteTable(
  'factory_chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => factoryChatSessions.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant' | 'system'>().notNull(),
    content: text('content'),
    /** Host(s) this turn targeted, if any. */
    hostIds: text('host_ids_json', { mode: 'json' }).$type<string[]>(),
    jobId: text('job_id'),
    attachments: text('attachments_json', { mode: 'json' }),
    ts: integer('ts').notNull().default(now),
  },
  (t) => [index('factory_chat_messages_session_idx').on(t.sessionId, t.ts)],
);

export type JobType = 'agent' | 'exec' | 'benchmark' | 'provision' | 'probe';
export type JobStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').$type<JobType>().notNull(),
    title: text('title').notNull(),
    /** Agent prompt, shell command, etc. */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    createdAt: integer('created_at').notNull().default(now),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    error: text('error'),
  },
  (t) => [index('jobs_status_idx').on(t.status, t.createdAt)],
);

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    result: text('result_text'),
    artifacts: text('artifacts_json', { mode: 'json' }).$type<
      Array<{ id: string; filename: string; kind: string; url: string; bytes?: number }>
    >(),
    error: text('error'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
  },
  (t) => [index('job_runs_job_idx').on(t.jobId), index('job_runs_host_idx').on(t.hostId)],
);

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  everyMinutes: integer('every_minutes').notNull().default(60),
  jobType: text('job_type').$type<JobType>().notNull(),
  /** Optional host id list; empty/null = all online hosts. */
  hostIds: text('host_ids_json', { mode: 'json' }).$type<string[] | null>(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  lastRunAt: integer('last_run_at'),
  nextRunAt: integer('next_run_at'),
  createdAt: integer('created_at').notNull().default(now),
});

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type HostSpecs = typeof hostSpecs.$inferSelect;
export type LlmBenchmark = typeof llmBenchmarks.$inferSelect;
export type ProvisionRun = typeof provisionRuns.$inferSelect;
export type CommandAuditRow = typeof commandAudit.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
