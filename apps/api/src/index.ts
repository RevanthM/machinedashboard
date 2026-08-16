// Must stay first — populates process.env before config.ts snapshots it.
import './env.js';

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { asc, desc, eq, gte } from 'drizzle-orm';
import Fastify from 'fastify';

import {
  buildUserMessage,
  resumeAfterApproval,
  runAgentTurn,
  systemPrompt,
  type Attachment,
  type ChatMessage,
} from './agent/loop.js';
import type { ApprovalMode } from './agent/gate.js';
import { type ToolCall, type ToolContext, type ToolPreview } from './agent/tools.js';
import {
  contentTypeFor,
  readAttachmentMeta,
  writeAttachment,
  type ChatAttachmentRef,
} from './agent/attachments.js';
import { detectBackend, isOllamaHealthy, runBenchmark } from './bench/ollama.js';
import { refreshSpecs, TelemetryPoller } from './collect/poller.js';
import { assertSafeConfig, config } from './config.js';
import { getDb } from './db/client.js';
import {
  chatMessages,
  chatSessions,
  commandAudit,
  factoryChatMessages,
  factoryChatSessions,
  hostMetrics,
  hostSpecs,
  hosts,
  jobRuns,
  jobs,
  llmBenchmarks,
  provisionRuns,
  schedules,
  settings,
  type Host,
} from './db/schema.js';
import { GuacTokenService } from './guac/token.js';
import { checkTcpReachable, openShim } from './guac/shim.js';
import { defaultSettings, GuacTunnel } from './guac/tunnel.js';
import { commitInventory } from './inventory/commit.js';
import { INLINE_KEY_WARNING } from './inventory/keys.js';
import { parseInventory, type ParsedRow } from './inventory/parse.js';
import {
  createMeshProvider,
  createMigrationWitness,
  normalizeHostname,
  type MeshPeer,
} from './mesh/index.js';
import { reconcileMesh } from './mesh/reconcile.js';
import { DryRunTransport, isDryRun } from './provision/dry-run.js';
import { runProvisioning } from './provision/engine.js';
import { probeAndRecord } from './hosts/probe.js';
import { displayName } from './hosts/display.js';
import { activeAddress, describeHostLlm, getTransport, loadHost, ollamaUrl } from './hosts/service.js';
import {
  createFactorySession,
  getFactoryThread,
  handleFactoryChatMessage,
  listFactorySessions,
} from './factory/chat.js';
import { createJob, getJobBundle, routeJobHost, runJob, type JobRunnerDeps } from './factory/jobs.js';
import { startScheduler, upsertSchedule } from './factory/scheduler.js';
import { Scrubber } from './secrets/scrub.js';
import { AesFileVault } from './secrets/vault.js';
import { recordingEnabled, SessionRecorder } from './terminal/recorder.js';
import { TransportPool } from './transport/pool.js';

assertSafeConfig();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});

await app.register(websocket);
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024 }, // N-14
});

const { db } = getDb();
const vault = new AesFileVault(config.vaultPath, config.vaultPassphrase);
const scrubber = new Scrubber({
  literals: [...vault.allValues(), config.mesh.netbirdSetupKey, config.mesh.netbirdPat].filter(
    Boolean,
  ) as string[],
});
const mesh = createMeshProvider(config.mesh);
const witness = createMigrationWitness(config.mesh);
const pool = new TransportPool();
const guacTokens = config.guac.tokenSecret ? new GuacTokenService(config.guac.tokenSecret) : null;

/**
 * The desktop tunnel runs on its own loopback HTTP server (default :8081)
 * rather than sharing Fastify's — @fastify/websocket and guacamole-lite each
 * install an `upgrade` handler, and two on one server steal each other's
 * connections. Vite proxies /guac to it.
 */
const tunnel = new GuacTunnel({
  port: Number(process.env.GUAC_WS_PORT ?? 8081),
  guacdHost: config.guac.host,
  guacdPort: config.guac.port,
  cryptKey: config.guac.tokenSecret || 'fleet-console-dev-key-not-for-real-use',
  onLog: (message) => app.log.debug({ guac: message }),
});

for (const dir of [config.keysDir, config.attachmentsDir, config.recordingsDir]) {
  mkdirSync(dir, { recursive: true });
}

const ctx = { db, vault, pool };

// --- live event fan-out ------------------------------------------------------

type Subscriber = (event: unknown) => void;
const subscribers = new Set<Subscriber>();

function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const send of subscribers) {
    try {
      send(payload);
    } catch {
      // A dead socket is removed by its own close handler.
    }
  }
}

function toSafeRow(row: ParsedRow) {
  const { inlinePrivateKey, secrets, ...rest } = row;
  return {
    ...rest,
    hasInlinePrivateKey: Boolean(inlinePrivateKey),
    hasStoredSecrets: Object.values(secrets).some(Boolean),
  };
}

// --- health & debug ----------------------------------------------------------

app.get('/api/health', async () => ({
  ok: true,
  fleetHome: config.fleetHome,
  meshProvider: mesh.name,
  dryRun: isDryRun(),
}));

/** PRD §14 requires pool state be inspectable. */
app.get('/api/debug/pool', async () => pool.stats());

// --- mesh --------------------------------------------------------------------

app.get('/api/mesh/health', async () => mesh.healthCheck());

app.get('/api/mesh/peers', async () => {
  const health = await mesh.healthCheck();
  return { provider: mesh.name, health, peers: health.reachable ? await mesh.listPeers() : [] };
});

