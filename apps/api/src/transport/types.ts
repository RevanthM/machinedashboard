/**
 * How Fleet Console reaches a managed host.
 *
 * Two implementations, because this fleet's host #1 *is* the operator laptop.
 * SSH-ing to localhost would mean running an sshd we don't need, authenticating
 * against a key we'd have to manage, and a confusing failure mode when the
 * machine's own sshd is down. `LocalTransport` sidesteps all of it.
 */
import type { OsFamily } from '../shell/escape.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ExecOptions {
  /** Extra environment, injected without ever appearing on the command line. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Run via sudo / as administrator. */
  elevated?: boolean;
  /** Streamed as it arrives, for live provisioning logs. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ShellSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  close(): void;
}

export interface ShellOptions {
  cols?: number;
  rows?: number;
  term?: string;
}

export interface Transport {
  readonly kind: 'ssh' | 'local';
  readonly os: OsFamily;

  /** Run a script to completion. The script is wrapped per-OS by the impl. */
  exec(script: string, opts?: ExecOptions): Promise<ExecResult>;

  /** Interactive PTY, for the browser terminal (F6). */
  shell(opts?: ShellOptions): Promise<ShellSession>;

  /** Cheap liveness probe used by the status pips. */
  ping(): Promise<boolean>;

  dispose(): Promise<void>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'unreachable'
      | 'auth_failed'
      | 'host_key_changed'
      | 'timeout'
      | 'exec_failed',
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
