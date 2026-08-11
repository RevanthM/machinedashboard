// Must stay first — populates process.env before config.ts snapshots it.
import './env.js';

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { desc, eq, gte } from 'drizzle-orm';
import Fastify from 'fastify';

import { detectBackend, isOllamaHealthy, runBenchmark } from './bench/ollama.js';
import { refreshSpecs, TelemetryPoller } from './collect/poller.js';
import { assertSafeConfig, config } from './config.js';
import { getDb } from './db/client.js';
import {
  chatSessions,
  commandAudit,
  hostMetrics,
  hostSpecs,
  hosts,
  llmBenchmarks,
  provisionRuns,
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
import { activeAddress, getTransport, loadHost, ollamaUrl } from './hosts/service.js';
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

  return {
    hosts: rows.map((host) => ({
      ...host,
      activeAddress: activeAddress(host),
      specs: specById.get(host.id) ?? null,
      latestBenchmark: benchById.get(host.id) ?? null,
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
    return {
      ...host,
      activeAddress: activeAddress(host),
      specs: specs[0] ?? null,
      benchmarks: benches,
    };
  } catch (err) {
    return reply.status(404).send({ error: (err as Error).message });
  }
});

app.patch('/api/hosts/:id', async (request) => {
  const { id } = request.params as { id: string };
  const body = request.body as Partial<Host>;
  const allowed = {
    name: body.name,
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
  return loadHost(db, id);
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
    const backend = await detectBackend(baseUrl, gpu);
    const model = body.model ?? config.ollamaModel;

    const result = await runBenchmark({
      baseUrl,
      model,
      backend,
      onProgress: (message) => broadcast({ type: 'benchmark_progress', hostId: id, message }),
    });

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
        name: host.name,
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
  const path = join(config.attachmentsDir, id);
  writeFileSync(path, buffer, { mode: 0o600 });

  const kind = classifyAttachment(file.filename, buffer);
  return {
    id,
    filename: file.filename,
    bytes: buffer.length,
    kind,
    inlineable: kind === 'text',
  };
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

// --- chat sessions -----------------------------------------------------------

app.post('/api/chat/:hostId/sessions', async (request) => {
  const { hostId } = request.params as { hostId: string };
  const id = randomUUID();
  await db.insert(chatSessions).values({ id, hostId, title: 'New session' });
  return { id, hostId };
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
function classifyAttachment(filename: string, buffer: Buffer): 'text' | 'image' | 'binary' {
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(filename)) return 'image';
  // Sniff rather than trust the extension (N-14): a NUL byte in the first 8 KB
  // means it is not text we should be splicing into a prompt.
  const head = buffer.subarray(0, 8192);
  if (head.includes(0)) return 'binary';
  return 'text';
}