app.get('/api/mesh/migration', async () => {
  if (!witness) return { migrating: false, stranded: [], note: 'No secondary mesh configured.' };

  const [primaryHealth, witnessHealth] = await Promise.all([
    mesh.healthCheck(),
    witness.healthCheck(),
  ]);
  const primaryPeers: MeshPeer[] = primaryHealth.reachable ? await mesh.listPeers() : [];
  const legacyPeers: MeshPeer[] = witnessHealth.reachable ? await witness.listPeers() : [];

  const covered = new Set(primaryPeers.map((p) => normalizeHostname(p.hostname)));
  const stranded = legacyPeers.filter((p) => !covered.has(normalizeHostname(p.hostname)));

  return {
    migrating: legacyPeers.length > 0,
    primary: { provider: mesh.name, reachable: primaryHealth.reachable, peers: primaryPeers },
    legacy: { provider: witness.name, reachable: witnessHealth.reachable, peers: legacyPeers },
    stranded,
    safeToRemoveLegacy: legacyPeers.length > 0 && stranded.length === 0,
  };
});

async function reconcileAll() {
  const legacy = witness ? await reconcileMesh(db, witness) : null;
  const primary = await reconcileMesh(db, mesh);
  return { legacy, primary };
}

app.post('/api/mesh/reconcile', async () => reconcileAll());

// --- hosts -------------------------------------------------------------------

app.get('/api/hosts', async () => {
  const rows = await db.select().from(hosts);
  const specs = await db.select().from(hostSpecs);
  const specById = new Map(specs.map((s) => [s.hostId, s]));

  // Latest benchmark per host, for the tok/s figure on each card.
  const benches = await db.select().from(llmBenchmarks).orderBy(desc(llmBenchmarks.ts));
  const benchById = new Map<string, (typeof benches)[number]>();
  for (const b of benches) if (!benchById.has(b.hostId)) benchById.set(b.hostId, b);

  const llmInfos = await Promise.all(rows.map((host) => describeHostLlm(host)));

  return {
    hosts: rows.map((host, i) => ({
      ...host,
      displayName: displayName(host),
      activeAddress: activeAddress(host),
      specs: specById.get(host.id) ?? null,
      latestBenchmark: benchById.get(host.id) ?? null,
      llm: llmInfos[i]!,
    })),
  };
});

app.get('/api/hosts/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const host = await loadHost(db, id);
    const specs = await db.select().from(hostSpecs).where(eq(hostSpecs.hostId, id)).limit(1);
    const benches = await db
      .select()
      .from(llmBenchmarks)
      .where(eq(llmBenchmarks.hostId, id))
      .orderBy(desc(llmBenchmarks.ts))
      .limit(24);
    const llm = await describeHostLlm(host);
    return {
      ...host,
      displayName: displayName(host),
      activeAddress: activeAddress(host),
      specs: specs[0] ?? null,
      benchmarks: benches,
      latestBenchmark: benches[0] ?? null,
      llm,
    };
  } catch (err) {
    return reply.status(404).send({ error: (err as Error).message });
  }
});

