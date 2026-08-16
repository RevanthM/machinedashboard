/**
 * Simple in-process scheduler: every minute, fire due schedules as factory jobs.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hosts, schedules, type Host, type JobType } from '../db/schema.js';
import { createJob, runJob, type JobRunnerDeps } from './jobs.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function startScheduler(deps: JobRunnerDeps): NodeJS.Timeout {
  const tick = async () => {
    try {
      await schedulerTick(deps);
    } catch (err) {
      deps.broadcast?.({ type: 'scheduler_error', error: (err as Error).message });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
  return timer;
}

export async function schedulerTick(deps: JobRunnerDeps): Promise<void> {
  const now = nowSec();
  const rows = await deps.db.select().from(schedules).where(eq(schedules.enabled, true));
  for (const sched of rows) {
    const due = !sched.nextRunAt || sched.nextRunAt <= now;
    if (!due) continue;

    const allHosts = await deps.db.select().from(hosts);
    const hostIds =
      sched.hostIds && sched.hostIds.length > 0
        ? sched.hostIds
        : allHosts.filter((h) => h.status === 'online' || h.isSelf).map((h) => h.id);

    if (hostIds.length === 0) {
      await deps.db
        .update(schedules)
        .set({
          lastRunAt: now,
          nextRunAt: now + Math.max(1, sched.everyMinutes) * 60,
        })
        .where(eq(schedules.id, sched.id));
      continue;
    }

    const { jobId } = await createJob(deps.db, {
      type: sched.jobType,
      title: `Schedule: ${sched.name}`,
      hostIds,
      payload: sched.payload ?? {},
    });

    // Fire-and-forget so the tick does not block on long benches.
    void runJob(deps, jobId).catch((err) => {
      deps.broadcast?.({
        type: 'job_failed',
        jobId,
        title: sched.name,
        error: (err as Error).message,
      });
    });

    await deps.db
      .update(schedules)
      .set({
        lastRunAt: now,
        nextRunAt: now + Math.max(1, sched.everyMinutes) * 60,
      })
      .where(eq(schedules.id, sched.id));

    deps.broadcast?.({ type: 'schedule_fired', scheduleId: sched.id, jobId, name: sched.name });
  }
}

export async function upsertSchedule(
  db: Db,
  input: {
    id?: string;
    name: string;
    everyMinutes: number;
    jobType: JobType;
    hostIds?: string[] | null;
    payload?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  const existing = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  const nextRunAt = nowSec() + Math.max(1, input.everyMinutes) * 60;
  if (existing.length) {
    await db
      .update(schedules)
      .set({
        name: input.name,
        everyMinutes: input.everyMinutes,
        jobType: input.jobType,
        hostIds: input.hostIds ?? null,
        payload: input.payload ?? {},
        enabled: input.enabled ?? true,
        nextRunAt,
      })
      .where(eq(schedules.id, id));
  } else {
    await db.insert(schedules).values({
      id,
      name: input.name,
      everyMinutes: input.everyMinutes,
      jobType: input.jobType,
      hostIds: input.hostIds ?? null,
      payload: input.payload ?? {},
      enabled: input.enabled ?? true,
      nextRunAt,
    });
  }
  return id;
}

export type { Host };
