/**
 * Provisioning DAG runner (R-07, R-08).
 *
 * Ordering rule from PRD §F2: "A failed step blocks dependents but not
 * siblings." So `install_ollama` failing must not prevent `install_rdp` from
 * running — they are independent branches off `detect_os`, and a host with a
 * working desktop and no LLM is more useful than one with neither.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hosts, provisionRuns, type Host } from '../db/schema.js';
import type { MeshProvider } from '../mesh/types.js';
import type { Scrubber } from '../secrets/scrub.js';
import type { OsFamily } from '../shell/escape.js';
import type { Transport } from '../transport/types.js';
import { DryRunTransport } from './dry-run.js';
import { ALL_STEPS, newRunId } from './steps.js';
import type {
  ProvisionReport,
  ProvisionStep,
  StepContext,
  StepReport,
} from './types.js';

export interface RunOptions {
  db: Db;
  host: Host;
  transport: Transport;
  mesh: MeshProvider;
  scrubber: Scrubber;
  /** Restrict to these step ids (plus their dependencies). */
  only?: string[];
  /** Re-apply even when `check` reports the work is done. */
  force?: boolean;
  onEvent?: (event: ProvisionEvent) => void;
}

export type ProvisionEvent =
  | { type: 'step_start'; stepId: string; title: string }
  | { type: 'output'; stepId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'log'; stepId: string; message: string }
  | { type: 'step_end'; stepId: string; status: StepReport['status']; detail?: string };

export async function runProvisioning(opts: RunOptions): Promise<ProvisionReport> {
  const { db, host, transport, mesh, scrubber, onEvent } = opts;
  const started = Date.now();
  const dryRun = transport instanceof DryRunTransport;
  const os: OsFamily = host.os ?? 'ubuntu';

  const steps = selectSteps(opts.only);
  const reports = new Map<string, StepReport>();
  const facts: Record<string, string> = {};

  // Seed facts the steps rely on but do not themselves discover.
  if (host.osEdition) facts.windowsEdition = host.osEdition;

  if (!dryRun) {
    await db
      .update(hosts)
      .set({ provisionState: 'in_progress', updatedAt: nowSec() })
      .where(eq(hosts.id, host.id));
  }

  for (const step of steps) {
    if (step.appliesTo && !step.appliesTo.includes(os)) {
      reports.set(step.id, {
        id: step.id,
        title: step.title,
        status: 'not_applicable',
        detail: `Does not apply to ${os}.`,
        durationMs: 0,
      });
      continue;
    }

    const blockedBy = step.dependsOn.filter((dep) => {
      const report = reports.get(dep);
      return report && (report.status === 'failed' || report.status === 'blocked');
    });
    if (blockedBy.length > 0) {
      reports.set(step.id, {
        id: step.id,
        title: step.title,
        status: 'blocked',
        detail: `Blocked by ${blockedBy.join(', ')}.`,
        durationMs: 0,
      });
      onEvent?.({ type: 'step_end', stepId: step.id, status: 'blocked' });
      continue;
    }

    const report = await runStep(step, {
      db,
      host,
      transport,
      mesh,
      scrubber,
      os,
      facts,
      force: opts.force ?? false,
      dryRun,
      onEvent,
    });
    reports.set(step.id, report);
  }

  const list = [...reports.values()];
  const anyFailed = list.some((r) => r.status === 'failed');
  // A host whose model could not fit is a distinct state, not a failure — the
  // rest of it provisioned fine and the dashboard should say so.
  const llmUnsupported = list.some(
    (r) => r.status === 'failed' && r.detail?.includes('LLM_UNSUPPORTED'),
  );

  if (!dryRun) {
    await db
      .update(hosts)
      .set({
        provisionState: anyFailed
          ? llmUnsupported && !list.some((r) => r.status === 'failed' && !r.detail?.includes('LLM_UNSUPPORTED'))
            ? 'llm_unsupported'
            : 'failed'
          : 'provisioned',
        osEdition: facts.windowsEdition ?? host.osEdition,
        rdpProtocol: (facts.remoteDesktop as 'rdp' | 'vnc' | undefined) ?? host.rdpProtocol,
        updatedAt: nowSec(),
      })
      .where(eq(hosts.id, host.id));
  }

  return {
    hostId: host.id,
    hostName: host.name,
    dryRun,
    steps: list,
    ok: !anyFailed,
    durationMs: Date.now() - started,
  };
}