app.patch('/api/hosts/:id', async (request) => {
  const { id } = request.params as { id: string };
  const body = request.body as Partial<Host> & { nickname?: string | null };
  const allowed = {
    name: body.name,
    nickname: body.nickname === undefined ? undefined : body.nickname?.trim() || null,
    host: body.host,
    hostname: body.hostname,
    sshPort: body.sshPort,
    username: body.username,
    tags: body.tags,
    enableOllama: body.enableOllama,
    notes: body.notes,
    rdpPort: body.rdpPort,
    rdpUsername: body.rdpUsername,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await db.update(hosts).set(clean(allowed)).where(eq(hosts.id, id));
  // The address may have changed; drop any pooled connection to the old one.
  await pool.invalidate(id);
  const host = await loadHost(db, id);
  return { ...host, displayName: displayName(host) };
});

app.delete('/api/hosts/:id', async (request) => {
  const { id } = request.params as { id: string };
  await pool.invalidate(id);
  vault.deleteHost(id);
  await db.delete(hosts).where(eq(hosts.id, id));
  return { deleted: true };
});

app.post('/api/hosts/:id/probe', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const host = await loadHost(db, id);
    const result = await probeAndRecord(ctx, host);
    broadcast({ type: 'probe', hostId: id, result });
    return result;
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

app.post('/api/hosts/probe-all', async () => {
  const rows = await db.select().from(hosts);
  const results = await Promise.all(
    rows.map(async (host) => {
      try {
        return await probeAndRecord(ctx, host);
      } catch (err) {
        return { hostId: host.id, name: host.name, ok: false, error: (err as Error).message };
      }
    }),
  );
  broadcast({ type: 'probe', results });
  return { results };
});

// --- provisioning ------------------------------------------------------------

app.post('/api/hosts/:id/provision', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = (request.body ?? {}) as { steps?: string[]; force?: boolean; dryRun?: boolean };

  try {
    const host = await loadHost(db, id);
    const dryRun = body.dryRun ?? isDryRun();
    const transport = dryRun
      ? new DryRunTransport(host.os ?? 'ubuntu')
      : await getTransport(ctx, host);

    const report = await runProvisioning({
      db,
      host,
      transport,
      mesh,
      scrubber,
      only: body.steps,
      force: body.force,
      onEvent: (event) => broadcast({ ...event, type: `provision_${event.type}`, hostId: id }),
    });

    // Specs are collected after provisioning so the dashboard fills in without
    // waiting for the next telemetry tick.
    if (!dryRun && report.ok) {
      try {
        await refreshSpecs(db, host, transport);
      } catch (err) {
        app.log.warn({ err }, 'spec refresh after provisioning failed');
      }
    }

    return report;
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

app.get('/api/hosts/:id/provision/runs', async (request) => {
  const { id } = request.params as { id: string };
  return {
    runs: await db
      .select()
      .from(provisionRuns)
      .where(eq(provisionRuns.hostId, id))
      .orderBy(desc(provisionRuns.startedAt))
      .limit(200),
  };
});

// --- exec (audited one-shot) -------------------------------------------------

app.post('/api/hosts/:id/exec', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { command, timeoutMs } = request.body as { command: string; timeoutMs?: number };
  if (!command) return reply.status(400).send({ error: 'command is required' });

  try {
    const host = await loadHost(db, id);
    const transport = await getTransport(ctx, host);
    const started = Date.now();
    const result = await transport.exec(command, { timeoutMs: timeoutMs ?? 60_000 });

    await db.insert(commandAudit).values({
      id: randomUUID(),
      hostId: id,
      source: 'exec',
      command: scrubber.scrub(command),
      approvedBy: 'operator',
      exitCode: result.exitCode,
      stdoutHead: scrubber.scrub(result.stdout).slice(0, 4000),
      stderrHead: scrubber.scrub(result.stderr).slice(0, 4000),
      durationMs: Date.now() - started,
    });

    return {
      stdout: scrubber.scrub(result.stdout),
      stderr: scrubber.scrub(result.stderr),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

// --- specs & metrics ---------------------------------------------------------

app.get('/api/hosts/:id/specs', async (request) => {
  const { id } = request.params as { id: string };
  const rows = await db.select().from(hostSpecs).where(eq(hostSpecs.hostId, id)).limit(1);
  return rows[0] ?? null;
});

app.post('/api/hosts/:id/specs/refresh', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const host = await loadHost(db, id);
    await refreshSpecs(db, host, await getTransport(ctx, host));
    return { refreshed: true };
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

app.get('/api/hosts/:id/metrics', async (request) => {
  const { id } = request.params as { id: string };
  const { since } = request.query as { since?: string };
  const sinceSec = since ? Number(since) : Math.floor(Date.now() / 1000) - 24 * 3600;
  return {
    metrics: await db
      .select()
      .from(hostMetrics)
      .where(eq(hostMetrics.hostId, id))
      .orderBy(desc(hostMetrics.ts))
      .limit(2000)
      .then((rows) => rows.filter((r) => r.ts >= sinceSec).reverse()),
  };
});

// --- benchmarks --------------------------------------------------------------

app.post('/api/hosts/:id/benchmark', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = (request.body ?? {}) as { model?: string };

  try {
    const host = await loadHost(db, id);
    const baseUrl = ollamaUrl(host);
    if (!baseUrl) return reply.status(400).send({ error: 'Host has no reachable address.' });

    if (!(await isOllamaHealthy(baseUrl))) {
      return reply.status(400).send({
        error:
          `Ollama is not answering on ${baseUrl}. Provision the host, or check that ` +
          `OLLAMA_HOST binds beyond loopback so it is reachable over the mesh.`,
      });
    }

    const specs = await db.select().from(hostSpecs).where(eq(hostSpecs.hostId, id)).limit(1);
    const gpu = specs[0]?.gpu ?? [];
    const model = body.model ?? config.ollamaModel;

    // Warm/detect after the suite so /api/ps reflects the loaded model. Pre-run
    // detection often sees an empty process list and, on Metal, historically
    // mis-labeled the host as CPU.
    const result = await runBenchmark({
      baseUrl,
      model,
      backend: gpu[0]?.backend,
      onProgress: (message) => broadcast({ type: 'benchmark_progress', hostId: id, message }),
    });
    const backend = await detectBackend(baseUrl, gpu);
    result.backend = backend;

    await db.insert(llmBenchmarks).values({
      hostId: id,
      model: result.model,
      promptTokens: result.promptTokens ?? null,
      evalTokens: result.evalTokens ?? null,
      ttftMs: result.ttftMs ?? null,
      evalTps: result.evalTps ?? null,
      promptTps: result.promptTps ?? null,
      totalMs: result.totalMs ?? null,
      loadMs: result.loadMs ?? null,
      numCtx: result.numCtx,
      quant: null,
      backend: result.backend ?? null,
    });

    broadcast({ type: 'benchmark_done', hostId: id, result });
    return result;
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

app.get('/api/hosts/:id/benchmarks', async (request) => {
  const { id } = request.params as { id: string };
  return {
    benchmarks: await db
      .select()
      .from(llmBenchmarks)
      .where(eq(llmBenchmarks.hostId, id))
      .orderBy(desc(llmBenchmarks.ts))
      .limit(100),
  };
});

/** R-21: fleet ranked by eval tok/s, grouped by backend. */
app.get('/api/leaderboard', async () => {
  const rows = await db.select().from(hosts);
  const benches = await db.select().from(llmBenchmarks).orderBy(desc(llmBenchmarks.ts));

  const latest = new Map<string, (typeof benches)[number]>();
  for (const b of benches) if (!latest.has(b.hostId)) latest.set(b.hostId, b);

  const entries = rows
    .map((host) => {
      const bench = latest.get(host.id);
      if (!bench) return null;
      return {
        hostId: host.id,
        name: displayName(host),
        os: host.os,
        model: bench.model,
        backend: bench.backend ?? 'cpu',
        evalTps: bench.evalTps,
        promptTps: bench.promptTps,
        ttftMs: bench.ttftMs,
        numCtx: bench.numCtx,
        ts: bench.ts,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => (b.evalTps ?? 0) - (a.evalTps ?? 0));

  const byBackend: Record<string, typeof entries> = {};
  for (const entry of entries) {
    (byBackend[entry.backend] ??= []).push(entry);
  }

  return { entries, byBackend };
});

// --- remote desktop (F8) -----------------------------------------------------

/**
 * Preflight for PRD §14 risk #1. Reports whether guacd can reach the host
 * directly, and whether the loopback shim is required — before anyone opens a
 * session that would otherwise just hang.
 */
app.get('/api/hosts/:id/rdp/preflight', async (request, reply) => {
  const { id } = request.params as { id: string };
  const host = await loadHost(db, id);
  const resolved = activeAddress(host);
  if (!resolved) return reply.status(400).send({ error: 'Host has no reachable address.' });

  const port = host.rdpPort ?? (host.rdpProtocol === 'vnc' ? 5900 : 3389);
  const [guacdUp, hostReachable] = await Promise.all([
    checkTcpReachable(config.guac.host, config.guac.port, 3000),
    checkTcpReachable(resolved.address, port, 4000),
  ]);

  return {
    guacdReachable: guacdUp,
    hostDesktopReachable: hostReachable,
    protocol: host.rdpProtocol,
    address: resolved.address,
    port,
    shimRequired: true,
    note: guacdUp
      ? undefined
      : `guacd is not answering on ${config.guac.host}:${config.guac.port}. ` +
        `Start it with: docker compose -f deploy/guacd/docker-compose.yml up -d`,
  };
});

app.post('/api/hosts/:id/rdp/session', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!guacTokens) {
    return reply.status(500).send({
      error: 'GUAC_TOKEN_SECRET is not set. Generate one and add it to .env.',
    });
  }

  try {
    const host = await loadHost(db, id);
    const resolved = activeAddress(host);
    if (!resolved) return reply.status(400).send({ error: 'Host has no reachable address.' });

    const port = host.rdpPort ?? (host.rdpProtocol === 'vnc' ? 5900 : 3389);
    const protocol = host.rdpProtocol === 'vnc' ? 'vnc' : 'rdp';

    // guacd cannot route to mesh addresses from inside Docker on this platform,
    // so it is handed a loopback shim instead (see guac/shim.ts). The shim is
    // single-use and self-closing, which is what makes the token below safe to
    // hand to a browser.
    const shim = await openShim({
      targetHost: resolved.address,
      targetPort: port,
      onClose: (reason) => app.log.info({ hostId: id, reason }, 'rdp shim closed'),
    });

    const settings = defaultSettings(protocol, {
      hostname: config.guac.advertiseHost,
      port: shim.port,
      username: host.rdpUsername ?? host.username,
      password: vault.get(id, 'rdp_password') ?? undefined,
    });

    // Credentials stay server-side; the browser only ever holds the token, and
    // the token only points at a shim that dies after one connection.
    return {
      token: tunnel.encodeToken(protocol, settings),
      expiresAt: Date.now() + 60_000,
      protocol,
      shimPort: shim.port,
    };
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

/** R-27: .rdp file for a native client, when fidelity matters. */
app.get('/api/hosts/:id/rdp/file', async (request, reply) => {
  const { id } = request.params as { id: string };
  const host = await loadHost(db, id);
  const resolved = activeAddress(host);
  if (!resolved) return reply.status(400).send({ error: 'Host has no reachable address.' });

  const body = [
    `full address:s:${resolved.address}:${host.rdpPort ?? 3389}`,
    `username:s:${host.rdpUsername ?? host.username}`,
    'screen mode id:i:2',
    'authentication level:i:0',
    'prompt for credentials:i:1',
  ].join('\r\n');

  return reply
    .header('Content-Type', 'application/x-rdp')
    .header('Content-Disposition', `attachment; filename="${host.name.replace(/[^\w.-]/g, '_')}.rdp"`)
    .send(body);
});

// --- inventory ---------------------------------------------------------------

app.post('/api/inventory/parse', async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.status(400).send({ error: 'No file uploaded.' });
  const result = parseInventory(await file.toBuffer(), file.filename);
  return { ...result, rows: result.rows.map(toSafeRow) };
});

app.post('/api/inventory/commit', async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.status(400).send({ error: 'No file uploaded.' });

  const skipRaw = (request.query as { skip?: string }).skip ?? '';
  const skipRowNumbers = skipRaw
    .split(',')
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter(Number.isFinite);

  const parsed = parseInventory(await file.toBuffer(), file.filename);
  const result = await commitInventory(parsed.rows, {
    db,
    vault,
    keysDir: config.keysDir,
    skipRowNumbers,
  });

  // New secrets exist, so the scrubber's literal list is stale.
  scrubber.setLiterals([
    ...vault.allValues(),
    config.mesh.netbirdSetupKey,
    config.mesh.netbirdPat,
  ].filter(Boolean) as string[]);

  return {
    committed: result.committed.map((c) => ({
      rowNumber: c.rowNumber,
      hostId: c.hostId,
      name: c.name,
      action: c.action,
      key: c.keyWritten
        ? {
            path: c.keyWritten.path,
            type: c.keyWritten.keyType,
            wasWellFormed: c.keyWritten.wasWellFormed,
            validated: c.keyWritten.validated,
          }
        : null,
      warnings: c.warnings,
    })),
    skipped: result.skipped,
    hasInlineKeys: parsed.hasInlineKeys,
    inlineKeyWarning: parsed.hasInlineKeys ? INLINE_KEY_WARNING : null,
  };
});

// --- attachments (R-29, N-14) ------------------------------------------------

app.post('/api/attachments', async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.status(400).send({ error: 'No file uploaded.' });

  const buffer = await file.toBuffer();
  const id = randomUUID();
  // Quarantine directory, original name preserved only as metadata — the file
  // on disk is named by id so a crafted filename cannot traverse or execute.
  const ref = writeAttachment(config.attachmentsDir, id, buffer, file.filename);

  return {
    id: ref.id,
    filename: ref.filename,
    bytes: ref.bytes,
    kind: ref.kind,
    inlineable: ref.kind === 'text',
    url: ref.url,
  };
});

app.get('/api/attachments/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return reply.status(400).send({ error: 'Invalid attachment id.' });
  }
  const path = join(config.attachmentsDir, id);
  if (!existsSync(path)) return reply.status(404).send({ error: 'Attachment not found.' });
  const meta = readAttachmentMeta(config.attachmentsDir, id);
  const filename = meta?.filename ?? id;
  const type = meta?.contentType ?? contentTypeFor(filename, meta?.kind ?? 'binary');
  reply.header('Content-Type', type);
  reply.header('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
  return reply.send(createReadStream(path));
});

// --- audit (R-31) ------------------------------------------------------------

app.get('/api/audit', async (request) => {
  const { hostId, since, limit } = request.query as {
    hostId?: string;
    since?: string;
    limit?: string;
  };
  const rows = await db
    .select()
    .from(commandAudit)
    .where(hostId ? eq(commandAudit.hostId, hostId) : undefined)
    .orderBy(desc(commandAudit.ranAt))
    .limit(Math.min(Number(limit ?? 500), 2000));

  const sinceSec = since ? Number(since) : null;
  return { entries: sinceSec ? rows.filter((r) => r.ranAt >= sinceSec) : rows };
});

// --- settings ----------------------------------------------------------------

app.get('/api/settings', async () => {
  const rows = await db.select().from(settings);
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    ...values,
    // Non-secret runtime config, so the UI can show what is in effect.
    meshProvider: config.mesh.provider,
    netbirdMgmtUrl: config.mesh.netbirdMgmtUrl,
    netbirdConfigured: Boolean(config.mesh.netbirdPat),
    telemetryPollMs: config.telemetryPollMs,
    ollamaModel: config.ollamaModel,
    approvalMode: config.agent.approvalMode,
    dryRun: isDryRun(),
  };
});

app.put('/api/settings', async (request) => {
  const body = request.body as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  for (const [key, value] of Object.entries(body)) {
    const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing.length > 0) {
      await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value, updatedAt: now });
    }
  }
  return { saved: true };
});

// --- chat sessions (per-host agent) ------------------------------------------

/** Pending tool calls waiting on operator approval, keyed by session id. */
const pendingApprovals = new Map<
  string,
  { call: ToolCall; messages: ChatMessage[]; preview: ToolPreview }
>();

async function resolveAgentModel(host: Host): Promise<{ baseUrl: string; model: string }> {
  const model = config.agent.model || config.ollamaModel;
  if (config.agent.modelBaseUrl) {
    return { baseUrl: config.agent.modelBaseUrl.replace(/\/+$/, ''), model };
  }
  const hostUrl = ollamaUrl(host);
  if (hostUrl && (await isOllamaHealthy(hostUrl))) {
    return { baseUrl: hostUrl, model };
  }
  // Fall back to the operator machine's Ollama so chat still works when the
  // target has SSH but no LLM — tools still execute on the selected host.
  const local = `http://127.0.0.1:${config.ollamaPort}`;
  if (await isOllamaHealthy(local)) {
    return { baseUrl: local, model };
  }
  throw new Error(
    hostUrl
      ? `No Ollama answering on ${hostUrl} or ${local}. Install/start Ollama, or set AGENT_MODEL_BASE_URL.`
      : `Host has no reachable address, and local Ollama at ${local} is down.`,
  );
}

async function buildToolContext(host: Host, sessionId: string): Promise<ToolContext> {
  const resolved = activeAddress(host);
  if (!resolved && !host.isSelf) {
    throw new Error(`Host ${host.name} has no reachable address.`);
  }
  const transport = await getTransport(ctx, host);
  return {
    db,
    host,
    hostAddress: resolved?.address ?? '127.0.0.1',
    transport,
    scrubber,
    mode: config.agent.approvalMode as ApprovalMode,
    sessionId,
    attachmentsDir: config.attachmentsDir,
    resolveAttachment: (id) => {
      const path = join(config.attachmentsDir, id);
      if (!existsSync(path)) return null;
      const meta = readAttachmentMeta(config.attachmentsDir, id);
      return { path, filename: meta?.filename ?? id };
    },
    getSpecs: async () => {
      const rows = await db.select().from(hostSpecs).where(eq(hostSpecs.hostId, host.id)).limit(1);
      return rows[0] ?? null;
    },
    getMetrics: async () => {
      const rows = await db
        .select()
        .from(llmBenchmarks)
        .where(eq(llmBenchmarks.hostId, host.id))
        .orderBy(desc(llmBenchmarks.ts))
        .limit(5);
      return rows;
    },
  };
}

async function loadSessionHistory(sessionId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.ts));
  return rows.map((row) => ({
    role: row.role as ChatMessage['role'],
    content: row.content ?? '',
    ...(row.toolCalls
      ? { tool_calls: row.toolCalls as ChatMessage['tool_calls'] }
      : {}),
  }));
}

app.get('/api/chat/:hostId/sessions', async (request) => {
  const { hostId } = request.params as { hostId: string };
  const sessions = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.hostId, hostId))
    .orderBy(desc(chatSessions.createdAt));
  return { sessions };
});

app.post('/api/chat/:hostId/sessions', async (request) => {
  const { hostId } = request.params as { hostId: string };
  await loadHost(db, hostId);
  const id = randomUUID();
  const body = (request.body as { title?: string } | null) ?? {};
  await db.insert(chatSessions).values({
    id,
    hostId,
    title: body.title?.trim() || 'New chat',
  });
  return { id, hostId };
});

app.get('/api/chat/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session) return reply.status(404).send({ error: 'Session not found.' });

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.ts));

  const pending = pendingApprovals.get(sessionId)?.preview ?? null;
  return { session, messages, pending };
});

