/**
 * Factory jobs: create, run in parallel across hosts, collect results/artifacts.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  buildUserMessage,
  runAgentTurn,
  systemPrompt,
  type ChatMessage,
} from '../agent/loop.js';
import type { ApprovalMode } from '../agent/gate.js';
import type { ToolContext } from '../agent/tools.js';
import type { Db } from '../db/client.js';
import {
  hostSpecs,
  jobRuns,
  jobs,
  llmBenchmarks,
  type Host,
  type JobStatus,
  type JobType,
} from '../db/schema.js';
import { displayName } from '../hosts/display.js';
import { ensureAgentChatSession } from './agent-session.js';
import { desc } from 'drizzle-orm';

export type { JobType };

export interface JobArtifact {
  id: string;
  filename: string;
  kind: string;
  url: string;
  bytes?: number;
}

export interface CreateJobInput {
  type: JobType;
  title: string;
  hostIds: string[];
  payload?: Record<string, unknown>;
}

export interface JobRunnerDeps {
  db: Db;
  loadHost: (id: string) => Promise<Host>;
  buildToolContext: (host: Host, sessionId: string) => Promise<ToolContext>;
  resolveAgentModel: (host: Host) => Promise<{ baseUrl: string; model: string }>;
  execOnHost: (host: Host, command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  probeHost?: (host: Host) => Promise<unknown>;
  benchmarkHost?: (host: Host) => Promise<unknown>;
  broadcast?: (event: unknown) => void;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function extractArtifacts(messages: ChatMessage[]): JobArtifact[] {
  const out: JobArtifact[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !m.content) continue;
    const match = m.content.match(/"attachment_id"\s*:\s*"([^"]+)"/);
    const file = m.content.match(/"filename"\s*:\s*"([^"]+)"/);
    const kind = m.content.match(/"kind"\s*:\s*"([^"]+)"/);
    const url = m.content.match(/"url"\s*:\s*"([^"]+)"/);
    if (match) {
      out.push({
        id: match[1]!,
        filename: file?.[1] ?? match[1]!,
        kind: kind?.[1] ?? 'binary',
        url: url?.[1] ?? `/api/attachments/${match[1]}`,
      });
    }
  }
  return out;
}

export async function createJob(db: Db, input: CreateJobInput): Promise<{ jobId: string }> {
  if (input.hostIds.length === 0) throw new Error('At least one hostId is required.');
  const jobId = randomUUID();
  await db.insert(jobs).values({
    id: jobId,
    type: input.type,
    title: input.title,
    payload: input.payload ?? {},
    status: 'queued',
  });
  for (const hostId of input.hostIds) {
    await db.insert(jobRuns).values({
      id: randomUUID(),
      jobId,
      hostId,
      status: 'queued',
    });
  }
  return { jobId };
}

export async function runJob(deps: JobRunnerDeps, jobId: string): Promise<void> {
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new Error(`Job ${jobId} not found.`);

  const runs = await deps.db.select().from(jobRuns).where(eq(jobRuns.jobId, jobId));
  const started = nowSec();
  await deps.db
    .update(jobs)
    .set({ status: 'running', startedAt: started, error: null })
    .where(eq(jobs.id, jobId));
  deps.broadcast?.({ type: 'job_started', jobId, title: job.title });

  const results = await Promise.all(
    runs.map(async (run) => {
      const host = await deps.loadHost(run.hostId);
      await deps.db
        .update(jobRuns)
        .set({ status: 'running', startedAt: nowSec() })
        .where(eq(jobRuns.id, run.id));

      try {
        const { result, artifacts, ok } = await executeRun(deps, job.type, job.payload, host);
        const status: JobStatus = ok ? 'ok' : 'failed';
        await deps.db
          .update(jobRuns)
          .set({
            status,
            result,
            artifacts: artifacts.length ? artifacts : null,
            error: ok ? null : result.slice(0, 2000),
            endedAt: nowSec(),
          })
          .where(eq(jobRuns.id, run.id));
        return status;
      } catch (err) {
        const message = (err as Error).message;
        await deps.db
          .update(jobRuns)
          .set({ status: 'failed', error: message, endedAt: nowSec() })
          .where(eq(jobRuns.id, run.id));
        return 'failed' as JobStatus;
      }
    }),
  );

  const allOk = results.every((s) => s === 'ok');
  await deps.db
    .update(jobs)
    .set({
      status: allOk ? 'ok' : 'failed',
      endedAt: nowSec(),
      error: allOk ? null : 'One or more host runs failed.',
    })
    .where(eq(jobs.id, jobId));

  deps.broadcast?.({
    type: allOk ? 'job_ok' : 'job_failed',
    jobId,
    title: job.title,
    hosts: runs.length,
  });
}

async function executeRun(
  deps: JobRunnerDeps,
  type: JobType,
  payload: Record<string, unknown>,
  host: Host,
): Promise<{ result: string; artifacts: JobArtifact[]; ok: boolean }> {
  if (type === 'exec') {
    const command = String(payload.command ?? '');
    if (!command) throw new Error('exec job requires payload.command');
    const res = await deps.execOnHost(host, command);
    const text = `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`.trim();
    return { result: text || `(exit ${res.exitCode})`, artifacts: [], ok: res.exitCode === 0 };
  }

  if (type === 'probe') {
    const result = await deps.probeHost?.(host);
    return { result: JSON.stringify(result ?? { ok: true }, null, 2), artifacts: [], ok: true };
  }

  if (type === 'benchmark') {
    const result = await deps.benchmarkHost?.(host);
    return { result: JSON.stringify(result ?? {}, null, 2), artifacts: [], ok: true };
  }

  if (type === 'provision') {
    return {
      result: 'Use the host Provision tab for full provisioning; factory MVP does not re-run the DAG here.',
      artifacts: [],
      ok: false,
    };
  }

  // agent
  const text = String(payload.text ?? payload.prompt ?? '').trim();
  if (!text) throw new Error('agent job requires payload.text');

  const sessionId = await ensureAgentChatSession(
    deps.db,
    host.id,
    `Job · ${displayName(host)}`,
  );
  const { baseUrl, model } = await deps.resolveAgentModel(host);
  const toolCtx = await deps.buildToolContext(host, sessionId);
  toolCtx.mode = toolCtx.mode as ApprovalMode;

  const history: ChatMessage[] = [
    { role: 'system', content: systemPrompt(displayName(host), host.os ?? 'unknown') },
  ];
  const built = buildUserMessage(text, []);
  history.push(built.message);

  const turn = await runAgentTurn(
    { db: deps.db, sessionId, toolCtx, baseUrl, model },
    history,
  );

  if (turn.pending.length > 0) {
    return {
      result: `Paused for approval: ${turn.pending[0]!.tool} — ${turn.pending[0]!.subject}`,
      artifacts: extractArtifacts(turn.messages),
      ok: false,
    };
  }

  const artifacts = extractArtifacts(turn.messages);
  const finalText = (turn.finalText ?? '').trim() || 'Agent finished with no text.';
  return { result: finalText, artifacts, ok: true };
}

/**
 * Pick the best host for a workload using tags/OS/VRAM/tok/s.
 */
