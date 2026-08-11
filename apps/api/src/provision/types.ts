/**
 * Provisioning step contract (R-07).
 *
 * Every step is detect → check → apply → verify. `check` is what makes
 * re-provisioning a no-op (N-10): if it reports the work is already done, the
 * step is skipped without running `apply` at all. That is also what makes the
 * engine resumable — a run that died halfway re-checks each step rather than
 * blindly re-applying.
 *
 * Steps never build command strings by hand; they return script bodies that the
 * engine wraps through the per-OS escaping module.
 */
import type { Host } from '../db/schema.js';
import type { MeshProvider } from '../mesh/types.js';
import type { OsFamily } from '../shell/escape.js';
import type { ExecResult, Transport } from '../transport/types.js';

export interface StepContext {
  host: Host;
  transport: Transport;
  os: OsFamily;
  mesh: MeshProvider;
  /** Run a script on the host, streaming output to the run log. */
  exec(script: string, opts?: { elevated?: boolean; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  /** Emit a line into the run log without executing anything. */
  log(message: string): void;
  /** Facts accumulated by earlier steps (e.g. detected Windows edition). */
  facts: Record<string, string>;
}

export type StepOutcome =
  | { status: 'ok'; detail?: string }
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

export interface ProvisionStep {
  id: string;
  title: string;
  /** Steps that must succeed (or skip) before this one runs. */
  dependsOn: string[];
  /** OS families this step applies to. Omit for all. */
  appliesTo?: OsFamily[];
  /** Should this step run at all for this host? */
  enabled?(ctx: StepContext): boolean;
  /** True when the work is already done. Skips apply. */
  check(ctx: StepContext): Promise<boolean>;
  apply(ctx: StepContext): Promise<void>;
  /** Confirm the applied state. Runs after apply, and after a positive check. */
  verify(ctx: StepContext): Promise<StepOutcome>;
}

export interface StepReport {
  id: string;
  title: string;
  /**
   * `planned` is the dry-run outcome: the step's commands were collected but
   * nothing ran. It is deliberately distinct from `ok` (it did not happen) and
   * from `failed` (nothing went wrong) — reporting a dry run as a wall of
   * failures would train the operator to ignore the one that matters.
   */
  status: 'ok' | 'skipped' | 'failed' | 'blocked' | 'not_applicable' | 'planned';
  detail?: string;
  durationMs: number;
  /** Commands this step would run. Populated in dry-run mode. */
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