app.post('/api/chat/sessions/:sessionId/messages', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as { text?: string; attachmentIds?: string[] };
  const text = body?.text?.trim() ?? '';
  const attachmentIds = Array.isArray(body?.attachmentIds)
    ? body.attachmentIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  if (!text && attachmentIds.length === 0) {
    return reply.status(400).send({ error: 'Message text or attachments are required.' });
  }

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session) return reply.status(404).send({ error: 'Session not found.' });
  if (pendingApprovals.has(sessionId)) {
    return reply
      .status(409)
      .send({ error: 'A tool call is waiting for approval. Approve or deny it first.' });
  }

  const host = await loadHost(db, session.hostId);
  const { baseUrl, model } = await resolveAgentModel(host);
  const toolCtx = await buildToolContext(host, sessionId);

  const history = await loadSessionHistory(sessionId);
  const sys = systemPrompt(host.name, host.os ?? 'unknown');
  if (history.length === 0 || history[0]?.role !== 'system') {
    history.unshift({ role: 'system', content: sys });
  }

  let resolved: Attachment[] = [];
  try {
    resolved = resolveChatAttachments(attachmentIds);
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }

  const displayText =
    text ||
    (resolved.length === 1
      ? `Attached ${resolved[0]!.filename}`
      : `Attached ${resolved.length} files`);

  const built = buildUserMessage(displayText, resolved);
  history.push(built.message);

  const attachmentRefs: ChatAttachmentRef[] = resolved.map((a) => ({
    id: a.id,
    filename: a.filename,
    kind: a.kind,
    url: `/api/attachments/${a.id}`,
    bytes: (() => {
      try {
        return statSyncSafe(a.path);
      } catch {
        return 0;
      }
    })(),
  }));

  await db.insert(chatMessages).values({
    id: randomUUID(),
    sessionId,
    role: 'user',
    content: displayText,
    attachments: attachmentRefs.length > 0 ? attachmentRefs : null,
  });

  try {
    const result = await runAgentTurn(
      { db, sessionId, toolCtx, baseUrl, model },
      history,
    );

    if (result.pending.length > 0) {
      const preview = result.pending[0]!;
      // Recover the tool call the model just proposed from the last assistant
      // message — the preview carries callId, and args live in history.
      const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
      const raw = lastAssistant?.tool_calls?.[0];
      if (raw) {
        pendingApprovals.set(sessionId, {
          call: {
            id: preview.callId,
            name: raw.function.name as ToolCall['name'],
            args: raw.function.arguments ?? {},
          },
          messages: result.messages,
          preview,
        });
      }
    }

    return {
      finalText: result.finalText ?? null,
      pending: result.pending[0] ?? null,
      truncationNotice: built.notice ?? result.truncationNotice,
      model,
      baseUrl,
    };
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
});