interface StepRunOptions {
  db: Db;
  host: Host;
  transport: Transport;
  mesh: MeshProvider;
  scrubber: Scrubber;
  os: OsFamily;
  facts: Record<string, string>;
  force: boolean;
  dryRun: boolean;
  onEvent?: (event: ProvisionEvent) => void;
}

async function runStep(step: ProvisionStep, o: StepRunOptions): Promise<StepReport> {
  const started = Date.now();
  const runId = newRunId();
  const commands: string[] = [];
  let stdout = '';
  let stderr = '';

  o.onEvent?.({ type: 'step_start', stepId: step.id, title: step.title });

  const ctx: StepContext = {
    host: o.host,
    transport: o.transport,
    os: o.os,
    mesh: o.mesh,
    facts: o.facts,
    log: (message) => {
      o.onEvent?.({ type: 'log', stepId: step.id, message: o.scrubber.scrub(message) });
    },
    exec: async (script, execOpts = {}) => {
      commands.push(script);
      return o.transport.exec(script, {
        ...execOpts,
        onStdout: (chunk) => {
          const clean = o.scrubber.scrub(chunk);
          stdout += clean;
          o.onEvent?.({ type: 'output', stepId: step.id, stream: 'stdout', chunk: clean });
        },
        onStderr: (chunk) => {
          const clean = o.scrubber.scrub(chunk);
          stderr += clean;
          o.onEvent?.({ type: 'output', stepId: step.id, stream: 'stderr', chunk: clean });
        },
      });
    },
  };

  const finish = async (status: StepReport['status'], detail?: string): Promise<StepReport> => {
    const durationMs = Date.now() - started;
    if (!o.dryRun) {
      await o.db.insert(provisionRuns).values({
        id: runId,
        hostId: o.host.id,
        step: step.id,
        status: status === 'ok' ? 'ok' : status === 'skipped' ? 'skipped' : 'failed',
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode: status === 'ok' ? 0 : 1,
        startedAt: Math.floor(started / 1000),
        endedAt: nowSec(),
      });
    }
    o.onEvent?.({ type: 'step_end', stepId: step.id, status, detail });
    return {
      id: step.id,
      title: step.title,
      status,
      detail,
      durationMs,
      commands: o.dryRun ? commands : undefined,
    };
  };

  try {
    if (step.enabled && !step.enabled(ctx)) {
      return finish('not_applicable', 'Disabled for this host.');
    }

    if (!o.force) {
      const alreadyDone = await step.check(ctx);
      if (alreadyDone) {
        // Still verify — "check passed" and "actually working" are not the same
        // thing, and this is the path a re-provision takes (N-10).
        const outcome = await step.verify(ctx);
        return outcome.status === 'failed'
          ? finish('failed', outcome.detail)
          : finish('skipped', outcome.detail ?? 'Already configured.');
      }
    }

    await step.apply(ctx);

    // In dry-run nothing executed, so `verify` cannot succeed and running it
    // would report a false failure. The collected commands are the deliverable.
    if (o.dryRun) {
      return finish('planned', `${commands.length} command(s) would run`);
    }

    const outcome = await step.verify(ctx);
    return outcome.status === 'failed'
      ? finish('failed', outcome.detail)
      : finish('ok', outcome.detail);
  } catch (err) {
    return finish('failed', o.scrubber.scrub((err as Error).message));
  }
}

/**
 * Topologically order the catalogue, pulling in dependencies of any explicit
 * selection so `only: ['pull_model']` still runs `install_ollama` first.
 */
function selectSteps(only?: string[]): ProvisionStep[] {
  const byId = new Map(ALL_STEPS.map((s) => [s.id, s]));
  const wanted = new Set<string>();

  const include = (id: string) => {
    if (wanted.has(id)) return;
    const step = byId.get(id);
    if (!step) return;
    wanted.add(id);
    step.dependsOn.forEach(include);
  };

  if (only && only.length > 0) only.forEach(include);
  else ALL_STEPS.forEach((s) => include(s.id));

  const ordered: ProvisionStep[] = [];
  const placed = new Set<string>();

  // ALL_STEPS is authored in dependency order, so a bounded number of passes
  // settles it without needing a full toposort.
  for (let pass = 0; pass < ALL_STEPS.length + 1 && placed.size < wanted.size; pass++) {
    for (const step of ALL_STEPS) {
      if (!wanted.has(step.id) || placed.has(step.id)) continue;
      if (step.dependsOn.every((d) => !wanted.has(d) || placed.has(d))) {
        ordered.push(step);
        placed.add(step.id);
      }
    }
  }
  return ordered;
}

function truncate(text: string, max = 64_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…truncated (${text.length} bytes)`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
