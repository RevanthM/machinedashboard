/**
 * Transport for the machine running Fleet Console.
 *
 * Appendix A host #1 (`Matha-Windows-3080-5TB`) is the operator laptop, so it
 * is managed like any other host but reached without a network hop. Everything
 * above `Transport` is unaware of the difference — the same provisioning steps,
 * telemetry collectors and agent tools run against it unchanged.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { wrapScript, wrapScriptElevated, type OsFamily } from '../shell/escape.js';
import {
  TransportError,
  type ExecOptions,
  type ExecResult,
  type ShellOptions,
  type ShellSession,
  type Transport,
} from './types.js';

export function detectLocalOs(): OsFamily {
  switch (platform()) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'ubuntu';
  }
}

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  readonly os: OsFamily;

  constructor(os: OsFamily = detectLocalOs()) {
    this.os = os;
  }

  async exec(script: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const commandLine = opts.elevated
      ? wrapScriptElevated(script, this.os)
      : wrapScript(script, this.os);

    return new Promise((resolvePromise, reject) => {
      // The wrapper already produced a fully-formed command line, so it is
      // handed to a shell verbatim rather than re-split into argv here — any
      // re-quoting at this layer is exactly the bug the wrapper prevents.
      const child = spawn(commandLine, {
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...opts.env },
      });

      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;

      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          child.kill();
          reject(
            new TransportError(
              `Local command timed out after ${opts.timeoutMs}ms`,
              'timeout',
            ),
          );
        }, opts.timeoutMs);
      }

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
        opts.onStdout?.(c);
      });
      child.stderr.on('data', (c: string) => {
        stderr += c;
        opts.onStderr?.(c);
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new TransportError(err.message, 'exec_failed'));
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolvePromise({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  /**
   * A real PTY needs a native module (node-pty) that this machine cannot build
   * without a compiler toolchain. Rather than ship a half-working terminal, the
   * local host's terminal tab is disabled with a clear reason; every other
   * feature works. Remote hosts get a proper PTY over SSH, which is where the
   * browser terminal actually matters.
   */
  async shell(_opts?: ShellOptions): Promise<ShellSession> {
    throw new TransportError(
      'Interactive terminal is not available for the local host. ' +
        'Use your own terminal on this machine, or install node-pty to enable it.',
      'exec_failed',
    );
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {
    // Nothing held open.
  }
}