app.post('/api/chat/sessions/:sessionId/approve', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const body = (request.body as { typedConfirmation?: string } | null) ?? {};
  const pending = pendingApprovals.get(sessionId);
  if (!pending) return reply.status(404).send({ error: 'No pending approval for this session.' });

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session) return reply.status(404).send({ error: 'Session not found.' });

  const host = await loadHost(db, session.hostId);
  const { baseUrl, model } = await resolveAgentModel(host);
  const toolCtx = await buildToolContext(host, sessionId);

  pendingApprovals.delete(sessionId);

  try {
    const result = await resumeAfterApproval(
      { db, sessionId, toolCtx, baseUrl, model },
      pending.messages,
      pending.call,
      'approve',
      body.typedConfirmation,
    );

    if (result.pending.length > 0) {
      const preview = result.pending[0]!;
      const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
      const raw = lastAssistant?.tool_calls?.[0];
      if (raw) {
        pendingApprovals.set(sessionId, {
          call: {
            id: preview.callId,
            name: raw.function.name as ToolCall['name'],
            args: raw.function.arguments ?? {},
          },
          messages: result.messages,
          preview,
        });
      }
    }

    return {
      finalText: result.finalText ?? null,
      pending: result.pending[0] ?? null,
    };
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
});

app.post('/api/chat/sessions/:sessionId/deny', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const pending = pendingApprovals.get(sessionId);
  if (!pending) return reply.status(404).send({ error: 'No pending approval for this session.' });

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session) return reply.status(404).send({ error: 'Session not found.' });

  const host = await loadHost(db, session.hostId);
  const { baseUrl, model } = await resolveAgentModel(host);
  const toolCtx = await buildToolContext(host, sessionId);

  pendingApprovals.delete(sessionId);

  try {
    const result = await resumeAfterApproval(
      { db, sessionId, toolCtx, baseUrl, model },
      pending.messages,
      pending.call,
      'deny',
    );

    if (result.pending.length > 0) {
      const preview = result.pending[0]!;
      const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
      const raw = lastAssistant?.tool_calls?.[0];
      if (raw) {
        pendingApprovals.set(sessionId, {
          call: {
            id: preview.callId,
            name: raw.function.name as ToolCall['name'],
            args: raw.function.arguments ?? {},
          },
          messages: result.messages,
          preview,
        });
      }
    }

    return {
      finalText: result.finalText ?? null,
      pending: result.pending[0] ?? null,
    };
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
});

