/**
 * SSH transport (ssh2).
 *
 * Host keys are pinned on first connect (TOFU) per PRD §11 — blanket-accepting
 * unknown keys would make the mesh's security guarantees decorative. A changed
 * key is a hard failure the operator must resolve explicitly; it is never
 * auto-accepted, because the one time it matters is the one time it is real.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { wrapScript, wrapScriptElevated, type OsFamily } from '../shell/escape.js';
import {
  TransportError,
  type ExecOptions,
  type ExecResult,
  type ShellOptions,
  type ShellSession,
  type Transport,
} from './types.js';

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  os: OsFamily;
  auth:
    | { method: 'password'; password: string }
    | { method: 'key'; privateKeyPath: string; passphrase?: string }
    | { method: 'agent'; agentSocket?: string };
  /** Pinned key fingerprint (`SHA256:...`). Null on first connect. */
  knownHostKey?: string | null;
  /** Called when a key is learned, so it can be persisted. */
  onHostKeyLearned?: (fingerprint: string) => void;
  sudoPassword?: string;
}

/** Same `SHA256:base64` shape `ssh-keyscan` and OpenSSH print. */
export function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;
  readonly os: OsFamily;

  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly target: SshTarget) {
    this.os = target.os;
  }

  async exec(script: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const client = await this.connect();

    const commandLine = opts.elevated
      ? wrapScriptElevated(script, this.os, this.target.sudoPassword)
      : wrapScript(script, this.os);

    return new Promise((resolvePromise, reject) => {
      client.exec(commandLine, { env: opts.env }, (err, stream) => {
        if (err) {
          reject(new TransportError(err.message, 'exec_failed'));
          return;
        }

        let stdout = '';
        let stderr = '';
        let timer: NodeJS.Timeout | undefined;

        if (opts.timeoutMs) {
          timer = setTimeout(() => {
            stream.close();
            reject(
              new TransportError(`Command timed out after ${opts.timeoutMs}ms`, 'timeout'),
            );
          }, opts.timeoutMs);
        }

        // `sudo -S` reads the password from stdin; see wrapScriptElevated.
        if (opts.elevated && this.target.sudoPassword && this.os !== 'windows') {
          stream.write(`${this.target.sudoPassword}\n`);
        }

        stream.setEncoding('utf8');
        stream.on('data', (c: string) => {
          stdout += c;
          opts.onStdout?.(c);
        });
        stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', (c: string) => {
          stderr += c;
          opts.onStderr?.(c);
        });
        stream.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer);
          resolvePromise({
            stdout,
            stderr,
            exitCode: code ?? -1,
            durationMs: Date.now() - started,
          });
        });
      });
    });
  }

  async shell(opts: ShellOptions = {}): Promise<ShellSession> {
    const client = await this.connect();

    return new Promise((resolvePromise, reject) => {
      client.shell(
        {
          term: opts.term ?? 'xterm-256color',
          cols: opts.cols ?? 120,
          rows: opts.rows ?? 30,
        },
        (err, stream: ClientChannel) => {
          if (err) {
            reject(new TransportError(err.message, 'exec_failed'));
            return;
          }
          stream.setEncoding('utf8');
          resolvePromise({
            write: (data) => stream.write(data),
            // Propagates SIGWINCH so full-screen programs redraw correctly.
            resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
            onData: (cb) => stream.on('data', cb),
            onClose: (cb) => stream.on('close', cb),
            close: () => stream.close(),
          });
        },
      );
    });
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.exec(
        this.os === 'windows' ? 'Write-Output ok' : 'echo ok',
        { timeoutMs: 10_000 },
      );
      return res.exitCode === 0 && res.stdout.includes('ok');
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.client?.end();
    this.client = null;
    this.connecting = null;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.doConnect();
    try {
      return await this.connecting;
    } catch (err) {
      // Let the next call retry rather than caching a rejected promise forever.
      this.connecting = null;
      throw err;
    }
  }

  private doConnect(): Promise<Client> {
    const { target } = this;

    return new Promise((resolvePromise, reject) => {
      const client = new Client();

      const config: ConnectConfig = {
        host: target.host,
        port: target.port,
        username: target.username,
        // Reap dead sessions instead of leaking them into the pool (PRD §14).
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        readyTimeout: 20_000,
        hostVerifier: (key: Buffer) => {
          const fingerprint = fingerprintHostKey(key);
          if (!target.knownHostKey) {
            target.onHostKeyLearned?.(fingerprint);
            return true;
          }
          return normalizeFingerprint(target.knownHostKey) === fingerprint;
        },
      };

      switch (target.auth.method) {
        case 'password':
          config.password = target.auth.password;
          break;
        case 'key':
          try {
            config.privateKey = readFileSync(target.auth.privateKeyPath);
          } catch (err) {
            reject(
              new TransportError(
                `Cannot read private key at ${target.auth.privateKeyPath}: ${(err as Error).message}`,
                'auth_failed',
              ),
            );
            return;
          }
          if (target.auth.passphrase) config.passphrase = target.auth.passphrase;
          break;
        case 'agent':
          config.agent = target.auth.agentSocket ?? process.env.SSH_AUTH_SOCK;
          if (!config.agent) {
            reject(
              new TransportError(
                'auth_method=agent but no SSH agent socket is available (SSH_AUTH_SOCK unset).',
                'auth_failed',
              ),
            );
            return;
          }
          break;
      }

      client.on('ready', () => {
        this.client = client;
        resolvePromise(client);
      });

      client.on('error', (err: Error & { level?: string }) => {
        this.client = null;
        reject(toTransportError(err, target));
      });

      client.on('close', () => {
        this.client = null;
        this.connecting = null;
      });

      client.connect(config);
    });
  }
}

function normalizeFingerprint(value: string): string {
  // The inventory records these as "ED25519 SHA256:xxx"; keep only the digest.
  const match = /SHA256:[A-Za-z0-9+/]+=*/.exec(value);
  return (match?.[0] ?? value).replace(/=+$/, '');
}

/** Turn ssh2's error vocabulary into something the import UI can act on. */
function toTransportError(
  err: Error & { level?: string; code?: string },
  target: SshTarget,
): TransportError {
  const where = `${target.host}:${target.port}`;

  if (err.message.includes('Host key verification') || err.level === 'client-authentication') {
    if (err.message.toLowerCase().includes('host key')) {
      return new TransportError(
        `Host key for ${where} does not match the pinned key. If you rebuilt this ` +
          `machine, clear its pinned key; otherwise treat this as a real warning.`,
        'host_key_changed',
        err.message,
      );
    }
  }

  if (err.level === 'client-authentication') {
    return new TransportError(
      `Authentication failed for ${target.username}@${where}.`,
      'auth_failed',
      err.message,
    );
  }

  if (err.code === 'ECONNREFUSED') {
    return new TransportError(
      `Port ${target.port} closed on ${target.host} — is sshd running? See PREREQS.md.`,
      'unreachable',
      err.message,
    );
  }

  if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
    return new TransportError(
      `${target.host} is unreachable. If it is only on the mesh, confirm the peer is connected.`,
      'unreachable',
      err.message,
    );
  }

  return new TransportError(`SSH to ${where} failed: ${err.message}`, 'unreachable', err.message);
}