export async function routeJobHost(
  db: Db,
  inventory: Host[],
  opts: {
    os?: string;
    tag?: string;
    prefer?: 'evalTps' | 'freeVram' | 'online';
  },
): Promise<Host | null> {
  let pool = inventory.filter((h) => h.status === 'online' || h.isSelf);
  if (opts.os) pool = pool.filter((h) => h.os === opts.os);
  if (opts.tag) {
    const t = opts.tag.toLowerCase();
    pool = pool.filter((h) => (h.tags ?? []).some((x) => x.toLowerCase() === t));
  }
  if (pool.length === 0) return null;

  const prefer = opts.prefer ?? 'evalTps';
  if (prefer === 'online') return pool[0] ?? null;

  const scored: Array<{ host: Host; score: number }> = [];
  for (const host of pool) {
    if (prefer === 'evalTps') {
      const benches = await db
        .select()
        .from(llmBenchmarks)
        .where(eq(llmBenchmarks.hostId, host.id))
        .orderBy(desc(llmBenchmarks.ts))
        .limit(1);
      scored.push({ host, score: benches[0]?.evalTps ?? 0 });
    } else {
      const specs = await db.select().from(hostSpecs).where(eq(hostSpecs.hostId, host.id)).limit(1);
      const vram = (specs[0]?.gpu ?? []).reduce((sum, g) => sum + (g.vramMb ?? 0), 0);
      scored.push({ host, score: vram || (specs[0]?.ramFreeGb ?? 0) * 1024 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.host ?? null;
}

export async function getJobBundle(db: Db, jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return null;
  const runs = await db.select().from(jobRuns).where(eq(jobRuns.jobId, jobId));
  return { job, runs };
}