// --- factory (fleet chat, jobs, schedules) -----------------------------------

function jobRunnerDeps(): JobRunnerDeps {
  return {
    db,
    loadHost: (id) => loadHost(db, id),
    buildToolContext,
    resolveAgentModel,
    execOnHost: async (host, command) => {
      const transport = await getTransport(ctx, host);
      return transport.exec(command, { timeoutMs: 120_000 });
    },
    probeHost: (host) => probeAndRecord(ctx, host),
    benchmarkHost: async (host) => {
      const url = ollamaUrl(host);
      if (!url) throw new Error('No Ollama URL for host');
      const specs = await db.select().from(hostSpecs).where(eq(hostSpecs.hostId, host.id)).limit(1);
      const result = await runBenchmark({
        baseUrl: url,
        model: config.ollamaModel,
        backend: specs[0]?.gpu?.[0]?.backend,
        onProgress: (message) =>
          broadcast({ type: 'benchmark_progress', hostId: host.id, message }),
      });
      const backend = await detectBackend(url, specs[0]?.gpu ?? []);
      result.backend = backend;
      await db.insert(llmBenchmarks).values({
        hostId: host.id,
        model: result.model,
        evalTps: result.evalTps,
        promptTps: result.promptTps,
        ttftMs: result.ttftMs,
        loadMs: result.loadMs,
        numCtx: result.numCtx,
        backend: result.backend,
      });
      return result;
    },
    broadcast,
  };
}

