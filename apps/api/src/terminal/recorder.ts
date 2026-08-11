/**
 * Terminal session recording (R-24), in asciicast v2.
 *
 * v2 is a streaming format — a JSON header line followed by one JSON array per
 * event — so a recording stays valid even if the process dies mid-session. That
 * matters here: sessions end by the operator closing a tab or a link dropping,
 * neither of which gives us a clean shutdown hook.
 *
 * Only output is captured, never input. Keystrokes would record passwords typed
 * into `sudo`, `ssh`, or any interactive prompt — the terminal is exactly where
 * a secret is most likely to be typed, and a recording of it would be a
 * plaintext credential store sitting on disk. Output is additionally passed
 * through the scrubber.
 *
 * https://docs.asciinema.org/manual/asciicast/v2/
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Scrubber } from '../secrets/scrub.js';

export interface RecorderOptions {
  dir: string;
  hostId: string;
  hostName: string;
  cols: number;
  rows: number;
  scrubber: Scrubber;
  /** Unix seconds; injected so the caller controls the clock. */
  startedAt?: number;
}

export class SessionRecorder {
  readonly path: string;
  private readonly stream: WriteStream;
  private readonly startMs: number;
  private closed = false;
  private bytes = 0;

  constructor(private readonly opts: RecorderOptions) {
    mkdirSync(opts.dir, { recursive: true });
    const stamp = new Date((opts.startedAt ?? Math.floor(Date.now() / 1000)) * 1000)
      .toISOString()
      .replace(/[:.]/g, '-');
    const safeName = opts.hostName.replace(/[^A-Za-z0-9._-]+/g, '_');
    this.path = join(opts.dir, `${safeName}-${stamp}.cast`);

    this.stream = createWriteStream(this.path, { mode: 0o600 });
    this.startMs = Date.now();

    const header = {
      version: 2,
      width: opts.cols,
      height: opts.rows,
      timestamp: opts.startedAt ?? Math.floor(Date.now() / 1000),
      title: `Fleet Console — ${opts.hostName}`,
      env: { TERM: 'xterm-256color' },
    };
    this.stream.write(`${JSON.stringify(header)}\n`);
  }

  /** Record terminal output. Input is deliberately never recorded. */
  writeOutput(data: string): void {
    if (this.closed) return;
    const clean = this.opts.scrubber.scrub(data);
    const elapsed = (Date.now() - this.startMs) / 1000;
    this.bytes += clean.length;
    this.stream.write(`${JSON.stringify([Number(elapsed.toFixed(6)), 'o', clean])}\n`);
  }

  /**
   * Record a resize. Players need this to reflow, and a session that grows
   * mid-recording renders as corrupted output without it.
   */
  writeResize(cols: number, rows: number): void {
    if (this.closed) return;
    const elapsed = (Date.now() - this.startMs) / 1000;
    this.stream.write(
      `${JSON.stringify([Number(elapsed.toFixed(6)), 'r', `${cols}x${rows}`])}\n`,
    );
  }

  close(): { path: string; bytes: number; durationMs: number } {
    const result = {
      path: this.path,
      bytes: this.bytes,
      durationMs: Date.now() - this.startMs,
    };
    if (!this.closed) {
      this.closed = true;
      this.stream.end();
    }
    return result;
  }
}

export function recordingEnabled(): boolean {
  const raw = process.env.RECORD_SESSIONS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}
