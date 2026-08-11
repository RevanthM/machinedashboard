/**
 * Dry-run transport (R-08).
 *
 * `DRY_RUN=1` must print every command without connecting to anything. Rather
 * than threading a boolean through the engine and every step — where one missed
 * branch means an unintended connection — dry-run is implemented as a Transport
 * that cannot connect by construction. The engine and steps are unchanged.
 *
 * `check()` calls return a non-zero exit so steps report "not yet done" and
 * proceed to `apply`, which is what makes the printed plan show the full set of
 * commands rather than a list of skips.
 */
import type { OsFamily } from '../shell/escape.js';
import type {
  ExecOptions,
  ExecResult,
  ShellSession,
  Transport,
} from './../transport/types.js';
import { TransportError } from './../transport/types.js';

export class DryRunTransport implements Transport {
  readonly kind = 'ssh' as const;
  readonly commands: Array<{ script: string; elevated: boolean }> = [];

  constructor(readonly os: OsFamily) {}

  async exec(script: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.commands.push({ script, elevated: Boolean(opts.elevated) });
    opts.onStdout?.(`[dry-run] would execute:\n${script}\n`);
    return {
      stdout: '',
      // Non-zero so `check` steps report "not done" and the plan shows apply.
      stderr: '[dry-run] not executed',
      exitCode: 1,
      durationMs: 0,
    };
  }

  async shell(): Promise<ShellSession> {
    throw new TransportError('Interactive shell is unavailable in dry-run mode.', 'exec_failed');
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {}
}

export function isDryRun(): boolean {
  const raw = process.env.DRY_RUN?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}