app.get('/api/factory/sessions', async () => {
  const sessions = await listFactorySessions(db);
  return { sessions };
});

app.post('/api/factory/sessions', async (request) => {
  const body = (request.body as { title?: string } | null) ?? {};
  return createFactorySession(db, body.title);
});

app.get('/api/factory/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const thread = await getFactoryThread(db, sessionId);
  if (!thread) return reply.status(404).send({ error: 'Session not found.' });
  return thread;
});

app.post('/api/factory/sessions/:sessionId/messages', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as { text?: string };
  const text = body?.text?.trim() ?? '';
  if (!text) return reply.status(400).send({ error: 'Message text is required.' });
  const thread = await getFactoryThread(db, sessionId);
  if (!thread) return reply.status(404).send({ error: 'Session not found.' });
  try {
    const result = await handleFactoryChatMessage(jobRunnerDeps(), sessionId, text);
    return result;
  } catch (err) {
    return reply.status(502).send({ error: (err as Error).message });
  }
});

app.get('/api/jobs', async () => {
  const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(100);
  const runs = await db.select().from(jobRuns);
  const runsByJob = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = runsByJob.get(r.jobId) ?? [];
    list.push(r);
    runsByJob.set(r.jobId, list);
  }
  return {
    jobs: rows.map((j) => ({ ...j, runs: runsByJob.get(j.id) ?? [] })),
  };
});

app.get('/api/jobs/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const bundle = await getJobBundle(db, id);
  if (!bundle) return reply.status(404).send({ error: 'Job not found.' });
  return bundle;
});

app.post('/api/jobs', async (request, reply) => {
  const body = request.body as {
    type?: 'agent' | 'exec' | 'benchmark' | 'provision' | 'probe';
    title?: string;
    hostIds?: string[];
    payload?: Record<string, unknown>;
    run?: boolean;
  };
  if (!body?.type || !body.hostIds?.length) {
    return reply.status(400).send({ error: 'type and hostIds[] are required.' });
  }
  try {
    const { jobId } = await createJob(db, {
      type: body.type,
      title: body.title?.trim() || `${body.type} job`,
      hostIds: body.hostIds,
      payload: body.payload ?? {},
    });
    if (body.run !== false) {
      // Await so the UI gets a completed result for short jobs; long jobs still OK.
      await runJob(jobRunnerDeps(), jobId);
    }
    return getJobBundle(db, jobId);
  } catch (err) {
    return reply.status(400).send({ error: (err as Error).message });
  }
});

app.post('/api/jobs/route', async (request, reply) => {
  const body = request.body as {
    os?: string;
    tag?: string;
    prefer?: 'evalTps' | 'freeVram' | 'online';
    type?: 'agent' | 'exec' | 'benchmark' | 'probe';
    title?: string;
    payload?: Record<string, unknown>;
    run?: boolean;
  };
  const inventory = await db.select().from(hosts);
  const picked = await routeJobHost(db, inventory, {
    os: body.os,
    tag: body.tag,
    prefer: body.prefer,
  });
  if (!picked) return reply.status(404).send({ error: 'No host matched routing criteria.' });
  if (!body.type) {
    return { host: { ...picked, displayName: displayName(picked) } };
  }
  const { jobId } = await createJob(db, {
    type: body.type,
    title: body.title?.trim() || `Routed ${body.type} → ${displayName(picked)}`,
    hostIds: [picked.id],
    payload: body.payload ?? {},
  });
  if (body.run !== false) await runJob(jobRunnerDeps(), jobId);
  return { host: { ...picked, displayName: displayName(picked) }, ...(await getJobBundle(db, jobId)) };
});

