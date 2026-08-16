/**
 * Factory chat: resolve host(s) from operator text and run agent/jobs.
 */
import { randomUUID } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import {
  buildUserMessage,
  runAgentTurn,
  systemPrompt,
  type ChatMessage,
} from '../agent/loop.js';
import type { ToolContext } from '../agent/tools.js';
import type { Db } from '../db/client.js';
import {
  factoryChatMessages,
  factoryChatSessions,
  hosts,
  type Host,
} from '../db/schema.js';
import { displayName } from '../hosts/display.js';
import { ensureAgentChatSession } from './agent-session.js';
import { createJob, runJob, type JobRunnerDeps } from './jobs.js';
import { resolveHostsFromText } from './router.js';

export async function listFactorySessions(db: Db) {
  return db
    .select()
    .from(factoryChatSessions)
    .orderBy(desc(factoryChatSessions.createdAt));
}

export async function createFactorySession(db: Db, title?: string) {
  const id = randomUUID();
  await db.insert(factoryChatSessions).values({
    id,
    title: title?.trim() || 'Factory chat',
  });
  return { id };
}

export async function getFactoryThread(db: Db, sessionId: string) {
  const [session] = await db
    .select()
    .from(factoryChatSessions)
    .where(eq(factoryChatSessions.id, sessionId))
    .limit(1);
  if (!session) return null;
  const messages = await db
    .select()
    .from(factoryChatMessages)
    .where(eq(factoryChatMessages.sessionId, sessionId))
    .orderBy(asc(factoryChatMessages.ts));
  return { session, messages };
}

export interface FactoryChatDeps extends JobRunnerDeps {
  resolveAgentModel: (host: Host) => Promise<{ baseUrl: string; model: string }>;
  buildToolContext: (host: Host, sessionId: string) => Promise<ToolContext>;
}

export async function handleFactoryChatMessage(
  deps: FactoryChatDeps,
  sessionId: string,
  text: string,
): Promise<{
  finalText: string;
  hostIds: string[];
  jobId: string | null;
  model?: string;
}> {
  const inventory = await deps.db.select().from(hosts);
  const resolution = resolveHostsFromText(text, inventory);

  await deps.db.insert(factoryChatMessages).values({
    id: randomUUID(),
    sessionId,
    role: 'user',
    content: text,
    hostIds: resolution.hosts.map((h) => h.id),
  });

  if (resolution.mode === 'none' || resolution.hosts.length === 0) {
    const reply = resolution.reason;
    await deps.db.insert(factoryChatMessages).values({
      id: randomUUID(),
      sessionId,
      role: 'assistant',
      content: reply,
      hostIds: [],
    });
    return { finalText: reply, hostIds: [], jobId: null };
  }

  if (resolution.mode === 'multi' || resolution.hosts.length > 1) {
    const hostIds = resolution.hosts.map((h) => h.id);
    const { jobId } = await createJob(deps.db, {
      type: 'agent',
      title: resolution.taskText.slice(0, 80) || 'Factory multi-host task',
      hostIds,
      payload: { text: resolution.taskText },
    });
    await runJob(deps, jobId);
    const { getJobBundle } = await import('./jobs.js');
    const full = await getJobBundle(deps.db, jobId);
    const lines = (full?.runs ?? []).map((r) => {
      const host = inventory.find((h) => h.id === r.hostId);
      const label = host ? displayName(host) : r.hostId;
      return `### ${label} (${r.status})\n${r.result ?? r.error ?? ''}`;
    });
    const reply =
      `${resolution.reason}\n\nRan on ${hostIds.length} host(s) as job ${jobId}.\n\n` +
      lines.join('\n\n');
    await deps.db.insert(factoryChatMessages).values({
      id: randomUUID(),
      sessionId,
      role: 'assistant',
      content: reply,
      hostIds,
      jobId,
    });
    return { finalText: reply, hostIds, jobId };
  }

  const host = resolution.hosts[0]!;
  const { baseUrl, model } = await deps.resolveAgentModel(host);
  const toolSessionId = await ensureAgentChatSession(
    deps.db,
    host.id,
    `Factory · ${displayName(host)}`,
  );
  const toolCtx = await deps.buildToolContext(host, toolSessionId);
  const history: ChatMessage[] = [
    {
      role: 'system',
      content:
        systemPrompt(displayName(host), host.os ?? 'unknown') +
        `\nYou were reached via Factory Chat. The operator asked about this specific host.`,
    },
  ];
  const built = buildUserMessage(resolution.taskText, []);
  history.push(built.message);

  const turn = await runAgentTurn(
    { db: deps.db, sessionId: toolSessionId, toolCtx, baseUrl, model },
    history,
  );

  let reply =
    (turn.finalText ?? '').trim() ||
    (turn.pending[0]
      ? `Paused for approval on ${displayName(host)}: ${turn.pending[0].tool}`
      : 'Done.');
  reply = `**${displayName(host)}** — ${resolution.reason}\n\n${reply}`;

  await deps.db.insert(factoryChatMessages).values({
    id: randomUUID(),
    sessionId,
    role: 'assistant',
    content: reply,
    hostIds: [host.id],
  });

  return { finalText: reply, hostIds: [host.id], jobId: null, model };
}