app.get('/api/schedules', async () => {
  const rows = await db.select().from(schedules).orderBy(desc(schedules.createdAt));
  return { schedules: rows };
});

app.post('/api/schedules', async (request, reply) => {
  const body = request.body as {
    id?: string;
    name?: string;
    everyMinutes?: number;
    jobType?: 'agent' | 'exec' | 'benchmark' | 'probe';
    hostIds?: string[] | null;
    payload?: Record<string, unknown>;
    enabled?: boolean;
  };
  if (!body?.name || !body.jobType || !body.everyMinutes) {
    return reply.status(400).send({ error: 'name, jobType, everyMinutes required.' });
  }
  const id = await upsertSchedule(db, {
    id: body.id,
    name: body.name,
    everyMinutes: body.everyMinutes,
    jobType: body.jobType,
    hostIds: body.hostIds,
    payload: body.payload,
    enabled: body.enabled,
  });
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  return row;
});

app.delete('/api/schedules/:id', async (request) => {
  const { id } = request.params as { id: string };
  await db.delete(schedules).where(eq(schedules.id, id));
  return { deleted: true };
});

// --- websockets --------------------------------------------------------------

app.get('/ws/events', { websocket: true }, (socket) => {
  const send: Subscriber = (payload) => socket.send(payload as string);
  subscribers.add(send);
  socket.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

  const heartbeat = setInterval(() => {
    socket.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
  }, 20_000);

  socket.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(send);
  });
});

/** R-23: interactive PTY bridged to xterm.js. */
app.get('/ws/terminal/:hostId', { websocket: true }, async (socket, request) => {
  const { hostId } = request.params as { hostId: string };

  try {
    const host = await loadHost(db, hostId);
    const transport = await getTransport(ctx, host);
    const session = await transport.shell({ cols: 120, rows: 30 });

    // R-24, off by default. Records output only — never keystrokes, which is
    // where passwords get typed.
    const recorder = recordingEnabled()
      ? new SessionRecorder({
          dir: config.recordingsDir,
          hostId: host.id,
          hostName: host.name,
          cols: 120,
          rows: 30,
          scrubber,
        })
      : null;

    session.onData((data) => {
      recorder?.writeOutput(data);
      socket.send(JSON.stringify({ type: 'data', data }));
    });
    session.onClose((code) => {
      socket.send(JSON.stringify({ type: 'exit', code }));
      socket.close();
    });

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as
          | { type: 'input'; data: string }
          | { type: 'resize'; cols: number; rows: number };
        if (msg.type === 'input') session.write(msg.data);
        // Propagates SIGWINCH so full-screen programs redraw (R-23).
        else if (msg.type === 'resize') {
          session.resize(msg.cols, msg.rows);
          recorder?.writeResize(msg.cols, msg.rows);
        }
      } catch {
        // Ignore malformed frames rather than tearing down the session.
      }
    });

    socket.on('close', () => {
      session.close();
      if (recorder) {
        const saved = recorder.close();
        app.log.info({ hostId, ...saved }, 'session recording saved');
      }
    });
  } catch (err) {
    socket.send(
      JSON.stringify({ type: 'error', message: (err as Error).message }),
    );
    socket.close();
  }
});

// --- startup -----------------------------------------------------------------

const poller = new TelemetryPoller({
  db,
  intervalMs: config.telemetryPollMs,
  getTransport: (host) => getTransport(ctx, host),
  onSample: (event) => broadcast(event),
  onError: (hostId, err) => app.log.debug({ hostId, err }, 'telemetry poll failed'),
});

try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
  app.log.info(
    `Fleet Console API on http://${config.apiHost}:${config.apiPort}` +
      (isDryRun() ? ' [DRY RUN — no host will be contacted]' : ''),
  );

  let polling = false;
  const meshTick = async () => {
    if (polling) return;
    polling = true;
    try {
      await reconcileAll();
    } catch (err) {
      app.log.warn({ err }, 'mesh reconciliation failed');
    } finally {
      polling = false;
    }
  };
  void meshTick();
  const meshTimer = setInterval(() => void meshTick(), config.meshPollMs);
  meshTimer.unref();

  if (!isDryRun()) poller.start();
  startScheduler(jobRunnerDeps());
  app.log.info('Factory scheduler started (60s tick)');

  // Starting the tunnel does not require guacd to be up; sessions fail with a
  // clear message from the preflight endpoint if it is not.
  if (guacTokens) {
    tunnel.start();
    app.log.info(`Guacamole tunnel on ws://127.0.0.1:${process.env.GUAC_WS_PORT ?? 8081}/guac`);
  } else {
    app.log.warn('GUAC_TOKEN_SECRET unset — remote desktop disabled.');
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    poller.stop();
    void pool.disposeAll().finally(() => process.exit(0));
  });
}

// --- helpers -----------------------------------------------------------------

function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Classify an upload (R-29). Binaries are never inlined into a prompt — they
 * are offered only as upload_attachment targets.
 */
// classifyAttachment lives in agent/attachments.ts (shared with download_file).

function resolveChatAttachments(ids: string[]): Attachment[] {
  const out: Attachment[] = [];
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error(`Invalid attachment id: ${id}`);
    }
    const path = join(config.attachmentsDir, id);
    if (!existsSync(path)) throw new Error(`Attachment not found: ${id}`);
    const meta = readAttachmentMeta(config.attachmentsDir, id);
    out.push({
      id,
      filename: meta?.filename ?? id,
      path,
      kind: meta?.kind ?? 'binary',
    });
  }
  return out;
}

function statSyncSafe(path: string): number {
  return statSync(path).size;
}
